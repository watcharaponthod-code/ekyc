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


@runtime_checkable
class FaceBackend(Protocol):
    """Vision operations the verification pipeline depends on."""

    name: str

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

    def __init__(
        self,
        face_count: int = 1,
        pad: float = 0.95,
        yaw: float = 0.0,
        eye_openness: float = 0.30,
        embedding: np.ndarray | None = None,
    ) -> None:
        self.face_count = face_count
        self.pad = pad
        self.yaw = yaw
        self._eye_openness = eye_openness
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


def _unit(vector: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vector))
    return vector / norm if norm > 0 else vector
