"""DB-backed FastAPI app, shared by local uvicorn and Vercel's api/index.py.

    python -m uvicorn telemetry.main:app --host 0.0.0.0 --port 8000

Starting uvicorn serves HTTP only. For continuous local ingestion, ALSO run
``python -m telemetry run``. Vercel instead invokes GET /api/cron/ingest every
five minutes. Neither path needs an open browser tab. main_parser.py is an
unrelated offline file converter, not an ASGI entry point.

GET /api/telemetry/trusted and /api/ingest/status are read-only. All ingest
routes (including the legacy /api/ingest/trigger alias) use CRON_SECRET; they
fail closed on Vercel. Only unconfigured local development allows anonymous
bootstrap. A read must never bypass cron authentication or block on upstream.

Vehicle data and cycle outcomes live in PostgreSQL. Only the upstream token,
extractor signatures and per-instance single-flight/cooldown are cached here.
"""

from __future__ import annotations

import hmac
import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Final

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import func, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .auth import TokenManager
from .api import UpstreamClient
from .config import Settings, get_settings
from .db import build_engine, build_session_factory, init_schema
from .document import document_from_state_rows, empty_document
from .exceptions import AuthRejectedError
from .extractor import TelemetryExtractor
from .models import ProvisionedSite, VehicleState
from .ingestion import failure_detail, ingestion_health, run_recorded_cycle
from .logging_setup import configure_logging
from .schemas import (
    SiteProvisionRecord,
    SiteProvisionRequest,
    SiteProvisionResponse,
)

# Include extractor/date-probe events under uvicorn as well as the CLI.
configure_logging(get_settings())
log = logging.getLogger("telemetry.control_plane")

app = FastAPI(
    title="Digital Twin Control Plane",
    version="2.1.0",
    redirect_slashes=False,
    description=(
        "Reads the validated telemetry snapshot out of Neon PostgreSQL and "
        "triggers ingestion cycles from the Blue Energy Motors API. "
        "HTTP is read/trigger only; polling is owned by the worker or cron."
    ),
)

# Origins allowed to call us directly from a browser.  On Vercel the dashboard
# reaches us through the same-origin rewrite (server-to-server, no CORS), so
# this list only matters for direct browser calls in local development.
_ALLOWED_ORIGINS: Final[list[str]] = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ALLOW_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


# ---------------------------------------------------------------------------
# process-cached infrastructure (one warm instance = one of each)
# ---------------------------------------------------------------------------
_engine = None
_factory = None
_schema_ready = threading.Event()
_ingest_lock = threading.Lock()  # one cycle at a time per instance
_cycle_lock = threading.Lock()  # guards the summary/cooldown fields below
_state: dict[str, Any] = {"last_cycle": None, "last_started": 0.0}

_ingest_client: UpstreamClient | None = None
_ingest_tokens: TokenManager | None = None
_ingest_extractor: TelemetryExtractor | None = None


def _settings() -> Settings:
    """Settings accessor -- monkeypatched by the test suite."""
    return get_settings()


def _session_factory():
    """Session factory accessor -- monkeypatched by the test suite."""
    global _engine, _factory
    settings = _settings()
    if not settings.database_url:
        raise HTTPException(
            status_code=503,
            detail="DATABASE_URL is not configured. Set it to the Neon connection string "
            "(postgresql+psycopg://user:password@host/db?sslmode=require).",
        )
    if _engine is None:
        # Cached per process: one engine, one sessionmaker per warm instance.
        # On Vercel the engine runs NullPool (see db.build_engine), so no socket
        # outlives the invocation that opened it.
        _engine = build_engine(settings)
        _factory = build_session_factory(_engine)
    return _factory


def _ensure_schema_once() -> None:
    """create_all + column reconcile, once per process (idempotent, cheap).

    `create_all` only creates MISSING tables -- it never widens an existing
    one -- so the reconcile inside `init_schema` is what lights up the
    validator-verdict columns on a database provisioned by an older engine.
    """
    if _schema_ready.is_set():
        return
    factory = _session_factory()
    engine = (getattr(factory, "kw", {}) or {}).get("bind") or getattr(factory, "bind", None)
    if engine is None:
        raise HTTPException(status_code=503, detail="No database engine bound to the session factory.")
    init_schema(engine)
    _schema_ready.set()


