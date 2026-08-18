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
import logging

import cv2
import numpy as np

from ..config import Thresholds
from ..decision import DecisionInput, DecisionOutput, decide, flash_frame_keys, required_frame_keys
from ..logging_config import timed
from ..ml.backend import FaceBackend, FrameFacts
from ..ml.geometry import brightness, face_ratio, mean_face_color, sharpness
from ..schemas import EvidenceManifest

log = logging.getLogger("ekyc.verification")

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
    """Everything the rules need from one frame.

    When the backend can produce geometry, pose and eye openness in a single
    pass — MediaPipe can — that path is taken, because running the landmarker
    once per frame instead of three times is the difference between a snappy
    check and a slow one.
    """
    analyze = getattr(backend, "analyze", None)
    if callable(analyze):
        return _measure_single_pass(backend, analyze, key, image_bgr)

    faces = backend.detect(image_bgr)
    if not faces:
        return FrameFacts(key=key, face_count=0)

    face = max(faces, key=lambda f: f.width)
    companions = sum(1 for f in faces if f.width >= face.width * COMPANION_WIDTH_RATIO)
    yaw, pitch, roll = backend.pose(image_bgr, face.kps)

    return FrameFacts(
        key=key,
        face_count=companions,
        det_score=face.score,
        pad=backend.pad_score(image_bgr, face.bbox),
        yaw=yaw,
        pitch=pitch,
        roll=roll,
        eye_openness=backend.eye_openness(image_bgr, face.bbox, face.kps),
        sharpness=sharpness(image_bgr, face.bbox),
        brightness=brightness(image_bgr, face.bbox),
        face_ratio=face_ratio(image_bgr, face.bbox),
        embedding=backend.embed(image_bgr, face.kps),
        face_rgb=mean_face_color(image_bgr, face.bbox),
    )


def _measure_single_pass(backend: FaceBackend, analyze, key: str, image_bgr: np.ndarray) -> FrameFacts:
    with timed("measure.analyze", frame=key) as span:
        faces = analyze(image_bgr)
        span["faces"] = len(faces)

    if not faces:
        return FrameFacts(key=key, face_count=0)

    face = max(faces, key=lambda f: f.width)
    companions = sum(1 for f in faces if f.width >= face.width * COMPANION_WIDTH_RATIO)

    with timed("measure.pad", frame=key) as span:
        pad = backend.pad_score(image_bgr, face.bbox)
        span["pad"] = round(pad, 4)

    with timed("measure.embed", frame=key):
        embedding = backend.embed(image_bgr, face.kps)

    facts = FrameFacts(
        key=key,
        face_count=companions,
        det_score=face.score,
        pad=pad,
        yaw=face.yaw,
        pitch=face.pitch,
        roll=face.roll,
        eye_openness=face.ear,
        sharpness=sharpness(image_bgr, face.bbox),
        brightness=brightness(image_bgr, face.bbox),
        face_ratio=face_ratio(image_bgr, face.bbox),
        embedding=embedding,
        blendshapes=dict(face.blendshapes),
        face_rgb=mean_face_color(image_bgr, face.bbox),
    )
    log.debug(
        "frame measured",
        extra={
            "context": {
                "frame": key,
                "faces": companions,
                "yaw": round(facts.yaw, 1),
                "pitch": round(facts.pitch, 1),
                "ear": round(facts.eye_openness, 3),
                "pad": round(facts.pad, 3),
                "sharpness": round(facts.sharpness, 1),
            }
        },
    )
    return facts


def verify_evidence(
    backend: FaceBackend,
    issued_challenges: list[str],
    manifest: EvidenceManifest,
    frames: dict[str, bytes],
    thresholds: Thresholds,
    flash_commanded: list[tuple[float, float, float]] | None = None,
) -> tuple[DecisionOutput, dict[str, FrameFacts], dict[str, str]]:
    """Decode, measure, decide. Returns the decision, the facts and frame hashes."""
    hashes = {key: hashlib.sha256(raw).hexdigest() for key, raw in frames.items()}
    flash_commanded = flash_commanded or []

    facts: dict[str, FrameFacts] = {}
    for key in [*required_frame_keys(issued_challenges), *flash_frame_keys(len(flash_commanded))]:
        raw = frames.get(key)
        if raw is None:
            continue
        try:
            image = decode_frame(raw)
        except FrameError as error:
            log.warning("frame rejected", extra={"context": {"frame": key, "reason": error.code}})
            return DecisionOutput(reasons=[error.code]), facts, hashes
        facts[key] = measure(backend, key, image)

    with timed("decide", frames=len(facts)) as span:
        output = decide(
            DecisionInput(issued_challenges, manifest, facts, flash_commanded, hashes),
            thresholds,
        )
        span["decision"] = "pass" if output.passed else "fail"
        span["reasons"] = ",".join(output.reasons) or "-"

    return output, facts, hashes
