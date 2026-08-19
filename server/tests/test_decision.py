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
        yaw=0.0,
        eye_openness=0.30,
        sharpness=120.0,
        brightness=0.5,
        face_ratio=0.4,
        embedding=ALICE,
        # a shut, unsmiling neutral — what MediaPipe reads on a resting face
        mouth_open=0.05,
        smile=0.05,
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
            frames[name] = facts(name, yaw=-30.0)
        elif name == "turnRight":
            frames[name] = facts(name, yaw=30.0)
        elif name == "closeEyes":
            frames[name] = facts(name, eye_openness=0.08)
        elif name == "openMouth":
            frames[name] = facts(name, mouth_open=0.7)
        elif name == "smile":
            frames[name] = facts(name, smile=0.8)
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
        data.facts["turnLeft"] = facts("turnLeft", face_count=2, yaw=-30.0)
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
        data.facts["turnLeft"] = facts("turnLeft", yaw=-30.0, sharpness=1.0)
        assert "QUALITY_SHARPNESS" not in decide(data, TH).reasons

    def test_it_reports_every_quality_problem_at_once(self):
        data = good_case(["turnLeft"])
        data.facts["neutral"] = facts("neutral", sharpness=1.0, brightness=0.01, face_ratio=0.01)
        reasons = decide(data, TH).reasons
        assert {"QUALITY_SHARPNESS", "QUALITY_BRIGHTNESS", "QUALITY_FACE_TOO_SMALL"} <= set(reasons)


class TestPad:
    def test_it_rejects_when_any_frame_looks_like_a_screen(self):
        data = good_case(["turnLeft", "turnRight"])
        data.facts["turnRight"] = facts("turnRight", yaw=30.0, pad=0.1)
        assert "PAD_LOW" in decide(data, TH).reasons

    def test_it_scores_the_worst_frame_not_the_average(self):
        data = good_case(["turnLeft", "turnRight"])
        data.facts["turnRight"] = facts("turnRight", yaw=30.0, pad=0.3)
        assert decide(data, TH).scores["pad"] == pytest.approx(0.3)


class TestPose:
    def test_it_rejects_a_neutral_frame_in_profile(self):
        data = good_case(["turnLeft"])
        data.facts["neutral"] = facts("neutral", yaw=68.0)
        assert "POSE_NOT_FRONTAL" in decide(data, TH).reasons

    def test_it_tolerates_the_per_person_bias_in_a_frontal_frame(self):
        """LFW puts |yawProxy| at 0.18 median for frontal faces; that must pass."""
        data = good_case(["turnLeft", "turnRight"])
        data.facts["neutral"] = facts("neutral", yaw=18.0)
        data.facts["turnLeft"] = facts("turnLeft", yaw=-15.0)
        data.facts["turnRight"] = facts("turnRight", yaw=52.0)
        assert decide(data, TH).passed, decide(data, TH).reasons

    def test_turn_size_is_measured_from_the_persons_own_neutral(self):
        """A biased neutral frame must not turn a real turn into a failure."""
        data = good_case(["turnLeft"])
        data.facts["neutral"] = facts("neutral", yaw=22.0)
        data.facts["turnLeft"] = facts("turnLeft", yaw=11.0)  # abs is big, delta is small
        assert "POSE_INSUFFICIENT_TURN" in decide(data, TH).reasons
        assert decide(data, TH).scores["steps"]["turnLeft"]["yawDelta"] == pytest.approx(-11.0)

    def test_it_rejects_a_head_that_barely_moved(self):
        data = good_case(["turnLeft"])
        data.facts["turnLeft"] = facts("turnLeft", yaw=-4.0)
        assert "POSE_INSUFFICIENT_TURN" in decide(data, TH).reasons

    def test_it_rejects_two_turns_in_the_same_direction(self):
        data = good_case(["turnLeft", "turnRight"])
        data.facts["turnRight"] = facts("turnRight", yaw=-30.0)
        assert "POSE_SAME_DIRECTION" in decide(data, TH).reasons

    def test_it_accepts_either_absolute_direction_for_a_given_label(self):
        """The rule is 'opposite', never 'left is negative' — mirroring must not matter."""
        mirrored = good_case(["turnLeft", "turnRight"])
        mirrored.facts["turnLeft"] = facts("turnLeft", yaw=30.0)
        mirrored.facts["turnRight"] = facts("turnRight", yaw=-30.0)
        assert decide(mirrored, TH).passed

    def test_the_same_direction_rule_needs_both_turns_present(self):
        data = good_case(["turnLeft"])
        assert decide(data, TH).passed


