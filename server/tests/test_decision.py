"""Rules, exhaustively. No models, no database, no I/O."""

from __future__ import annotations

import numpy as np
import pytest

from app.config import Thresholds
from app.decision import DecisionInput, decide
from app.ml.backend import FrameFacts
from app.schemas import EvidenceManifest, StepObservation

TH = Thresholds()

ALICE = np.zeros(512, dtype=np.float32)
ALICE[0] = 1.0
BOB = np.zeros(512, dtype=np.float32)
BOB[1] = 1.0


def facts(key: str, **overrides) -> FrameFacts:
    base = dict(
        key=key,
        face_count=1,
        det_score=0.9,
        pad=0.95,
        yaw_proxy=0.0,
        eye_openness=0.6,
        sharpness=120.0,
        brightness=0.5,
        face_ratio=0.4,
        embedding=ALICE,
    )
    base.update(overrides)
    return FrameFacts(**base)  # type: ignore[arg-type]


def manifest(names: list[str], **overrides) -> EvidenceManifest:
    steps = []
    start = 1_000
    for name in ["center", *names]:
        steps.append(StepObservation(name=name, tStart=start, tEnd=start + 900))
        start += 1_200
    payload = dict(nonce="n", startedAt=1_000, finishedAt=start + 1_000, steps=steps)
    payload.update(overrides)
    return EvidenceManifest(**payload)  # type: ignore[arg-type]


def good_case(names=("closeEyes", "turnLeft", "turnRight")):
    names = list(names)
    frames = {"neutral": facts("neutral")}
    for name in names:
        if name == "turnLeft":
            frames[name] = facts(name, yaw_proxy=-0.4)
        elif name == "turnRight":
            frames[name] = facts(name, yaw_proxy=0.4)
        elif name == "closeEyes":
            frames[name] = facts(name, eye_openness=0.2)
        else:
            frames[name] = facts(name)
    return DecisionInput(names, manifest(names), frames)


class TestHappyPath:
    def test_a_complete_honest_session_passes(self):
        out = decide(good_case(), TH)
        assert out.passed, out.reasons

    def test_it_reports_the_numbers_behind_the_verdict(self):
        out = decide(good_case(), TH)
        assert out.scores["pad"] == pytest.approx(0.95)
        assert out.scores["identityConsistency"] == pytest.approx(1.0)
        assert out.scores["steps"]["turnLeft"]["ok"] is True

    def test_a_single_challenge_session_passes(self):
        out = decide(good_case(["turnLeft"]), TH)
        assert out.passed, out.reasons


class TestStructure:
    def test_it_rejects_a_client_that_reordered_the_challenges(self):
        data = good_case(["turnLeft", "turnRight"])
        data.manifest = manifest(["turnRight", "turnLeft"])
        assert decide(data, TH).reasons == ["CHALLENGE_MISMATCH"]

    def test_it_rejects_a_client_that_substituted_a_challenge(self):
        data = good_case(["turnLeft"])
        data.manifest = manifest(["smile"])
        assert decide(data, TH).reasons == ["CHALLENGE_MISMATCH"]

    def test_it_rejects_a_missing_frame(self):
        data = good_case(["turnLeft", "turnRight"])
        del data.facts["turnRight"]
        assert decide(data, TH).reasons == ["FRAME_MISSING"]

    def test_it_rejects_a_session_finished_impossibly_fast(self):
        data = good_case(["turnLeft"])
        data.manifest.finishedAt = data.manifest.startedAt + 500
        assert decide(data, TH).reasons == ["TIMING_IMPLAUSIBLE"]

    def test_it_rejects_an_instant_step(self):
        data = good_case(["turnLeft"])
        data.manifest.steps[1].tEnd = data.manifest.steps[1].tStart + 10
        assert decide(data, TH).reasons == ["TIMING_IMPLAUSIBLE"]

    def test_it_rejects_overlapping_steps(self):
        data = good_case(["turnLeft", "turnRight"])
        data.manifest.steps[2].tStart = data.manifest.steps[1].tStart - 100
        assert decide(data, TH).reasons == ["TIMING_IMPLAUSIBLE"]

    def test_it_rejects_a_frame_with_no_face(self):
        data = good_case(["turnLeft"])
        data.facts["turnLeft"] = facts("turnLeft", face_count=0)
        assert decide(data, TH).reasons == ["NO_FACE"]

    def test_it_rejects_a_barely_detected_face(self):
        data = good_case(["turnLeft"])
        data.facts["neutral"] = facts("neutral", det_score=0.2)
        assert decide(data, TH).reasons == ["NO_FACE"]

    def test_it_rejects_a_second_person_in_frame(self):
        data = good_case(["turnLeft"])
        data.facts["turnLeft"] = facts("turnLeft", face_count=2, yaw_proxy=-0.4)
        assert decide(data, TH).reasons == ["MULTIPLE_FACES"]

    def test_structural_failure_short_circuits_the_rest(self):
        data = good_case(["turnLeft"])
        data.facts["neutral"] = facts("neutral", face_count=0, pad=0.0, sharpness=1.0)
        assert decide(data, TH).reasons == ["NO_FACE"]


