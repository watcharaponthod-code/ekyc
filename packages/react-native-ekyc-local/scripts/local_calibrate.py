"""Tune the local flow from real sessions — the log the app shares.

    python packages/react-native-ekyc-local/scripts/local_calibrate.py ekyc-local-sessions.jsonl [more.jsonl ...]

Input: the `ekyc-local-sessions.jsonl` the app writes (one JSON object per
session: mode, passed, reasons, stepMetrics, consistency pairs, pulse,
thresholds, timings). Numbers only — no images, no embeddings.

Output, per gate, what the sessions actually did versus what the gate asked:

* per challenge: distribution of the *best value reached* and how many sessions
  reached the threshold — the answer to "is 25° of turn too much for this
  phone?" or "does the mouth ratio ever get to +0.18?";
* identity: distribution of the star-topology minimum and every neutral↔pose
  similarity — the answer to "where should consistencyMin sit for one person
  on this device?" (suggested: the p5 of genuine sessions minus a margin, but
  never below the LFW impostor p95 of 0.47 for `matchMin`);
* pulse: score / prominence distribution — whether the burst is usable on this
  phone at all, and where 0.5 sits in it;
* failure histogram with the step it died on.

It prints suggestions; it does not edit anything. Whether the sessions were
genuine (one cooperative person) is something only the tester knows — label
attack sessions in the app before trusting the numbers.
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path


def pct(values: list[float], p: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, max(0, int(round(p / 100 * (len(s) - 1)))))]


def fmt(v: float | None) -> str:
    return "  n/a" if v is None else f"{v:6.3f}"


def series(name: str, values: list[float]) -> None:
    if not values:
        return
    print(f"  {name:34s} n={len(values):3d} min={fmt(min(values))} p10={fmt(pct(values, 10))} med={fmt(statistics.median(values))} p90={fmt(pct(values, 90))} max={fmt(max(values))}")


def main(paths: list[str]) -> int:
    try:  # Windows consoles default to cp1252; the report uses arrows and ≈
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    rows: list[dict] = []
    for path in paths:
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    if not rows:
        print("no sessions found", file=sys.stderr)
        return 2

    passed = sum(1 for r in rows if r.get("passed"))
    print(f"sessions={len(rows)} passed={passed} passRate={passed / len(rows):.2%}")
    reasons: Counter[str] = Counter()
    for r in rows:
        reasons.update(r.get("reasons") or ["<pass>"])
    print("reasons:", ", ".join(f"{k}×{v}" for k, v in reasons.most_common()))

    # --- per challenge: best reached vs needed -------------------------------
    print("\n== challenges: best value reached vs needed ==")
    best: dict[str, list[float]] = defaultdict(list)
    needed: dict[str, list[float]] = defaultdict(list)
    reached: dict[str, list[bool]] = defaultdict(list)
    for r in rows:
        for _key, m in (r.get("stepMetrics") or {}).items():
            name = m["challenge"] + (f"#{m['phase']}" if m.get("phase") else "")
            best[name].append(float(m["best"]))
            needed[name].append(float(m["needed"]))
            ok = m["best"] >= m["needed"] if m.get("direction", "above") == "above" else m["best"] <= m["needed"]
            reached[name].append(bool(ok))
    for name in sorted(best):
        series(f"{name}.best", best[name])
        n_ok = sum(reached[name])
        print(f"  {name:34s} reached threshold in {n_ok}/{len(reached[name])} sessions (needed ≈ {statistics.median(needed[name]):.2f})")
        if reached[name] and n_ok / len(reached[name]) < 0.8:
            p20 = pct(best[name], 20)
            print(f"    → suggestion: {name} threshold near the p20 of what people actually reach ({p20:.2f}); if that is far below the server rule, the *server* rule is what needs re-measuring")

    # --- identity -----------------------------------------------------------
    print("\n== identity (MobileFaceNet) ==")
    mins: list[float] = []
    per_pose: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        c = r.get("consistency")
        if not c or not c.get("pairs"):
            continue
        mins.append(float(c["min"]))
        for p in c["pairs"]:
            other = p["b"] if p["a"] == "neutral" else p["a"] if p["b"] == "neutral" else f"{p['a']}~{p['b']}"
            per_pose[other].append(float(p["similarity"]))
    series("consistency.min (star)", mins)
    for pose in sorted(per_pose):
        series(f"neutral↔{pose}", per_pose[pose])
    if mins:
        th = rows[-1].get("thresholds", {}).get("consistencyMin", 0.45)
        below = sum(1 for m in mins if m < th)
        print(f"  consistencyMin={th}: {below}/{len(mins)} sessions below it")
        p5 = pct(mins, 5)
        if p5 is not None:
            print(f"    → suggestion (genuine sessions only): consistencyMin ≈ p5 − 0.03 = {max(0.2, p5 - 0.03):.2f}  (impostor guard: LFW impostor p95 = 0.47 for cross-session matchMin; within-session swaps sit far lower)")
    matches = [float(r["match"]["score"]) for r in rows if r.get("match")]
    series("match vs saved template", matches)

    # --- pulse ---------------------------------------------------------------
    print("\n== rPPG pulse ==")
    ps = [r["pulse"] for r in rows if r.get("pulse")]
    series("pulse.score", [float(p["score"]) for p in ps if p.get("note", "") == ""])
    series("pulse.prominenceDb", [float(p["prominenceDb"]) for p in ps if p.get("note", "") == ""])
    series("pulse.samplingHz", [float(p["samplingHz"]) for p in ps if p.get("samplingHz")])
    notes = Counter(p.get("note", "") or "measured" for p in ps)
    if ps:
        print("  notes:", dict(notes))
        usable = [float(p["score"]) for p in ps if p.get("note", "") == ""]
        if usable:
            print(f"  → {sum(1 for s in usable if s >= 0.5)}/{len(usable)} measured bursts ≥ 0.5; keep advisory until genuine p10 is comfortably above 0.5 on this phone")

    # --- timings -------------------------------------------------------------
    print("\n== timings ==")
    series("captureMs", [float(r["timings"]["captureMs"]) for r in rows if r.get("timings")])
    series("embedMs", [float(r["timings"]["embedMs"]) for r in rows if r.get("timings")])
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:] or ["ekyc-local-sessions.jsonl"]))
