"""rPPG pulse scorer, proven on synthetic skin-colour traces.

A real face: three skin patches whose colour oscillates at one heart rate
(green strongest, as haemoglobin absorbs), each with its own noise. A silicone
mask / photo / static spoof: the same patches with noise and no oscillation.
The score must separate them when the pulse amplitude is comfortably above the
noise, and must fail *closed* (score 0) on inputs it cannot judge.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.pulse import MIN_FRAMES, PROMINENCE_CENTRE_DB, PulseResult, pulse_liveness_score

BASE = np.array([0.62, 0.45, 0.38])


def _times(fs: float, secs: float, rng, jitter: float = 0.02) -> np.ndarray:
    n = int(fs * secs)
    dt = np.full(n, 1000.0 / fs) * (1 + rng.normal(0, jitter, n))
    t = np.cumsum(dt)
    return (t - t[0]).astype(int)


def _trace(t: np.ndarray, rng, *, bpm: float | None, amp: float, noise: float, patches: int = 3, drift: float = 0.0):
    n = len(t)
    pulse = np.sin(2 * np.pi * (bpm / 60.0) * t / 1000.0) if bpm else np.zeros(n)
    out = np.zeros((n, patches, 3))
    for k in range(patches):
        gain = rng.uniform(0.7, 1.3)
        out[:, k, :] = (
            BASE * (1 + drift * np.linspace(0, 1, n))[:, None]
            + np.outer(pulse, [amp * 0.5, amp, amp * 0.4]) * gain
            + rng.normal(0, noise, (n, 3))
        )
    return np.clip(out, 0, 1)


def real(rng, fs=12, secs=7, amp=0.002, noise=0.001, **kw):
    t = _times(fs, secs, rng)
    return t, _trace(t, rng, bpm=rng.uniform(55, 95), amp=amp, noise=noise, **kw)


def mask(rng, fs=12, secs=7, noise=0.001, **kw):
    t = _times(fs, secs, rng)
    return t, _trace(t, rng, bpm=None, amp=0.0, noise=noise, **kw)


class TestSeparation:
    def test_a_beating_face_scores_high_and_reads_the_right_rate(self):
        rng = np.random.default_rng(1)
        t = _times(15, 8, rng)
        colors = _trace(t, rng, bpm=72, amp=0.002, noise=0.0008)
        result = pulse_liveness_score(t, colors)
        assert result.score > 0.8, result
        assert abs(result.bpm - 72) < 6, result
        assert result.patches == 3

    def test_a_mask_with_no_pulse_scores_low(self):
        rng = np.random.default_rng(2)
        scores = [pulse_liveness_score(*mask(rng)).score for _ in range(30)]
        assert np.percentile(scores, 90) < 0.5, scores

    def test_real_beats_mask_with_a_margin_at_moderate_snr(self):
        rng = np.random.default_rng(3)
        reals = [pulse_liveness_score(*real(rng)).prominence_db for _ in range(30)]
        fakes = [pulse_liveness_score(*mask(rng)).prominence_db for _ in range(30)]
        assert np.percentile(reals, 10) > np.percentile(fakes, 90), (reals, fakes)
        assert np.median(reals) > PROMINENCE_CENTRE_DB > np.percentile(fakes, 90)

    def test_slow_illumination_drift_does_not_look_like_a_pulse(self):
        rng = np.random.default_rng(4)
        scores = [pulse_liveness_score(*mask(rng, drift=0.05)).score for _ in range(20)]
        assert np.percentile(scores, 90) < 0.5, scores

    def test_a_static_photo_is_flat_and_scores_zero(self):
        t = np.arange(0, 8000, 80)
        colors = np.tile(BASE, (len(t), 3, 1))
        result = pulse_liveness_score(t, colors)
        assert result.score == 0.0
        assert result.note == "flat"

    def test_three_patches_suppress_noise_peaks_that_fool_one(self):
        # The whole point of averaging spectra across forehead + cheeks: a
        # random noise peak in one patch is not at the same frequency in the
        # others, so the mask's apparent "prominence" collapses; a real pulse
        # is at one frequency everywhere and survives.
        rng = np.random.default_rng(5)
        one = [pulse_liveness_score(*mask(rng, patches=1)).prominence_db for _ in range(30)]
        three = [pulse_liveness_score(*mask(rng, patches=3)).prominence_db for _ in range(30)]
        assert np.percentile(three, 90) < np.percentile(one, 90) - 2.0, (one, three)
        reals = [pulse_liveness_score(*real(rng, patches=3)).prominence_db for _ in range(30)]
        assert np.percentile(reals, 10) > np.percentile(three, 90)


class TestFailClosed:
    def test_too_few_frames(self):
        rng = np.random.default_rng(6)
        t = _times(12, 1.5, rng)
        result = pulse_liveness_score(t, _trace(t, rng, bpm=70, amp=0.003, noise=0.001))
        assert result.score == 0.0 and result.note == "too_short"

    def test_too_short_a_span_even_with_many_frames(self):
        rng = np.random.default_rng(7)
        t = _times(60, 2.0, rng)  # 120 frames in 2 s
        assert len(t) > MIN_FRAMES
        result = pulse_liveness_score(t, _trace(t, rng, bpm=70, amp=0.003, noise=0.001))
        assert result.score == 0.0 and result.note == "too_short"

    def test_shape_mismatch(self):
        assert pulse_liveness_score([1, 2, 3], [(0.5, 0.5, 0.5)]).note == "shape"
        assert pulse_liveness_score([], []).score == 0.0

    def test_duplicate_timestamps_are_collapsed_not_crashed(self):
        rng = np.random.default_rng(8)
        t, colors = real(rng)
        t = np.repeat(t[: len(t) // 2], 2)  # every timestamp twice
        result = pulse_liveness_score(t, colors)
        assert isinstance(result, PulseResult)

    def test_nan_input_scores_zero(self):
        rng = np.random.default_rng(9)
        t, colors = real(rng)
        colors[3, 1, 1] = np.nan
        assert pulse_liveness_score(t, colors).note == "nan"


@pytest.mark.parametrize("fs", [8, 12, 20, 30])
def test_it_works_across_the_snapshot_rates_phones_deliver(fs):
    rng = np.random.default_rng(fs)
    reals = [pulse_liveness_score(*real(rng, fs=fs, secs=7)).score for _ in range(15)]
    fakes = [pulse_liveness_score(*mask(rng, fs=fs, secs=7)).score for _ in range(15)]
    assert np.median(reals) > np.percentile(fakes, 90), (fs, reals, fakes)
