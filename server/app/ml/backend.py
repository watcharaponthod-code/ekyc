"""The ML seam.

Everything the decision engine needs from computer vision is behind this one
protocol. The real implementation loads four ONNX models; the fake one lets the
whole API and its test suite run with no model files at all.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

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
    #: 0..1 — MiniFASNet live probability.
    pad: float = 0.0
    #: -1..1 — 0 is frontal. See `geometry.yaw_proxy`.
    yaw_proxy: float = 0.0
    #: Height/width ratio of the eye contour; falls sharply when eyes close.
    eye_openness: float = 0.0
    sharpness: float = 0.0
    brightness: float = 0.0
    #: Face box width divided by frame width.
    face_ratio: float = 0.0
    embedding: np.ndarray = field(default_factory=lambda: np.zeros(512, dtype=np.float32))


class FaceBackend(Protocol):
    """Vision operations the verification pipeline depends on."""

    name: str

    def loaded_models(self) -> dict[str, bool]: ...

    def detect(self, image_bgr: np.ndarray) -> list[DetectedFace]: ...

    def embed(self, image_bgr: np.ndarray, kps: np.ndarray) -> np.ndarray: ...

    def pad_score(self, image_bgr: np.ndarray, bbox: np.ndarray) -> float: ...

    def eye_openness(self, image_bgr: np.ndarray, bbox: np.ndarray, kps: np.ndarray) -> float: ...


class FakeFaceBackend:
    """Scripted backend for tests.

    Give it a dict keyed by anything you like and drive `next_facts` from the
    test, or let it return a plausible default. It never touches ONNX, so the
    session, protocol and decision tests run in milliseconds.
    """

    name = "fake"

    def __init__(
        self,
        face_count: int = 1,
        pad: float = 0.95,
        yaw_proxy: float = 0.0,
        eye_openness: float = 0.35,
        embedding: np.ndarray | None = None,
    ) -> None:
        self.face_count = face_count
        self.pad = pad
        self.yaw_proxy = yaw_proxy
        self._eye_openness = eye_openness
        self._embedding = embedding if embedding is not None else _unit(np.ones(512, dtype=np.float32))

    def loaded_models(self) -> dict[str, bool]:
        return {"detector": True, "embedder": True, "landmarks": True, "pad": True}

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


def _unit(vector: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vector))
    return vector / norm if norm > 0 else vector
