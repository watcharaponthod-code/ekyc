"""The ISO/IEC 30107-3 evaluation harness, on synthetic retained sessions."""

from __future__ import annotations

import importlib.util
import json
import math
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "pad_eval.py"
spec = importlib.util.spec_from_file_location("pad_eval", SCRIPT)
pad_eval = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["pad_eval"] = pad_eval  # dataclasses resolve annotations through sys.modules
spec.loader.exec_module(pad_eval)


def _session(root: Path, label: str, sid: str, decision: str, reasons: list[str], scores: dict | None = None) -> None:
    d = root / label / sid
    d.mkdir(parents=True)
    (d / "manifest.json").write_text("{}")
    (d / "decision.json").write_text(json.dumps({"decision": decision, "reasons": reasons, "scores": scores or {}}))
    (d / "neutral.jpg").write_bytes(b"\xff\xd8\xff\xd9")


@pytest.fixture
def evaluation_root(tmp_path):
    root = tmp_path / "kept"
    # 10 bona fide: 9 pass, 1 rejected on quality, 0 non-response
    for i in range(9):
        _session(root, "bona_fide", f"b{i}", "pass", [], {"pad": 0.9})
    _session(root, "bona_fide", "b9", "fail", ["QUALITY_SHARPNESS"])
    # print: 8 caught by PAD, 1 got through, 1 non-response (no face)
    for i in range(8):
        _session(root, "print_a4", f"p{i}", "fail", ["PAD_LOW", "FLASH_SPOOF"])
    _session(root, "print_a4", "p8", "pass", [], {"pad": 0.6, "flash": 0.7})
    _session(root, "print_a4", "p9", "fail", ["NO_FACE"])
    # silicone mask: 3 caught by open-mouth, 2 by pulse, 5 accepted
    for i in range(3):
        _session(root, "mask_silicone", f"m{i}", "fail", ["MOUTH_NOT_OPEN"])
    for i in range(3, 5):
        _session(root, "mask_silicone", f"m{i}", "fail", ["PULSE_ABSENT"])
    for i in range(5, 10):
        _session(root, "mask_silicone", f"m{i}", "pass", [], {"pad": 0.8, "pulse": {"score": 0.3}})
    return root


def test_it_computes_the_iso_rates(evaluation_root):
    presentations = pad_eval.load_presentations(evaluation_root)
    assert len(presentations) == 30
    report = pad_eval.build_report(pad_eval.summarise(presentations))

    bona = report["bona_fide"]
    assert bona["n"] == 10 and bona["rejected"] == 1
    assert bona["BPCER"] == pytest.approx(0.1)
    assert bona["reject_reasons"] == {"QUALITY_SHARPNESS": 1}

    print_ = report["species"]["print_a4"]
    assert print_["n"] == 10 and print_["classified"] == 9 and print_["accepted"] == 1
    assert print_["APCER"] == pytest.approx(1 / 9)
    assert print_["APNRR"] == pytest.approx(0.1)
    assert print_["caught_by"] == {"PAD_LOW": 8, "FLASH_SPOOF": 8}
    assert print_["accepted_scores"] == [{"pad": 0.6, "flash": 0.7}]

    mask = report["species"]["mask_silicone"]
    assert mask["APCER"] == pytest.approx(0.5)
    assert mask["caught_by"] == {"MOUTH_NOT_OPEN": 3, "PULSE_ABSENT": 2}
    assert mask["accepted_scores"][0]["pulse"] == 0.3

    assert report["summary"]["APCER_max_species"] == "mask_silicone"
    assert report["summary"]["APCER_max"] == pytest.approx(0.5)
    assert report["summary"]["ACER"] == pytest.approx((0.5 + 0.1) / 2)


def test_wilson_interval_is_sane():
    rate, lo, hi = pad_eval.wilson(0, 30)
    assert rate == 0.0 and lo == 0.0 and 0.1 < hi < 0.15  # 0/30 is *not* "0 %"
    rate, lo, hi = pad_eval.wilson(30, 30)
    assert rate == 1.0 and hi == 1.0 and 0.85 < lo < 0.9
    assert all(math.isnan(v) for v in pad_eval.wilson(0, 0))


def test_non_response_is_kept_out_of_the_error_rates():
    p = pad_eval.Presentation("x", "s", "fail", ["FRAME_MISSING"], {})
    assert p.non_response and not p.accepted
    q = pad_eval.Presentation("x", "s", "fail", ["PAD_LOW"], {})
    assert not q.non_response


def test_the_cli_renders_text_json_and_markdown(evaluation_root, tmp_path, capsys):
    code = pad_eval.main([str(evaluation_root), "--json", str(tmp_path / "r.json"), "--markdown", str(tmp_path / "r.md"), "--min-per-species", "5"])
    assert code == 0
    out = capsys.readouterr().out
    assert "mask_silicone" in out and "APCER_max" in out and "BPCER" in out
    data = json.loads((tmp_path / "r.json").read_text())
    assert data["summary"]["APCER_max_species"] == "mask_silicone"
    md = (tmp_path / "r.md").read_text(encoding="utf-8")
    assert md.startswith("# PAD evaluation") and "| mask_silicone |" in md


def test_an_empty_or_missing_root_is_an_error(tmp_path):
    assert pad_eval.main([str(tmp_path / "nope")]) == 2
    (tmp_path / "empty").mkdir()
    assert pad_eval.main([str(tmp_path / "empty")]) == 2
