"""Whole system, real models, real faces.

Builds an evidence bundle out of real photographs — a near-frontal shot for the
neutral frame plus two shots whose head pose differs in opposite directions —
then drives it through the actual HTTP API: create session, upload multipart,
measure with ONNX, decide, enrol, and verify against a fresh photo.

Skipped unless the models are fetched and LFW is cached.
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db import get_db
from app.main import app
from app.models import Base

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"

#: How far a fixture frame must differ from neutral to stand in for a turn.
#: Matches the shipped `turn_yaw_min_deg`, so the evidence the test builds is
#: evidence the real rules would accept.
MIN_TURN_DEG = 22.0

pytestmark = pytest.mark.models


@pytest.fixture(scope="module")
def backend():
    """The configured backend — `deepface` unless `EKYC_BACKEND` says otherwise.

    Running the end-to-end path against whichever stack is actually deployed is
    the point; pinning it to one implementation would test the wrong thing.
    """
    from app.config import settings

    if settings.backend == "onnx":
        required = ("det_10g.onnx", "w600k_r50.onnx", "minifasnet_v2.onnx")
        if not all((MODELS_DIR / name).is_file() for name in required):
            pytest.skip("ONNX models not fetched; run scripts/fetch_models.py")
        from app.ml.onnx_backend import OnnxFaceBackend

        return OnnxFaceBackend(MODELS_DIR)

    if not (MODELS_DIR / "face_landmarker.task").is_file():
        pytest.skip("MediaPipe model not fetched; run scripts/fetch_models.py")
    pytest.importorskip("mediapipe")
    pytest.importorskip("deepface")
    from app.ml.deepface_backend import DeepFaceMediaPipeBackend

    return DeepFaceMediaPipeBackend(MODELS_DIR)


@pytest.fixture(scope="module")
def posed_people(backend):
    """Per person: a frontal shot and two shots posed in opposite directions.

    Real photographs, so the pose spread is whatever the photographer got —
    which is exactly the point: the pipeline has to cope with real variation.
    """
    cv2 = pytest.importorskip("cv2")
    sklearn_datasets = pytest.importorskip("sklearn.datasets")
    try:
        data = sklearn_datasets.fetch_lfw_people(
            min_faces_per_person=20, resize=1.0, color=True, slice_=None, download_if_missing=False
        )
    except Exception:  # noqa: BLE001
        pytest.skip("LFW not cached locally")

    images = (data.images * 255).astype(np.uint8)
    grouped: dict[int, list[np.ndarray]] = {}
    for image, target in zip(images, data.target, strict=False):
        grouped.setdefault(int(target), []).append(cv2.cvtColor(image, cv2.COLOR_RGB2BGR))

    from app.services.verification import COMPANION_WIDTH_RATIO

    people = {}
    for person, shots in grouped.items():
        measured = []
        # Scan every photograph of the subject, not a slice: with real pose in
        # degrees far fewer LFW frames clear a 22 deg turn, and a short scan
        # silently skipped the whole end-to-end suite.
        for image in shots:
            faces = backend.detect(image)
            if not faces:
                continue
            subject = max(faces, key=lambda f: f.width)
            # LFW is press photography: bystanders are common, and a frame with
            # a second significant face is *correctly* rejected by the pipeline.
            # Only single-subject frames are usable as stand-ins for a selfie.
            significant = sum(1 for f in faces if f.width >= subject.width * COMPANION_WIDTH_RATIO)
            if significant != 1:
                continue
            yaw, _, _ = backend.pose(image, subject.kps)
            measured.append((yaw, image))
        if len(measured) < 6:
            continue
        # Two independent posed sets from disjoint photographs, so one can be
        # enrolled and the other used to verify — the way a second visit works.
        measured.sort(key=lambda pair: pair[0])
        centre = sorted(measured, key=lambda pair: abs(pair[0]))
        sets = []
        for index in (0, 1):
            neutral = centre[index]
            left, right = measured[index], measured[-1 - index]
            if left[1] is neutral[1] or right[1] is neutral[1]:
                break
            if abs(left[0] - neutral[0]) < MIN_TURN_DEG or abs(right[0] - neutral[0]) < MIN_TURN_DEG:
                break
            if (left[0] - neutral[0]) * (right[0] - neutral[0]) >= 0:
                break
            sets.append({"neutral": neutral[1], "left": left[1], "right": right[1]})
        if len(sets) < 2:
            continue
        people[person] = {**sets[0], "second": sets[1]}
        if len(people) == 2:
            break

    if len(people) < 2:
        pytest.skip(
            f"needed 2 subjects with opposite turns of >= {MIN_TURN_DEG} deg, found {len(people)}"
        )
    return people


@pytest.fixture
def relaxed_pad(monkeypatch):
    """Turn the PAD gate off for these tests, on purpose.

    LFW is digitised press photography — rescanned, recompressed, funnelled —
    and MiniFASNet scores it as not-live, which is arguably the model doing its
    job. Its accuracy is measured separately against genuine phone selfies and
    real screen replays (docs/ml-validation.md §2); what *these* tests exist to
    prove is that sessions, multipart upload, measurement, the rules, enrolment
    and matching all fit together on real faces.
    """
    from app.config import Thresholds
    import app.main as main_module

    # Sharpness is relaxed for the same reason: the quality gates are calibrated
    # against genuine phone selfies (sharpness min 98, p5 119 — see
    # docs/ml-validation.md) and 250x250 archival crops sit below that by
    # construction. Pose, identity and session rules stay fully strict.
    monkeypatch.setattr(
        main_module,
        "thresholds",
        # The closed-eyes rule is relaxed too: LFW subjects have their eyes
        # open in every frame, so the `closeEyes` step is answered with a
        # frontal shot. Its accuracy is covered in test_deepface_backend.py.
        Thresholds(pad_min=0.0, sharpness_min=0.0, eye_rule="advisory"),
    )


@pytest.fixture
def client(tmp_path, backend, relaxed_pad):
    engine = create_engine(
        f"sqlite:///{tmp_path/'e2e.db'}", connect_args={"check_same_thread": False}
    )
    Base.metadata.create_all(engine)
    TestingSession = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    def override_db():
        db = TestingSession()
        try:
            yield db
        finally:
            db.close()

    import app.main as main_module

    app.dependency_overrides[get_db] = override_db
    original = main_module.get_backend
    main_module.get_backend = lambda: backend  # type: ignore[assignment]

    with TestClient(app) as test_client:
        yield test_client

    main_module.get_backend = original  # type: ignore[assignment]
    app.dependency_overrides.clear()


def encode(image: np.ndarray) -> bytes:
    import cv2

    ok, buffer = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    assert ok
    return io.BytesIO(buffer).getvalue()


def run_session(client, shots, purpose, *, person_id=None, name=None):
    """Create a session and answer whatever challenges it asks for."""
    body = {"purpose": purpose}
    if person_id:
        body["personId"] = person_id
    if name:
        body["displayName"] = name
    created = client.post("/v1/sessions", json=body).json()

    pick = {
        "closeEyes": shots["neutral"],  # eyes stay open: the rule is advisory
        "turnLeft": shots["left"],
        "turnRight": shots["right"],
    }

    steps, files, t = [], [("frames", ("neutral.jpg", encode(shots["neutral"]), "image/jpeg"))], 1_000
    steps.append({"name": "center", "tStart": t, "tEnd": t + 900})
    for challenge in created["challenges"]:
        t += 1_200
        steps.append({"name": challenge, "tStart": t, "tEnd": t + 900})
        files.append(("frames", (f"{challenge}.jpg", encode(pick[challenge]), "image/jpeg")))

    manifest = {
        "nonce": created["nonce"],
        "startedAt": 1_000,
        "finishedAt": t + 2_000,
        "steps": steps,
        "capture": {"frameWidth": 720, "frameHeight": 960, "fps": 30, "mirrored": True},
    }
    response = client.post(
        f"/v1/sessions/{created['sessionId']}/submit",
        data={"manifest": json.dumps(manifest)},
        files=files,
    )
    assert response.status_code == 200, response.text
    return response.json()


class TestEndToEnd:
    def test_a_real_person_enrols_and_then_verifies(self, client, posed_people):
        first, second = list(posed_people.values())

        enrolled = run_session(client, first, "enroll", name="Test Subject")
        assert enrolled["decision"] == "pass", enrolled["reasons"]
        person_id = enrolled["personId"]
        assert person_id

        # a different set of photographs of the same person must match
        verified = run_session(client, first["second"], "verify", person_id=person_id)
        assert verified["decision"] == "pass", verified["reasons"]
        assert verified["match"]["ok"] is True

        # a different person must not
        impostor = run_session(client, second, "verify", person_id=person_id)
        assert impostor["decision"] == "fail"
        assert impostor["reasons"] == ["NO_MATCH"]
        assert impostor["match"]["score"] < verified["match"]["score"]

    def test_identify_finds_the_right_person_among_several(self, client, posed_people):
        ids = {}
        for label, shots in posed_people.items():
            result = run_session(client, shots, "enroll", name=f"person-{label}")
            assert result["decision"] == "pass", result["reasons"]
            ids[label] = result["personId"]

        label, shots = next(iter(posed_people.items()))
        found = run_session(client, shots["second"], "identify")
        assert found["decision"] == "pass", found["reasons"]
        assert found["personId"] == ids[label]

    def test_the_decision_carries_the_evidence(self, client, posed_people):
        shots = next(iter(posed_people.values()))
        result = run_session(client, shots, "enroll", name="Scores")
        scores = result["scores"]

        assert 0.0 <= scores["pad"] <= 1.0
        assert scores["identityConsistency"] > 0.2
        assert "sharpness" in scores["quality"]
        assert scores["steps"]["neutral"]["ok"] is True

    def test_deleting_a_person_really_removes_them(self, client, posed_people):
        shots = next(iter(posed_people.values()))
        person_id = run_session(client, shots, "enroll", name="Erasable")["personId"]
        assert client.get("/v1/persons").json()

        assert client.delete(f"/v1/persons/{person_id}").status_code == 204
        assert client.get("/v1/persons").json() == []

        after = run_session(client, shots, "verify", person_id=person_id)
        assert after["decision"] == "fail"
        assert after["reasons"] == ["PERSON_NOT_FOUND"]
