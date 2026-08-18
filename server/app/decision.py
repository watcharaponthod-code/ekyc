"""The decision engine.

Pure Python over already-measured facts — no ONNX, no database, no I/O. That
separation is what lets the whole rule set be tested exhaustively in
milliseconds, and it keeps the rules readable enough to argue about.

Structural problems short-circuit (there is no point measuring pose on a frame
with no face). Everything after that accumulates, so the user gets told all of
what went wrong at once.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import combinations

from .config import Thresholds
from .flash import flash_liveness_score
from .ml.backend import FrameFacts
from .ml.geometry import cosine
from .schemas import EvidenceManifest

#: The only challenges the server issues, because they are the only ones it can
#: re-verify from a still frame. `smile` exists in the mobile module but is not
#: issued — an unverifiable challenge is theatre.
VERIFIABLE_CHALLENGES = ("closeEyes", "turnLeft", "turnRight")

TURN_CHALLENGES = ("turnLeft", "turnRight")

NEUTRAL_KEY = "neutral"


@dataclass(slots=True)
class DecisionInput:
    #: Challenges the server issued, in order, excluding the implicit `center`.
    issued_challenges: list[str]
    manifest: EvidenceManifest
    #: Measurements keyed by frame key (`neutral` plus one per challenge, and
    #: `flash_0..flash_{n-1}` when a flash plan was issued).
    facts: dict[str, FrameFacts]
    #: The screen-flash colours the server commanded, in order (0..1 RGB). Empty
    #: when this session issued no active-flash challenge.
    flash_commanded: list[tuple[float, float, float]] = field(default_factory=list)
    #: SHA-256 per uploaded frame, keyed by frame key. Used to catch an injected
    #: or replayed stream that repeats the same bytes for more than one step.
    frame_hashes: dict[str, str] = field(default_factory=dict)


def flash_frame_keys(n: int) -> list[str]:
    return [f"flash_{i}" for i in range(n)]


@dataclass(slots=True)
class DecisionOutput:
    reasons: list[str] = field(default_factory=list)
    scores: dict[str, object] = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return not self.reasons


def required_frame_keys(issued_challenges: list[str]) -> list[str]:
    return [NEUTRAL_KEY, *issued_challenges]


def decide(data: DecisionInput, th: Thresholds) -> DecisionOutput:
    out = DecisionOutput()

    structural = _check_structure(data, th)
    if structural:
        out.reasons.extend(structural)
        return out

    facts = data.facts
    neutral = facts[NEUTRAL_KEY]

    out.scores["quality"] = {
        "sharpness": round(neutral.sharpness, 2),
        "brightness": round(neutral.brightness, 3),
        "faceRatio": round(neutral.face_ratio, 3),
    }
    out.reasons.extend(_check_quality(neutral, th))

    pad_min = min(f.pad for f in facts.values())
    out.scores["pad"] = round(pad_min, 4)
    if pad_min < th.pad_min:
        out.reasons.append("PAD_LOW")

    step_scores, pose_reasons = _check_pose_and_eyes(data, th)
    out.scores["steps"] = step_scores
    out.reasons.extend(pose_reasons)

    consistency = _min_pairwise_similarity(data)
    out.scores["identityConsistency"] = round(consistency, 4)
    if consistency < th.consistency_min:
        out.reasons.append("IDENTITY_INCONSISTENT")

    out.reasons.extend(_check_flash(data, th, out.scores))
    out.reasons.extend(_check_injection(data))
    out.reasons.extend(_check_attestation(data, th))

    return out


# ---------------------------------------------------------------------------


def _check_structure(data: DecisionInput, th: Thresholds) -> list[str]:
    """Cheap checks that make the rest meaningful. First failure wins."""
    steps = data.manifest.steps
    claimed = [s.name for s in steps]
    expected = ["center", *data.issued_challenges]
    if claimed != expected:
        return ["CHALLENGE_MISMATCH"]

    duration = data.manifest.finishedAt - data.manifest.startedAt
    if not (th.total_duration_min_ms <= duration <= th.total_duration_max_ms):
        return ["TIMING_IMPLAUSIBLE"]

    previous_end = -1
    for step in steps:
        if step.tEnd - step.tStart < th.step_duration_min_ms:
            return ["TIMING_IMPLAUSIBLE"]
        if step.tStart < previous_end:
            return ["TIMING_IMPLAUSIBLE"]
        previous_end = step.tEnd

    missing = [key for key in required_frame_keys(data.issued_challenges) if key not in data.facts]
    if missing:
        return ["FRAME_MISSING"]

    for facts in data.facts.values():
        if facts.face_count == 0 or facts.det_score < th.det_score_min:
            return ["NO_FACE"]
        if facts.face_count > 1:
            return ["MULTIPLE_FACES"]

    return []


def _check_quality(neutral: FrameFacts, th: Thresholds) -> list[str]:
    reasons: list[str] = []
    if neutral.sharpness < th.sharpness_min:
        reasons.append("QUALITY_SHARPNESS")
    if not (th.brightness_min <= neutral.brightness <= th.brightness_max):
        reasons.append("QUALITY_BRIGHTNESS")
    if neutral.face_ratio < th.face_ratio_min:
        reasons.append("QUALITY_FACE_TOO_SMALL")
    return reasons


def _check_pose_and_eyes(
    data: DecisionInput, th: Thresholds
) -> tuple[dict[str, object], list[str]]:
    reasons: list[str] = []
    scores: dict[str, object] = {}
    neutral = data.facts[NEUTRAL_KEY]

    frontal_ok = abs(neutral.yaw) <= th.neutral_yaw_max_deg
    scores[NEUTRAL_KEY] = {
        "yawDeg": round(neutral.yaw, 2),
        "pitchDeg": round(neutral.pitch, 2),
        "ear": round(neutral.eye_openness, 4),
        "ok": frontal_ok,
    }
    if not frontal_ok:
        reasons.append("POSE_NOT_FRONTAL")

    turn_deltas: dict[str, float] = {}
    for name in data.issued_challenges:
        facts = data.facts[name]
        if name in TURN_CHALLENGES:
            # Measured as a *change* from this person's own neutral frame.
            # Even with MediaPipe's transformation-matrix pose there is a
            # per-person resting offset — nobody holds their head at exactly
            # zero — and with the five-point fallback the offset is large
            # (equivalent to +/-13 deg on LFW, from facial asymmetry alone).
            # The difference cancels it either way.
            delta = facts.yaw - neutral.yaw
            turned_enough = abs(delta) >= th.turn_yaw_min_deg
            turn_deltas[name] = delta
            scores[name] = {
                "yawDeg": round(facts.yaw, 2),
                "yawDelta": round(delta, 2),
                "ok": turned_enough,
            }
            if not turned_enough:
                reasons.append("POSE_INSUFFICIENT_TURN")
        elif name == "closeEyes":
            ratio = _openness_ratio(facts.eye_openness, neutral.eye_openness)
            # Two independent reads. The ratio is robust to eye shape; the
            # absolute EAR floor catches the case where the neutral frame was
            # itself taken mid-blink, which would make any ratio look fine.
            closed = ratio <= th.eye_closed_ratio and facts.eye_openness <= th.ear_closed_max
            blink = max(
                facts.blendshapes.get("eyeBlinkLeft", 0.0),
                facts.blendshapes.get("eyeBlinkRight", 0.0),
            )
            scores[name] = {
                "ear": round(facts.eye_openness, 4),
                "neutralEar": round(neutral.eye_openness, 4),
                "ratio": round(ratio, 4),
                "blinkBlendshape": round(blink, 4),
                "ok": closed,
                "rule": th.eye_rule,
            }
            if not closed and th.eye_rule == "enforce":
                reasons.append("EYES_NOT_CLOSED")
        else:
            scores[name] = {"ok": True, "note": "not server-verifiable"}

    if len(turn_deltas) == 2:
        a, b = turn_deltas.values()
        if a * b >= 0:
            reasons.append("POSE_SAME_DIRECTION")

    return scores, reasons


def _check_injection(data: DecisionInput) -> list[str]:
    """Injection / replay tell: two steps that share the exact same bytes.

    A live capture never produces byte-identical frames for different steps
    (sensor noise alone differs), and the flash frames are different colours by
    construction. An injected static stream, or a replayed evidence bundle,
    repeats a frame — so a duplicate hash across distinct keys is a strong,
    zero-cost signal. Sophisticated per-frame-varying injection needs the
    active-flash correlation and device attestation to catch; this handles the
    common case for free.
    """
    seen: dict[str, str] = {}
    for key, digest in (data.frame_hashes or {}).items():
        if digest in seen:
            return ["FRAMES_DUPLICATE"]
        seen[digest] = key
    return []


def _check_attestation(data: DecisionInput, th: Thresholds) -> list[str]:
    """Require a device-integrity token when configured. Presence only for now.

    Verifying the token cryptographically (Play Integrity / App Attest) needs
    Google/Apple APIs and is the next step; even presence raises the bar against
    an attacker running the flow outside a genuine, unmodified app.
    """
    if not th.require_attestation:
        return []
    att = data.manifest.attestation
    if att is None or att.type == "none" or not att.token:
        return ["ATTESTATION_MISSING"]
    return []


def _check_flash(data: DecisionInput, th: Thresholds, scores: dict[str, object]) -> list[str]:
    """Active-flash liveness: did the face reflect the commanded screen flash?

    Skipped entirely when no flash plan was issued (``flash_commanded`` empty),
    so it never affects sessions that predate the feature. A real face tracks
    the random colour sequence; a photo, a replay of a different sequence, or an
    injected stream does not.
    """
    if not data.flash_commanded:
        return []
    keys = flash_frame_keys(len(data.flash_commanded))
    if any(k not in data.facts for k in keys):
        return ["FLASH_FRAME_MISSING"]
    observed = [data.facts[k].face_rgb for k in keys]
    score = flash_liveness_score(data.flash_commanded, observed)
    scores["flash"] = round(score, 4)
    return ["FLASH_SPOOF"] if score < th.flash_min else []


def _openness_ratio(closed: float, neutral: float) -> float:
    """Eye openness relative to the same person's own neutral frame.

    Relative rather than absolute, so it does not care about eye shape, camera
    distance or lens. A neutral frame with no measurable opening means we
    cannot judge, and we return a ratio that fails closed.
    """
    if neutral <= 1e-6:
        return 1.0
    return closed / neutral


def _min_pairwise_similarity(data: DecisionInput) -> float:
    """Lowest similarity between any two evidence frames.

    This is a *swap* detector: it catches passing liveness as one person and
    submitting another person's photo. It is not a match — a turned head
    legitimately scores well below two frontal shots — hence a loose threshold.
    """
    keys = required_frame_keys(data.issued_challenges)
    if len(keys) < 2:
        return 1.0
    return min(
        cosine(data.facts[a].embedding, data.facts[b].embedding) for a, b in combinations(keys, 2)
    )
