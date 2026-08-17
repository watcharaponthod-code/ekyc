"""Enrolment, matching and erasure.

Identification is a linear scan of 512-float dot products. On CPU that is
comfortably sub-second into the tens of thousands of templates; past that,
replace this module's `identify` with a pgvector query — nothing else changes.
"""

from __future__ import annotations

import datetime as dt

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Person, Template
from ..ml.geometry import cosine


class PersonError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def enroll(db: Session, embedding: np.ndarray, display_name: str | None, session_id: str) -> Person:
    person = Person(display_name=display_name)
    db.add(person)
    db.flush()
    db.add(Template(person_id=person.id, embedding=Template.pack(embedding), session_id=session_id))
    db.commit()
    return person


def add_template(db: Session, person_id: str, embedding: np.ndarray, session_id: str) -> None:
    """Attach another view of an already-enrolled face. More views, better recall."""
    db.add(Template(person_id=person_id, embedding=Template.pack(embedding), session_id=session_id))
    db.commit()


def verify(db: Session, person_id: str, embedding: np.ndarray) -> float:
    """Best similarity against any template of one person."""
    person = _live_person(db, person_id)
    if person is None:
        raise PersonError("PERSON_NOT_FOUND")
    templates = db.scalars(select(Template).where(Template.person_id == person_id)).all()
    if not templates:
        raise PersonError("PERSON_NOT_FOUND")
    return max(cosine(embedding, t.vector) for t in templates)


def identify(db: Session, embedding: np.ndarray) -> tuple[Person, float] | None:
    """Closest enrolled person, or None when nobody is enrolled."""
    rows = db.execute(
        select(Template, Person).join(Person, Template.person_id == Person.id).where(Person.deleted_at.is_(None))
    ).all()
    if not rows:
        return None
    best_person, best_score = None, -1.0
    for template, person in rows:
        score = cosine(embedding, template.vector)
        if score > best_score:
            best_person, best_score = person, score
    return (best_person, best_score) if best_person is not None else None


def list_persons(db: Session) -> list[tuple[Person, int]]:
    people = db.scalars(select(Person).where(Person.deleted_at.is_(None))).all()
    return [(p, len(p.templates)) for p in people]


def delete_person(db: Session, person_id: str) -> None:
    """Real erasure, not a flag: templates go too. PDPA right to be forgotten."""
    person = _live_person(db, person_id)
    if person is None:
        raise PersonError("PERSON_NOT_FOUND")
    person.deleted_at = dt.datetime.now(dt.timezone.utc)
    db.delete(person)
    db.commit()


def _live_person(db: Session, person_id: str) -> Person | None:
    person = db.get(Person, person_id)
    return person if person is not None and person.deleted_at is None else None
