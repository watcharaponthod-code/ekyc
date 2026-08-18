"""ISO/IEC 30107-3-style PAD evaluation over retained sessions.

    py -3.12 scripts/pad_eval.py [ROOT] [--rescore] [--json out.json] [--markdown out.md]

ROOT is the retention directory (`EKYC_FRAMES_DIR`, default `server/retained_frames`)
laid out by `services/retention.py`::

    ROOT/<label>/<session_id>/{manifest.json, decision.json, *.jpg}

`label` is the presentation type the tester declared when creating the session
(`CreateSessionRequest.label`). One label is the bona fide class —
`bona_fide` — every other label is a presentation-attack-instrument (PAI)
species: `print_a4`, `replay_phone`, `mask_paper`, `mask_3dprint`,
`mask_silicone`, ...

What is reported, in the vocabulary of ISO/IEC 30107-3:

* **APCER** per PAI species — attack presentations classified as bona fide,
  over attack presentations that produced a classification;
* **APCER (max)** — the worst species, which is the single number the standard
  asks you to quote when one is quoted;
* **BPCER** — bona fide presentations classified as attacks;
* **ACER** — (APCER_max + BPCER) / 2, informational;
* **APNRR / BPNRR** — non-response rates: presentations the system could not
  acquire at all (no face, missing frame, corrupt frame, protocol mismatch),
  reported separately as the standard requires rather than silently counted
  as a catch;
* Wilson 95 % intervals on every rate — the sample sizes here are small and
  a point estimate without an interval is a false comfort;
* per species, **which gate caught what** (reason-code histogram over the
  rejections) and, for the attacks that got through, the scores they carried
  — this is the threshold-tuning view.

`--rescore` ignores the recorded decision and re-runs `verify_evidence` on the
retained frames with the *current* backend and thresholds (env overrides
apply: `EKYC_PAD_MIN=…`, `EKYC_PULSE_RULE=enforce`, …). That is how a
threshold change is evaluated without re-presenting every mask.

This script does not make the system certified. Certification is a lab
(iBeta, Fime, …) running its own species set under its own protocol; this
script exists so the numbers you bring to that lab are honest, and so you can
find out before they do.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

BONA_FIDE = "bona_fide"

#: Reasons that mean "no classification was made" — the presentation was not
#: acquired. ISO/IEC 30107-3 keeps these out of APCER/BPCER and reports them
#: as non-response rates instead.
NON_RESPONSE = {
    "NO_FACE",
    "MULTIPLE_FACES",
    "FRAME_MISSING",
    "FRAME_UNREADABLE",
    "CHALLENGE_MISMATCH",
    "TIMING_IMPLAUSIBLE",
    "FLASH_FRAME_MISSING",
    "PULSE_FRAME_MISSING",
    "SESSION_EXPIRED",
    "SESSION_CONSUMED",
    "MANIFEST_INVALID",
}


@dataclass(slots=True)
class Presentation:
    label: str
    session_id: str
    decision: str  # pass | fail
    reasons: list[str]
    scores: dict

    @property
    def non_response(self) -> bool:
        return self.decision == "fail" and bool(set(self.reasons) & NON_RESPONSE)

    @property
    def accepted(self) -> bool:
        return self.decision == "pass"


@dataclass(slots=True)
class SpeciesReport:
    label: str
    total: int = 0
    non_response: int = 0
    accepted: int = 0
    rejected: int = 0
    reasons: Counter = field(default_factory=Counter)
    accepted_scores: list[dict] = field(default_factory=list)

    @property
    def classified(self) -> int:
        return self.total - self.non_response


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float, float]:
    """(rate, low, high) — Wilson score interval; (nan, nan, nan) for n == 0."""
    if n <= 0:
        return float("nan"), float("nan"), float("nan")
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return p, max(0.0, centre - half), min(1.0, centre + half)


def load_presentations(root: Path) -> list[Presentation]:
    out: list[Presentation] = []
    for label_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        for session_dir in sorted(p for p in label_dir.iterdir() if p.is_dir()):
            decision_file = session_dir / "decision.json"
            if not decision_file.is_file():
                continue
            data = json.loads(decision_file.read_text(encoding="utf-8"))
            out.append(
                Presentation(
                    label=label_dir.name,
                    session_id=session_dir.name,
                    decision=str(data.get("decision", "fail")),
                    reasons=list(data.get("reasons", [])),
                    scores=dict(data.get("scores", {})),
                )
            )
    return out


def rescore(root: Path, presentations: list[Presentation]) -> list[Presentation]:
    """Re-run the pipeline on the retained frames with the current backend/thresholds."""
    from app.config import thresholds
    from app.flash import FLASH_PALETTE
    from app.main import get_backend
    from app.schemas import EvidenceManifest
    from app.services.verification import verify_evidence

    backend = get_backend()
    out: list[Presentation] = []
    for p in presentations:
        session_dir = root / p.label / p.session_id
        decision = json.loads((session_dir / "decision.json").read_text(encoding="utf-8"))
        manifest_raw = (session_dir / "manifest.json").read_text(encoding="utf-8")
        manifest = EvidenceManifest.model_validate_json(manifest_raw)
        frames = {f.stem: f.read_bytes() for f in session_dir.glob("*.jpg")}
        flash_commanded = [FLASH_PALETTE[n] for n in decision.get("flash", []) if n in FLASH_PALETTE]
        pulse_requested = int((decision.get("pulse") or {}).get("frames", 0))
        output, _, _ = verify_evidence(
            backend, list(decision.get("challenges", [])), manifest, frames, thresholds,
            flash_commanded, pulse_requested,
        )
        out.append(
            Presentation(
                label=p.label,
                session_id=p.session_id,
                decision="pass" if output.passed else "fail",
                reasons=list(output.reasons),
                scores=json.loads(json.dumps(output.scores, default=float)),
            )
        )
        print(f"  rescored {p.label}/{p.session_id}: {'pass' if output.passed else 'fail'} {','.join(output.reasons) or '-'}")
    return out


def summarise(presentations: list[Presentation]) -> dict[str, SpeciesReport]:
    reports: dict[str, SpeciesReport] = defaultdict(lambda: SpeciesReport(label=""))
    for p in presentations:
        report = reports[p.label]
        report.label = p.label
        report.total += 1
        if p.non_response:
            report.non_response += 1
            continue
        if p.accepted:
            report.accepted += 1
            report.accepted_scores.append(_flat_scores(p.scores))
        else:
            report.rejected += 1
            report.reasons.update(p.reasons)
    return dict(reports)


def _flat_scores(scores: dict) -> dict:
    flat: dict = {}
    for key in ("pad", "flash", "identityConsistency", "planarity"):
        if key in scores:
            flat[key] = scores[key]
    pulse = scores.get("pulse")
    if isinstance(pulse, dict) and "score" in pulse:
        flat["pulse"] = pulse["score"]
    steps = scores.get("steps", {})
    if isinstance(steps, dict):
        for name in ("openMouth", "smile"):
            if name in steps and isinstance(steps[name], dict) and "value" in steps[name]:
                flat[name] = steps[name]["value"]
    return flat


def build_report(reports: dict[str, SpeciesReport]) -> dict:
    bona = reports.get(BONA_FIDE)
    species = {k: v for k, v in reports.items() if k != BONA_FIDE}

    result: dict = {"bona_fide": None, "species": {}, "summary": {}}
    if bona:
        bpcer, lo, hi = wilson(bona.rejected, bona.classified)
        bpnrr = wilson(bona.non_response, bona.total)
        result["bona_fide"] = {
            "n": bona.total,
            "classified": bona.classified,
            "rejected": bona.rejected,
            "BPCER": bpcer, "BPCER_ci95": [lo, hi],
            "BPNRR": bpnrr[0], "BPNRR_ci95": [bpnrr[1], bpnrr[2]],
            "reject_reasons": dict(bona.reasons.most_common()),
        }
    apcers = []
    for label, sp in sorted(species.items()):
        apcer, lo, hi = wilson(sp.accepted, sp.classified)
        apnrr = wilson(sp.non_response, sp.total)
        if not math.isnan(apcer):
            apcers.append((apcer, label))
        result["species"][label] = {
            "n": sp.total,
            "classified": sp.classified,
            "accepted": sp.accepted,
            "APCER": apcer, "APCER_ci95": [lo, hi],
            "APNRR": apnrr[0], "APNRR_ci95": [apnrr[1], apnrr[2]],
            "caught_by": dict(sp.reasons.most_common()),
            "accepted_scores": sp.accepted_scores,
        }
    if apcers:
        worst, worst_label = max(apcers)
        result["summary"]["APCER_max"] = worst
        result["summary"]["APCER_max_species"] = worst_label
        if bona and bona.classified:
            result["summary"]["ACER"] = (worst + result["bona_fide"]["BPCER"]) / 2
    return result


def _pct(x: float) -> str:
    return "  n/a " if x != x else f"{100 * x:5.1f}%"


def render_text(report: dict) -> str:
    lines: list[str] = []
    bona = report["bona_fide"]
    lines.append("== Bona fide ==")
    if bona:
        lines.append(
            f"  n={bona['n']}  classified={bona['classified']}  rejected={bona['rejected']}  "
            f"BPCER={_pct(bona['BPCER'])} [{_pct(bona['BPCER_ci95'][0])}..{_pct(bona['BPCER_ci95'][1])}]  "
            f"BPNRR={_pct(bona['BPNRR'])}"
        )
        if bona["reject_reasons"]:
            lines.append("  false-reject reasons: " + ", ".join(f"{k}×{v}" for k, v in bona["reject_reasons"].items()))
    else:
        lines.append("  (no `bona_fide` sessions — BPCER cannot be computed)")
    lines.append("")
    lines.append("== Presentation attacks (per PAI species) ==")
    lines.append(f"  {'species':18s} {'n':>4s} {'clas':>4s} {'acc':>4s}  {'APCER':>7s}  {'95% CI':>17s}  {'APNRR':>7s}   caught by")
    for label, sp in report["species"].items():
        ci = f"[{_pct(sp['APCER_ci95'][0]).strip()}..{_pct(sp['APCER_ci95'][1]).strip()}]"
        caught = ", ".join(f"{k}×{v}" for k, v in list(sp["caught_by"].items())[:5]) or "-"
        lines.append(
            f"  {label:18s} {sp['n']:4d} {sp['classified']:4d} {sp['accepted']:4d}  {_pct(sp['APCER'])}  {ci:>17s}  {_pct(sp['APNRR'])}   {caught}"
        )
        for scores in sp["accepted_scores"][:3]:
            lines.append(f"      ↳ accepted with {scores}")
        if len(sp["accepted_scores"]) > 3:
            lines.append(f"      ↳ … {len(sp['accepted_scores']) - 3} more accepted")
    if not report["species"]:
        lines.append("  (no attack sessions)")
    lines.append("")
    summary = report["summary"]
    if summary:
        lines.append(
            f"== Summary ==  APCER_max={_pct(summary['APCER_max'])} ({summary['APCER_max_species']})"
            + (f"  ACER={_pct(summary['ACER'])}" if "ACER" in summary else "")
        )
    lines.append("")
    lines.append("Rates follow ISO/IEC 30107-3: APCER/BPCER over classified presentations; non-response")
    lines.append("(APNRR/BPNRR) reported separately. Wilson 95% intervals. This is an internal")
    lines.append("measurement, not a certification.")
    return "\n".join(lines)


def render_markdown(report: dict) -> str:
    lines = ["# PAD evaluation (ISO/IEC 30107-3 metrics)", ""]
    bona = report["bona_fide"]
    if bona:
        lines += [
            "## Bona fide", "",
            "| n | classified | rejected | BPCER | 95 % CI | BPNRR |", "|---|---|---|---|---|---|",
            f"| {bona['n']} | {bona['classified']} | {bona['rejected']} | {_pct(bona['BPCER']).strip()} | "
            f"{_pct(bona['BPCER_ci95'][0]).strip()} – {_pct(bona['BPCER_ci95'][1]).strip()} | {_pct(bona['BPNRR']).strip()} |",
            "",
        ]
    lines += ["## Attacks by PAI species", "", "| species | n | classified | accepted | APCER | 95 % CI | APNRR | caught by |", "|---|---|---|---|---|---|---|---|"]
    for label, sp in report["species"].items():
        caught = ", ".join(f"{k}×{v}" for k, v in list(sp["caught_by"].items())[:6]) or "-"
        lines.append(
            f"| {label} | {sp['n']} | {sp['classified']} | {sp['accepted']} | {_pct(sp['APCER']).strip()} | "
            f"{_pct(sp['APCER_ci95'][0]).strip()} – {_pct(sp['APCER_ci95'][1]).strip()} | {_pct(sp['APNRR']).strip()} | {caught} |"
        )
    summary = report["summary"]
    if summary:
        lines += ["", f"**APCER (max)** = {_pct(summary['APCER_max']).strip()} ({summary['APCER_max_species']})"
                  + (f", **ACER** = {_pct(summary['ACER']).strip()}" if "ACER" in summary else "")]
    lines += ["", "_Internal measurement per ISO/IEC 30107-3 metric definitions; not a certification._"]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("root", nargs="?", default=os.environ.get("EKYC_FRAMES_DIR", str(Path(__file__).resolve().parent.parent / "retained_frames")))
    parser.add_argument("--rescore", action="store_true", help="re-run the pipeline on the retained frames with the current backend/thresholds")
    parser.add_argument("--json", dest="json_out", help="write the full report as JSON")
    parser.add_argument("--markdown", dest="md_out", help="write a Markdown summary")
    parser.add_argument("--min-per-species", type=int, default=30, help="warn when a species has fewer presentations than this")
    args = parser.parse_args(argv)

    root = Path(args.root)
    if not root.is_dir():
        print(f"no such directory: {root}", file=sys.stderr)
        return 2
    presentations = load_presentations(root)
    if not presentations:
        print(f"no retained sessions under {root} (set EKYC_RETAIN_FRAMES=all and label your sessions)", file=sys.stderr)
        return 2
    if args.rescore:
        print(f"rescoring {len(presentations)} sessions with the current backend/thresholds…")
        presentations = rescore(root, presentations)

    reports = summarise(presentations)
    report = build_report(reports)
    for label, sp in reports.items():
        if sp.total < args.min_per_species:
            print(f"warning: `{label}` has only {sp.total} presentations (< {args.min_per_species}); its rate is not meaningful yet", file=sys.stderr)
    print(render_text(report))
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(report, indent=2, default=float), encoding="utf-8")
    if args.md_out:
        Path(args.md_out).write_text(render_markdown(report), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
