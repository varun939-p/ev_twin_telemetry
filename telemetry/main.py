"""FastAPI control plane -- the dashboard's read path and the ingestion trigger.

Serverless edition.  One deployment serves both the Next.js dashboard and this
ASGI app (mounted by ``api/index.py`` on Vercel), and the app itself is
stateless: every request reads or writes **Neon PostgreSQL**, never a local
file.  The old design -- a background poller rewriting
``trusted_vehicle_telemetry.json`` and this service serving that file -- cannot
run on Vercel's ephemeral filesystem; the database is the only state here.

Run locally (needs DATABASE_URL, e.g. the bundled mock + PostgreSQL):

    uvicorn telemetry.main:app --host 0.0.0.0 --port 8000

Routes
------
    GET  /health                  liveness (probe-friendly, always cheap)
    GET  /api/health              same, under /api for the same-origin rewrite
    GET  /api/telemetry/trusted   THE dashboard read: the trusted document,
                                  rebuilt from `vehicle_state` on every call
    POST /api/provision-site      register a twin site (append-only table)
    GET  /api/provisioned-sites   list what was provisioned
    POST /api/ingest/run          one extraction cycle: vendor API -> validate
                                  -> Neon upsert (Bearer-protected)
    GET  /api/cron/ingest         the Vercel Cron entry point; same cycle
    POST /api/ingest/upload       REMOVED -- 410 Gone (serverless filesystems
                                  are ephemeral; ingest means "into Neon")

Ingestion is authenticated with ``CRON_SECRET`` (Vercel sends
``Authorization: Bearer $CRON_SECRET`` on managed cron invocations
automatically).  On Vercel the ingest routes fail closed when the secret is
unset -- an open endpoint that triggers upstream pulls is a quota leak.  Local
development stays open when no secret is configured.

Warm-instance state is deliberate and bounded: the upstream token, the
unchanged-frame signatures and the resolved live-date are cached per process
(cold starts re-authenticate; warm invocations reuse a live token), and a
cooldown + single-flight lock stop overlapping requests from turning into an
accidental poll loop against the vendor API.
"""

from __future__ import annotations

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
from .exceptions import AuthRejectedError, TelemetryError, UpstreamError
from .extractor import TelemetryExtractor
from .models import ProvisionedSite, VehicleState
from .schemas import (
    SiteProvisionRecord,
    SiteProvisionRequest,
    SiteProvisionResponse,
)

log = logging.getLogger("backend.control-plane")
# uvicorn configures its own loggers and leaves the root at WARNING, so attach a
# handler here to guarantee "payload reached Python" proofs print to console.
if not log.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s :: %(message)s"))
    log.addHandler(_handler)
    log.setLevel(logging.INFO)
    log.propagate = False

