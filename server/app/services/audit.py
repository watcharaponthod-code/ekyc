"""Read side of the audit log — "why are sessions failing?"

The audit table already stores every decision with its reasons and scores.
This turns it into the two views tuning needs:

* the recent rows themselves (for a human to eyeball one bad session), and
* a summary: pass rate, reason histogram, and per-gate score percentiles,
  so the gate that fails most, and by how much, is one glance away.

No images, no embeddings — nothing here can identify a face.
"""

from __future__ import annotations

import statistics
from collections import Counter
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import AuditEvent


def recent(db: Session, limit: int = 100) -> list[dict[str, Any]]:
    rows = db.execute(select(AuditEvent).order_by(AuditEvent.at.desc()).limit(limit)).scalars().all()
    return [
        {
            "at": row.at.isoformat() if row.at else None,
            "sessionId": row.session_id,
            "personId": row.person_id,
            "decision": row.decision,
            "reasons": list(row.reasons or []),
            "scores": row.scores or {},
        }
        for row in rows
    ]


def _pct(values: list[float], p: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    k = min(len(s) - 1, max(0, int(round((p / 100) * (len(s) - 1)))))
    return round(s[k], 4)


def _series(values: list[float]) -> dict[str, Any] | None:
    if not values:
        return None
    return {
        "n": len(values),
        "min": round(min(values), 4),
        "p10": _pct(values, 10),
        "median": round(statistics.median(values), 4),
        "p90": _pct(values, 90),
        "max": round(max(values), 4),
    }


def summarise(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Pass rate, reason histogram, and score distributions per gate."""
    reasons: Counter[str] = Counter()
    passed = 0
    gate: dict[str, list[float]] = {}

    def add(key: str, value: Any) -> None:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            gate.setdefault(key, []).append(float(value))

    for row in rows:
        if row["decision"] == "pass":
            passed += 1
        reasons.update(row["reasons"] or ["<pass>"])
        s = row.get("scores") or {}
        add("pad", s.get("pad"))
        add("flash", s.get("flash"))
        add("identityConsistency", s.get("identityConsistency"))
        add("planarity", s.get("planarity"))
        q = s.get("quality") or {}
        add("quality.sharpness", q.get("sharpness"))
        add("quality.brightness", q.get("brightness"))
        add("quality.faceRatio", q.get("faceRatio"))
        pulse = s.get("pulse") or {}
        add("pulse.score", pulse.get("score"))
        steps = s.get("steps") or {}
        for name, step in steps.items():
            if not isinstance(step, dict):
                continue
            if "yawDelta" in step:
                add(f"steps.{name}.yawDelta", abs(step["yawDelta"]))
            if "ratio" in step:
                add(f"steps.{name}.earRatio", step["ratio"])
                add(f"steps.{name}.ear", step.get("ear"))
            if "delta" in step:
                add(f"steps.{name}.delta", step["delta"])
                add(f"steps.{name}.value", step.get("value"))
            if name == "neutral" and "yawDeg" in step:
                add("steps.neutral.absYaw", abs(step["yawDeg"]))

    return {
        "sessions": len(rows),
        "passed": passed,
        "passRate": round(passed / len(rows), 4) if rows else None,
        "reasons": dict(reasons.most_common()),
        "scores": {k: _series(v) for k, v in sorted(gate.items())},
    }