class TestEyes:
    def test_it_measures_closure_against_the_persons_own_neutral_frame(self):
        data = good_case(["closeEyes"])
        data.facts["neutral"] = facts("neutral", eye_openness=0.34)
        data.facts["closeEyes"] = facts("closeEyes", eye_openness=0.11)
        assert decide(data, TH).scores["steps"]["closeEyes"]["ratio"] == pytest.approx(0.11 / 0.34, abs=1e-3)

    def test_open_eyes_fail_the_closed_eyes_step(self):
        data = good_case(["closeEyes"])
        data.facts["closeEyes"] = facts("closeEyes", eye_openness=0.30)
        assert "EYES_NOT_CLOSED" in decide(data, TH).reasons

    def test_the_rule_can_be_downgraded_to_advisory(self):
        """Kept as an escape hatch: measured and scored, but not decisive."""
        lenient = Thresholds(eye_rule="advisory")
        data = good_case(["closeEyes"])
        data.facts["closeEyes"] = facts("closeEyes", eye_openness=0.30)
        out = decide(data, lenient)
        assert out.passed
        assert out.scores["steps"]["closeEyes"]["ok"] is False

    def test_a_low_ratio_is_not_enough_without_a_low_absolute_ear(self):
        """A neutral frame caught mid-blink would make any ratio look fine."""
        data = good_case(["closeEyes"])
        data.facts["neutral"] = facts("neutral", eye_openness=0.60)
        data.facts["closeEyes"] = facts("closeEyes", eye_openness=0.25)
        assert "EYES_NOT_CLOSED" in decide(data, TH).reasons

    def test_an_unmeasurable_neutral_frame_fails_closed(self):
        data = good_case(["closeEyes"])
        data.facts["neutral"] = facts("neutral", eye_openness=0.0)
        assert "EYES_NOT_CLOSED" in decide(data, TH).reasons

    def test_blendshape_blink_is_reported_alongside_the_geometry(self):
        data = good_case(["closeEyes"])
        data.facts["closeEyes"] = facts(
            "closeEyes", eye_openness=0.08, blendshapes={"eyeBlinkLeft": 0.94, "eyeBlinkRight": 0.91}
        )
        assert decide(data, TH).scores["steps"]["closeEyes"]["blinkBlendshape"] == pytest.approx(0.94)


class TestIdentityConsistency:
    def test_it_catches_a_swapped_face(self):
        data = good_case(["turnLeft"])
        data.facts["turnLeft"] = facts("turnLeft", yaw=-30.0, embedding=BOB)
        assert "IDENTITY_INCONSISTENT" in decide(data, TH).reasons

    def test_it_tolerates_the_pose_change_of_one_person(self):
        blended = (0.75 * ALICE + 0.25 * BOB).astype(np.float32)
        data = good_case(["turnLeft"])
        data.facts["turnLeft"] = facts("turnLeft", yaw=-30.0, embedding=blended)
        assert decide(data, TH).passed

    def test_it_reports_the_worst_pair_not_the_mean(self):
        data = good_case(["turnLeft", "turnRight"])
        data.facts["turnRight"] = facts("turnRight", yaw=30.0, embedding=BOB)
        assert decide(data, TH).scores["identityConsistency"] == pytest.approx(0.0, abs=1e-6)


# --- active-flash liveness (server-issued random colour sequence) -----------
from app.flash import FLASH_PALETTE  # noqa: E402

FLASH_CMD = [FLASH_PALETTE[k] for k in ("red", "green", "blue", "white")]


