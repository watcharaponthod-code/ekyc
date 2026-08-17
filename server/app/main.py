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
    init_db()
    yield


app = FastAPI(title="eKYC verification server", version=settings.version, lifespan=lifespan)


@lru_cache(maxsize=1)
def get_backend() -> FaceBackend:
    """Load the vision models once.

    Falls back to the fake backend when ONNX is disabled, so the API can be run
    and exercised end-to-end without downloading 200 MB of weights.
    """
    if not settings.use_onnx:
        return FakeFaceBackend()
    from .ml.onnx_backend import OnnxFaceBackend

    return OnnxFaceBackend(settings.models_dir)


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
        return sessions_service.create_session(db, request)
    except SessionError as error:
        raise HTTPException(status_code=400, detail=error.code) from error


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
