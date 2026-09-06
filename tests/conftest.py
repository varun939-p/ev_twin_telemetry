"""Shared fixtures: a live mock upstream, SQLite for logic tests, PostgreSQL when available."""

from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

import pytest
import requests
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from telemetry.config import Settings  # noqa: E402
from telemetry.models import Base  # noqa: E402
from tools.mock_server import PASSCODE, SECRET_KEY, make_server  # noqa: E402

PG_URL = os.getenv("TEST_DATABASE_URL", "")


@pytest.fixture(scope="session")
def mock_api():
    """A real HTTP server speaking the documented API, on a random port."""
    server = make_server(port=0, vehicles=4, all_fields=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    base = f"http://{host}:{port}"

    # Wait until it actually accepts connections.
    for _ in range(50):
        try:
            requests.get(f"{base}/__stats", timeout=1)
            break
        except requests.exceptions.RequestException:
            time.sleep(0.05)

    class Handle:
        base_url = base
        fleet = server.fleet  # type: ignore[attr-defined]
        secret_key = SECRET_KEY
        passcode = PASSCODE

        def control(self, path: str) -> dict:
            return requests.post(f"{base}{path}", timeout=5).json()

        def stats(self) -> dict:
            return requests.get(f"{base}/__stats", timeout=5).json()

        def reset(self) -> None:
            with self.fleet.lock:
                self.fleet.fail_remaining = 0
                self.fleet.latency_ms = 0
                self.fleet.bad_creds = False
                self.fleet.frozen = False
                self.fleet.scenario = None
                self.fleet.counts.update(
                    {"auth": 0, "auth_failed": 0, "data": 0, "detail": 0, "data_401": 0, "data_500": 0}
                )

    handle = Handle()
    yield handle
    server.shutdown()
    server.server_close()


@pytest.fixture
def settings(mock_api) -> Settings:
    """Settings pointed at the mock, with retry delays small enough to test."""
    return Settings(
        api_base_url=mock_api.base_url,
        api_secret_key=mock_api.secret_key,
        api_passcode=mock_api.passcode,
        database_url="sqlite://",
        poll_interval_seconds=0.05,
        backoff_base_seconds=0.001,
        backoff_max_seconds=0.005,
        http_max_retries=3,
        request_timeout=5.0,
        token_refresh_interval=3300.0,
        token_expiry_safety_margin=240.0,
        _env_file=None,
    )


@pytest.fixture
def sqlite_session():
    """In-memory SQLite -- dialect-agnostic logic tests."""
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool, future=True
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    session = factory()
    yield session
    session.close()
    engine.dispose()


@pytest.fixture(scope="session")
def pg_url() -> str:
    return PG_URL


@pytest.fixture
def pg_session(pg_url):
    """Real PostgreSQL session; skipped unless TEST_DATABASE_URL is set.

    The upsert is PostgreSQL-specific SQL, so the tests that matter most for
    data correctness run here rather than against a SQLite approximation.
    Schema creation goes through `init_schema` (not bare create_all) so the
    column reconcile for databases created by older engine versions runs here
    exactly as it does in production.
    """
    if not pg_url:
        pytest.skip("TEST_DATABASE_URL not set -- PostgreSQL-specific tests skipped")
    engine = create_engine(pg_url, future=True)
    from telemetry.db import init_schema

    init_schema(engine)
    # Start each test from an empty store so assertions are absolute.
    with engine.begin() as conn:
        from sqlalchemy import text

        conn.execute(text("TRUNCATE telemetry, vehicle_state, vehicles, provisioned_sites RESTART IDENTITY CASCADE"))
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    session = factory()
    yield session
    session.close()
    engine.dispose()
