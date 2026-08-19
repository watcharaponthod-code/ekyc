"""Why are sessions failing? — offline summary of the audit table.

    py -3.12 scripts/audit_report.py            # local sqlite (EKYC_DATABASE_URL / default ekyc.db)
    py -3.12 scripts/audit_report.py --limit 500 --json out.json

Same numbers as `GET /v1/audit` on a running server: pass rate, reason
histogram, and per-gate score percentiles (pad, flash, identity consistency,
per-step yaw deltas, EAR ratios, mouth deltas, pulse). Read it as: which gate
fails most, and how far from the threshold the failures sit — then look at
`docs/liveness-hardening.md` / `config.py` for what that gate's threshold is
based on before touching it.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.db import SessionLocal  # noqa: E402
from app.services import audit  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--json", dest="json_out")
    args = parser.parse_args(argv)
    with SessionLocal() as db:
        rows = audit.recent(db, args.limit)
    summary = audit.summarise(rows)
    print(f"sessions={summary['sessions']} passed={summary['passed']} passRate={summary['passRate']}")
    print("reasons:", ", ".join(f"{k}×{v}" for k, v in summary["reasons"].items()) or "-")
    for key, series in summary["scores"].items():
        if series:
            print(f"  {key:32s} n={series['n']:3d} min={series['min']} p10={series['p10']} med={series['median']} p90={series['p90']} max={series['max']}")
    if args.json_out:
        Path(args.json_out).write_text(json.dumps({"summary": summary, "recent": rows}, indent=2, default=str), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
