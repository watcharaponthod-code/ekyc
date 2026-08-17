"""Real ONNX models on real images.

Skipped automatically when the model files are absent (`fetch_models.py`) or
when the LFW fixture set has not been cached by scikit-learn, so the default
`pytest` run stays fast and dependency-free.

    py -3.12 -m pytest tests/test_ml_integration.py -v
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from app.ml.align import ARCFACE_DST, ARCFACE_SIZE, estimate_norm, norm_crop, umeyama
from app.ml.geometry import cosine, minifasnet_crop, yaw_proxy

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
REQUIRED = ("det_10g.onnx", "w600k_r50.onnx")

#: What `EKYC_NEUTRAL_YAW_MAX_DEG` should be set to when running the onnx
#: backend, to absorb the five-point proxy's per-person bias.
ONNX_NEUTRAL_YAW_MAX_DEG = 45.0

pytestmark = pytest.mark.models


@pytest.fixture(scope="module")
def backend():
    if not all((MODELS_DIR / name).is_file() for name in REQUIRED):
        pytest.skip("ONNX models not fetched; run scripts/fetch_models.py")
    from app.ml.onnx_backend import OnnxFaceBackend

    return OnnxFaceBackend(MODELS_DIR)


@pytest.fixture(scope="module")
def faces():
    """A few real faces per person, from LFW. Cached by scikit-learn."""
    cv2 = pytest.importorskip("cv2")
    sklearn_datasets = pytest.importorskip("sklearn.datasets")
    try:
        data = sklearn_datasets.fetch_lfw_people(
            min_faces_per_person=20, resize=1.0, color=True, slice_=None, download_if_missing=False
        )
    except Exception:  # noqa: BLE001 — any fetch failure means "not available here"
        pytest.skip("LFW not cached locally")

    images = (data.images * 255).astype(np.uint8)
    by_person: dict[int, list[np.ndarray]] = {}
    for image, target in zip(images, data.target, strict=False):
        bucket = by_person.setdefault(int(target), [])
        if len(bucket) < 3:
            bucket.append(cv2.cvtColor(image, cv2.COLOR_RGB2BGR))
    return {k: v for k, v in list(by_person.items())[:10] if len(v) == 3}


class TestAlignment:
    def test_umeyama_recovers_a_known_similarity_transform(self):
        source = np.array([[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 1.0], [0.5, 0.5]])
        angle = np.deg2rad(30)
        rotation = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
        target = (source @ rotation.T) * 3.0 + np.array([7.0, -2.0])

        matrix = umeyama(source, target)
        recovered = source @ matrix[:2, :2].T + matrix[:2, 2]
        assert np.allclose(recovered, target, atol=1e-6)

    def test_alignment_puts_the_landmarks_on_the_canonical_template(self):
        kps = ARCFACE_DST * 2.0 + np.array([13.0, 7.0])
        matrix = estimate_norm(kps.astype(np.float32))
        mapped = kps @ matrix[:, :2].T + matrix[:, 2]
        assert np.allclose(mapped, ARCFACE_DST, atol=1e-3)


class TestDetection:
    def test_it_finds_a_face_in_every_reference_image(self, backend, faces):
        total = misses = 0
        for images in faces.values():
            for image in images:
                total += 1
                if not backend.detect(image):
                    misses += 1
        assert total > 0
        assert misses == 0, f"{misses}/{total} detection misses"

    def test_the_landmarks_are_anatomically_ordered(self, backend, faces):
        image = next(iter(faces.values()))[0]
        face = max(backend.detect(image), key=lambda f: f.width)
        eyes_y = face.kps[:2, 1].mean()
        mouth_y = face.kps[3:, 1].mean()
        assert eyes_y < face.kps[2, 1] < mouth_y, "expected eyes above nose above mouth"

    def test_the_raw_yaw_proxy_carries_a_per_person_bias(self, backend, faces):  # noqa: D401
        """The reason turns are judged as a *delta*, pinned as a test.

        On frontal reference photos the raw proxy is nowhere near zero — facial
        asymmetry and landmark placement push it around. If this ever stops
        being true the relative rule is over-engineering; while it holds, an
        absolute pose threshold would be wrong.
        """
        values = []
        for images in faces.values():
            for image in images:
                detected = backend.detect(image)
                if detected:
                    values.append(abs(yaw_proxy(max(detected, key=lambda f: f.width).kps)))

        assert np.median(values) > 0.05, "bias vanished; revisit the relative pose rule"
        assert np.median(values) < 0.45, "frontal faces must still pass NEUTRAL_YAW_MAX"

    def test_the_five_point_proxy_needs_a_looser_gate_than_the_default(self, backend, faces):
        """Measured, and the reason this backend is the secondary one.

        Converting the five-point proxy to degrees does not make it as good as
        a real pose estimate: it still carries roughly +/-13 deg of per-person
        bias from facial asymmetry. Against the shared 25 deg gate — which is
        sized for MediaPipe's transformation-matrix pose — only about two
        thirds of unconstrained frontal press photos pass. Deployments running
        `EKYC_BACKEND=onnx` must raise `EKYC_NEUTRAL_YAW_MAX_DEG` accordingly.
        """
        from app.config import Thresholds
        from app.ml.geometry import yaw_degrees

        shared_limit = Thresholds().neutral_yaw_max_deg
        values = []
        for images in faces.values():
            for image in images:
                detected = backend.detect(image)
                if detected:
                    values.append(abs(yaw_degrees(max(detected, key=lambda f: f.width).kps)))

        at_shared = float(np.mean([v <= shared_limit for v in values]))
        at_loose = float(np.mean([v <= ONNX_NEUTRAL_YAW_MAX_DEG for v in values]))

        # Measured over 20 subjects: median 15.9 deg, p90 38.6, max 67.1 —
        # for photographs that are all nominally frontal. Asserting the shape
        # of that finding rather than a precise rate, which 30 images cannot
        # support.
        assert at_shared < 0.9, "proxy bias vanished; the looser gate is no longer needed"
        assert at_loose >= 0.80, (
            f"only {at_loose:.0%} pass even at {ONNX_NEUTRAL_YAW_MAX_DEG} deg — "
            "the recommended onnx gate is too tight"
        )
        assert at_loose - at_shared > 0.10, "the looser gate should admit materially more"

    def test_both_backends_report_pose_in_the_same_units(self, backend, faces):
        """A shared threshold is only meaningful if the units agree."""
        image = next(iter(faces.values()))[0]
        face = max(backend.detect(image), key=lambda f: f.width)
        yaw, pitch, roll = backend.pose(image, face.kps)
        assert -180.0 <= yaw <= 180.0
        assert -180.0 <= roll <= 180.0
        assert pitch == 0.0, "the five-point backend does not estimate pitch"


class TestRecognition:
    def test_embeddings_are_unit_length(self, backend, faces):
        image = next(iter(faces.values()))[0]
        face = max(backend.detect(image), key=lambda f: f.width)
        vector = backend.embed(image, face.kps)
        assert vector.shape == (512,)
        assert np.linalg.norm(vector) == pytest.approx(1.0, abs=1e-4)

    def test_it_separates_people(self, backend, faces):
        from app.config import Thresholds

        embeddings = {}
        for person, images in faces.items():
            vectors = []
            for image in images:
                detected = backend.detect(image)
                if detected:
                    vectors.append(backend.embed(image, max(detected, key=lambda f: f.width).kps))
            embeddings[person] = vectors

        same = [
            cosine(vectors[i], vectors[j])
            for vectors in embeddings.values()
            for i in range(len(vectors))
            for j in range(i + 1, len(vectors))
        ]
        different = [
            cosine(a, b)
            for pa, va in embeddings.items()
            for pb, vb in embeddings.items()
            if pa < pb
            for a in va
            for b in vb
        ]

        threshold = Thresholds().match_min
        assert np.median(same) > threshold + 0.15, "genuine pairs must clear the threshold comfortably"
        assert np.percentile(different, 99) < threshold, "impostor pairs must stay below it"

    def test_the_same_image_embeds_identically(self, backend, faces):
        image = next(iter(faces.values()))[0]
        face = max(backend.detect(image), key=lambda f: f.width)
        first = backend.embed(image, face.kps)
        second = backend.embed(image, face.kps)
        assert cosine(first, second) == pytest.approx(1.0, abs=1e-5)


class TestPad:
    def test_it_returns_a_probability(self, backend, faces):
        image = next(iter(faces.values()))[0]
        face = max(backend.detect(image), key=lambda f: f.width)
        score = backend.pad_score(image, face.bbox)
        assert 0.0 <= score <= 1.0

    def test_the_crop_never_leaves_the_image(self, faces):
        """The clamping is the whole reason the detector works; guard it."""
        image = next(iter(faces.values()))[0]
        height, width = image.shape[:2]
        bbox = np.array([width - 20, height - 20, width + 200, height + 200], dtype=np.float32)
        patch = minifasnet_crop(image, bbox, 2.7, 80)
        assert patch is not None
        assert patch.shape == (80, 80, 3)

    def test_a_degenerate_box_is_rejected_rather_than_guessed(self, faces):
        image = next(iter(faces.values()))[0]
        assert minifasnet_crop(image, np.array([5.0, 5.0, 5.0, 5.0]), 2.7, 80) is None


class TestEyeWindows:
    def test_the_eye_windows_land_on_actual_eyes(self, backend, faces):
        """Higher local contrast at the eyes than on the cheek, on real faces.

        This is the check that the canonical window coordinates are right —
        if alignment or the constants drift, this fails.
        """
        import cv2

        eye_contrast, cheek_contrast = [], []
        for images in faces.values():
            for image in images:
                detected = backend.detect(image)
                if not detected:
                    continue
                face = max(detected, key=lambda f: f.width)
                aligned = norm_crop(image, face.kps, ARCFACE_SIZE)
                gray = cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY).astype(np.float32)
                for cx, cy in ARCFACE_DST[:2]:
                    eye_contrast.append(
                        gray[int(cy) - 8 : int(cy) + 8, int(cx) - 11 : int(cx) + 11].std()
                    )
                # cheek: below the eye, beside the nose
                cheek_contrast.append(gray[74:90, 32:54].std())

        assert np.median(eye_contrast) > np.median(cheek_contrast) * 1.3

    def test_openness_is_a_bounded_number(self, backend, faces):
        image = next(iter(faces.values()))[0]
        face = max(backend.detect(image), key=lambda f: f.width)
        value = backend.eye_openness(image, face.bbox, face.kps)
        assert 0.0 <= value <= 2.0