app = FastAPI(
    title="Digital Twin Control Plane",
    version="2.0.0",
    description=(
        "Reads the validated telemetry snapshot out of Neon PostgreSQL and "
        "triggers ingestion cycles from the Blue Energy Motors API. "
        "Serverless: no local files, no background loop."
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
def health() -> dict[str, Any]:
    """Liveness probe. Always cheap; never throws.

    ``database`` answers one of: ``not-configured`` / ``up`` / ``down`` -- a
    fast ``SELECT 1`` so the dashboard can distinguish "the function is up but
    the database is not" from a plain outage.  A failed probe still returns
    200: this endpoint reports the process, not the data path.
    """
    settings = _settings()
    database = "not-configured"
    if settings.database_url:
        database = "down"
        try:
            factory = _session_factory()
            probe = factory()
            try:
                probe.execute(text("SELECT 1")).scalar()
            finally:
                probe.close()
            database = "up"
        except Exception:
            log.warning("health probe: database unreachable", exc_info=True)

    last = _state.get("last_cycle")
    return {
        "status": "ok",
        "service": "digital-twin-control-plane",
        "version": app.version,
        "database": database,
        "database_url": _mask_url(settings.database_url) if settings.database_url else None,
        "serverless": bool(os.getenv("VERCEL") or os.getenv("AWS_LAMBDA_FUNCTION_NAME")),
        "last_cycle": last.get("finished_at") if isinstance(last, dict) else None,
        "time": datetime.now(timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# the dashboard read
# ---------------------------------------------------------------------------
@app.get(
    "/api/telemetry/trusted",
    summary="Serve the latest validated telemetry document, rebuilt from Neon.",
)
def trusted_telemetry(db: Session = Depends(get_db)) -> JSONResponse:
    """The dashboard's single read endpoint.

    The document is assembled from ``vehicle_state`` -- the table the
    extraction engine upserts on every cycle -- so the freshest committed
    snapshot is what the dashboard renders.  Per-parameter verdicts
    (``field_status``) were persisted at ingest time by the validator; nothing
    is re-invented or re-validated here, and no local file is involved.

    ``no-store`` because the whole point is that a cycle five seconds ago is
    already stale; the Next.js layer applies its own short revalidate window.
    """
    settings = _settings()
    generated_at = datetime.now(timezone.utc)
    try:
        _ensure_schema_once()
        rows = list(db.execute(select(VehicleState)).scalars())
    except HTTPException:
        raise
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=503, detail=f"Database unreachable: {exc}") from exc

    if not rows:
        payload = empty_document(
            settings_tz=settings.tz,
            require_all_fields=settings.require_all_fields,
            reason=(
                "No vehicles in the database yet. Trigger an ingestion cycle "
                "(POST /api/ingest/run, or wait for the cron job) to pull the fleet."
            ),
            generated_at=generated_at,
        )
    else:
        payload = document_from_state_rows(
            rows,
            settings_tz=settings.tz,
            require_all_fields=settings.require_all_fields,
            generated_at=generated_at,
            database_url_masked=_mask_url(settings.database_url),
            last_cycle=_last_cycle_summary(),
        )

    return JSONResponse(
        content=payload,
        headers={
            "Cache-Control": "no-store",
            # Lets the caller log ingest lag without parsing the body.
            "X-Document-Generated-At": generated_at.isoformat(),
            "X-Document-Vehicles": str(len(payload.get("vehicles", []))),
        },
    )


def _last_cycle_summary() -> dict[str, Any] | None:
    with _cycle_lock:
        last = _state.get("last_cycle")
        return dict(last) if isinstance(last, dict) else None


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
        if provided != expected:
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
    try:
        settings.validate_required()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    cooldown = _cooldown_seconds()
    with _cycle_lock:
        last_started = float(_state.get("last_started") or 0.0)
    if cooldown and last_started and (time.monotonic() - last_started) < cooldown:
        raise HTTPException(
            status_code=429,
            detail=(
                f"An ingestion cycle ran {time.monotonic() - last_started:.0f}s ago "
                f"(cooldown {cooldown:.0f}s). Reuse the last result below instead of "
                "polling the vendor API."
            ),
        )

    if not _ingest_lock.acquire(blocking=False):
        raise HTTPException(
            status_code=409,
            detail="An ingestion cycle is already running on this instance. Retry shortly.",
        )

    started = time.monotonic()
    with _cycle_lock:
        _state["last_started"] = started
    factory = _session_factory()
    session = factory()
    try:
        _ensure_schema_once()
        client, tokens, extractor = _ingest_components(settings)
        report = extractor.run_cycle(session)
    except AuthRejectedError as exc:
        # Credentials are wrong or the client was disabled. Re-authenticating
        # will not help until the operator fixes the secret, but the cached
        # token must go: keep the instance alive and honest.
        _reset_ingest_components()
        log.error("ingest auth rejected: %s", exc)
        raise HTTPException(status_code=502, detail=f"Upstream rejected our credentials: {exc}") from exc
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=f"Upstream API failure: {exc}") from exc
    except TelemetryError as exc:
        raise HTTPException(status_code=502, detail=f"Extraction failed: {exc}") from exc
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=503, detail=f"Database write failed: {exc}") from exc
    finally:
        session.close()
        _ingest_lock.release()

    summary = {
        "seen": report.seen,
        "accepted": report.accepted,
        "rejected": report.rejected,
        "states_written": report.write.states_written,
        "history_written": report.write.history_written,
        "unchanged_skipped": report.write.skipped_unchanged,
        "stale_skipped": report.write.states_skipped_stale,
        "detail_ok": report.detail_ok,
        "detail_failed": report.detail_failed,
        "resolved_date": report.resolved_date,
        "date_source": report.date_source,
        "date_probes": report.date_probes,
    }
    cycle = {
        "ok": True,
        "trigger": trigger,
        "cycle_seconds": round(time.monotonic() - started, 3),
        "summary": summary,
        "report_line": report.summary(),
        "finished_at": datetime.now(timezone.utc).isoformat(),
    }
    with _cycle_lock:
        _state["last_cycle"] = cycle
    log.info("ingest (%s): %s", trigger, report.summary())
    return cycle


# ---------------------------------------------------------------------------
# error shape: keep every failure JSON and predictable for the dashboard
# ---------------------------------------------------------------------------
@app.exception_handler(HTTPException)
async def _http_exception_handler(request: Request, exc: HTTPException):  # noqa: ANN001 - FastAPI signature
    from fastapi.responses import JSONResponse as _JSONResponse

    return _JSONResponse(status_code=exc.status_code, content={"ok": False, "detail": exc.detail})
