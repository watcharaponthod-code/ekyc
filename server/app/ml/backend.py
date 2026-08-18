"""The ML seam.

Everything the decision engine needs from computer vision is behind this one
protocol. Two implementations exist:

* `DeepFaceMediaPipeBackend` — MediaPipe Face Landmarker for geometry, pose and
  eye openness; DeepFace for embedding and anti-spoofing. The default.
* `OnnxFaceBackend` — SCRFD + ArcFace + MiniFASNet loaded directly with
  onnxruntime. No TensorFlow, much lighter, kept for constrained deployments.

`FakeFaceBackend` lets the whole API and its test suite run with no model files
at all.

Pose is reported in **degrees** by every backend, so thresholds mean the same
thing regardless of which one is running.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

import numpy as np


@dataclass(slots=True)
class DetectedFace:
    #: x1, y1, x2, y2 in pixels.
    bbox: np.ndarray
    #: 5 landmarks (eye, eye, nose, mouth corner, mouth corner) in pixels.
    kps: np.ndarray
    score: float

    @property
    def width(self) -> float:
        return float(self.bbox[2] - self.bbox[0])


@dataclass(slots=True)
class FrameFacts:
    """Everything measured from one uploaded frame."""

    key: str
    face_count: int
    det_score: float = 0.0
    #: 0..1 — probability the face is live.
    pad: float = 0.0
    #: Head rotation in degrees. No absolute direction is asserted anywhere:
    #: the rules only ever compare against the subject's own neutral frame.
    yaw: float = 0.0
    pitch: float = 0.0
    roll: float = 0.0
    #: Eye-aspect-ratio where the backend can measure it (~0.30 open, ~0.10
    #: closed); otherwise a backend-specific openness proxy.
    eye_openness: float = 0.0
    sharpness: float = 0.0
    brightness: float = 0.0
    #: Face box width divided by frame width.
    face_ratio: float = 0.0
    embedding: np.ndarray = field(default_factory=lambda: np.zeros(512, dtype=np.float32))
    #: Optional second opinion from MediaPipe blendshapes.
    blendshapes: dict[str, float] = field(default_factory=dict)
    #: Mean face colour, 0..1 RGB — read by active-flash liveness only.
    face_rgb: tuple[float, float, float] = (0.0, 0.0, 0.0)
    #: Landmark non-planarity (depth cue); -1.0 when the backend cannot measure it.
    planarity: float = -1.0
    #: Mouth opening, 0..1 (MediaPipe `jawOpen` blendshape); -1.0 when the
    #: backend cannot measure expressions. Read by the `openMouth` challenge —
    #: the one thing a rigid mask cannot do.
    mouth_open: float = -1.0
    #: Smile, 0..1 (mean of `mouthSmileLeft/Right`); -1.0 when unmeasured.
    smile: float = -1.0
    #: Mean RGB (0..1) per skin patch (forehead, cheeks) — the rPPG signal
    #: source. One patch (face-box centre) when the backend has no landmarks.
    skin_patches: list[tuple[float, float, float]] = field(default_factory=list)


@runtime_checkable
class FaceBackend(Protocol):
    """Vision operations the verification pipeline depends on."""

    name: str
    #: True when the backend measures mouth opening and smile (`FrameFacts.
    #: mouth_open` / `.smile`). The session issuer only asks for expression
    #: challenges when the backend can verify them.
    supports_expressions: bool

    def loaded_models(self) -> dict[str, bool]: ...

    def detect(self, image_bgr: np.ndarray) -> list[DetectedFace]: ...

    def embed(self, image_bgr: np.ndarray, kps: np.ndarray) -> np.ndarray: ...

    def pad_score(self, image_bgr: np.ndarray, bbox: np.ndarray) -> float: ...

    def eye_openness(self, image_bgr: np.ndarray, bbox: np.ndarray, kps: np.ndarray) -> float: ...

    def pose(self, image_bgr: np.ndarray, kps: np.ndarray) -> tuple[float, float, float]:
        """Yaw, pitch, roll in degrees."""
        ...


class FakeFaceBackend:
    """Scripted backend for tests.

    Never touches MediaPipe, DeepFace or ONNX, so the session, protocol and
    decision tests run in milliseconds.
    """

    name = "fake"
    supports_expressions = True

    def __init__(
        self,
        face_count: int = 1,
        pad: float = 0.95,
        yaw: float = 0.0,
        eye_openness: float = 0.30,
        embedding: np.ndarray | None = None,
        mouth_open: float = 0.05,
        smile: float = 0.05,
    ) -> None:
        self.face_count = face_count
        self.pad = pad
        self.yaw = yaw
        self._eye_openness = eye_openness
        self.mouth_open = mouth_open
        self.smile = smile
        self._embedding = (
            embedding if embedding is not None else _unit(np.ones(512, dtype=np.float32))
        )

    def loaded_models(self) -> dict[str, bool]:
        return {"detector": True, "embedder": True, "pad": True}

    def detect(self, image_bgr: np.ndarray) -> list[DetectedFace]:
        h, w = image_bgr.shape[:2]
        box = np.array([w * 0.3, h * 0.25, w * 0.7, h * 0.75], dtype=np.float32)
        kps = np.array(
            [
                [w * 0.42, h * 0.42],
                [w * 0.58, h * 0.42],
                [w * 0.50, h * 0.52],
                [w * 0.44, h * 0.62],
                [w * 0.56, h * 0.62],
            ],
            dtype=np.float32,
        )
        return [DetectedFace(bbox=box, kps=kps, score=0.99)] * self.face_count

    def embed(self, image_bgr: np.ndarray, kps: np.ndarray) -> np.ndarray:
        return self._embedding

    def pad_score(self, image_bgr: np.ndarray, bbox: np.ndarray) -> float:
        return self.pad

    def eye_openness(self, image_bgr: np.ndarray, bbox: np.ndarray, kps: np.ndarray) -> float:
        return self._eye_openness

    def pose(self, image_bgr: np.ndarray, kps: np.ndarray) -> tuple[float, float, float]:
        return self.yaw, 0.0, 0.0

    def expressions(self, image_bgr: np.ndarray, bbox: np.ndarray) -> tuple[float, float]:
        """(mouth_open, smile) — scripted."""
        return self.mouth_open, self.smile


def _unit(vector: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vector))
    return vector / norm if norm > 0 else vector
