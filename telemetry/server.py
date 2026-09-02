import json, logging, os, threading, re
from pathlib import Path
from typing import Any, Final
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

log = logging.getLogger("backend.provision")
if not log.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s :: %(message)s"))
    log.addHandler(_handler)
    log.setLevel(logging.INFO)

_STORE_LOCK = threading.Lock()
STORE_PATH: Final[Path] = Path(__file__).with_name("provisioned_sites.json")

class SiteProvisionRequest(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    siteId: str = Field(min_length=3, max_length=32, pattern=r"^[A-Za-z0-9._-]{3,32}$")
    label: str = Field(default="", max_length=64)
    customer: str = Field(min_length=1, max_length=64)
    chargers: int = Field(ge=0, le=512)
    dgCapacityKw: int = Field(ge=0, le=100_000)
    gridFeederKw: int = Field(ge=0, le=100_000)

class SiteProvisionRecord(SiteProvisionRequest):
    received_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    source: str = Field(default="nextjs-dashboard")

app = FastAPI(title="Digital Twin Control Plane")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

def _read_store() -> list[dict[str, Any]]:
    if not STORE_PATH.exists(): return []
    try:
        data = json.loads(STORE_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (ValueError, OSError):
        return []

def _append(record: SiteProvisionRecord) -> int:
    with _STORE_LOCK:
        rows = _read_store()
        rows.append(json.loads(record.model_dump_json()))
        tmp = STORE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(STORE_PATH)
        return len(rows)

@app.post("/api/provision-site")
def provision_site(payload: SiteProvisionRequest):
    record = SiteProvisionRecord(**payload.model_dump())
    total = _append(record)
    log.info(f"provisioned site={record.siteId} customer={record.customer} chargers={record.chargers} dg={record.dgCapacityKw}kW feeder={record.gridFeederKw}kW (total={total})")
    return {"ok": True, "siteId": record.siteId, "message": f"Site {record.siteId} provisioned for {record.customer}.", "totalSites": total}