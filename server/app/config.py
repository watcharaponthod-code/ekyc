"""Configuration and decision thresholds.

Every threshold here is a *default*, not a validated value. Calibration on the
target population is Phase 6 of the plan; shipping these unchanged is called out
as a limitation in the design spec.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

SERVER_ROOT = Path(__file__).resolve().parent.parent


class Thresholds(BaseSettings):
    """The numbers that decide pass/fail."""

    model_config = SettingsConfigDict(env_prefix="EKYC_", extra="ignore")

    # --- detection & quality -------------------------------------------------
    det_score_min: float = 0.5
    sharpness_min: float = 60.0
    brightness_min: float = 0.25
    brightness_max: float = 0.85
    face_ratio_min: float = 0.22

    # --- presentation attack detection --------------------------------------
    pad_min: float = 0.70

    # --- pose ----------------------------------------------------------------
    #: Sanity bound on the neutral frame. Deliberately loose: the raw yaw proxy
    #: carries a per-person bias (LFW: |median| 0.18, p90 0.56) that says
    #: nothing about pose. The client already gates |yaw| < 12 deg before
    #: capturing, so this only has to reject a true profile shot.
    neutral_yaw_max: float = 0.45
    #: Minimum *change* from the neutral frame for a turn to count.
    #: 0.30 ~ 25 deg under a simple head model (delta ~ 0.635*tan(theta)).
    turn_yaw_min: float = 0.30

    # --- eyes ----------------------------------------------------------------
    eye_closed_ratio: float = 0.65
    #: `advisory` measures and logs the eye check but never fails on it alone;
    #: `enforce` makes it a hard rule. Advisory is the default because the
    #: metric has not been calibrated on matched open/closed captures yet —
    #: see docs/ml-validation.md. Flip to `enforce` after Phase 6.
    eye_rule: str = Field(default="advisory", pattern="^(advisory|enforce)$")

    # --- identity ------------------------------------------------------------
    #: Min pairwise cosine across the evidence frames. This is a *swap*
    #: detector, not a match: it must survive a real head turn.
    #:
    #: Measured on LFW under conditions harsher than any session — a frontal
    #: shot plus two extreme profiles (|yawProxy| up to 1.0), photographed years
    #: apart: worst genuine 0.455, p5 0.505. Impostor frontal pairs top out at
    #: 0.145. 0.30 sits in the middle of that empty band, with 2x headroom above
    #: the worst impostor and 1.5x below the worst genuine.
    consistency_min: float = 0.30
    #: cosine required to call two faces the same person.
    match_min: float = 0.42

    # --- timing plausibility -------------------------------------------------
    total_duration_min_ms: int = 2_000
    total_duration_max_ms: int = 90_000
    step_duration_min_ms: int = 250


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="EKYC_", extra="ignore")

    database_url: str = "sqlite:///./ekyc.db"
    models_dir: Path = SERVER_ROOT / "models"
    session_ttl_seconds: int = 120
    #: How many challenges (besides the implicit `center`) each risk tier issues.
    challenges_full: int = 3
    challenges_reduced: int = 1
    #: `none` keeps no images at all. `on_fail` is useful while tuning, and is a
    #: privacy trade-off you must justify before enabling in production.
    retain_frames: str = Field(default="none", pattern="^(none|on_fail|all)$")
    frames_dir: Path = SERVER_ROOT / "retained_frames"
    #: Set false to run the API with the fake backend (no model files needed).
    use_onnx: bool = True
    version: str = "0.1.0"


settings = Settings()
thresholds = Thresholds()