def get_db() -> Session:
    """Request-scoped session. Read paths never commit; writers commit themselves."""
    factory = _session_factory()
    session = factory()
    try:
        yield session
    finally:
        session.close()


def _mask_url(url: str) -> str:
    """Credentials stripped, for echoing config back in health responses."""
    try:
        from sqlalchemy.engine import make_url

        return make_url(url).render_as_string(hide_password=True)
    except Exception:  # pragma: no cover - defensive
        return "<set>"


# ---------------------------------------------------------------------------
# health
# ---------------------------------------------------------------------------
@app.get("/health")
@app.get("/api/health")
def health() -> JSONResponse:
    """Process liveness plus uncached DB/poller health; never calls upstream."""
    settings = _settings()
    database = "not-configured"
    diagnostic: dict[str, Any] = {
        "state": "unknown", "detail": "Database is not configured; ingestion health is unknown.",
        "expected_interval_seconds": settings.poll_interval_seconds,
        "last_attempt": None, "last_success_at": None, "newest_observed_at": None,
    }
    if settings.database_url:
        database = "down"
        try:
            _ensure_schema_once()
            with _session_factory()() as probe:
                probe.execute(text("SELECT 1")).scalar()
                diagnostic = ingestion_health(probe, settings)
            database = "up"
        except Exception as exc:
            log.warning("health probe: database unavailable (%s)", type(exc).__name__)
            diagnostic["detail"] = "Database unreachable; ingestion health is unknown. Check Neon connectivity."
    return JSONResponse({
        "status": "ok", "service": "digital-twin-control-plane", "version": app.version,
        "database": database,
        "serverless": bool(os.getenv("VERCEL") or os.getenv("AWS_LAMBDA_FUNCTION_NAME")),
        "last_cycle": diagnostic.get("last_attempt", {}).get("finished_at") if diagnostic.get("last_attempt") else None,
        "ingestion": diagnostic,
        "time": datetime.now(timezone.utc).isoformat(),
    }, headers={"Cache-Control": "no-store"})


@app.get("/api/ingest/status", summary="Durable ingestion diagnostics (read-only).")
def ingest_status(db: Session = Depends(get_db)) -> JSONResponse:
    _ensure_schema_once()
    return JSONResponse(ingestion_health(db, _settings()), headers={"Cache-Control": "no-store"})


@app.get("/api/telemetry/trusted", summary="Latest validated telemetry document, rebuilt from Neon.")
def trusted_telemetry(db: Session = Depends(get_db)) -> JSONResponse:
    """Read committed snapshots only; never turn a dashboard visit into a poll."""
    settings = _settings()
    generated_at = datetime.now(timezone.utc)
    try:
        _ensure_schema_once()
        rows = list(db.execute(select(VehicleState)).scalars())
        diagnostic = ingestion_health(db, settings, now=generated_at)
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=503, detail=failure_detail(exc)[1]) from exc

    if not rows:
        payload = empty_document(
            settings_tz=settings.tz, require_all_fields=settings.require_all_fields,
            reason="No vehicles have been ingested yet. " + diagnostic["detail"],
            generated_at=generated_at,
        )
    else:
        payload = document_from_state_rows(
            rows, settings_tz=settings.tz, require_all_fields=settings.require_all_fields,
            generated_at=generated_at, database_url_masked=_mask_url(settings.database_url),
            last_cycle=diagnostic["last_attempt"],
        )
    payload["pipeline_health"]["ingestion"] = diagnostic
    return JSONResponse(content=payload, headers={
        "Cache-Control": "no-store",
        "X-Document-Generated-At": generated_at.isoformat(),
        "X-Document-Vehicles": str(len(rows)),
        "X-Auto-Ingest": "false",
    })