class TestQuality:
    def test_it_rejects_a_blurred_face(self):
        data = good_case(["turnLeft"])
        data.facts["neutral"] = facts("neutral", sharpness=10.0)
        assert "QUALITY_SHARPNESS" in decide(data, TH).reasons

    @pytest.mark.parametrize("value", [0.05, 0.99])
    def test_it_rejects_bad_exposure(self, value):
        data = good_case(["turnLeft"])
        data.facts["neutral"] = facts("neutral", brightness=value)
        assert "QUALITY_BRIGHTNESS" in decide(data, TH).reasons

    def test_it_rejects_a_face_too_small_to_judge(self):
        data = good_case(["turnLeft"])
        data.facts["neutral"] = facts("neutral", face_ratio=0.05)
        assert "QUALITY_FACE_TOO_SMALL" in decide(data, TH).reasons

    def test_quality_only_judges_the_neutral_frame(self):
        data = good_case(["turnLeft"])
        data.facts["turnLeft"] = facts("turnLeft", yaw_proxy=-0.4, sharpness=1.0)
        assert "QUALITY_SHARPNESS" not in decide(data, TH).reasons

    def test_it_reports_every_quality_problem_at_once(self):
        data = good_case(["turnLeft"])
        data.facts["neutral"] = facts("neutral", sharpness=1.0, brightness=0.01, face_ratio=0.01)
        reasons = decide(data, TH).reasons
        assert {"QUALITY_SHARPNESS", "QUALITY_BRIGHTNESS", "QUALITY_FACE_TOO_SMALL"} <= set(reasons)


class TestPad:
    def test_it_rejects_when_any_frame_looks_like_a_screen(self):
        data = good_case(["turnLeft", "turnRight"])
        data.facts["turnRight"] = facts("turnRight", yaw_proxy=0.4, pad=0.1)
        assert "PAD_LOW" in decide(data, TH).reasons

    def test_it_scores_the_worst_frame_not_the_average(self):
        data = good_case(["turnLeft", "turnRight"])
        data.facts["turnRight"] = facts("turnRight", yaw_proxy=0.4, pad=0.3)
        assert decide(data, TH).scores["pad"] == pytest.approx(0.3)


