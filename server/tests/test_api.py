"""End-to-end API behaviour, driven through the fake vision backend.

These tests exercise the real routes, the real database and the real decision
engine — only the four ONNX models are stubbed, so the suite runs anywhere.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db import get_db
from app.main import app
from app.ml.backend import FakeFaceBackend
from app.models import Base


@pytest.fixture
def client(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path/'test.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    TestingSession = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    def override_db():
        db = TestingSession()
        try:
            yield db
        finally:
            db.close()

    backend = FakeFaceBackend()
    app.dependency_overrides[get_db] = override_db

    # The routes call `get_backend()` directly (it is a cached loader, not a
    # dependency), so swap the module attribute for the duration of the test.
    import app.main as main_module

    original = main_module.get_backend
    main_module.get_backend = lambda: backend  # type: ignore[assignment]

    with TestClient(app) as test_client:
        test_client.backend = backend  # type: ignore[attr-defined]
        yield test_client

    main_module.get_backend = original  # type: ignore[assignment]
    app.dependency_overrides.clear()


def make_session(client, **payload):
    body = {"purpose": "enroll", **payload}
    response = client.post("/v1/sessions", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def manifest_for(session, *, start=1_000, step_ms=900, gap=1_200, nonce=None):
    steps = []
    t = start
    for name in ["center", *session["challenges"]]:
        steps.append(
            {
                "name": name,
                "tStart": t,
                "tEnd": t + step_ms,
                "observed": {"yaw": 0, "pitch": 0, "roll": 0, "leftEye": 0.9, "rightEye": 0.9, "smile": 0},
            }
        )
        t += gap
    return {
        "nonce": nonce if nonce is not None else session["nonce"],
        "startedAt": start,
        "finishedAt": t + 1_000,
        "steps": steps,
        "capture": {"frameWidth": 1280, "frameHeight": 720, "fps": 30, "mirrored": True},
    }


def submit(client, session, jpeg, *, manifest=None, keys=None):
    manifest = manifest or manifest_for(session)
    keys = keys if keys is not None else ["neutral", *session["challenges"]]
    files = [("frames", (f"{key}.jpg", jpeg(seed=i), "image/jpeg")) for i, key in enumerate(keys)]
    return client.post(
        f"/v1/sessions/{session['sessionId']}/submit",
        data={"manifest": json.dumps(manifest)},
        files=files,
    )


class TestSessionCreation:
    def test_it_issues_a_nonce_and_a_challenge_list(self, client):
        session = make_session(client)
        assert len(session["nonce"]) >= 32
        assert len(session["challenges"]) == 3
        assert "center" not in session["challenges"]

    def test_a_reduced_tier_asks_for_one_challenge(self, client):
        session = make_session(client, purpose="verify", personId="p_x", tier="reduced")
        assert len(session["challenges"]) == 1

    def test_verify_without_a_person_is_rejected(self, client):
        assert client.post("/v1/sessions", json={"purpose": "verify"}).status_code == 400

    def test_the_order_varies_between_sessions(self, client):
        orders = {tuple(make_session(client)["challenges"]) for _ in range(25)}
        assert len(orders) > 1, "challenge order must be randomised per session"


class TestSubmission:
    def test_a_session_can_only_be_submitted_once(self, client, jpeg_bytes):
        session = make_session(client)
        first = submit(client, session, jpeg_bytes)
        assert first.status_code == 200
        second = submit(client, session, jpeg_bytes)
        assert second.status_code == 409
        assert second.json()["detail"] == "SESSION_CONSUMED"

    def test_a_wrong_nonce_is_rejected(self, client, jpeg_bytes):
        session = make_session(client)
        bad = manifest_for(session, nonce="not-the-nonce")
        response = submit(client, session, jpeg_bytes, manifest=bad)
        assert response.status_code == 409
        assert response.json()["detail"] == "NONCE_MISMATCH"

    def test_an_unknown_session_is_a_404(self, client, jpeg_bytes):
        session = make_session(client)
        session["sessionId"] = "s_does_not_exist"
        assert submit(client, session, jpeg_bytes).status_code == 404

    def test_a_malformed_manifest_is_a_422(self, client, jpeg_bytes):
        session = make_session(client)
        response = client.post(
            f"/v1/sessions/{session['sessionId']}/submit",
            data={"manifest": "{not json"},
            files=[("frames", ("neutral.jpg", jpeg_bytes(), "image/jpeg"))],
        )
        assert response.status_code == 422

    def test_null_or_nan_telemetry_does_not_reject_the_submission(self, client, jpeg_bytes):
        # ML Kit sometimes yields NaN, and JS `x ?? 0` does not catch it, so it
        # reaches the server as JSON null. The observed/capture values are
        # advisory — the server re-measures from the pixels — so a null must
        # never turn a real liveness run into a 422.
        session = make_session(client)
        manifest = manifest_for(session)
        manifest["steps"][1]["observed"]["yaw"] = None
        manifest["steps"][1]["observed"]["leftEye"] = None
        manifest["capture"]["fps"] = None
        manifest["capture"]["frameHeight"] = None
        response = submit(client, session, jpeg_bytes, manifest=manifest)
        assert response.status_code == 200, response.text

    def test_a_missing_frame_fails_the_decision_not_the_request(self, client, jpeg_bytes):
        session = make_session(client)
        response = submit(client, session, jpeg_bytes, keys=["neutral"])
        assert response.status_code == 200
        assert response.json()["decision"] == "fail"
        assert response.json()["reasons"] == ["FRAME_MISSING"]

    def test_an_undecodable_frame_is_reported_as_such(self, client, jpeg_bytes):
        session = make_session(client)
        keys = ["neutral", *session["challenges"]]
        files = [("frames", (f"{k}.jpg", b"not an image", "image/jpeg")) for k in keys]
        response = client.post(
            f"/v1/sessions/{session['sessionId']}/submit",
            data={"manifest": json.dumps(manifest_for(session))},
            files=files,
        )
        assert response.json()["reasons"] == ["FRAME_UNREADABLE"]

    def test_a_reordered_manifest_is_rejected(self, client, jpeg_bytes):
        session = make_session(client)
        bad = manifest_for(session)
        bad["steps"][1], bad["steps"][2] = bad["steps"][2], bad["steps"][1]
        response = submit(client, session, jpeg_bytes, manifest=bad)
        assert response.json()["reasons"] == ["CHALLENGE_MISMATCH"]

    def test_every_submission_is_audited(self, client, jpeg_bytes, tmp_path):
        from sqlalchemy import create_engine, select
        from sqlalchemy.orm import Session as OrmSession

        from app.models import AuditEvent

        session = make_session(client)
        submit(client, session, jpeg_bytes)

        engine = create_engine(f"sqlite:///{tmp_path/'test.db'}")
        with OrmSession(engine) as db:
            events = db.scalars(select(AuditEvent)).all()
        assert len(events) == 1
        assert events[0].session_id == session["sessionId"]
        assert set(events[0].frame_hashes) >= {"neutral"}
        assert all(len(h) == 64 for h in events[0].frame_hashes.values())


class TestPersons:
    def test_listing_is_empty_before_anyone_enrols(self, client):
        assert client.get("/v1/persons").json() == []

    def test_deleting_an_unknown_person_is_a_404(self, client):
        assert client.delete("/v1/persons/p_nope").status_code == 404


class TestHealth:
    def test_it_reports_the_backend_in_use(self, client):
        body = client.get("/v1/health").json()
        assert body["status"] == "ok"
        assert body["backend"] == "fake"


class TestClientLog:
    def test_it_accepts_a_phone_diagnostic_line(self, client):
        response = client.post(
            "/v1/client-log",
            json={"device": "android 36", "level": "info", "message": "camera", "detail": "front 10"},
        )
        assert response.status_code == 204

    def test_it_ignores_keys_it_does_not_know(self, client):
        response = client.post("/v1/client-log", json={"message": "x", "embedding": [1, 2, 3]})
        assert response.status_code == 204


# --- active-flash liveness, end to end through the API ----------------------
import io as _io  # noqa: E402
from PIL import Image as _Image  # noqa: E402
from app.flash import FLASH_PALETTE as _PALETTE  # noqa: E402


def _reflected(color):
    """Mean face colour a real face shows under this flash colour."""
    amb, alb, k = (0.2, 0.18, 0.16), (0.9, 0.6, 0.5), 0.35
    return tuple(min(1.0, a + al * k * c) for a, al, c in zip(amb, alb, color))


def _solid_jpeg(rgb):
    r, g, b = (int(round(v * 255)) for v in rgb)
    buf = _io.BytesIO()
    _Image.new("RGB", (640, 640), (r, g, b)).save(buf, "JPEG", quality=95)
    return buf.getvalue()


def _flash_files(session, *, real):
    files = []
    for i, name in enumerate(session["flash"]):
        rgb = _reflected(_PALETTE[name]) if real else (0.5, 0.4, 0.35)
        files.append(("frames", (f"flash_{i}.jpg", _solid_jpeg(rgb), "image/jpeg")))
    return files


def _submit_with_flash(client, session, jpeg, *, real):
    keys = ["neutral", *session["challenges"]]
    files = [("frames", (f"{k}.jpg", jpeg(seed=i), "image/jpeg")) for i, k in enumerate(keys)]
    files += _flash_files(session, real=real)
    return client.post(
        f"/v1/sessions/{session['sessionId']}/submit",
        data={"manifest": json.dumps(manifest_for(session))},
        files=files,
    )


class TestActiveFlashApi:
    def test_flash_is_off_by_default(self, client):
        assert make_session(client)["flash"] == []

    def test_the_plan_is_a_random_colour_sequence_when_enabled(self, client, monkeypatch):
        from app.config import settings as cfg

        monkeypatch.setattr(cfg, "flash_frames", 4)
        plans = {tuple(make_session(client)["flash"]) for _ in range(20)}
        assert all(len(p) == 4 for p in plans)
        assert len(plans) > 1, "flash order must be randomised per session"

    def test_a_face_that_reflects_the_flash_clears_the_flash_gate(self, client, jpeg_bytes, monkeypatch):
        # The fake backend reports a fixed pose, so a full pass is covered by the
        # decision-level test; here we assert the *flash* gate specifically: the
        # reflected frames score above threshold and raise no FLASH_SPOOF.
        from app.config import settings as cfg

        monkeypatch.setattr(cfg, "flash_frames", 4)
        session = make_session(client)
        response = _submit_with_flash(client, session, jpeg_bytes, real=True)
        assert response.status_code == 200, response.text
        body = response.json()
        assert "FLASH_SPOOF" not in body["reasons"], body
        assert body["scores"]["flash"] > 0.5, body

    def test_a_photo_held_under_the_flash_is_rejected(self, client, jpeg_bytes, monkeypatch):
        from app.config import settings as cfg

        monkeypatch.setattr(cfg, "flash_frames", 4)
        session = make_session(client)
        response = _submit_with_flash(client, session, jpeg_bytes, real=False)
        assert response.json()["decision"] == "fail"
        assert "FLASH_SPOOF" in response.json()["reasons"], response.json()
