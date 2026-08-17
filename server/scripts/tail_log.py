"""One timeline: phone diagnostics + server decisions, newest last.

    py -3.12 server/scripts/tail_log.py            # last 40 lines
    py -3.12 server/scripts/tail_log.py -n 200
    py -3.12 server/scripts/tail_log.py --follow   # keep printing as they arrive

Reads server/ekyc-server.log (JSON lines). Phone lines are the ones the
capture screen POSTs to /v1/client-log; they carry a `device` field.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

LOG = Path(__file__).resolve().parent.parent / "ekyc-server.log"

INTERESTING = {
    "session.created", "session.rejected", "submit.decided", "submit.rejected",
    "decide", "measure.analyze", "measure.pad", "measure.embed", "backend.load", "server.start",
}


def fmt(raw: str) -> str | None:
    if not raw.startswith("{"):
        return None
    try:
        d = json.loads(raw)
    except json.JSONDecodeError:
        return None
    ts = d.get("ts", "")[11:19]
    msg = d.get("message", "")
    if "device" in d:  # phone line
        detail = d.get("detail", "")
        sess = (d.get("session") or "")[:12]
        return f"{ts}  PHONE   {d['device']:<12} {msg:<18} {detail:<40} {sess}"
    if msg in INTERESTING:
        extra = {k: v for k, v in d.items() if k not in ("ts", "level", "logger", "message")}
        return f"{ts}  SERVER  {msg:<16} {json.dumps(extra, ensure_ascii=False)[:160]}"
    if d.get("level") in ("ERROR", "WARNING"):
        return f"{ts}  {d['level']:<7} {msg}"
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-n", type=int, default=40)
    ap.add_argument("--follow", action="store_true")
    a = ap.parse_args()

    if not LOG.exists():
        print(f"no log at {LOG} — start the server with EKYC_LOG_FORMAT=json and redirect stdout there")
        return 1

    lines = [x for x in (fmt(l) for l in LOG.read_text(encoding="utf-8", errors="ignore").splitlines()) if x]
    for line in lines[-a.n :]:
        print(line)

    if a.follow:
        with LOG.open("r", encoding="utf-8", errors="ignore") as fh:
            fh.seek(0, 2)
            while True:
                line = fh.readline()
                if not line:
                    time.sleep(0.5)
                    continue
                out = fmt(line.rstrip("\n"))
                if out:
                    print(out, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
