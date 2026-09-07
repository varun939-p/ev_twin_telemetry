"""Boot a REAL local PostgreSQL for development — no Docker, no cloud.

`pgserver` ships the actual PostgreSQL server binaries; this helper initialises
a data directory under `.pgdata/` (gitignored), creates the `twin` database the
engine expects, prints the SQLAlchemy DATABASE_URL on stdout line 1, and then
STAYS ALIVE as the postmaster's supervisor so a process manager
(`scripts/dev-stack.mjs`) can own it like any other stack process.

    .venv/bin/python tools/dev_postgres.py [--pgdata .pgdata]

This is a development convenience only. Production uses Neon (DATABASE_URL);
nothing here is on the Vercel path.
"""

from __future__ import annotations

import argparse
import sys
import time

import pgserver


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pgdata", default=".pgdata", help="PostgreSQL data directory (gitignored)")
    args = parser.parse_args()

    print(f"[dev_postgres] initialising/starting PostgreSQL in {args.pgdata} ...", file=sys.stderr)
    server = pgserver.get_server(args.pgdata)

    # Idempotently create the `twin` database (the engine's default name).
    server.psql("SELECT 1")  # proves the server answers before we touch DDL
    exists = server.psql("SELECT 1 FROM pg_database WHERE datname = 'twin'").strip()
    if "1" not in exists:
        server.psql("CREATE DATABASE twin")
        print("[dev_postgres] created database 'twin'", file=sys.stderr)

    uri = server.get_uri(database="twin")
    # DATABASE_URL for SQLAlchemy + psycopg (the driver the engine requires).
    sqlalchemy_url = uri.replace("postgresql://", "postgresql+psycopg://")
    if "sslmode=" not in sqlalchemy_url:
        sqlalchemy_url += ("&" if "?" in sqlalchemy_url else "?") + "sslmode=disable"
    print(sqlalchemy_url, flush=True)  # line 1 on stdout — the orchestrator reads THIS

    print(f"[dev_postgres] PostgreSQL is up; DATABASE_URL printed. Staying alive as supervisor.", file=sys.stderr)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
