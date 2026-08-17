"""Turn uploaded frames into a decision.

Split in two on purpose:

* `measure` does all the vision work and produces plain numbers;
* `decision.decide` applies the rules to those numbers.

So the rules can be tested exhaustively without a model file, and the vision
code can be validated against real images without knowing anything about
sessions.
"""

from __future__ import annotations

import hashlib

import cv2
import numpy as np

from ..config import Thresholds
from ..decision import DecisionInput, DecisionOutput, decide, required_frame_keys
from ..ml.backend import FaceBackend, FrameFacts
from ..ml.geometry import brightness, face_ratio, sharpness, yaw_proxy
from ..schemas import EvidenceManifest

MIN_SHORT_SIDE = 240
MAX_FRAME_BYTES = 8 * 1024 * 1024

#: A second face only counts as "someone else in the shot" if it is at least
#: this fraction of the subject's width. Without it, a stranger thirty metres
#: behind you fails the session — which is both hostile and easy to trigger, as
#: any set of real photographs shows.
COMPANION_WIDTH_RATIO = 0.5


class FrameError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def decode_frame(raw: bytes) -> np.ndarray:
    if len(raw) > MAX_FRAME_BYTES:
        raise FrameError("FRAME_UNREADABLE")
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise FrameError("FRAME_UNREADABLE")
    if min(image.shape[:2]) < MIN_SHORT_SIDE:
        raise FrameError("FRAME_UNREADABLE")
    return image


def measure(backend: FaceBackend, key: str, image_bgr: np.ndarray) -> FrameFacts:
    """Everything the rules need from one frame."""
    faces = backend.detect(image_bgr)
    if not faces:
        return FrameFacts(key=key, face_count=0)

    face = max(faces, key=lambda f: f.width)
    companions = sum(1 for f in faces if f.width >= face.width * COMPANION_WIDTH_RATIO)
    return FrameFacts(
        key=key,
        face_count=companions,
        det_score=face.score,
        pad=backend.pad_score(image_bgr, face.bbox),
        yaw_proxy=yaw_proxy(face.kps),
        eye_openness=backend.eye_openness(image_bgr, face.bbox, face.kps),
        sharpness=sharpness(image_bgr, face.bbox),
        brightness=brightness(image_bgr, face.bbox),
        face_ratio=face_ratio(image_bgr, face.bbox),
        embedding=backend.embed(image_bgr, face.kps),
    )


def verify_evidence(
    backend: FaceBackend,
    issued_challenges: list[str],
    manifest: EvidenceManifest,
    frames: dict[str, bytes],
    thresholds: Thresholds,
) -> tuple[DecisionOutput, dict[str, FrameFacts], dict[str, str]]:
    """Decode, measure, decide. Returns the decision, the facts and frame hashes."""
    hashes = {key: hashlib.sha256(raw).hexdigest() for key, raw in frames.items()}

    facts: dict[str, FrameFacts] = {}
    for key in required_frame_keys(issued_challenges):
        raw = frames.get(key)
        if raw is None:
            continue
        try:
            image = decode_frame(raw)
        except FrameError as error:
            return DecisionOutput(reasons=[error.code]), facts, hashes
        facts[key] = measure(backend, key, image)

    output = decide(DecisionInput(issued_challenges, manifest, facts), thresholds)
    return output, facts, hashes
