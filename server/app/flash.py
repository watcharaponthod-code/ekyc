"""Active-flash liveness — the technique iProov, AWS Rekognition Face Liveness
and FaceTec all lean on, done with only the screen and camera we already have.

The screen flashes a **server-issued random colour sequence**; a real 3-D face
lit by the screen reflects each colour, so the mean colour of the face region
tracks the commanded sequence. A printed photo, a replayed video, or an injected
stream cannot follow a sequence it did not know in advance — so the face colour
does *not* track it. One technique that at once:

* is a challenge the attacker cannot pre-compute (the sequence is random),
* defeats replay (a recording of a *different* session's flashes won't correlate),
* defeats a flat photo / screen (its colour is fixed regardless of the flash),
* resists injection (a pre-rendered stream can't match realtime reflectance).

Pure and numeric on purpose: `flash_liveness_score` takes the commanded colours
and the observed mean face colours and returns 0..1, so the whole thing is
tested exhaustively on synthetic frames without a camera. Measuring the mean
face colour from real pixels is the caller's job (`services.verification`).
"""

from __future__ import annotations

import numpy as np

#: Full-screen flash colours, linear 0..1 RGB. Off-primaries (a channel is lit
#: to 1.0, the others to a floor) keep the screen bright enough to read a face
#: while still separating the channels — a pure (1,0,0) leaves the face almost
#: black in green/blue and the correlation there becomes noise.
FLASH_PALETTE: dict[str, tuple[float, float, float]] = {
    "red": (1.0, 0.15, 0.15),
    "green": (0.15, 1.0, 0.15),
    "blue": (0.15, 0.15, 1.0),
    "white": (1.0, 1.0, 1.0),
}

#: Below this score the face did not track the flash → treat as spoof/injection.
#: Real synthetic faces score ~0.85+; photo/replay/wrong-sequence spoofs score
#: near 0. 0.5 sits in the empty middle (see test_flash.py); tune on device.
FLASH_MIN = 0.5

#: A flash challenge needs at least this many frames for a stable correlation.
FLASH_MIN_FRAMES = 3


def flash_liveness_score(
    commanded: list[tuple[float, float, float]] | np.ndarray,
    observed: list[tuple[float, float, float]] | np.ndarray,
) -> float:
    """How well the face colour tracked the commanded flash sequence, 0..1.

    ``commanded`` — the colours the screen showed, one per flash frame (0..1 RGB).
    ``observed``  — the mean colour of the face region in each matching frame.

    Per channel, the Pearson correlation across frames between what the screen
    commanded and what the face showed. A real face is (roughly) an affine
    function of the illumination — ``observed ≈ ambient + albedo · commanded`` —
    so each channel the screen *varied* correlates near +1. Averaged over the
    channels the screen actually varied, negatives clamped to 0 (anti-correlation
    is not liveness). A dead-constant face (a photo) scores 0.

    Absolute brightness is deliberately ignored: ambient light and skin tone set
    the level, the *flash* sets the variation, and only the variation is trustworthy.
    """
    c = np.asarray(commanded, dtype=np.float64)
    o = np.asarray(observed, dtype=np.float64)
    if c.ndim != 2 or c.shape[1] != 3 or c.shape != o.shape:
        return 0.0
    if c.shape[0] < FLASH_MIN_FRAMES:
        return 0.0

    per_channel: list[float] = []
    for ch in range(3):
        commanded_ch = c[:, ch]
        observed_ch = o[:, ch]
        # The screen must have varied this channel for it to carry information.
        if commanded_ch.std() < 1e-3:
            continue
        # A face that does not var at all under a varying flash is a flat surface.
        if observed_ch.std() < 1e-6:
            per_channel.append(0.0)
            continue
        corr = float(np.corrcoef(commanded_ch, observed_ch)[0, 1])
        if np.isnan(corr):
            corr = 0.0
        per_channel.append(max(0.0, corr))

    if not per_channel:
        return 0.0
    return float(np.mean(per_channel))
