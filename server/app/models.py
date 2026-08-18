"""ORM models.

Only three things persist: who a person is, one 2 KB vector per enrolment, and
an audit row per decision. No face images — see the privacy section of the
design spec.
"""

from __future__ import annotations

import datetime as dt
import secrets
from typing import Any

import numpy as np
from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(12)}"


class Person(Base):
    __tablename__ = "persons"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("p"))
    display_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_now)
    deleted_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    templates: Mapped[list["Template"]] = relationship(
        back_populates="person", cascade="all, delete-orphan"
    )


class Template(Base):
    """One enrolled face embedding: 512 float32, L2-normalised."""

    __tablename__ = "templates"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("t"))
    person_id: Mapped[str] = mapped_column(ForeignKey("persons.id", ondelete="CASCADE"), index=True)
    embedding: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_now)
    session_id: Mapped[str | None] = mapped_column(String(40), nullable=True)

    person: Mapped[Person] = relationship(back_populates="templates")

    @property
    def vector(self) -> np.ndarray:
        return np.frombuffer(self.embedding, dtype=np.float32)

    @staticmethod
    def pack(vector: np.ndarray) -> bytes:
        return np.asarray(vector, dtype=np.float32).tobytes()


class VerificationSession(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("s"))
    purpose: Mapped[str] = mapped_column(String(20))
    person_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    display_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    nonce: Mapped[str] = mapped_column(String(64))
    challenges: Mapped[list[str]] = mapped_column(JSON)
    #: Active-flash colour sequence issued for this session (names), or None.
    flash: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    policy: Mapped[dict[str, Any]] = mapped_column(JSON)
    client: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_now)
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    #: Set the moment a submission is accepted for processing — makes the
    #: session one-shot even against concurrent replays.
    consumed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    state: Mapped[str] = mapped_column(String(20), default="issued")


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(String(40), index=True)
    person_id: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_now)
    decision: Mapped[str] = mapped_column(String(10))
    reasons: Mapped[list[str]] = mapped_column(JSON)
    scores: Mapped[dict[str, Any]] = mapped_column(JSON)
    #: SHA-256 per uploaded frame. Not reversible to an image; lets us spot a
    #: replayed evidence bundle without keeping anyone's face.
    frame_hashes: Mapped[dict[str, str]] = mapped_column(JSON)