def _reflected(cmd):
    """Mean face colour a real face would show under this flash colour."""
    amb, alb, k = np.array([0.2, 0.18, 0.16]), np.array([0.9, 0.6, 0.5]), 0.35
    return tuple(np.clip(amb + alb * k * np.asarray(cmd), 0.0, 1.0))


def with_flash(data: DecisionInput, observed) -> DecisionInput:
    for i, rgb in enumerate(observed):
        data.facts[f"flash_{i}"] = facts(f"flash_{i}", face_rgb=tuple(float(v) for v in rgb))
    data.flash_commanded = FLASH_CMD
    return data


class TestActiveFlash:
    def test_a_face_that_reflects_the_flash_passes(self):
        out = decide(with_flash(good_case(), [_reflected(c) for c in FLASH_CMD]), TH)
        assert out.passed, out.reasons
        assert out.scores["flash"] > TH.flash_min

    def test_a_photo_that_holds_one_colour_scores_low_and_is_advisory_by_default(self):
        photo = [(0.5, 0.4, 0.35)] * len(FLASH_CMD)
        out = decide(with_flash(good_case(), photo), TH)
        assert out.scores["flash"] < TH.flash_min
        assert out.scores["flashRule"] == "advisory"
        assert "FLASH_SPOOF" not in out.reasons  # recorded, not enforced, until phones are measured

    def test_enforce_flags_a_photo_and_a_replay_of_a_different_sequence(self):
        enforce = Thresholds(flash_rule="enforce")
        photo = [(0.5, 0.4, 0.35)] * len(FLASH_CMD)
        assert "FLASH_SPOOF" in decide(with_flash(good_case(), photo), enforce).reasons
        other = [FLASH_PALETTE[k] for k in ("blue", "white", "red", "green")]
        out = decide(with_flash(good_case(), [_reflected(c) for c in other]), enforce)
        assert "FLASH_SPOOF" in out.reasons
        # and a real reflection still passes under enforce
        assert decide(with_flash(good_case(), [_reflected(c) for c in FLASH_CMD]), enforce).passed

    def test_a_missing_flash_frame_is_caught(self):
        data = with_flash(good_case(), [_reflected(c) for c in FLASH_CMD])
        del data.facts["flash_2"]
        assert "FLASH_FRAME_MISSING" in decide(data, TH).reasons

    def test_sessions_without_a_flash_plan_are_untouched(self):
        out = decide(good_case(), TH)  # flash_commanded defaults empty
        assert out.passed
        assert "flash" not in out.scores


# --- injection / deepfake defence -------------------------------------------
from app.schemas import Attestation  # noqa: E402


class TestInjectionDefence:
    def test_a_repeated_frame_across_steps_is_flagged(self):
        data = good_case()
        data.frame_hashes = {"neutral": "a", "turnLeft": "DUP", "turnRight": "DUP", "closeEyes": "d"}
        assert "FRAMES_DUPLICATE" in decide(data, TH).reasons

    def test_distinct_frames_are_fine(self):
        data = good_case()
        data.frame_hashes = {"neutral": "a", "turnLeft": "b", "turnRight": "c", "closeEyes": "d"}
        assert decide(data, TH).passed, decide(data, TH).reasons

    def test_attestation_required_but_absent_is_rejected(self):
        th = Thresholds(require_attestation=True)
        assert "ATTESTATION_MISSING" in decide(good_case(), th).reasons

    def test_attestation_required_and_none_type_is_rejected(self):
        th = Thresholds(require_attestation=True)
        data = good_case()
        data.manifest.attestation = Attestation(type="none", token=None)
        assert "ATTESTATION_MISSING" in decide(data, th).reasons

    def test_attestation_required_and_present_passes(self):
        th = Thresholds(require_attestation=True)
        data = good_case()
        data.manifest.attestation = Attestation(type="playIntegrity", token="tok")
        assert decide(data, th).passed, decide(data, th).reasons

    def test_attestation_not_required_by_default(self):
        assert decide(good_case(), TH).passed


# --- depth / 3-D landmark planarity (advisory flat-input cue) ----------------
from app.ml.geometry import planarity_score  # noqa: E402


