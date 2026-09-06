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


def test_shipped_cron_matches_hobby_daily_schedule():
    """The shipped cron must be a Hobby-compatible once-daily schedule.

    A sub-daily schedule (e.g. */5 in the five-minute cadence the engine
    prefers) is rejected by Vercel on the Hobby plan, so shipping it would
    make the deployment fail. The daily schedule here is intentional: on
    Hobby, real-time ingestion therefore requires the external five-minute
    scheduler described in DEPLOYMENT.md, never a managed sub-daily cron.
    """
    root = Path(__file__).resolve().parents[1]
    deployment = json.loads((root / "vercel.json").read_text())
    cron = deployment["crons"]
    assert Settings(_env_file=None).ingest_running_timeout_seconds == deployment["functions"]["api/index.py"]["maxDuration"]
    assert cron == [{"path": "/api/cron/ingest", "schedule": "0 18 * * *"}]
    # Hobby rejects any schedule more frequent than once per day.
    minute, hour, *_ = cron[0]["schedule"].split()
    assert "*" not in minute and "/" not in minute and "*" not in hour and "/" not in hour
    assert Settings(_env_file=None).poll_interval_seconds == 300
    assert "POLL_INTERVAL_SECONDS=300" in (root / ".env.example").read_text()


def test_function_region_is_colocated_with_the_neon_database():
    """Every read opens a fresh NullPool connection to Neon (us-east-2). Running
    the function in Mumbai added ~200 ms x (TLS + auth + query) per hop and was
    the difference between a 6 s SSR probe passing and timing out on cold start.
    cle1 is Vercel's us-east-2 region."""
    root = Path(__file__).resolve().parents[1]
    deployment = json.loads((root / "vercel.json").read_text())
    assert deployment["regions"] == ["cle1"]
