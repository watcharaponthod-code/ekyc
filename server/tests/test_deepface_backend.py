"""MediaPipe + DeepFace on real faces.

Skipped unless `face_landmarker.task` is present and LFW is cached, so the
default suite stays fast and dependency-free.

    py -3.12 -m pytest tests/test_deepface_backend.py -m models -v
"""

from __future__ import annotations

import itertools
from pathlib import Path

import numpy as np
import pytest

from app.config import Thresholds
from app.ml.geometry import cosine
from app.ml.mediapipe_landmarks import (
    LEFT_EYE_EAR,
    RIGHT_EYE_EAR,
    eye_aspect_ratio,
    pose_from_matrix,
)

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"

pytestmark = pytest.mark.models


@pytest.fixture(scope="module")
def backend():
    if not (MODELS_DIR / "face_landmarker.task").is_file():
        pytest.skip("MediaPipe model not fetched; run scripts/fetch_models.py")
    pytest.importorskip("mediapipe")
    pytest.importorskip("deepface")
    from app.ml.deepface_backend import DeepFaceMediaPipeBackend

    return DeepFaceMediaPipeBackend(MODELS_DIR)


@pytest.fixture(scope="module")
def people():
    """Three photographs each of a handful of real people."""
    cv2 = pytest.importorskip("cv2")
    datasets = pytest.importorskip("sklearn.datasets")
    try:
        data = datasets.fetch_lfw_people(
            min_faces_per_person=20, resize=1.0, color=True, slice_=None, download_if_missing=False
        )
    except Exception:  # noqa: BLE001
        pytest.skip("LFW not cached locally")

    images = (data.images * 255).astype(np.uint8)
    grouped: dict[int, list[np.ndarray]] = {}
    for image, target in zip(images, data.target, strict=False):
        bucket = grouped.setdefault(int(target), [])
        if len(bucket) < 3:
            bucket.append(cv2.cvtColor(image, cv2.COLOR_RGB2BGR))
    return {k: v for k, v in list(grouped.items())[:8] if len(v) == 3}


@pytest.fixture(scope="module")
def analyzed(backend, people):
    """One MediaPipe pass per image, reused across tests — it is the slow part."""
    out = {}
    for person, images in people.items():
        faces = []
        for image in images:
            found = backend.analyze(image)
            if found:
                faces.append((image, max(found, key=lambda f: f.width)))
        out[person] = faces
    return out


class TestPureGeometry:
    def test_ear_indices_are_six_points_per_eye(self):
        assert len(RIGHT_EYE_EAR) == len(LEFT_EYE_EAR) == 6
        assert not set(RIGHT_EYE_EAR) & set(LEFT_EYE_EAR)

    def test_ear_collapses_when_the_lids_meet(self):
        """A synthetic eye, flattened: the ratio must fall, not just wobble."""
        points = np.zeros((478, 2), dtype=np.float32)
        for indices, x0 in ((RIGHT_EYE_EAR, 0.0), (LEFT_EYE_EAR, 100.0)):
            outer, u1, u2, inner, l2, l1 = indices
            points[outer] = (x0, 10.0)
            points[inner] = (x0 + 30.0, 10.0)
            points[u1] = (x0 + 10.0, 4.0)
            points[u2] = (x0 + 20.0, 4.0)
            points[l1] = (x0 + 10.0, 16.0)
            points[l2] = (x0 + 20.0, 16.0)
        open_ear = eye_aspect_ratio(points)

        for indices in (RIGHT_EYE_EAR, LEFT_EYE_EAR):
            for index in indices:
                points[index][1] = 10.0
        assert eye_aspect_ratio(points) < open_ear * 0.2
        assert 0.2 < open_ear < 0.6

    def test_pose_decomposition_recovers_a_known_rotation(self):
        angle = np.deg2rad(30.0)
        matrix = np.eye(4)
        matrix[:3, :3] = np.array(
            [
                [np.cos(angle), 0.0, np.sin(angle)],
                [0.0, 1.0, 0.0],
                [-np.sin(angle), 0.0, np.cos(angle)],
            ]
        )
        yaw, pitch, roll = pose_from_matrix(matrix)
        assert yaw == pytest.approx(30.0, abs=0.5)
        assert pitch == pytest.approx(0.0, abs=0.5)
        assert roll == pytest.approx(0.0, abs=0.5)

    def test_pose_decomposition_survives_gimbal_lock(self):
        matrix = np.eye(4)
        matrix[:3, :3] = np.array([[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]])
        yaw, pitch, roll = pose_from_matrix(matrix)
        assert all(np.isfinite(v) for v in (yaw, pitch, roll))


class TestDetection:
    def test_it_finds_every_face(self, analyzed, people):
        found = sum(len(v) for v in analyzed.values())
        expected = sum(len(v) for v in people.values())
        assert found == expected

    def test_it_returns_the_arcface_five_points_in_order(self, analyzed):
        _, face = next(iter(analyzed.values()))[0]
        assert face.kps.shape == (5, 2)
        eyes_y = face.kps[:2, 1].mean()
        mouth_y = face.kps[3:, 1].mean()
        assert eyes_y < face.kps[2, 1] < mouth_y

    def test_it_returns_the_full_mesh(self, analyzed):
        _, face = next(iter(analyzed.values()))[0]
        assert face.landmarks.shape[0] >= 468

    def test_the_box_encloses_the_landmarks(self, analyzed):
        _, face = next(iter(analyzed.values()))[0]
        assert face.landmarks[:, 0].min() >= face.bbox[0] - 1
        assert face.landmarks[:, 0].max() <= face.bbox[2] + 1


