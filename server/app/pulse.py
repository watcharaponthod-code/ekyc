"""Remote photoplethysmography (rPPG) liveness — the 3-D-mask counter-measure.

Every layer before this one is defeated by a good silicone mask: it turns,
blinks through eye holes, is three-dimensional, and reflects the screen flash
like skin. What a mask does **not** have is blood. Skin colour pulses with each
heartbeat — a fraction of a percent, invisible to the eye, but measurable as
the mean colour of a skin patch over a few seconds of video. This is the same
signal a pulse-oximeter reads, recovered from a camera, and the technique the
3-D-mask PAD literature converged on (Liu, Yuen et al. 2016; Nowara 2017;
Heusch & Marcel 2019).

Pure and numeric: ``pulse_liveness_score`` takes ``(t_ms, [patch RGB…])`` per
frame — one mean colour per skin patch (forehead, both cheeks) — and returns a
score, a beats-per-minute estimate and the spectral prominence. Measuring the
patch colours from pixels is the caller's job (`services.verification`, via
`geometry.skin_patch_colors` on MediaPipe's landmarks).

Method:

1. resample the irregular phone timestamps onto a uniform grid;
2. per patch, POS (Wang, den Brinker, Stuijk & de Haan, IEEE TBME 2017):
   in a sliding window, normalise each channel by its mean, project onto the
   plane orthogonal to skin tone — ``S1 = G − B``, ``S2 = −2R + G + B`` — and
   combine ``h = S1 + (σ1/σ2)·S2``; overlap-add the windows;
3. Hann-windowed power spectrum in the physiological band 0.7–3 Hz
   (42–180 bpm), normalised per patch and **averaged across patches** — a real
   pulse peaks at the same frequency in every patch, noise does not;
4. prominence = mean power within ±0.15 Hz of the peak over the median power
   elsewhere in the band, in dB. A pulse concentrates power at one frequency; a
   mask, a photo or noise spreads it flat.

Calibrated on synthetic traces only (see test_pulse.py): with a pulse
amplitude at least twice the per-frame colour noise, real p10 ≈ 9 dB against
spoof max ≈ 7 dB; at amplitude ≈ noise the two overlap. That is why the gate
ships **advisory** (`Thresholds.pulse_rule`) until it has been measured on
phones, and why the burst is 7–8 s at the highest snapshot rate the device
gives. This layer raises the cost of a mask attack; it is not a certificate.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

#: Physiological band: 42–180 bpm.
BAND_HZ = (0.7, 3.0)
#: Half-width of the window counted as "the pulse" around the spectral peak.
PEAK_HALF_WIDTH_HZ = 0.15
#: POS window length in seconds (the paper uses 1.6 s at 20 fps).
POS_WINDOW_S = 1.6
#: A burst shorter than this cannot resolve the band; the score is 0.
MIN_FRAMES = 24
MIN_SPAN_MS = 3_000
#: Uniform resampling rate bounds. Below ~5 Hz the band aliases; above 60 is waste.
RESAMPLE_HZ = (5.0, 60.0)
#: Score = logistic(prominence_dB − centre)/scale. 7 dB → 0.5.
PROMINENCE_CENTRE_DB = 7.0
PROMINENCE_SCALE_DB = 1.0


@dataclass(slots=True)
class PulseResult:
    #: 0..1 — confidence that a periodic pulse is present.
    score: float
    #: Beats per minute at the spectral peak (0 when nothing was measured).
    bpm: float
    #: Peak prominence in dB (peak window mean vs median of the rest of the band).
    prominence_db: float
    frames: int
    span_ms: int
    sampling_hz: float
    patches: int = 0
    #: Why the score is 0 without measurement, or "" when it was measured.
    note: str = ""


def pulse_liveness_score(
    times_ms: list[int] | np.ndarray,
    colors: list | np.ndarray,
) -> PulseResult:
    """``colors`` is (n, 3) for one patch or (n, k, 3) for k patches per frame."""
    t = np.asarray(times_ms, dtype=np.float64).reshape(-1)
    c = np.asarray(colors, dtype=np.float64)
    n = int(t.shape[0])
    if c.ndim == 2:
        c = c[:, None, :]
    if n == 0 or c.ndim != 3 or c.shape[0] != n or c.shape[2] != 3:
        return PulseResult(0.0, 0.0, 0.0, n, 0, 0.0, 0, "shape")
    k = int(c.shape[1])

    order = np.argsort(t, kind="stable")
    t, c = t[order], c[order]
    keep = np.concatenate([[True], np.diff(t) > 0])  # drop duplicate timestamps
    t, c = t[keep], c[keep]
    n = int(t.shape[0])
    span = int(round(t[-1] - t[0])) if n > 1 else 0
    if n < MIN_FRAMES or span < MIN_SPAN_MS:
        return PulseResult(0.0, 0.0, 0.0, n, span, 0.0, k, "too_short")
    if not np.all(np.isfinite(c)):
        return PulseResult(0.0, 0.0, 0.0, n, span, 0.0, k, "nan")

    # 1. uniform resampling at the burst's own median rate
    median_dt = float(np.median(np.diff(t))) / 1000.0
    fs = float(np.clip(1.0 / max(median_dt, 1e-3), *RESAMPLE_HZ))
    grid = np.arange(t[0], t[-1], 1000.0 / fs)
    if grid.shape[0] < MIN_FRAMES:
        return PulseResult(0.0, 0.0, 0.0, n, span, fs, k, "too_short")

    # 2./3. per-patch POS → normalised band spectrum, averaged
    accumulated: np.ndarray | None = None
    freqs: np.ndarray | None = None
    used = 0
    for patch in range(k):
        trace = c[:, patch, :]
        if np.any(trace.std(axis=0) < 1e-9):
            continue  # a constant patch (photo, saturated) carries nothing
        rgb = np.stack([np.interp(grid, t, trace[:, ch]) for ch in range(3)], axis=1)
        signal = pos_signal(rgb, fs)
        if signal is None or signal.std() < 1e-12:
            continue
        f, power = band_spectrum(signal, fs)
        total = float(power.sum())
        if total <= 0.0:
            continue
        power = power / total
        accumulated = power if accumulated is None else accumulated + power
        freqs = f
        used += 1
    if accumulated is None or freqs is None:
        return PulseResult(0.0, 0.0, 0.0, n, span, fs, k, "flat")
    accumulated /= used

    # 4. prominence of the strongest peak
    prominence_db, peak_hz = peak_prominence(freqs, accumulated)
    score = float(1.0 / (1.0 + np.exp(-(prominence_db - PROMINENCE_CENTRE_DB) / PROMINENCE_SCALE_DB)))
    return PulseResult(score, float(peak_hz * 60.0), float(prominence_db), n, span, fs, used)


def pos_signal(rgb: np.ndarray, fs: float) -> np.ndarray | None:
    """Plane-Orthogonal-to-Skin pulse signal from a uniformly sampled RGB trace."""
    n = rgb.shape[0]
    win = max(int(round(POS_WINDOW_S * fs)), 8)
    if n < win:
        win = n
    h = np.zeros(n, dtype=np.float64)
    projection = np.array([[0.0, 1.0, -1.0], [-2.0, 1.0, 1.0]])
    for start in range(0, n - win + 1):
        block = rgb[start : start + win]
        mean = block.mean(axis=0)
        if np.any(mean <= 1e-9):
            continue
        normalised = block / mean - 1.0
        s = normalised @ projection.T  # (win, 2)
        s1, s2 = s[:, 0], s[:, 1]
        sigma2 = s2.std()
        alpha = s1.std() / sigma2 if sigma2 > 1e-12 else 0.0
        p = s1 + alpha * s2
        h[start : start + win] += p - p.mean()
    return h if np.any(h != 0.0) else None


def band_spectrum(signal: np.ndarray, fs: float) -> tuple[np.ndarray, np.ndarray]:
    """(frequencies, power) restricted to the physiological band."""
    x = signal - signal.mean()
    n = x.shape[0]
    window = np.hanning(n)
    nfft = int(2 ** np.ceil(np.log2(max(n, 8) * 8)))  # zero-pad for a fine grid
    spectrum = np.abs(np.fft.rfft(x * window, nfft)) ** 2
    freqs = np.fft.rfftfreq(nfft, d=1.0 / fs)
    band = (freqs >= BAND_HZ[0]) & (freqs <= BAND_HZ[1])
    return freqs[band], spectrum[band]


def peak_prominence(freqs: np.ndarray, power: np.ndarray) -> tuple[float, float]:
    """(prominence in dB, peak Hz): mean power around the peak over the median
    power of the rest of the band (first harmonic excluded from "rest")."""
    if freqs.size == 0:
        return -30.0, 0.0
    peak_index = int(np.argmax(power))
    peak_hz = float(freqs[peak_index])
    in_peak = np.abs(freqs - peak_hz) <= PEAK_HALF_WIDTH_HZ
    in_harmonic = np.abs(freqs - 2.0 * peak_hz) <= PEAK_HALF_WIDTH_HZ
    rest = power[~(in_peak | in_harmonic)]
    if rest.size == 0:
        return 30.0, peak_hz
    floor = float(np.median(rest))
    if floor <= 1e-18:
        return 30.0, peak_hz
    prominence = 10.0 * np.log10(float(power[in_peak].mean()) / floor)
    return float(np.clip(prominence, -30.0, 30.0)), peak_hz