# ---------------------------------------------------------------------------
# site provisioning (DB-backed; the old JSON append lost its filesystem)
# ---------------------------------------------------------------------------
@app.post(
    "/api/provision-site",
    response_model=SiteProvisionResponse,
    status_code=200,
    summary="Register a new isolated twin site (append-only Neon table).",
)
def provision_site(payload: SiteProvisionRequest, db: Session = Depends(get_db)) -> SiteProvisionResponse:
    _ensure_schema_once()
    record = SiteProvisionRecord(**payload.model_dump())
    try:
        db.add(
            ProvisionedSite(
                site_id=record.siteId,
                label=record.label,
                customer=record.customer,
                chargers=record.chargers,
                dg_capacity_kw=record.dgCapacityKw,
                grid_feeder_kw=record.gridFeederKw,
                source=record.source,
                received_at=record.received_at,
            )
        )
        total = db.execute(select(func.count()).select_from(ProvisionedSite)).scalar_one()
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail=f"Database write failed: {exc}") from exc

    # Console proof for the demo: the payload made it from the browser to Python.
    log.info(
        "provisioned site=%s customer=%r chargers=%d dg=%dkW feeder=%dkW (total=%d)",
        record.siteId,
        record.customer,
        record.chargers,
        record.dgCapacityKw,
        record.gridFeederKw,
        total,
    )

    return SiteProvisionResponse(
        siteId=record.siteId,
        message=f"Site {record.siteId} provisioned for {record.customer}.",
        totalSites=total,
    )


@app.get("/api/provisioned-sites")
def list_sites(db: Session = Depends(get_db)) -> dict[str, Any]:
    _ensure_schema_once()
    try:
        rows = list(db.execute(select(ProvisionedSite).order_by(ProvisionedSite.received_at)).scalars())
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=503, detail=f"Database unreachable: {exc}") from exc
    return {
        "ok": True,
        "count": len(rows),
        "sites": [
            {
                "siteId": r.site_id,
                "label": r.label,
                "customer": r.customer,
                "chargers": r.chargers,
                "dgCapacityKw": r.dg_capacity_kw,
                "gridFeederKw": r.grid_feeder_kw,
                "source": r.source,
                "received_at": (r.received_at or datetime.now(timezone.utc)).isoformat(),
            }
            for r in rows
        ],
    }


# ---------------------------------------------------------------------------
# ingestion: one cycle, on demand (cron or manual), straight into Neon
# ---------------------------------------------------------------------------
def _ingest_components(settings: Settings) -> tuple[UpstreamClient, TokenManager, TelemetryExtractor]:
    """Build (once per process) the upstream client + token cache + extractor.

    Keeping them module-level is what makes warm invocations cheap AND correct:
    the token manager re-authenticates only at its 55-minute deadline, the
    extractor skips unchanged frames, and the live-date resolver remembers the
    date it settled on -- exactly the per-process state the old loop relied on.
    """
    global _ingest_client, _ingest_tokens, _ingest_extractor
    if _ingest_extractor is None:
        _ingest_client = UpstreamClient(settings)
        _ingest_tokens = TokenManager(settings, _ingest_client)
        _ingest_extractor = TelemetryExtractor(settings, _ingest_client, _ingest_tokens)
    return _ingest_client, _ingest_tokens, _ingest_extractor


def _reset_ingest_components() -> None:
    global _ingest_client, _ingest_tokens, _ingest_extractor
    if _ingest_client is not None:
        _ingest_client.session.close()
    _ingest_client = None
    _ingest_tokens = None
    _ingest_extractor = None


def _authorize_ingest(request: Request) -> None:
    """Bearer check against CRON_SECRET. Fails closed on Vercel, open locally."""
    expected = _settings().cron_secret or os.getenv("CRON_SECRET", "")
    if expected:
        provided = ""
        header = request.headers.get("authorization", "")
        if header.lower().startswith("bearer "):
            provided = header[7:].strip()
        if not hmac.compare_digest(provided.encode(), expected.encode()):
            raise HTTPException(status_code=401, detail="Invalid or missing ingestion secret.")
        return
    if os.getenv("VERCEL") or os.getenv("AWS_LAMBDA_FUNCTION_NAME"):
        raise HTTPException(
            status_code=401,
            detail="Ingestion is not authorised: set the CRON_SECRET environment variable "
            "(Vercel -> Settings -> Environment Variables). Vercel Cron sends it as a "
            "Bearer token automatically; external schedulers must send it explicitly.",
        )
    log.info("no CRON_SECRET configured -- allowing unauthenticated local ingestion")


