"""Pool selection must inspect the dialect, not 'postgresql+psycopg'. No DB I/O."""
import json
from pathlib import Path

import pytest
from sqlalchemy.pool import NullPool, QueuePool

from telemetry.config import Settings
from telemetry.db import build_engine


@pytest.mark.parametrize("platform", ["VERCEL", "AWS_LAMBDA_FUNCTION_NAME"])
def test_serverless_forces_nullpool_for_psycopg_even_when_flag_is_false(monkeypatch, platform):
    monkeypatch.setenv(platform, "1")
    config = Settings(_env_file=None, database_url="postgresql+psycopg://user:placeholder@localhost/test", db_nullpool=False)
    engine = build_engine(config)
    try:
        assert isinstance(engine.pool, NullPool)
    finally:
        engine.dispose()


def test_local_pool_options_apply_to_the_driver_qualified_url(monkeypatch):
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.delenv("AWS_LAMBDA_FUNCTION_NAME", raising=False)
    config = Settings(_env_file=None, database_url="postgresql+psycopg://user:placeholder@localhost/test", db_pool_size=2)
    engine = build_engine(config)
    try:
        assert isinstance(engine.pool, QueuePool)
        assert engine.pool.size() == 2
    finally:
        engine.dispose()


def test_explicit_nullpool_locally():
    config = Settings(_env_file=None, database_url="postgresql+psycopg://user@localhost/test", db_nullpool=True)
    engine = build_engine(config)
    try:
        assert isinstance(engine.pool, NullPool)
    finally:
        engine.dispose()


def test_shipped_cron_matches_five_minute_default():
    root = Path(__file__).resolve().parents[1]
    deployment = json.loads((root / "vercel.json").read_text())
    cron = deployment["crons"]
    assert Settings(_env_file=None).ingest_running_timeout_seconds == deployment["functions"]["api/index.py"]["maxDuration"]
    assert cron == [{"path": "/api/cron/ingest", "schedule": "*/5 * * * *"}]
    assert Settings(_env_file=None).poll_interval_seconds == 300
    assert "POLL_INTERVAL_SECONDS=300" in (root / ".env.example").read_text()
