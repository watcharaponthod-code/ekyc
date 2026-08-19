"""FastAPI application.

Route handlers stay thin: parse, delegate to a service, shape a response. All
the judgement lives in `decision.py` and the `services` package.
"""

from __future__ import annotations

import json
import os
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from sqlalchemy.orm import Session

from .config import settings, thresholds
from .db import get_db, init_db
from .logging_config import configure as configure_logging
from .logging_config import log_event, timed
from .decision import NEUTRAL_KEY, required_frame_keys
from .flash import FLASH_PALETTE
from .ml.backend import FaceBackend, FakeFaceBackend
from .models import AuditEvent
from .schemas import (
    CreatedSession,
    CreateSessionRequest,
    DecisionResponse,
    EvidenceManifest,
    HealthOut,
    MatchResult,
    PersonOut,
)
from .services import audit as audit_service
from .services import evidence as evidence_service
from .services import persons as persons_service
from .services import sessions as sessions_service
from .services.sessions import SessionError
from .services.retention import retain_evidence
from .services.verification import verify_evidence

@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    configure_logging(settings.log_level, settings.log_format)
    init_db()
    log_event("server.start", version=settings.version, backend=settings.backend)
    backend = get_backend()
    warm_up = getattr(backend, "warm_up", None)
    if warm_up is not None:
        with timed("backend.warm_up", backend=backend.name):
            warm_up()
    # The onnx backend's eye-openness is an image-statistics proxy, not a
    # measured EAR (docs/ml-validation.md §5): its closed-eyes rule must stay
    # advisory unless someone has calibrated it and said so explicitly. Seen
    # in the field: every Railway (onnx) session failed EYES_NOT_CLOSED.
    if settings.backend == "onnx" and thresholds.eye_rule == "enforce" and "EKYC_EYE_RULE" not in os.environ:
        thresholds.eye_rule = "advisory"
        log_event("thresholds.adjusted", rule="eye_rule", value="advisory", reason="onnx backend has no calibrated EAR")
    yield


app = FastAPI(title="eKYC verification server", version=settings.version, lifespan=lifespan)


from fastapi.exceptions import RequestValidationError  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from starlette.requests import Request  # noqa: E402


@app.exception_handler(RequestValidationError)
async def _log_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    """Turn FastAPI's opaque 422 into a logged line naming the offending field.

    A submit that fails request validation (a form field the phone omitted, a
    part the server could not read as a file) otherwise reaches the device as a
    bare "Server returned 422" with no way to tell what was wrong.
    """
    log_event("request.invalid", path=str(request.url.path),
              errors=str(exc.errors())[:500])
    return JSONResponse(status_code=422, content={"detail": exc.errors()})


