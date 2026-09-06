"""Database plumbing: engine, session factory, schema bootstrap."""

from __future__ import annotations

import logging
import os
from typing import Final, Iterator

from sqlalchemy import Engine, create_engine, event, text
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from .config import Settings, get_settings

log = logging.getLogger(__name__)

_POOLABLE = ("postgresql", "mysql", "mssql", "oracle")


def build_engine(settings: Settings | None = None) -> Engine:
    """Create an engine tuned for a small, steady poller.

    * `pool_pre_ping` -- the poller is idle for ~60 s between writes; Postgres or
      a NAT/firewall in between will happily drop that socket.  Pre-ping turns a
      surprise `OperationalError` at 03:00 into a transparent reconnect.
    * `pool_recycle` -- belt and braces for `idle_in_transaction_session_timeout`.
    * On serverless platforms (`VERCEL`, Lambda) the engine swaps to NullPool:
      a QueuePool's idle sockets would die between invocations anyway, and the
      platform may freeze the container while a connection is checked out.
    """
    settings = settings or get_settings()
    url = settings.database_url
    kwargs: dict = {"echo": settings.db_echo, "future": True}

    if url.split(":", 1)[0] in _POOLABLE:
        if settings.db_nullpool or os.getenv("VERCEL") or os.getenv("AWS_LAMBDA_FUNCTION_NAME"):
            kwargs.update(poolclass=NullPool, pool_pre_ping=True)
        else:
            kwargs.update(
                pool_size=settings.db_pool_size,
                max_overflow=settings.db_max_overflow,
                pool_recycle=settings.db_pool_recycle,
                pool_pre_ping=True,
            )

    engine = create_engine(url, **kwargs)

    @event.listens_for(engine, "connect")
    def _set_search_path(dbapi_conn, _record):  # pragma: no cover - driver level
        """Pin the schema so unqualified names always resolve."""
        if settings.db_schema != "public" and engine.dialect.name == "postgresql":
            with dbapi_conn.cursor() as cur:
                cur.execute(f"SET search_path TO {settings.db_schema}, public")

    return engine


def build_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, expire_on_commit=False, future=True, autoflush=False)


def session_scope(factory: sessionmaker[Session]) -> Iterator[Session]:
    """`with session_scope(factory) as s:` -- commit on success, rollback on error."""
    session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def ping(engine: Engine) -> str:
    with engine.connect() as conn:
        row = conn.execute(text("SELECT 1")).scalar_one()
        return f"ok (select 1 -> {row})"


def init_schema(engine: Engine) -> None:
    """Create tables + indexes, then reconcile columns on existing databases.

    Fine for first boot and for CI.  In production, promote the generated DDL
    (`python -m telemetry schema`) into an Alembic revision so migrations are
    reviewable and reversible.
    """
    from .models import Base

    Base.metadata.create_all(engine)
    _ensure_columns(engine)
    log.info("schema ensured on %s", engine.url.render_as_string(hide_password=True))


# Columns added after the first production schema shipped.  `create_all` only
# creates MISSING tables -- it never widens an existing one -- so a database
# initialised by an earlier engine version would otherwise 500 on the first
# upsert.  The reconciles are idempotent ADD COLUMN IF NOT EXISTS statements,
# cheap enough to run once per process start (the control plane caches them).
_ADDED_COLUMNS: Final = (
    # (table, column, ddl type) -- validator verdicts persisted next to the frame
    ("vehicle_state", "field_status", "JSONB"),
    ("vehicle_state", "missing_fields", "JSONB"),
    ("vehicle_state", "field_errors", "JSONB"),
)


def _ensure_columns(engine: Engine) -> None:
    if engine.dialect.name != "postgresql":
        return  # SQLite dev/CI creates fresh databases; nothing to reconcile
    from sqlalchemy import text

    with engine.begin() as conn:
        for table, column, ddl in _ADDED_COLUMNS:
            conn.execute(text(f'ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {ddl}'))