class TestPlanarity:
    def test_flat_scores_near_zero_tilted_plane_too_and_3d_scores_higher(self):
        rng = np.random.default_rng(0)
        xy = rng.random((300, 2))
        flat = np.column_stack([xy, np.zeros(300)])
        tilted = np.column_stack([xy, 0.7 * xy[:, 0] - 0.3 * xy[:, 1]])  # a tilted plane
        d3 = np.column_stack([xy, rng.random(300) * 0.5])
        assert planarity_score(flat) < 1e-6
        assert planarity_score(tilted) < 1e-3  # rotation-invariant: a plane is a plane
        assert planarity_score(d3) > 0.02
        assert planarity_score(np.zeros((2, 3))) == -1.0  # degenerate sentinel

    def test_gate_is_advisory_by_default(self):
        data = good_case()
        for f in data.facts.values():
            f.planarity = 0.0001
        out = decide(data, TH)
        assert out.passed, out.reasons
        assert "planarity" in out.scores

    def test_enforce_rejects_a_flat_neutral(self):
        th = Thresholds(planarity_rule="enforce")
        data = good_case()
        data.facts["neutral"].planarity = 0.0001
        assert "FLAT_FACE" in decide(data, th).reasons

    def test_enforce_passes_a_3d_neutral(self):
        th = Thresholds(planarity_rule="enforce")
        data = good_case()
        for f in data.facts.values():
            f.planarity = 0.05
        assert decide(data, th).passed, decide(data, th).reasons

    def test_unmeasured_planarity_is_skipped(self):
        assert "planarity" not in decide(good_case(), TH).scores


# --- expression challenges: the rigid-mask defence ---------------------------


class TestExpressions:
    def test_an_open_mouth_passes(self):
        out = decide(good_case(["openMouth", "turnLeft", "turnRight"]), TH)
        assert out.passed, out.reasons
        assert out.scores["steps"]["openMouth"]["ok"] is True

    def test_a_smile_passes(self):
        out = decide(good_case(["smile", "turnLeft", "turnRight"]), TH)
        assert out.passed, out.reasons

    def test_a_mask_that_cannot_open_its_mouth_fails(self):
        data = good_case(["openMouth", "turnLeft", "turnRight"])
        data.facts["openMouth"] = facts("openMouth", mouth_open=0.08)  # rigid: jaw never moves
        out = decide(data, TH)
        assert "MOUTH_NOT_OPEN" in out.reasons
        assert out.scores["steps"]["openMouth"]["ok"] is False

    def test_a_permanently_gaping_mask_does_not_pass_on_delta_alone(self):
        # The neutral frame already gapes (0.5) and the "open" frame gapes a
        # little more (0.72): the absolute bar is met but the rise is small.
        data = good_case(["openMouth"])
        data.facts["neutral"] = facts("neutral", mouth_open=0.55)
        data.facts["openMouth"] = facts("openMouth", mouth_open=0.7)
        assert "MOUTH_NOT_OPEN" in decide(data, TH).reasons

    def test_a_small_rise_from_shut_is_not_enough_either(self):
        data = good_case(["openMouth"])
        data.facts["openMouth"] = facts("openMouth", mouth_open=0.3)  # rose 0.25 but under the bar
        assert "MOUTH_NOT_OPEN" in decide(data, TH).reasons

    def test_no_smile_fails(self):
        data = good_case(["smile"])
        data.facts["smile"] = facts("smile", smile=0.1)
        assert "SMILE_ABSENT" in decide(data, TH).reasons

    def test_an_unmeasurable_expression_fails_closed(self):
        data = good_case(["openMouth"])
        data.facts["openMouth"] = facts("openMouth", mouth_open=-1.0)
        assert "EXPRESSION_UNVERIFIABLE" in decide(data, TH).reasons

    def test_the_rule_can_be_downgraded_to_advisory(self):
        data = good_case(["openMouth"])
        data.facts["openMouth"] = facts("openMouth", mouth_open=0.08)
        out = decide(data, Thresholds(expression_rule="advisory"))
        assert out.passed, out.reasons
        assert out.scores["steps"]["openMouth"]["ok"] is False


# --- PAD is judged on the challenge frames only ------------------------------


