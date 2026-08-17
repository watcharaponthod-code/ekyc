"""Wire format. Mirrors `packages/react-native-ekyc/src/types.ts`."""

from __future__ import annotations

import datetime as dt
from typing import Any, Literal

from pydantic import BaseModel, Field

Purpose = Literal["enroll", "verify", "identify"]
ChallengeName = Literal["center", "closeEyes", "turnLeft", "turnRight", "smile"]


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


class SessionPolicy(BaseModel):
    holdMs: int = 400
    perStepTimeoutMs: int = 12_000
    totalTimeoutMs: int = 60_000


class CreatedSession(BaseModel):
    sessionId: str
    nonce: str
    challenges: list[ChallengeName]
    expiresAt: dt.datetime
    policy: SessionPolicy


class ObservedSignal(BaseModel):
    yaw: float = 0.0
    pitch: float = 0.0
    roll: float = 0.0
    leftEye: float = 1.0
    rightEye: float = 1.0
    smile: float = 0.0


class StepObservation(BaseModel):
    name: ChallengeName
    tStart: int
    tEnd: int
    observed: ObservedSignal = Field(default_factory=ObservedSignal)


class CaptureInfo(BaseModel):
    frameWidth: int = 0
    frameHeight: int = 0
    fps: float = 0.0
    mirrored: bool = True


class Attestation(BaseModel):
    type: Literal["playIntegrity", "appAttest", "none"] = "none"
    token: str | None = None


class EvidenceManifest(BaseModel):
    nonce: str
    startedAt: int
    finishedAt: int
    steps: list[StepObservation]
    capture: CaptureInfo = Field(default_factory=CaptureInfo)
    attestation: Attestation | None = None


class MatchResult(BaseModel):
    ok: bool
    score: float


class DecisionResponse(BaseModel):
    decision: Literal["pass", "fail"]
    reasons: list[str] = Field(default_factory=list)
    scores: dict[str, Any] = Field(default_factory=dict)
    personId: str | None = None
    match: MatchResult | None = None


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
