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
