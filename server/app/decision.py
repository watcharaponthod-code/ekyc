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
from .pulse import pulse_liveness_score
from .schemas import EvidenceManifest

#: Challenges every backend can re-verify from a still frame: pose from
#: landmarks, eye closure from the eye contours.
VERIFIABLE_CHALLENGES = ("closeEyes", "turnLeft", "turnRight")

#: Challenges verified from MediaPipe blendshapes (`jawOpen`, `mouthSmile*`).
#: Only issued when the backend reports `supports_expressions` — an
#: unverifiable challenge is theatre. `openMouth` is the rigid-mask
#: counter-measure: a 3-D print, resin or latex mask cannot open its jaw.
EXPRESSION_CHALLENGES = ("openMouth", "smile")

TURN_CHALLENGES = ("turnLeft", "turnRight")

NEUTRAL_KEY = "neutral"
PULSE_PREFIX = "pulse_"


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
    #: How many rPPG frames the server asked for (0 = no pulse burst issued).
    pulse_requested: int = 0
    #: One entry per usable pulse frame: (device time ms, [patch RGB...]).
    pulse_samples: list[tuple[int, list[tuple[float, float, float]]]] = field(default_factory=list)


def flash_frame_keys(n: int) -> list[str]:
    return [f"flash_{i}" for i in range(n)]


def pulse_frame_keys(n: int) -> list[str]:
    return [f"{PULSE_PREFIX}{i}" for i in range(n)]


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

    # PAD over the challenge frames only. Flash frames are lit by a saturated
    # colour and pulse anchors are the same face seconds later; neither is
    # what MiniFASNet was calibrated on, and one odd frame must not fail a
    # real person (the flash gate judges the flash frames).
    pad_min = min(facts[k].pad for k in required_frame_keys(data.issued_challenges))
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
    out.reasons.extend(_check_pulse(data, th, out.scores))
    out.reasons.extend(_check_planarity(data, th, out.scores))
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
        elif name == "openMouth":
            reasons.extend(_check_expression(
                scores, name, facts.mouth_open, neutral.mouth_open,
                th.mouth_open_min, th.mouth_open_delta_min, th.expression_rule, "MOUTH_NOT_OPEN",
            ))
        elif name == "smile":
            reasons.extend(_check_expression(
                scores, name, facts.smile, neutral.smile,
                th.smile_min, th.smile_delta_min, th.expression_rule, "SMILE_ABSENT",
            ))
        else:
            scores[name] = {"ok": True, "note": "not server-verifiable"}

    if len(turn_deltas) == 2:
        a, b = turn_deltas.values()
        if a * b >= 0:
            reasons.append("POSE_SAME_DIRECTION")

    return scores, reasons


def _check_expression(
    scores: dict[str, object],
    name: str,
    value: float,
    neutral_value: float,
    absolute_min: float,
    delta_min: float,
    rule: str,
    failure: str,
) -> list[str]:
    """Two-part expression rule: an absolute level on the challenge frame and a
    rise over the subject's own neutral frame. The absolute bound stops a
    permanently gaping mask from passing by "rising" from a neutral it also
    faked; the delta stops a naturally wide-mouthed neutral from clearing the
    absolute bar without doing anything. Unmeasured (-1) fails closed under
    `enforce` — the issuer must not have asked for it.
    """
    measured = value >= 0.0 and neutral_value >= 0.0
    delta = (value - neutral_value) if measured else 0.0
    ok = measured and value >= absolute_min and delta >= delta_min
    scores[name] = {
        "value": round(value, 4),
        "neutral": round(neutral_value, 4),
        "delta": round(delta, 4),
        "measured": measured,
        "ok": ok,
        "rule": rule,
    }
    if ok or rule != "enforce":
        return []
    return [failure if measured else "EXPRESSION_UNVERIFIABLE"]


def _check_pulse(data: DecisionInput, th: Thresholds, scores: dict[str, object]) -> list[str]:
    """rPPG: does the skin colour carry a heartbeat across the burst?

    Skipped when no burst was issued. A burst that came back too short is a
    protocol failure (`PULSE_FRAME_MISSING`) regardless of the rule; the
    liveness verdict itself (`PULSE_ABSENT`) is advisory or enforced per
    `pulse_rule`.
    """
    if data.pulse_requested <= 0:
        return []
    samples = data.pulse_samples
    span = (samples[-1][0] - samples[0][0]) if len(samples) > 1 else 0
    if len(samples) < th.pulse_min_frames or span < th.pulse_min_span_ms:
        scores["pulse"] = {"frames": len(samples), "spanMs": span, "ok": False, "note": "too_short"}
        return ["PULSE_FRAME_MISSING"]
    times = [t for t, _ in samples]
    width = min(len(c) for _, c in samples)
    colors = [c[:width] for _, c in samples]
    result = pulse_liveness_score(times, colors)
    ok = result.score >= th.pulse_min
    scores["pulse"] = {
        "score": round(result.score, 4),
        "bpm": round(result.bpm, 1),
        "prominenceDb": round(result.prominence_db, 2),
        "frames": result.frames,
        "spanMs": result.span_ms,
        "samplingHz": round(result.sampling_hz, 2),
        "patches": result.patches,
        "ok": ok,
        "rule": th.pulse_rule,
        **({"note": result.note} if result.note else {}),
    }
    if not ok and th.pulse_rule == "enforce":
        return ["PULSE_ABSENT"]
    return []


def _check_planarity(data: DecisionInput, th: Thresholds, scores: dict[str, object]) -> list[str]:
    """Flat-input depth cue on the neutral frame. Advisory unless configured to
    enforce; skipped entirely when the backend did not measure it (planarity<0).
    """
    p = data.facts[NEUTRAL_KEY].planarity
    if p < 0:
        return []
    scores["planarity"] = round(p, 5)
    if th.planarity_rule == "enforce" and p < th.planarity_min:
        return ["FLAT_FACE"]
    return []


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
    # Pulse anchor frames (first/last of the burst) are embedded too, so a
    # burst filmed off a different face — an accomplice with a heartbeat while
    # a mask did the steps — is caught as a swap.
    keys += sorted(k for k in data.facts if k.startswith(PULSE_PREFIX))
    if len(keys) < 2:
        return 1.0
    return min(
        cosine(data.facts[a].embedding, data.facts[b].embedding) for a, b in combinations(keys, 2)
    )