def require_api_key(
    x_api_key: Annotated[str | None, Header(alias="X-API-Key")] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    """Shared-secret gate for every route but health.

    Off when `EKYC_API_KEYS` is empty (local development). Accepts the key in
    `X-API-Key` or as `Authorization: Bearer <key>`; comparison is constant
    time. This authenticates the *app*, not the person — liveness does that.
    """
    keys = settings.api_key_set()
    if not keys:
        return
    presented = x_api_key
    if presented is None and authorization and authorization.lower().startswith("bearer "):
        presented = authorization[7:].strip()
    if presented is None:
        raise HTTPException(status_code=401, detail="API_KEY_REQUIRED")
    if not any(secrets.compare_digest(presented, key) for key in keys):
        raise HTTPException(status_code=403, detail="API_KEY_INVALID")


ApiKey = Depends(require_api_key)


@lru_cache(maxsize=1)
def get_backend() -> FaceBackend:
    """Load the vision stack once, per `EKYC_BACKEND`."""
    with timed("backend.load", backend=settings.backend):
        if settings.backend == "fake":
            return FakeFaceBackend()
        if settings.backend == "onnx":
            from .ml.onnx_backend import OnnxFaceBackend

            return OnnxFaceBackend(settings.models_dir)

        from .ml.deepface_backend import DeepFaceMediaPipeBackend

        return DeepFaceMediaPipeBackend(settings.models_dir)


@app.get("/v1/health", response_model=HealthOut)
def health() -> HealthOut:
    try:
        backend = get_backend()
        return HealthOut(
            status="ok", version=settings.version, backend=backend.name, models=backend.loaded_models()
        )
    except Exception as error:  # noqa: BLE001 — health must never raise
        return HealthOut(status=f"degraded: {error}", version=settings.version, backend="none", models={})


@app.post("/v1/sessions", response_model=CreatedSession, status_code=201, dependencies=[ApiKey])
def create_session(
    request: CreateSessionRequest, db: Annotated[Session, Depends(get_db)]
) -> CreatedSession:
    try:
        expressions = bool(getattr(get_backend(), "supports_expressions", False))
        created = sessions_service.create_session(db, request, expressions=expressions)
    except SessionError as error:
        log_event("session.rejected", reason=error.code, purpose=request.purpose)
        raise HTTPException(status_code=400, detail=error.code) from error

    log_event(
        "session.created",
        session=created.sessionId,
        purpose=request.purpose,
        tier=request.tier,
        challenges=",".join(created.challenges),
        person=request.personId,
    )
    return created


@app.post("/v1/sessions/{session_id}/submit", response_model=DecisionResponse, dependencies=[ApiKey])
async def submit_evidence(
    session_id: str,
    manifest: Annotated[str, Form()],
    db: Annotated[Session, Depends(get_db)],
    frames: Annotated[list[UploadFile], File()] = [],  # noqa: B006 — FastAPI needs a literal default
) -> DecisionResponse:
    try:
        parsed = EvidenceManifest.model_validate_json(manifest)
    except Exception as error:  # noqa: BLE001
        # Log the real reason: a silent 422 on the phone is otherwise
        # indistinguishable from a network failure. `manifest[:400]` is the raw
        # body so a bad field value is visible, not just its name.
        log_event("submit.rejected", session=session_id, reason="MANIFEST_INVALID",
                  error=str(error)[:400], manifest=manifest[:400])
        raise HTTPException(status_code=422, detail="MANIFEST_INVALID") from error

    try:
        record = sessions_service.consume_session(db, session_id, parsed.nonce)
    except SessionError as error:
        log_event("submit.rejected", session=session_id, reason=error.code)
        status = 404 if error.code == "SESSION_NOT_FOUND" else 409
        raise HTTPException(status_code=status, detail=error.code) from error

    issued = list(record.challenges)
    # Every frame arrives under the single `frames` field; the *filename*
    # carries the key (`neutral.jpg`, `turnLeft.jpg`). Dynamic field names are
    # not expressible in a FastAPI signature, and filenames are unambiguous.
    uploaded = {
        f.filename.rsplit(".", 1)[0]: await f.read() for f in frames if f.filename
    }

    flash_commanded = [FLASH_PALETTE[name] for name in (record.flash or []) if name in FLASH_PALETTE]
    pulse_requested = int((record.pulse or {}).get("frames", 0))
    output, facts, hashes = verify_evidence(
        get_backend(), issued, parsed, uploaded, thresholds, flash_commanded, pulse_requested
    )

    response = DecisionResponse(
        decision="pass" if output.passed else "fail",
        reasons=output.reasons,
        scores=output.scores,
    )

    if output.passed:
        neutral = facts[NEUTRAL_KEY]
        try:
            _apply_outcome(db, record, neutral.embedding, response)
        except persons_service.PersonError as error:
            response.decision = "fail"
            response.reasons = [error.code]

    log_event(
        "submit.decided",
        session=record.id,
        purpose=record.purpose,
        decision=response.decision,
        reasons=",".join(response.reasons) or "-",
        person=response.personId,
        match=round(response.match.score, 4) if response.match else None,
        pad=response.scores.get("pad"),
        consistency=response.scores.get("identityConsistency"),
    )

    record.state = response.decision
    retain_evidence(record, uploaded, manifest, response)
    db.add(
        AuditEvent(
            session_id=record.id,
            person_id=response.personId,
            decision=response.decision,
            reasons=response.reasons,
            scores=json.loads(json.dumps(response.scores, default=float)),
            frame_hashes=hashes,
        )
    )
    db.commit()
    return response


def _apply_outcome(db: Session, record, embedding, response: DecisionResponse) -> None:
    if record.purpose == "enroll":
        person = persons_service.enroll(db, embedding, record.display_name, record.id)
        response.personId = person.id
        return

    if record.purpose == "verify":
        score = persons_service.verify(db, record.person_id, embedding)
        ok = score >= thresholds.match_min
        response.match = MatchResult(ok=ok, score=round(score, 4))
        response.personId = record.person_id if ok else None
        if not ok:
            response.decision = "fail"
            response.reasons = ["NO_MATCH"]
        return

    found = persons_service.identify(db, embedding)
    if found is None or found[1] < thresholds.match_min:
        response.match = MatchResult(ok=False, score=round(found[1], 4) if found else 0.0)
        response.decision = "fail"
        response.reasons = ["NO_MATCH"]
        return
    person, score = found
    response.personId = person.id
    response.match = MatchResult(ok=True, score=round(score, 4))


@app.post("/v1/client-log", status_code=204, dependencies=[ApiKey])
def client_log(entry: dict) -> None:
    """Diagnostics from the phone.

    A device in the field has no cable. Anything the capture screen logs is
    also POSTed here, so a failure on a phone shows up in the same server log
    as the decision it did (or did not) lead to. Whitelisted keys only — this
    is a log sink, not an input.
    """
    # `level` is log_event's own severity parameter; the client's string goes
    # under `severity` so it cannot collide.
    allowed = {
        "device": entry.get("device"),
        "severity": entry.get("level"),
        "message": entry.get("message"),
        "detail": entry.get("detail"),
        "session": entry.get("session"),
        "at": entry.get("at"),
    }
    log_event("client", **{k: str(v)[:500] for k, v in allowed.items() if v is not None})


@app.get("/v1/audit", dependencies=[ApiKey])
def audit(db: Annotated[Session, Depends(get_db)], limit: int = 100) -> dict:
    """Recent decisions plus a tuning summary (pass rate, reason histogram,
    per-gate score percentiles). No biometric data. Key-protected."""
    rows = audit_service.recent(db, max(1, min(limit, 1000)))
    return {"summary": audit_service.summarise(rows), "recent": rows}


def _key_ok_from_query(key: str | None) -> None:
    """Browser-friendly auth for images and the gallery: `?key=` instead of a header."""
    keys = settings.api_key_set()
    if not keys:
        return
    if key is None or not any(secrets.compare_digest(key, k) for k in keys):
        raise HTTPException(status_code=401, detail="API_KEY_REQUIRED")


@app.get("/v1/audit/gallery", response_class=HTMLResponse)
def evidence_gallery(key: str | None = Query(default=None), limit: int = 30) -> HTMLResponse:
    """The retained evidence, newest first, as one HTML page of thumbnails
    (evaluation deployments only — needs `EKYC_RETAIN_FRAMES`)."""
    _key_ok_from_query(key)
    sessions = evidence_service.list_sessions(settings.frames_dir, max(1, min(limit, 200)))
    return HTMLResponse(evidence_service.gallery_html(sessions, f"?key={key}" if key else ""))


@app.get("/v1/audit/{session_id}/frames", dependencies=[ApiKey])
def evidence_frames(session_id: str) -> dict:
    """What a retained session holds: decision, scores and the frame keys."""
    session_dir = evidence_service.find_session_dir(settings.frames_dir, session_id)
    if session_dir is None:
        raise HTTPException(status_code=404, detail="EVIDENCE_NOT_FOUND")
    return evidence_service.describe(session_dir)


@app.get("/v1/audit/{session_id}/frames/{key}.jpg")
def evidence_frame(session_id: str, key: str, api_key: str | None = Query(default=None, alias="key"),
                   x_api_key: Annotated[str | None, Header(alias="X-API-Key")] = None) -> FileResponse:
    """One retained frame as JPEG. Accepts the API key as `?key=` so an <img>
    tag or a browser can fetch it."""
    if x_api_key is not None:
        require_api_key(x_api_key=x_api_key, authorization=None)
    else:
        _key_ok_from_query(api_key)
    session_dir = evidence_service.find_session_dir(settings.frames_dir, session_id)
    path = evidence_service.frame_path(session_dir, key) if session_dir else None
    if path is None:
        raise HTTPException(status_code=404, detail="FRAME_NOT_FOUND")
    return FileResponse(str(path), media_type="image/jpeg")


@app.get("/v1/persons", response_model=list[PersonOut], dependencies=[ApiKey])
def list_persons(db: Annotated[Session, Depends(get_db)]) -> list[PersonOut]:
    return [
        PersonOut(
            id=person.id,
            displayName=person.display_name,
            templateCount=count,
            createdAt=person.created_at,
        )
        for person, count in persons_service.list_persons(db)
    ]


@app.delete("/v1/persons/{person_id}", status_code=204, dependencies=[ApiKey])
def delete_person(person_id: str, db: Annotated[Session, Depends(get_db)]) -> None:
    try:
        persons_service.delete_person(db, person_id)
    except persons_service.PersonError as error:
        raise HTTPException(status_code=404, detail=error.code) from error


__all__ = ["app", "get_backend", "required_frame_keys"]
