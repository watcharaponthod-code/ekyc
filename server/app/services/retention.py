"""Evidence retention — for PAD evaluation runs only.

The production default is `retain_frames=none`: no image is ever written. For
an ISO/IEC 30107-3-style evaluation you need the opposite — every bona fide
and attack presentation kept, with the decision that was made, so that
`scripts/pad_eval.py` can compute APCER per attack species and BPCER, and so
that thresholds can be re-tuned offline without re-presenting every mask.

Layout, one directory per session under `Settings.frames_dir`::

    <frames_dir>/<label or "unlabelled">/<session_id>/
        manifest.json     the manifest exactly as uploaded
        decision.json     {decision, reasons, scores, label, purpose, challenges, flash, pulse}
        neutral.jpg, turnLeft.jpg, ..., flash_0.jpg, pulse_0.jpg ...

`label` comes from `CreateSessionRequest.label` and is the presentation type
the tester declared (`bona_fide`, `print`, `replay`, `mask_silicone`, ...).

This is a privacy trade-off. Enable it only on an evaluation deployment, with
consenting test subjects, and wipe the directory afterwards.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from ..config import settings
from ..models import VerificationSession
from ..schemas import DecisionResponse

log = logging.getLogger("ekyc.retention")

_SAFE = re.compile(r"[^A-Za-z0-9_.-]+")


def _safe(name: str) -> str:
    return _SAFE.sub("_", name)[:64] or "unlabelled"


def retain_evidence(
    record: VerificationSession,
    frames: dict[str, bytes],
    manifest_raw: str,
    response: DecisionResponse,
) -> Path | None:
    """Write the bundle if the retention policy says so. Never raises."""
    mode = settings.retain_frames
    if mode == "none":
        return None
    if mode == "on_fail" and response.decision == "pass":
        return None
    try:
        label = _safe(str((record.client or {}).get("label") or "unlabelled"))
        target = Path(settings.frames_dir) / label / _safe(record.id)
        target.mkdir(parents=True, exist_ok=True)
        for key, raw in frames.items():
            (target / f"{_safe(key)}.jpg").write_bytes(raw)
        (target / "manifest.json").write_text(manifest_raw, encoding="utf-8")
        (target / "decision.json").write_text(
            json.dumps(
                {
                    "sessionId": record.id,
                    "label": label,
                    "purpose": record.purpose,
                    "challenges": list(record.challenges),
                    "flash": list(record.flash or []),
                    "pulse": record.pulse,
                    "decision": response.decision,
                    "reasons": list(response.reasons),
                    "scores": response.scores,
                },
                default=float,
                indent=2,
            ),
            encoding="utf-8",
        )
        log.info("evidence retained", extra={"context": {"session": record.id, "dir": str(target)}})
        return target
    except Exception:  # noqa: BLE001 — retention must never break a decision
        log.exception("evidence retention failed")
        return None
