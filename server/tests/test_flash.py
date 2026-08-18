"""Active-flash liveness scorer, proven on synthetic frames.

No camera needed: we model the mean face colour a real face *would* show under a
flash (ambient + skin-albedo · commanded) and confirm the score separates it
cleanly from a photo (constant colour) and a replay of a different flash
sequence. The separation margin is what the FLASH_MIN threshold sits inside.
"""

from __future__ import annotations

import numpy as np

from app.flash import FLASH_MIN, FLASH_PALETTE, flash_liveness_score

# A deliberately varied sequence so every channel carries signal.
COMMANDED = [
    FLASH_PALETTE["red"],
    FLASH_PALETTE["green"],
    FLASH_PALETTE["blue"],
    FLASH_PALETTE["white"],
    FLASH_PALETTE["green"],
]

# A plausible face: warm ambient, skin reflects red > green > blue.
AMBIENT = np.array([0.20, 0.18, 0.16])
ALBEDO = np.array([0.90, 0.60, 0.50])
REFLECTANCE = 0.35


def _real_face(commanded, rng, reflectance=REFLECTANCE):
    """Mean face colour a real face would show: ambient + albedo·(k·flash)+noise."""
    c = np.asarray(commanded)
    observed = AMBIENT + ALBEDO * reflectance * c + rng.normal(0, 0.01, c.shape)
    return np.clip(observed, 0.0, 1.0)


def test_a_real_face_tracks_the_flash_and_scores_high():
    rng = np.random.default_rng(1)
    score = flash_liveness_score(COMMANDED, _real_face(COMMANDED, rng))
    assert score > 0.8, score


def test_a_printed_photo_holds_one_colour_and_scores_near_zero():
    rng = np.random.default_rng(2)
    photo = np.array([0.5, 0.4, 0.35]) + rng.normal(0, 0.005, (len(COMMANDED), 3))
    score = flash_liveness_score(COMMANDED, np.clip(photo, 0, 1))
    assert score < 0.3, score


def test_a_replay_of_a_different_sequence_does_not_correlate():
    rng = np.random.default_rng(3)
    other = [FLASH_PALETTE[k] for k in ("blue", "white", "red", "green", "blue")]
    # The attacker's screen really did reflect *their* sequence — just not ours.
    observed = _real_face(other, rng)
    score = flash_liveness_score(COMMANDED, observed)
    assert score < FLASH_MIN, score


def test_real_beats_every_spoof_with_a_clear_margin():
    rng = np.random.default_rng(4)
    real = flash_liveness_score(COMMANDED, _real_face(COMMANDED, rng))
    photo = flash_liveness_score(
        COMMANDED, np.clip(np.array([0.5, 0.4, 0.35]) + rng.normal(0, 0.005, (5, 3)), 0, 1)
    )
    replay = flash_liveness_score(COMMANDED, _real_face(
        [FLASH_PALETTE[k] for k in ("green", "red", "white", "blue", "red")], rng
    ))
    assert real - max(photo, replay) > 0.4, (real, photo, replay)
    assert photo < FLASH_MIN < real and replay < FLASH_MIN < real


def test_it_survives_strong_ambient_light():
    # A bright room adds a big constant the flash must still be seen through.
    rng = np.random.default_rng(5)
    observed = np.clip(_real_face(COMMANDED, rng) + np.array([0.4, 0.4, 0.4]), 0, 1)
    assert flash_liveness_score(COMMANDED, observed) > 0.7


def test_degenerate_inputs_score_zero_not_crash():
    assert flash_liveness_score([], []) == 0.0
    assert flash_liveness_score(COMMANDED[:2], _real_face(COMMANDED[:2], np.random.default_rng(6))) == 0.0
    assert flash_liveness_score(COMMANDED, COMMANDED[:3]) == 0.0  # length mismatch
    flat = [FLASH_PALETTE["red"]] * 4  # screen never varied → no information → 0
    assert flash_liveness_score(flat, _real_face(flat, np.random.default_rng(7))) == 0.0
