"""CLI entry point.

    python -m telemetry run              # the continuous extraction loop
    python -m telemetry init-db          # create tables + indexes
    python -m telemetry schema           # print the PostgreSQL DDL
    python -m telemetry once [--dry-run] [--date YYYY-MM-DD]  # a single cycle, then exit
    python -m telemetry fields           # print the 24-parameter mapping table
    python -m telemetry mock-server      # local stand-in for the upstream API
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timezone

from sqlalchemy import create_mock_engine

from . import __version__
from .api import UpstreamClient
from .auth import TokenManager
from .config import Settings, get_settings
from .db import build_engine, build_session_factory, init_schema, ping
from .extractor import TelemetryExtractor
from .fields import PARAM_SPECS
from .logging_setup import configure_logging
from .orchestrator import TelemetryOrchestrator
from .schemas import VehiclesPayload, parse_payload

log = logging.getLogger("telemetry.cli")


def _settings() -> Settings:
    settings = get_settings()
    configure_logging(settings)
    return settings


# ------------------------------------------------------------------- helpers
def _date_arg(value: str) -> str:
    """argparse type for `--date`: accepts YYYY-MM-DD, rejects anything else.

    Checking here turns a typo into a usage error at the shell instead of a 400
    from the upstream API (guide section 6: bad `date` format) after the auth
    round-trip.  The string is returned untouched -- no reformatting -- so what
    the operator typed is exactly what reaches the query string.
    """
    text = value.strip()
    try:
        datetime.strptime(text, "%Y-%m-%d")
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"invalid date {value!r}: expected YYYY-MM-DD (ISO 8601, e.g. 2026-08-21)"
        ) from None
    return text


def _apply_date(settings: Settings, date: str | None) -> Settings:
    """Overlay a CLI `--date` onto the resolved configuration.

    Returns a copy rather than mutating: `get_settings()` is `lru_cache`d, and a
    one-shot CLI filter must not leak into any other settings consumer in the
    process.  `settings.api_date` stays the single source of truth for the date
    filter -- `api.py::_query_params` already turns it into `?date=YYYY-MM-DD`,
    so nothing downstream has to know the flag exists.  Omitting `--date` leaves
    whatever `API_DATE` in `.env` provided (or no filter at all).
    """
    if not date:
        return settings
    return settings.model_copy(update={"api_date": date})


# --------------------------------------------------------------------- run
def cmd_run(_args: argparse.Namespace) -> int:
    settings = _settings()
    settings.validate_required()
    engine = build_engine(settings)
    init_schema(engine)
    log.info("database reachable: %s", ping(engine))

    orchestrator = TelemetryOrchestrator(settings, build_session_factory(engine))
    return orchestrator.run_forever()


# ----------------------------------------------------------------- init-db
def cmd_init_db(_args: argparse.Namespace) -> int:
    settings = _settings()
    settings.validate_required()
    engine = build_engine(settings)
    init_schema(engine)
    log.info("database reachable: %s", ping(engine))
    return 0


# ------------------------------------------------------------------ schema
def cmd_schema(_args: argparse.Namespace) -> int:
    """Emit the exact DDL PostgreSQL will run -- paste it into an Alembic revision."""
    from .models import Base

    def dump(sql, *multiparams, **params):
        compiled = sql.compile(dialect=engine.dialect)
        text = str(compiled).strip()
        if text:
            sys.stdout.write(text + ";\n")

    engine = create_mock_engine("postgresql+psycopg://", dump)
    Base.metadata.create_all(bind=engine, checkfirst=False)
    return 0


# -------------------------------------------------------------------- once
def cmd_once(args: argparse.Namespace) -> int:
    settings = _apply_date(_settings(), args.date)
    settings.validate_required()

    log.info(
        "target: GET %s | date=%s",
        settings.vehicles_url(),
        settings.api_date or "<not set -- upstream defaults to today, IST>",
    )

    engine = build_engine(settings)
    factory = build_session_factory(engine)
    init_schema(engine)

    client = UpstreamClient(settings)
    tokens = TokenManager(settings, client)
    extractor = TelemetryExtractor(settings, client, tokens)

    if args.dry_run:
        payload: VehiclesPayload = extractor.fetch_only()
        validated = parse_payload(payload, settings.tz, ingest_time=datetime.now(timezone.utc))
        print(
            json.dumps(
                {
                    # What was actually called, so the URL format is verifiable
                    # without reading the logs.  `url` is assembled by the same
                    # code path that builds the real request.
                    "request": {
                        "method": "GET",
                        "url": client.vehicles_request_url(),
                        "date": settings.api_date,
                    },
                    "seen": validated.seen,
                    "accepted": validated.accepted,
                    "rejected": [r.model_dump() for r in validated.rejected],
                    "vehicles": [
                        {
                            "vehicle_id": v.vehicle_id,
                            "observed_at": v.observed_at.isoformat() if v.observed_at else None,
                            "missing": v.missing,
                            "field_errors": [e.model_dump() for e in v.field_errors],
                            "values": v.values,
                        }
                        for v in validated.ok
                    ],
                },
                indent=2,
                default=str,
            )
        )
        return 0

    orchestrator = TelemetryOrchestrator(settings, factory, extractor=extractor, tokens=tokens, client=client)
    return 0 if orchestrator.run_once() else 1


# ------------------------------------------------------------------ fields
def _source_label(spec) -> str:  # noqa: ANN001 - ParamSpec, kept untyped to avoid a cycle
    """The `source` column of the mapping table."""
    return "documented" if spec.documented else "INFERRED -- verify"


def cmd_fields(_args: argparse.Namespace) -> int:
    width = max(len(p.name) for p in PARAM_SPECS)
    print(f"{'#':>2}  {'column':<{width}}  {'unit':<6}  {'type':<6}  {'upstream aliases (first = preferred)':<50}  source")
    print("-" * (width + 76))
    for index, spec in enumerate(PARAM_SPECS, start=1):
        print(
            f"{index:>2}  {spec.name:<{width}}  {spec.unit:<6}  {spec.kind:<6}  "
            f"{', '.join(spec.aliases):<50}  "
            f"{_source_label(spec)}"
        )
    documented = sum(1 for p in PARAM_SPECS if p.documented)
    print(f"\n{len(PARAM_SPECS)} parameters: {documented} with keys confirmed upstream "
          f"(guide + live v1), {len(PARAM_SPECS) - documented} present under inferred keys. "
          "A parameter is NULL only when no alias appears in the merged frame.")
    return 0


# ------------------------------------------------------------- mock-server
def cmd_mock_server(args: argparse.Namespace) -> int:
    # tools/ is a scripts directory, not an importable package -- load it by path
    # so `python -m telemetry mock-server` works from a clean checkout.
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parent.parent / "tools" / "mock_server.py"
    spec = importlib.util.spec_from_file_location("mock_server", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load mock server from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.serve(port=args.port, vehicles=args.vehicles, all_fields=args.all_fields)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m telemetry",
        description="EV Battery Swap Station Digital Twin -- telemetry extraction engine",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("run", help="run the continuous extraction loop").set_defaults(func=cmd_run)
    sub.add_parser("init-db", help="create tables and indexes").set_defaults(func=cmd_init_db)
    sub.add_parser("schema", help="print the PostgreSQL DDL").set_defaults(func=cmd_schema)
    sub.add_parser("fields", help="print the 24-parameter mapping table").set_defaults(func=cmd_fields)

    once = sub.add_parser("once", help="run a single extraction cycle and exit")
    once.add_argument("--dry-run", action="store_true", help="fetch + validate, print JSON, write nothing")
    once.add_argument(
        "--date",
        metavar="YYYY-MM-DD",
        default=None,
        type=_date_arg,
        help="restrict the upstream payload to this date (server-local, IST); "
        "default: API_DATE from .env, else the server's own default (today)",
    )
    once.set_defaults(func=cmd_once)

    mock = sub.add_parser("mock-server", help="run a local stand-in for the upstream API")
    mock.add_argument("--port", type=int, default=8899)
    mock.add_argument("--vehicles", type=int, default=8)
    mock.add_argument("--all-fields", action="store_true", help="also emit the 14 undocumented parameters")
    mock.set_defaults(func=cmd_mock_server)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except KeyboardInterrupt:  # pragma: no cover
        return 130
    except RuntimeError as exc:
        # Configuration problems should read like configuration problems.
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
