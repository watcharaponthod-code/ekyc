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
from ..decision import (
    DecisionInput,
    DecisionOutput,
    decide,
    flash_frame_keys,
    pulse_frame_keys,
    required_frame_keys,
)
from ..logging_config import timed
from ..ml.backend import FaceBackend, FrameFacts
from ..ml.geometry import brightness, face_ratio, mean_face_color, sharpness, skin_patch_colors
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
    mouth_open, smile = _expressions(backend, image_bgr, face.bbox)

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
        mouth_open=mouth_open,
        smile=smile,
        skin_patches=skin_patch_colors(image_bgr, None, face.bbox),
    )


def _expressions(backend: FaceBackend, image_bgr: np.ndarray, bbox: np.ndarray) -> tuple[float, float]:
    """(mouth_open, smile) from a backend that measures them; (-1, -1) otherwise."""
    fn = getattr(backend, "expressions", None)
    if not callable(fn):
        return -1.0, -1.0
    mouth_open, smile = fn(image_bgr, bbox)
    return float(mouth_open), float(smile)


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

    from ..ml.deepface_backend import expressions_from_blendshapes

    mouth_open, smile = expressions_from_blendshapes(dict(face.blendshapes))
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
        planarity=getattr(face, "planarity", -1.0),
        mouth_open=mouth_open,
        smile=smile,
        skin_patches=skin_patch_colors(image_bgr, getattr(face, "landmarks", None), face.bbox),
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


def measure_skin(backend: FaceBackend, image_bgr: np.ndarray) -> list[tuple[float, float, float]] | None:
    """The cheap per-frame measurement for the rPPG burst: find the face and
    average its skin patches. No PAD, no embedding — a burst is dozens of
    frames and the pulse only needs colour. ``None`` when no face was found.
    """
    analyze = getattr(backend, "analyze", None)
    if callable(analyze):
        faces = analyze(image_bgr)
        if not faces:
            return None
        face = max(faces, key=lambda f: f.width)
        return skin_patch_colors(image_bgr, getattr(face, "landmarks", None), face.bbox)
    faces = backend.detect(image_bgr)
    if not faces:
        return None
    face = max(faces, key=lambda f: f.width)
    return skin_patch_colors(image_bgr, None, face.bbox)


def verify_evidence(
    backend: FaceBackend,
    issued_challenges: list[str],
    manifest: EvidenceManifest,
    frames: dict[str, bytes],
    thresholds: Thresholds,
    flash_commanded: list[tuple[float, float, float]] | None = None,
    pulse_requested: int = 0,
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

    pulse_samples: list[tuple[int, list[tuple[float, float, float]]]] = []
    if pulse_requested > 0:
        pulse_samples = _measure_pulse_burst(backend, manifest, frames, pulse_requested, facts)

    with timed("decide", frames=len(facts)) as span:
        output = decide(
            DecisionInput(
                issued_challenges, manifest, facts, flash_commanded, hashes,
                pulse_requested=pulse_requested, pulse_samples=pulse_samples,
            ),
            thresholds,
        )
        span["decision"] = "pass" if output.passed else "fail"
        span["reasons"] = ",".join(output.reasons) or "-"

    return output, facts, hashes


def _measure_pulse_burst(
    backend: FaceBackend,
    manifest: EvidenceManifest,
    frames: dict[str, bytes],
    pulse_requested: int,
    facts: dict[str, FrameFacts],
) -> list[tuple[int, list[tuple[float, float, float]]]]:
    """Skin colour per pulse frame, paired with the device timestamp from the
    manifest. Frames that fail to decode or show no face are skipped (the
    decision counts what is left). The first and last usable frames also get a
    full measurement so their embeddings join the identity-consistency check.
    """
    times = list(manifest.pulse.times) if manifest.pulse else []
    keys = pulse_frame_keys(pulse_requested)
    usable: list[tuple[str, int, np.ndarray]] = []
    with timed("measure.pulse", frames=len(keys)) as span:
        for index, key in enumerate(keys):
            raw = frames.get(key)
            if raw is None or index >= len(times):
                continue
            try:
                image = decode_frame(raw)
            except FrameError:
                continue
            usable.append((key, int(times[index]), image))
        samples: list[tuple[int, list[tuple[float, float, float]]]] = []
        with_face: list[tuple[str, np.ndarray]] = []
        for key, t, image in usable:
            colors = measure_skin(backend, image)
            if colors:
                samples.append((t, colors))
                with_face.append((key, image))
        span["usable"] = len(samples)
    anchors = (with_face[0], with_face[-1]) if len(with_face) > 1 else with_face[:1]
    for key, image in anchors:
        facts[key] = measure(backend, key, image)
    return samples