class TestPadScope:
    def test_a_low_pad_on_a_flash_frame_does_not_fail_the_session(self):
        data = with_flash(good_case(), [_reflected(c) for c in FLASH_CMD])
        data.facts["flash_0"] = facts("flash_0", pad=0.1, face_rgb=data.facts["flash_0"].face_rgb)
        out = decide(data, TH)
        assert "PAD_LOW" not in out.reasons, out.reasons
        assert out.scores["pad"] == pytest.approx(0.95)

    def test_a_low_pad_on_a_challenge_frame_still_fails(self):
        data = good_case()
        data.facts["turnLeft"] = facts("turnLeft", yaw=-30.0, pad=0.1)
        assert "PAD_LOW" in decide(data, TH).reasons


# --- rPPG pulse: the silicone-mask defence ------------------------------------

from app.pulse import MIN_FRAMES as PULSE_MIN_FRAMES  # noqa: E402


def _pulse_samples(rng, *, beating: bool, fs=12, secs=7, amp=0.002, noise=0.001):
    n = int(fs * secs)
    t = np.cumsum(np.full(n, 1000.0 / fs) * (1 + rng.normal(0, 0.02, n)))
    t = (t - t[0]).astype(int)
    base = np.array([0.62, 0.45, 0.38])
    pulse = np.sin(2 * np.pi * 1.2 * t / 1000.0) if beating else np.zeros(n)
    samples = []
    for i in range(n):
        patches = []
        for _ in range(3):
            rgb = base + pulse[i] * np.array([amp * 0.5, amp, amp * 0.4]) + rng.normal(0, noise, 3)
            patches.append(tuple(float(v) for v in rgb))
        samples.append((int(t[i]), patches))
    return samples


def with_pulse(data: DecisionInput, samples, requested: int = 60) -> DecisionInput:
    data.pulse_requested = requested
    data.pulse_samples = samples
    return data


class TestPulse:
    def test_no_plan_no_check(self):
        out = decide(good_case(), TH)
        assert "pulse" not in out.scores

    def test_a_beating_face_clears_the_gate(self):
        rng = np.random.default_rng(11)
        out = decide(with_pulse(good_case(), _pulse_samples(rng, beating=True)), TH)
        assert out.passed, out.reasons
        assert out.scores["pulse"]["ok"] is True
        assert 60 < out.scores["pulse"]["bpm"] < 84

    def test_a_pulseless_mask_is_recorded_but_advisory_by_default(self):
        rng = np.random.default_rng(12)
        out = decide(with_pulse(good_case(), _pulse_samples(rng, beating=False)), TH)
        assert out.scores["pulse"]["ok"] is False
        assert out.scores["pulse"]["rule"] == "advisory"
        assert "PULSE_ABSENT" not in out.reasons

    def test_enforce_rejects_a_pulseless_mask(self):
        rng = np.random.default_rng(13)
        out = decide(
            with_pulse(good_case(), _pulse_samples(rng, beating=False)),
            Thresholds(pulse_rule="enforce"),
        )
        assert "PULSE_ABSENT" in out.reasons

    def test_enforce_passes_a_beating_face(self):
        rng = np.random.default_rng(14)
        out = decide(
            with_pulse(good_case(), _pulse_samples(rng, beating=True)),
            Thresholds(pulse_rule="enforce"),
        )
        assert out.passed, out.reasons

    def test_a_burst_that_came_back_too_short_is_a_protocol_failure(self):
        rng = np.random.default_rng(15)
        samples = _pulse_samples(rng, beating=True)[: PULSE_MIN_FRAMES - 4]
        out = decide(with_pulse(good_case(), samples), TH)
        assert "PULSE_FRAME_MISSING" in out.reasons

    def test_pulse_anchor_frames_join_the_identity_check(self):
        rng = np.random.default_rng(16)
        data = with_pulse(good_case(), _pulse_samples(rng, beating=True))
        data.facts["pulse_0"] = facts("pulse_0", embedding=BOB)  # someone else's heartbeat
        assert "IDENTITY_INCONSISTENT" in decide(data, TH).reasons