class TestPose:
    def test_frontal_photographs_read_as_roughly_frontal(self, analyzed):
        yaws = [abs(face.yaw) for faces in analyzed.values() for _, face in faces]
        limit = Thresholds().neutral_yaw_max_deg
        assert np.median(yaws) < limit
        assert float(np.mean([y <= limit for y in yaws])) > 0.7

    def test_pose_is_reported_in_degrees_not_radians(self, analyzed):
        values = [abs(face.yaw) for faces in analyzed.values() for _, face in faces]
        assert max(values) > 3.2, "radians would never exceed pi"
        assert max(values) < 180.0


class TestEyes:
    def test_open_eyes_land_in_the_textbook_ear_range(self, analyzed):
        ears = [face.ear for faces in analyzed.values() for _, face in faces]
        assert 0.20 < np.median(ears) < 0.45

    def test_the_closed_threshold_sits_below_the_open_eye_distribution(self, analyzed):
        """The rule is only safe to enforce if open eyes clear the floor.

        Eye shape varies a lot between people, so this is checked against a
        low percentile rather than the median.
        """
        ears = np.array([face.ear for faces in analyzed.values() for _, face in faces])
        limit = Thresholds().ear_closed_max
        assert float(np.percentile(ears, 10)) > limit


class TestBlendshapes:
    def test_blink_and_smile_are_reported(self, analyzed):
        _, face = next(iter(analyzed.values()))[0]
        assert {"eyeBlinkLeft", "eyeBlinkRight"} <= set(face.blendshapes)
        assert all(0.0 <= v <= 1.0 for v in face.blendshapes.values())

    def test_blendshape_blink_agrees_with_the_geometry(self, analyzed):
        """Two independent measures of the same thing should not disagree."""
        pairs = [
            (face.ear, max(face.blendshapes.get("eyeBlinkLeft", 0.0), face.blendshapes.get("eyeBlinkRight", 0.0)))
            for faces in analyzed.values()
            for _, face in faces
        ]
        ears = np.array([p[0] for p in pairs])
        blinks = np.array([p[1] for p in pairs])
        if ears.std() < 1e-6:
            pytest.skip("no eye-openness variation in this sample")
        assert np.corrcoef(ears, blinks)[0, 1] < 0.0


class TestRecognition:
    def test_embeddings_are_unit_length(self, backend, analyzed):
        image, face = next(iter(analyzed.values()))[0]
        vector = backend.embed(image, face.kps)
        assert vector.shape == (512,)
        assert np.linalg.norm(vector) == pytest.approx(1.0, abs=1e-4)

    def test_the_same_face_embeds_identically(self, backend, analyzed):
        image, face = next(iter(analyzed.values()))[0]
        assert cosine(backend.embed(image, face.kps), backend.embed(image, face.kps)) == pytest.approx(
            1.0, abs=1e-5
        )

    def test_it_separates_people(self, backend, analyzed):
        vectors = {
            person: [backend.embed(image, face.kps) for image, face in faces]
            for person, faces in analyzed.items()
        }
        same = [
            cosine(v[i], v[j]) for v in vectors.values() for i in range(len(v)) for j in range(i + 1, len(v))
        ]
        different = [
            cosine(a, b)
            for p, q in itertools.combinations(vectors, 2)
            for a in vectors[p]
            for b in vectors[q]
        ]
        threshold = Thresholds().match_min
        assert np.median(same) > threshold
        assert np.median(different) < threshold / 2
        assert np.percentile(different, 95) < threshold


class TestAntiSpoofing:
    def test_it_returns_a_probability(self, backend, analyzed):
        image, face = next(iter(analyzed.values()))[0]
        score = backend.pad_score(image, face.bbox)
        assert 0.0 <= score <= 1.0

    def test_a_degenerate_box_fails_closed(self, backend, analyzed):
        """An unusable input must score as spoof, never as live."""
        image, _ = next(iter(analyzed.values()))[0]
        assert backend.pad_score(image, np.array([0.0, 0.0, 0.0, 0.0])) <= Thresholds().pad_min

    def test_it_uses_the_full_frame_not_a_crop(self, backend, analyzed):
        """Pinning the fix: cropping first destroys the border context the
        model reads, and screen replays start passing."""
        import inspect

        source = inspect.getsource(type(backend).pad_score)
        assert "image_bgr" in source
        assert "crop_bbox" not in source


class TestBackendContract:
    def test_it_satisfies_the_protocol_the_pipeline_depends_on(self, backend):
        from app.ml.backend import FaceBackend

        assert isinstance(backend, FaceBackend)

    def test_it_reports_which_models_are_loaded(self, backend):
        loaded = backend.loaded_models()
        assert loaded["mediapipe_landmarker"] is True
        assert set(loaded) >= {"mediapipe_landmarker", "deepface_embedder", "deepface_antispoof"}

    def test_measure_takes_the_single_pass_route(self, backend, people):
        """A three-pass measure would triple the cost of every frame."""
        from app.services.verification import measure

        image = next(iter(people.values()))[0]
        facts = measure(backend, "neutral", image)
        assert facts.face_count == 1
        assert facts.embedding.shape == (512,)
        assert facts.eye_openness > 0
        assert facts.blendshapes
