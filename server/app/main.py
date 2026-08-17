"""FastAPI application.

Route handlers stay thin: parse, delegate to a service, shape a response. All
the judgement lives in `decision.py` and the `services` package.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from .config import settings, thresholds
from .db import get_db, init_db
from .logging_config import configure as configure_logging
from .logging_config import log_event, timed
from .decision import NEUTRAL_KEY, required_frame_keys
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
from .services import persons as persons_service
from .services import sessions as sessions_service
from .services.sessions import SessionError
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
    yield


app = FastAPI(title="eKYC verification server", version=settings.version, lifespan=lifespan)


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


@app.post("/v1/sessions", response_model=CreatedSession, status_code=201)
def create_session(
    request: CreateSessionRequest, db: Annotated[Session, Depends(get_db)]
) -> CreatedSession:
    try:
        created = sessions_service.create_session(db, request)
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


@app.post("/v1/sessions/{session_id}/submit", response_model=DecisionResponse)
async def submit_evidence(
    session_id: str,
    manifest: Annotated[str, Form()],
    db: Annotated[Session, Depends(get_db)],
    frames: Annotated[list[UploadFile], File()] = [],  # noqa: B006 — FastAPI needs a literal default
) -> DecisionResponse:
    try:
        parsed = EvidenceManifest.model_validate_json(manifest)
    except Exception as error:  # noqa: BLE001
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

    output, facts, hashes = verify_evidence(get_backend(), issued, parsed, uploaded, thresholds)

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


@app.post("/v1/client-log", status_code=204)
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


@app.get("/v1/persons", response_model=list[PersonOut])
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


@app.delete("/v1/persons/{person_id}", status_code=204)
def delete_person(person_id: str, db: Annotated[Session, Depends(get_db)]) -> None:
    try:
        persons_service.delete_person(db, person_id)
    except persons_service.PersonError as error:
        raise HTTPException(status_code=404, detail=error.code) from error


__all__ = ["app", "get_backend", "required_frame_keys"]
