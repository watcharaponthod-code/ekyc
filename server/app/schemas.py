"""Wire format. Mirrors `packages/react-native-ekyc/src/types.ts`."""

from __future__ import annotations

import datetime as dt
import math
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, Field


def _finite(value: Any) -> float:
    """Coerce a device-reported number to a finite float.

    The phone's `observed`/`capture` values are advisory telemetry — the
    server re-measures pose, eyes and quality from the pixels regardless. But
    ML Kit occasionally yields NaN (an eye probability it could not compute, an
    Euler angle at an extreme), and JavaScript's `x ?? 0` does NOT catch NaN,
    so it reaches us as JSON `null`. Rejecting the whole submission over one
    advisory hint turned a good liveness run into a 422 on the device. Anything
    non-finite or missing becomes 0.
    """
    if value is None:
        return 0.0
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if math.isfinite(number) else 0.0


#: A float that tolerates the device sending null/NaN/Infinity.
Number = Annotated[float, BeforeValidator(_finite)]
#: An int that tolerates the same; rounded from the coerced float.
Count = Annotated[int, BeforeValidator(lambda v: int(_finite(v)))]

Purpose = Literal["enroll", "verify", "identify"]
ChallengeName = Literal["center", "closeEyes", "turnLeft", "turnRight", "smile", "openMouth", "nod", "moveCloser", "moveFarther"]


class ClientInfo(BaseModel):
    platform: str = ""
    osVersion: str = ""
    model: str = ""
    appVersion: str = ""


class CreateSessionRequest(BaseModel):
    purpose: Purpose
    personId: str | None = None
    displayName: str | None = None
    client: ClientInfo | None = None
    #: Risk tier. `reduced` issues a single challenge for step-up auth on an
    #: already-enrolled person; liveness still happens, it is just shorter.
    tier: Literal["full", "reduced"] = "full"
    #: Free-text tag for PAD evaluation runs (`bona_fide`, `mask_silicone`, ...).
    #: Stored with the session and written into the retained bundle so
    #: `scripts/pad_eval.py` can group sessions by presentation type. Has no
    #: effect on the decision.
    label: str | None = Field(default=None, max_length=64)


class SessionPolicy(BaseModel):
    holdMs: int = 400
    perStepTimeoutMs: int = 12_000
    totalTimeoutMs: int = 60_000
    #: The server's own pose thresholds, echoed to the phone so its predicates
    #: are derived from the rule that will judge the frames (client = rule +
    #: margin) instead of a second, drifting copy of the number.
    turnYawMinDeg: float | None = None
    neutralYawMaxDeg: float | None = None


class PulsePlan(BaseModel):
    """Capture `frames` stills of the still, lit face over about `durationMs`."""

    frames: int
    durationMs: int


class CreatedSession(BaseModel):
    sessionId: str
    nonce: str
    challenges: list[ChallengeName]
    #: Screen-flash colour names to show in order (empty when the feature is off).
    flash: list[str] = Field(default_factory=list)
    #: rPPG burst to capture after the steps (absent when the feature is off).
    pulse: PulsePlan | None = None
    expiresAt: dt.datetime
    policy: SessionPolicy


class ObservedSignal(BaseModel):
    yaw: Number = 0.0
    pitch: Number = 0.0
    roll: Number = 0.0
    leftEye: Number = 1.0
    rightEye: Number = 1.0
    smile: Number = 0.0
    mouthOpen: Number = 0.0


class StepObservation(BaseModel):
    name: ChallengeName
    # Advisory timing. Default 0 so a device that omits or nulls them yields a
    # graceful decision (the server re-derives what it needs) rather than a 422
    # the user reads as "verification failed" with no reason.
    tStart: Count = 0
    tEnd: Count = 0
    observed: ObservedSignal = Field(default_factory=ObservedSignal)


class CaptureInfo(BaseModel):
    frameWidth: Count = 0
    frameHeight: Count = 0
    fps: Number = 0.0
    mirrored: bool = True


class Attestation(BaseModel):
    type: Literal["playIntegrity", "appAttest", "none"] = "none"
    token: str | None = None


class PulseCapture(BaseModel):
    """Device timestamps (ms) of `pulse_0..pulse_{n-1}`, in key order."""

    times: list[Count] = Field(default_factory=list)


class EvidenceManifest(BaseModel):
    nonce: str
    startedAt: Count = 0
    finishedAt: Count = 0
    steps: list[StepObservation] = Field(default_factory=list)
    capture: CaptureInfo = Field(default_factory=CaptureInfo)
    attestation: Attestation | None = None
    pulse: PulseCapture | None = None


class MatchResult(BaseModel):
    ok: bool
    score: float


class DecisionResponse(BaseModel):
    decision: Literal["pass", "fail"]
    reasons: list[str] = Field(default_factory=list)
    scores: dict[str, Any] = Field(default_factory=dict)
    personId: str | None = None
    #: The matched/enrolled person's display name, so the phone can say who.
    displayName: str | None = None
    match: MatchResult | None = None
    #: Server-side wall time for the whole submit, ms — the tuning number for "it is slow".
    serverMs: int | None = None


class PersonOut(BaseModel):
    id: str
    displayName: str | None
    templateCount: int
    createdAt: dt.datetime


class HealthOut(BaseModel):
    status: str
    version: str
    backend: str
    models: dict[str, bool]