class TestPose:
    def test_it_rejects_a_neutral_frame_in_profile(self):
        data = good_case(["turnLeft"])
        data.facts["neutral"] = facts("neutral", yaw_proxy=0.9)
        assert "POSE_NOT_FRONTAL" in decide(data, TH).reasons

    def test_it_tolerates_the_per_person_bias_in_a_frontal_frame(self):
        """LFW puts |yawProxy| at 0.18 median for frontal faces; that must pass."""
        data = good_case(["turnLeft", "turnRight"])
        data.facts["neutral"] = facts("neutral", yaw_proxy=0.25)
        data.facts["turnLeft"] = facts("turnLeft", yaw_proxy=-0.20)
        data.facts["turnRight"] = facts("turnRight", yaw_proxy=0.70)
        assert decide(data, TH).passed, decide(data, TH).reasons

    def test_turn_size_is_measured_from_the_persons_own_neutral(self):
        """A biased neutral frame must not turn a real turn into a failure."""
        data = good_case(["turnLeft"])
        data.facts["neutral"] = facts("neutral", yaw_proxy=0.30)
        data.facts["turnLeft"] = facts("turnLeft", yaw_proxy=0.15)  # abs is big, delta is small
        assert "POSE_INSUFFICIENT_TURN" in decide(data, TH).reasons
        assert decide(data, TH).scores["steps"]["turnLeft"]["yawDelta"] == pytest.approx(-0.15)

    def test_it_rejects_a_head_that_barely_moved(self):
        data = good_case(["turnLeft"])
        data.facts["turnLeft"] = facts("turnLeft", yaw_proxy=-0.05)
        assert "POSE_INSUFFICIENT_TURN" in decide(data, TH).reasons

    def test_it_rejects_two_turns_in_the_same_direction(self):
        data = good_case(["turnLeft", "turnRight"])
        data.facts["turnRight"] = facts("turnRight", yaw_proxy=-0.4)
        assert "POSE_SAME_DIRECTION" in decide(data, TH).reasons

    def test_it_accepts_either_absolute_direction_for_a_given_label(self):
        """The rule is 'opposite', never 'left is negative' — mirroring must not matter."""
        mirrored = good_case(["turnLeft", "turnRight"])
        mirrored.facts["turnLeft"] = facts("turnLeft", yaw_proxy=0.4)
        mirrored.facts["turnRight"] = facts("turnRight", yaw_proxy=-0.4)
        assert decide(mirrored, TH).passed

    def test_the_same_direction_rule_needs_both_turns_present(self):
        data = good_case(["turnLeft"])
        assert decide(data, TH).passed


class TestEyes:
    def test_it_measures_closure_against_the_persons_own_neutral_frame(self):
        data = good_case(["closeEyes"])
        data.facts["neutral"] = facts("neutral", eye_openness=1.2)
        data.facts["closeEyes"] = facts("closeEyes", eye_openness=0.4)
        assert decide(data, TH).scores["steps"]["closeEyes"]["ratio"] == pytest.approx(1 / 3, abs=1e-4)

    def test_open_eyes_do_not_fail_the_session_while_the_rule_is_advisory(self):
        data = good_case(["closeEyes"])
        data.facts["closeEyes"] = facts("closeEyes", eye_openness=0.6)
        out = decide(data, TH)
        assert out.passed
        assert out.scores["steps"]["closeEyes"]["ok"] is False

    def test_enforcing_the_rule_rejects_open_eyes(self):
        strict = Thresholds(eye_rule="enforce")
        data = good_case(["closeEyes"])
        data.facts["closeEyes"] = facts("closeEyes", eye_openness=0.6)
        assert "EYES_NOT_CLOSED" in decide(data, strict).reasons

    def test_an_unmeasurable_neutral_frame_fails_closed(self):
        strict = Thresholds(eye_rule="enforce")
        data = good_case(["closeEyes"])
        data.facts["neutral"] = facts("neutral", eye_openness=0.0)
        assert "EYES_NOT_CLOSED" in decide(data, strict).reasons


class TestIdentityConsistency:
    def test_it_catches_a_swapped_face(self):
        data = good_case(["turnLeft"])
        data.facts["turnLeft"] = facts("turnLeft", yaw_proxy=-0.4, embedding=BOB)
        assert "IDENTITY_INCONSISTENT" in decide(data, TH).reasons

    def test_it_tolerates_the_pose_change_of_one_person(self):
        blended = (0.75 * ALICE + 0.25 * BOB).astype(np.float32)
        data = good_case(["turnLeft"])
        data.facts["turnLeft"] = facts("turnLeft", yaw_proxy=-0.4, embedding=blended)
        assert decide(data, TH).passed

    def test_it_reports_the_worst_pair_not_the_mean(self):
        data = good_case(["turnLeft", "turnRight"])
        data.facts["turnRight"] = facts("turnRight", yaw_proxy=0.4, embedding=BOB)
        assert decide(data, TH).scores["identityConsistency"] == pytest.approx(0.0, abs=1e-6)
