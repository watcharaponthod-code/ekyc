"""Read side of evidence retention — look at what a session captured.

Retention (`services/retention.py`) writes `<frames_dir>/<label>/<session>/`
with the frames, the manifest and the decision. This finds a session's
bundle again, lists its frames, and renders a small HTML gallery so a tester
can look at every shot behind a verdict — neutral, each challenge, the flash
frames, the pulse burst — without shell access to the box.

Only meaningful on an evaluation deployment with `EKYC_RETAIN_FRAMES` on.
Everything here is behind the API key.
"""

from __future__ import annotations

import html
import json
import re
from pathlib import Path
from typing import Any

_SAFE = re.compile(r"[^A-Za-z0-9_.-]+")

#: Display order for the gallery: evidence first, then flash, then pulse.
_ORDER = ("neutral", "closeEyes", "turnLeft", "turnRight", "openMouth", "smile", "nod")


def _safe(name: str) -> str:
    return _SAFE.sub("_", name)[:64]


def find_session_dir(frames_dir: Path, session_id: str) -> Path | None:
    sid = _safe(session_id)
    if not frames_dir.is_dir():
        return None
    for label_dir in frames_dir.iterdir():
        candidate = label_dir / sid
        if candidate.is_dir():
            return candidate
    return None


def frame_sort_key(name: str) -> tuple[int, int, str]:
    if name in _ORDER:
        return (0, _ORDER.index(name), name)
    if name.startswith("flash_"):
        return (1, int(name.split("_", 1)[1] or 0) if name.split("_", 1)[1].isdigit() else 0, name)
    if name.startswith("pulse_"):
        return (2, int(name.split("_", 1)[1] or 0) if name.split("_", 1)[1].isdigit() else 0, name)
    return (3, 0, name)


def describe(session_dir: Path) -> dict[str, Any]:
    decision: dict[str, Any] = {}
    decision_file = session_dir / "decision.json"
    if decision_file.is_file():
        try:
            decision = json.loads(decision_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            decision = {}
    frames = sorted((p.stem for p in session_dir.glob("*.jpg")), key=frame_sort_key)
    return {
        "sessionId": session_dir.name,
        "label": session_dir.parent.name,
        "decision": decision.get("decision"),
        "reasons": decision.get("reasons", []),
        "scores": decision.get("scores", {}),
        "challenges": decision.get("challenges", []),
        "frames": frames,
        "hasManifest": (session_dir / "manifest.json").is_file(),
    }


def frame_path(session_dir: Path, key: str) -> Path | None:
    candidate = session_dir / f"{_safe(key)}.jpg"
    return candidate if candidate.is_file() else None


def list_sessions(frames_dir: Path, limit: int = 50) -> list[dict[str, Any]]:
    if not frames_dir.is_dir():
        return []
    dirs = [d for label in frames_dir.iterdir() if label.is_dir() for d in label.iterdir() if d.is_dir()]
    dirs.sort(key=lambda d: d.stat().st_mtime, reverse=True)
    return [describe(d) for d in dirs[:limit]]


def gallery_html(sessions: list[dict[str, Any]], key_query: str) -> str:
    """One page: newest sessions first, every frame as a thumbnail with its key,
    the verdict and the per-step numbers underneath. `key_query` is the
    `?key=…` suffix so <img> requests carry the API key."""
    parts = [
        "<!doctype html><html lang='th'><head><meta charset='utf-8'><title>eKYC evidence</title>",
        "<style>body{font-family:system-ui,sans-serif;margin:16px;background:#f6f7f9;color:#111}",
        ".s{background:#fff;border-radius:10px;padding:12px 14px;margin:0 0 14px;box-shadow:0 1px 3px rgba(0,0,0,.08)}",
        ".pass{color:#15803d;font-weight:700}.fail{color:#b91c1c;font-weight:700}",
        ".row{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.f{text-align:center;font-size:12px}",
        ".f img{width:120px;height:160px;object-fit:cover;border-radius:6px;border:1px solid #ddd;display:block}",
        ".pulse img{width:60px;height:80px}pre{font-size:11px;background:#f1f3f6;padding:6px;border-radius:6px;overflow:auto;max-height:180px}</style></head><body>",
        f"<h2>eKYC evidence — {len(sessions)} sessions (newest first)</h2>",
    ]
    for s in sessions:
        cls = "pass" if s["decision"] == "pass" else "fail"
        parts.append(
            f"<div class='s'><div><b>{html.escape(s['sessionId'])}</b> · label <i>{html.escape(str(s['label']))}</i> · "
            f"<span class='{cls}'>{html.escape(str(s['decision']))}</span> {html.escape(', '.join(s['reasons']) or '')}"
            f" · challenges: {html.escape(', '.join(s['challenges']))}</div><div class='row'>"
        )
        for key in s["frames"]:
            extra = " pulse" if key.startswith("pulse_") else ""
            src = f"/v1/audit/{html.escape(s['sessionId'])}/frames/{html.escape(key)}.jpg{key_query}"
            parts.append(f"<div class='f{extra}'><img loading='lazy' src='{src}' alt='{html.escape(key)}'>{html.escape(key)}</div>")
        steps = s["scores"].get("steps") if isinstance(s["scores"], dict) else None
        summary = {k: v for k, v in (s["scores"] or {}).items() if k != "steps"}
        parts.append("</div><pre>" + html.escape(json.dumps({"scores": summary, "steps": steps}, ensure_ascii=False, indent=1)[:2500]) + "</pre></div>")
    parts.append("</body></html>")
    return "".join(parts)
