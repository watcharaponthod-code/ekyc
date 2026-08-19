"""Session lifecycle.

The server — never the client — decides which challenges are asked and in what
order. A client that could choose its own challenges could pick the ones its
pre-recorded video happens to contain.
"""

from __future__ import annotations

import datetime as dt
import secrets

from sqlalchemy.orm import Session

from ..config import settings, thresholds
from ..decision import EXPRESSION_CHALLENGES, VERIFIABLE_CHALLENGES
from ..flash import FLASH_PALETTE
from ..models import VerificationSession
from ..schemas import CreateSessionRequest, CreatedSession, PulsePlan, SessionPolicy


class SessionError(Exception):
    """Raised with a stable reason code the client can switch on."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def pick_challenges(
    tier: str,
    rng: secrets.SystemRandom | None = None,
    *,
    expressions: bool | None = None,
) -> list[str]:
    """Choose and shuffle the challenges for this session.

    Random *order* matters as much as random selection: a replay of a recorded
    session only works if the recording happens to match the order asked for.

    ``expressions`` says whether the running backend can verify `openMouth` /
    `smile` (blendshapes). When it can, and `always_open_mouth` is set, every
    full-tier session includes `openMouth` — the challenge a rigid mask cannot
    answer — in a random position among randomly drawn companions.
    """
    random = rng or secrets.SystemRandom()
    count = settings.challenges_reduced if tier == "reduced" else settings.challenges_full
    use_expressions = settings.expression_challenges if expressions is None else (
        expressions and settings.expression_challenges
    )
    pool = list(VERIFIABLE_CHALLENGES) + (list(EXPRESSION_CHALLENGES) if use_expressions else [])
    count = max(1, min(count, len(pool)))
    if use_expressions and settings.always_open_mouth and tier != "reduced":
        rest = [name for name in pool if name != "openMouth"]
        chosen = ["openMouth", *random.sample(rest, count - 1)]
        random.shuffle(chosen)
        return chosen
    return random.sample(pool, count)


def pick_pulse() -> dict[str, int] | None:
    """The rPPG burst plan, or None when the feature is off."""
    if settings.pulse_frames <= 0:
        return None
    return {"frames": int(settings.pulse_frames), "durationMs": int(settings.pulse_duration_ms)}


def pick_flash(count: int, rng: secrets.SystemRandom | None = None) -> list[str]:
    """A random screen-flash colour sequence. Order and identity are both
    random per session, so a recording of one session's flashes cannot satisfy
    another. A permutation while it fits the palette keeps every colour channel
    varying, which is what the correlation check needs.
    """
    if count <= 0:
        return []
    random = rng or secrets.SystemRandom()
    names = list(FLASH_PALETTE)
    if count <= len(names):
        return random.sample(names, count)
    return [random.choice(names) for _ in range(count)]


def create_session(
    db: Session, request: CreateSessionRequest, *, expressions: bool | None = None
) -> CreatedSession:
    if request.purpose == "verify" and not request.personId:
        raise SessionError("PERSON_REQUIRED")

    policy = SessionPolicy(
        turnYawMinDeg=thresholds.turn_yaw_min_deg,
        neutralYawMaxDeg=thresholds.neutral_yaw_max_deg,
        sharpnessMin=thresholds.sharpness_min,
    )
    record = VerificationSession(
        purpose=request.purpose,
        person_id=request.personId,
        display_name=request.displayName,
        nonce=secrets.token_urlsafe(32),
        challenges=pick_challenges(request.tier, expressions=expressions),
        flash=pick_flash(settings.flash_frames),
        pulse=pick_pulse(),
        policy=policy.model_dump(),
        client={
            **(request.client.model_dump() if request.client else {}),
            **({"label": request.label} if request.label else {}),
        } or None,
        expires_at=_now() + dt.timedelta(seconds=settings.session_ttl_seconds),
        state="issued",
    )
    db.add(record)
    db.commit()

    return CreatedSession(
        sessionId=record.id,
        nonce=record.nonce,
        challenges=record.challenges,  # type: ignore[arg-type]
        flash=record.flash or [],  # type: ignore[arg-type]
        pulse=PulsePlan(**record.pulse) if record.pulse else None,
        expiresAt=record.expires_at,
        policy=policy,
    )


def consume_session(db: Session, session_id: str, nonce: str) -> VerificationSession:
    """Claim a session for processing. Succeeds at most once, ever.

    Marking the session consumed *before* any ML work is what makes a replayed
    or parallel submission fail rather than race.
    """
    record = db.get(VerificationSession, session_id)
    if record is None:
        raise SessionError("SESSION_NOT_FOUND")
    if record.consumed_at is not None:
        raise SessionError("SESSION_CONSUMED")
    if _as_utc(record.expires_at) < _now():
        raise SessionError("SESSION_EXPIRED")
    if not secrets.compare_digest(record.nonce, nonce):
        raise SessionError("NONCE_MISMATCH")

    record.consumed_at = _now()
    record.state = "processing"
    db.commit()
    return record


def _as_utc(value: dt.datetime) -> dt.datetime:
    """SQLite hands back naive datetimes; treat them as the UTC they were."""
    return value if value.tzinfo else value.replace(tzinfo=dt.timezone.utc)
