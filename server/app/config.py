"""Configuration and decision thresholds.

Every threshold here is a *default*, not a validated value. Calibration on the
target population is Phase 6 of the plan; shipping these unchanged is called out
as a limitation in the design spec.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def normalize_db_url(url: str) -> str:
    """Make a database URL SQLAlchemy-2 + psycopg-3 ready.

    Railway (and Heroku-style hosts) inject ``postgres://...``; SQLAlchemy 2
    needs an explicit driver, and we ship psycopg 3. Rewrite the scheme so the
    same URL works whether it came from Railway, an env override, or the SQLite
    default. Idempotent.
    """
    if url.startswith("postgresql+psycopg://"):
        return url
    for scheme in ("postgres://", "postgresql://"):
        if url.startswith(scheme):
            return "postgresql+psycopg://" + url[len(scheme):]
    return url

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
    #: Measured: 30 live captures vs 40 screen-replay frames separate perfectly
    #: with DeepFace's two-model MiniFASNet ensemble (AUC 1.000) — live min
    #: 0.501, spoof max 0.393. 0.45 sits in the middle of that gap.
    pad_min: float = 0.45

    # --- pose (degrees) -------------------------------------------------------
    #: Sanity bound on the neutral frame. Loose on purpose: it only has to
    #: reject a true profile shot, because the client already gates
    #: |yaw| < 12 deg before capturing, and because a resting head is rarely at
    #: exactly zero.
    #:
    #: Sized for the default backend, whose pose comes from MediaPipe's
    #: transformation matrix. Running `EKYC_BACKEND=onnx` means pose is
    #: inferred from five points and carries about +/-13 deg of per-person
    #: bias, so raise this to ~45 there — see test_ml_integration.py.
    neutral_yaw_max_deg: float = 25.0
    #: Minimum *change* in yaw from the neutral frame for a turn to count.
    turn_yaw_min_deg: float = 22.0

    # --- eyes ----------------------------------------------------------------
    #: Closed-eye frame must drop to this fraction of the subject's own neutral
    #: eye-aspect-ratio.
    eye_closed_ratio: float = 0.65
    #: ...and be below this absolute EAR, which guards the case where the
    #: neutral frame was itself captured mid-blink and so makes any ratio look
    #: fine. Measured: open eyes on 20 LFW subjects sit at median 0.265 with
    #: p10 0.131, so the floor has to stay under 0.13 or narrow-eyed people
    #: would clear it with their eyes open. Truly shut lids score below 0.08.
    ear_closed_max: float = 0.12
    # --- active-flash liveness ----------------------------------------------
    #: Min correlation between the commanded screen-flash colours and the colour
    #: the face actually reflected. Synthetic separation is wide (real ~0.99,
    #: photo/replay ~0.15-0.23; see test_flash.py), so 0.5 sits in the empty
    #: gap. Only enforced when a session issued a flash plan.
    flash_min: float = 0.5

    #: `enforce` makes the closed-eyes check a hard rule; `advisory` measures
    #: and logs it without failing on it alone. Enforced by default now that
    #: the metric is a real eye-aspect-ratio from MediaPipe eye contours rather
    #: than an uncalibrated image statistic.
    eye_rule: str = Field(default="enforce", pattern="^(advisory|enforce)$")

    # --- identity ------------------------------------------------------------
    #: Min pairwise cosine across the evidence frames. This is a *swap*
    #: detector, not a match: it must survive a real head turn.
    #:
    #: Measured with the DeepFace embedder on 20 LFW subjects: the worst
    #: within-person pair scores 0.155 and p5 is 0.217, while impostor pairs
    #: sit at a median of 0.065. Those genuine pairs are photographs taken
    #: years apart at extreme angles, far harsher than two frames seconds
    #: apart, so this bound is conservative by construction.
    consistency_min: float = 0.25
    #: Cosine required to call two faces the same person. Measured with the
    #: DeepFace embedder over 60 genuine and 1710 impostor LFW pairs
    #: (AUC 0.994): at 0.42, FAR is 0.06% and FRR 13%. The FRR is inflated by
    #: LFW's cross-year, cross-pose pairs; two controlled selfies score far
    #: higher. Raise to 0.50 for FAR 0% at the cost of a 23% retry rate.
    match_min: float = 0.42

    # --- timing plausibility -------------------------------------------------
    total_duration_min_ms: int = 2_000
    total_duration_max_ms: int = 90_000
    step_duration_min_ms: int = 250


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="EKYC_", extra="ignore")

    #: Reads Railway's `DATABASE_URL` as well as `EKYC_DATABASE_URL`; the scheme
    #: is normalised to the psycopg driver. SQLite stays the zero-config default.
    database_url: str = Field(
        default="sqlite:///./ekyc.db",
        validation_alias=AliasChoices("EKYC_DATABASE_URL", "DATABASE_URL"),
    )
    models_dir: Path = SERVER_ROOT / "models"
    session_ttl_seconds: int = 120
    #: How many challenges (besides the implicit `center`) each risk tier issues.
    challenges_full: int = 3
    challenges_reduced: int = 1
    #: How many active-flash frames to issue (0 = feature off). Each is a
    #: full-screen colour the device shows while capturing; the server checks
    #: the face reflected the commanded sequence. Server-controlled on purpose.
    flash_frames: int = 0
    #: `none` keeps no images at all. `on_fail` is useful while tuning, and is a
    #: privacy trade-off you must justify before enabling in production.
    retain_frames: str = Field(default="none", pattern="^(none|on_fail|all)$")
    frames_dir: Path = SERVER_ROOT / "retained_frames"
    #: Which vision stack to run.
    #: - `deepface`: MediaPipe Face Landmarker + DeepFace. The default.
    #: - `onnx`: SCRFD + ArcFace + MiniFASNet via onnxruntime. No TensorFlow.
    #: - `fake`: scripted values; for running the API with no models at all.
    backend: str = Field(default="deepface", pattern="^(deepface|onnx|fake)$")
    log_level: str = "INFO"
    log_format: str = Field(default="text", pattern="^(text|json)$")
    version: str = "0.1.0"

    @field_validator("database_url")
    @classmethod
    def _normalize_database_url(cls, value: str) -> str:
        return normalize_db_url(value)


settings = Settings()
thresholds = Thresholds()
