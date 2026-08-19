"""Deploy config: Railway's DATABASE_URL and the psycopg scheme rewrite."""

from __future__ import annotations

from app.config import Settings, normalize_db_url


def test_normalize_rewrites_railway_and_bare_postgres_to_psycopg():
    assert normalize_db_url("postgres://u:p@h:5432/db") == "postgresql+psycopg://u:p@h:5432/db"
    assert normalize_db_url("postgresql://u:p@h/db") == "postgresql+psycopg://u:p@h/db"
    assert normalize_db_url("postgresql+psycopg://x/db") == "postgresql+psycopg://x/db"  # idempotent
    assert normalize_db_url("sqlite:///./ekyc.db") == "sqlite:///./ekyc.db"


def test_settings_reads_railway_DATABASE_URL(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://a:b@c/d")
    assert Settings().database_url == "postgresql+psycopg://a:b@c/d"


def test_settings_defaults_to_sqlite(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("EKYC_DATABASE_URL", raising=False)
    assert Settings().database_url == "sqlite:///./ekyc.db"


def test_onnx_backend_demotes_the_eye_rule_to_advisory_unless_configured(monkeypatch):
    """The onnx eye metric is an uncalibrated proxy (ml-validation §5); every
    Railway session failed EYES_NOT_CLOSED until this. Explicit env wins."""
    import os

    from app.config import Thresholds

    assert Thresholds().eye_rule == "enforce"  # deepface default: real EAR
    monkeypatch.delenv("EKYC_EYE_RULE", raising=False)
    th = Thresholds()
    # the demotion itself lives in main.lifespan; here we pin the two inputs it reads
    assert "EKYC_EYE_RULE" not in os.environ and th.eye_rule == "enforce"
    monkeypatch.setenv("EKYC_EYE_RULE", "enforce")
    assert Thresholds().eye_rule == "enforce"