def _cooldown_seconds() -> float:
    return max(_settings().ingest_min_interval_seconds, 0.0)


@app.post("/api/ingest/run", summary="Run one extraction cycle now (vendor API -> Neon).")
def ingest_run(request: Request) -> dict[str, Any]:
    _authorize_ingest(request)
    return _ingest_endpoint(trigger="manual")


@app.get("/api/cron/ingest", summary="Vercel Cron entry point: one extraction cycle.")
def cron_ingest(request: Request) -> dict[str, Any]:
    _authorize_ingest(request)
    return _ingest_endpoint(trigger="cron")


@app.post("/api/ingest/trigger", summary="Legacy dashboard alias; same authorization as /api/ingest/run.")
def trigger_ingest(request: Request) -> dict[str, Any]:
    _authorize_ingest(request)
    return _ingest_endpoint(trigger="dashboard")


@app.post("/api/ingest/upload", include_in_schema=False)
def ingest_upload_gone() -> JSONResponse:
    """The old file drop-zone, retired loudly rather than silently broken."""
    return JSONResponse(
        status_code=410,
        content={
            "ok": False,
            "detail": "Raw file upload was removed: serverless filesystems are ephemeral. "
            "Ingestion now means a validated cycle into PostgreSQL -- POST /api/ingest/run "
            "with the Bearer secret, or GET /api/cron/ingest from the scheduler.",
        },
    )


def _ingest_endpoint(*, trigger: str) -> dict[str, Any]:
    settings = _settings()
    if not _ingest_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="An ingestion cycle is already running on this instance. Retry shortly.")
    # EVERYTHING after acquiring the lock is protected by finally, including
    # factory/schema construction. A DB failure must not wedge this instance.
    try:
        cooldown = _cooldown_seconds()
        with _cycle_lock:
            last_started = float(_state.get("last_started") or 0.0)
            if cooldown and last_started and time.monotonic() - last_started < cooldown:
                raise HTTPException(status_code=429, detail=f"Ingestion cooldown is {cooldown:.0f}s. Wait before trying again.")
            _state["last_started"] = time.monotonic()
        _ensure_schema_once()
        _, _, extractor = _ingest_components(settings)
        result = run_recorded_cycle(settings, _session_factory(), extractor, trigger=trigger)
        with _cycle_lock:
            _state["last_cycle"] = result.payload
        return result.payload
    except HTTPException:
        raise
    except Exception as exc:
        if isinstance(exc, AuthRejectedError):
            _reset_ingest_components()
        code, detail = failure_detail(exc)
        log.error("ingest trigger=%s error_code=%s error_type=%s", trigger, code, type(exc).__name__)
        status = 503 if code in {"database_error", "configuration_error"} else 502
        raise HTTPException(status_code=status, detail=detail) from exc
    finally:
        _ingest_lock.release()


# ---------------------------------------------------------------------------
# error shape: keep every failure JSON and predictable for the dashboard
# ---------------------------------------------------------------------------
@app.exception_handler(HTTPException)
async def _http_exception_handler(request: Request, exc: HTTPException):  # noqa: ANN001 - FastAPI signature
    from fastapi.responses import JSONResponse as _JSONResponse

    return _JSONResponse(status_code=exc.status_code, content={"ok": False, "detail": exc.detail})


@app.exception_handler(SQLAlchemyError)
async def _database_exception_handler(request: Request, exc: SQLAlchemyError):
    log.error("database request failed (%s)", type(exc).__name__)
    return JSONResponse(status_code=503, content={"ok": False, "detail": failure_detail(exc)[1]})
