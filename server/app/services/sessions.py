"""Session lifecycle.

The server — never the client — decides which challenges are asked and in what
order. A client that could choose its own challenges could pick the ones its
pre-recorded video happens to contain.
"""

from __future__ import annotations

import datetime as dt
import secrets

from sqlalchemy.orm import Session

from ..config import settings
from ..decision import VERIFIABLE_CHALLENGES
from ..models import VerificationSession
from ..schemas import CreateSessionRequest, CreatedSession, SessionPolicy


class SessionError(Exception):
    """Raised with a stable reason code the client can switch on."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def pick_challenges(tier: str, rng: secrets.SystemRandom | None = None) -> list[str]:
    """Choose and shuffle the challenges for this session.

    Random *order* matters as much as random selection: a replay of a recorded
    session only works if the recording happens to match the order asked for.
    """
    random = rng or secrets.SystemRandom()
    count = settings.challenges_reduced if tier == "reduced" else settings.challenges_full
    pool = list(VERIFIABLE_CHALLENGES)
    count = max(1, min(count, len(pool)))
    return random.sample(pool, count)


def create_session(db: Session, request: CreateSessionRequest) -> CreatedSession:
    if request.purpose == "verify" and not request.personId:
        raise SessionError("PERSON_REQUIRED")

    policy = SessionPolicy()
    record = VerificationSession(
        purpose=request.purpose,
        person_id=request.personId,
        display_name=request.displayName,
        nonce=secrets.token_urlsafe(32),
        challenges=pick_challenges(request.tier),
        policy=policy.model_dump(),
        client=request.client.model_dump() if request.client else None,
        expires_at=_now() + dt.timedelta(seconds=settings.session_ttl_seconds),
        state="issued",
    )
    db.add(record)
    db.commit()

    return CreatedSession(
        sessionId=record.id,
        nonce=record.nonce,
        challenges=record.challenges,  # type: ignore[arg-type]
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
