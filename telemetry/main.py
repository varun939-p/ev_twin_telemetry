"""FastAPI control plane: receive a site provision and persist it to a file.

Demo constraints honoured:
  * No database.  The only write is an append to ``provisioned_sites.json``.
  * CORS is enabled so the Next.js app (default ``http://localhost:3000``) may
    POST directly.  In the sandbox we instead reach this service through the
    Next.js rewrite proxy, which is server-to-server and needs no CORS -- both
    paths work.

Run:
    uvicorn telemetry.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any, Final

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .schemas import (
    SiteProvisionRecord,
    SiteProvisionRequest,
    SiteProvisionResponse,
)

log = logging.getLogger("backend.provision")
# uvicorn configures its own loggers and leaves the root at WARNING, so attach a
# handler here to guarantee the "payload reached Python" proof prints to console.
if not log.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s :: %(message)s"))
    log.addHandler(_handler)
    log.setLevel(logging.INFO)
    log.propagate = False

_STORE_LOCK = threading.Lock()

# Where the append-only store lives; override for tests.
STORE_PATH: Final[Path] = Path(os.getenv("PROVISIONED_SITES_PATH", str(Path(__file__).with_name("provisioned_sites.json"))))

# Manual Data Ingestion drop-zone. Raw uploads land here for the validation
# pipeline; automated API agents will write to the same place later.
INGEST_DIR: Final[Path] = Path(os.getenv("INGEST_DIR", str(Path(__file__).resolve().parent.parent / "uploads" / "ingest")))
_INGEST_LOCK = threading.Lock()

# The validated document written by `main_parser.py`. This is what the
# dashboard reads; override for a staging layout or a shared volume.
TRUSTED_DOC_PATH: Final[Path] = Path(
    os.getenv(
        "TRUSTED_DOC_PATH",
        str(Path(__file__).resolve().parent.parent / "trusted_vehicle_telemetry.json"),
    )
)

# Origins allowed to call us directly from a browser.  The Next.js dev server
# is the primary one; the proxy path does not rely on CORS at all.
_ALLOWED_ORIGINS: Final[list[str]] = [
    origin.strip()
    for origin in os.getenv("CORS_ALLOW_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")
    if origin.strip()
]

app = FastAPI(
    title="Digital Twin Control Plane",
    version="0.1.0",
    description="Receives site-provisioning requests from the Next.js dashboard.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


# ------------------------------------------------------------------ storage
def _read_store() -> list[dict[str, Any]]:
    if not STORE_PATH.exists():
        return []
    try:
        data = json.loads(STORE_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (ValueError, OSError):
        log.warning("provisioned_sites.json was unreadable -- starting fresh")
        return []


def _append(record: SiteProvisionRecord) -> int:
    with _STORE_LOCK:
        rows = _read_store()
        rows.append(json.loads(record.model_dump_json()))
        tmp = STORE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(STORE_PATH)
        return len(rows)


# ------------------------------------------------------------------ routes
@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post(
    "/api/provision-site",
    response_model=SiteProvisionResponse,
    status_code=200,
    summary="Register a new isolated twin site (demo, file-backed).",
)
def provision_site(payload: SiteProvisionRequest) -> SiteProvisionResponse:
    record = SiteProvisionRecord(**payload.model_dump())
    total = _append(record)

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
def list_sites() -> dict[str, Any]:
    rows = _read_store()
    return {"ok": True, "count": len(rows), "sites": rows}


@app.get(
    "/api/telemetry/trusted",
    summary="Serve the latest validated telemetry document to the dashboard.",
)
def trusted_telemetry() -> Any:
    """The dashboard's single read endpoint.

    ``main_parser.py`` polls the vendor's two-tier v1 contract (authenticating
    with ``API_SECRET_KEY`` / ``API_PASSCODE`` from ``.env``), validates every
    frame and writes ``trusted_vehicle_telemetry.json``.  This hands that
    document to the Next.js server verbatim.

    The credentials deliberately stop HERE.  The browser never sees them and
    never talks to the vendor: browser -> Next server -> this service -> vendor.
    Anything else would put a fleet-wide API key in a client bundle.

    ``no-store`` because the whole point is that a poll five seconds ago is
    already stale; the Next.js layer applies its own short revalidate window.
    """
    if not TRUSTED_DOC_PATH.exists():
        raise HTTPException(
            status_code=503,
            detail=(
                f"No validated document at {TRUSTED_DOC_PATH.name}. "
                "Run `python main_parser.py` to poll the upstream and produce one."
            ),
        )

    try:
        payload = json.loads(TRUSTED_DOC_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        # A half-written file during a parser run must not 200 with junk.
        raise HTTPException(status_code=503, detail=f"Document unreadable: {exc}") from exc

    stat = TRUSTED_DOC_PATH.stat()
    return JSONResponse(
        content=payload,
        headers={
            "Cache-Control": "no-store",
            # Lets the caller log ingest lag without parsing the body.
            "X-Document-Mtime": str(int(stat.st_mtime)),
            "X-Document-Vehicles": str(len(payload.get("vehicles", []))),
        },
    )


@app.post("/api/ingest/upload", summary="Manual Data Ingestion: drop a raw telemetry file into the Data Layer.")
async def ingest_upload(file: UploadFile = File(...)) -> dict[str, Any]:
    name = Path(file.filename or "upload.bin").name  # strip any client path parts
    if not name.lower().endswith((".csv", ".json")):
        raise HTTPException(status_code=415, detail="Only .csv or .json telemetry files are accepted.")

    payload = await file.read()
    with _INGEST_LOCK:
        INGEST_DIR.mkdir(parents=True, exist_ok=True)
        target = INGEST_DIR / name
        target.write_bytes(payload)

    log.info("ingested file=%s bytes=%d", name, len(payload))
    return {
        "ok": True,
        "filename": name,
        "bytes": len(payload),
        "message": f"{name} ({len(payload)} bytes) received by the Data Layer.",
    }


@app.exception_handler(HTTPException)
async def _http_exception_handler(request, exc):  # noqa: ANN001 - FastAPI signature
    """Keep error bodies JSON and predictable for the dashboard's catch-path."""
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=exc.status_code, content={"ok": False, "detail": exc.detail})
