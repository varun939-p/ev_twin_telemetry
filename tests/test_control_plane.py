"""The control plane (telemetry/main.py): reads Neon, triggers ingestion.

The serverless contract in one file:

  * ``/api/telemetry/trusted`` rebuilds the trusted document from the
    ``vehicle_state`` snapshot table on every call -- no file, no cache of its
    own, and an EMPTY database is a valid 200 document (the dashboard renders
    its "awaiting first ingestion" states), while a MISCONFIGURED database is
    a 503 with a sentence an operator can act on.
  * ``/api/provision-site`` keeps its browser contract (the shape the old
    twin-view posted) but the append now lands in a Neon table -- the
    serverless filesystem is ephemeral, so the old JSON append would have
    silently vanished on every deploy.
  * the ingest routes are Bearer-gated by CRON_SECRET, fail closed on Vercel
    when the secret is missing, and hold a per-instance cooldown so a
    misbehaving client cannot become an accidental poll loop.

The suite runs on SQLite: everything asserted here (document building,
verdict persistence, auth, cooldown) is dialect-independent ORM work; the
PostgreSQL-specific upsert SQL is covered by test_repository.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from telemetry import main as control_plane
from telemetry.document import ABSENT_UPSTREAM, MEASURED
from telemetry.fields import PARAM_SPECS
from telemetry.models import Base
from telemetry.repository import TelemetryRepository
from telemetry.schemas import FieldError, ParsedVehicle

# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

# One plausible value per parameter kind -- enough for the document builder,
# which only cares that a value is present (measured) or absent (NULL).
_SAMPLE_VALUES: dict[str, object] = {
    "soc": 62.0,
    "soh": 97.5,
    "odometer_km": 41820.0,
    "residual_mileage_km": 140.5,
    "charge_cycles": 312,
    "battery_temp_c": 33.5,
    "min_cell_v": 3.31,
    "max_cell_v": 3.38,
    "max_temp_c": 36.1,
    "min_temp_c": 28.4,
    "regen_kwh": 11.2,
    "speed_kmh": 0.0,
    "total_power_kwh": 1523.4,
    "charging_status": 0,
    "battery_avg_temp_c": 32.8,
    "battery_total_v": 521.6,
    "battery_current_a": -2.4,
    "max_cell_v_cell_no": 12,
    "min_cell_v_pack_no": 2,
    "min_cell_v_cell_no": 88,
    "max_temp_pack_no": 1,
    "work_status": "PARKED",
    "latitude": 12.9716,
    "longitude": 77.5946,
}


def _parsed_vehicle(
    vehicle_id: str,
    *,
    observed: datetime,
    absent: tuple[str, ...] = (),
    nulls: tuple[str, ...] = (),
    errors: list[FieldError] | None = None,
) -> ParsedVehicle:
    """A validator-shaped frame: absent keys dropped, nulls kept, errors marked."""
    values: dict[str, object] = {}
    for spec in PARAM_SPECS:
        if spec.name in absent:
            continue
        if spec.name in nulls:
            values[spec.name] = None
        else:
            values[spec.name] = _SAMPLE_VALUES[spec.name]
    return ParsedVehicle(
        vehicle_id=vehicle_id,
        observed_at=observed,
        values=values,
        field_errors=errors or [],
        missing=list(absent),
    )


def _seed(session_factory, vehicles: list[ParsedVehicle], ingested_at: datetime | None = None) -> None:
    session = session_factory()
    try:
        TelemetryRepository(session).write_cycle(
            vehicles, ingested_at=ingested_at or datetime.now(timezone.utc)
        )
        session.commit()
    finally:
        session.close()


@pytest.fixture
def client(tmp_path, monkeypatch):
    """TestClient over a fresh SQLite database and an isolated Settings copy."""
    db_file = tmp_path / "twin.db"
    engine = create_engine(f"sqlite:///{db_file}", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

    settings = control_plane._settings().model_copy(
        update={
            "database_url": f"sqlite:///{db_file}",
            "api_secret_key": "sk_test_secret",
            "api_passcode": "test-passcode",
            "cron_secret": "",
            "ingest_min_interval_seconds": 0.0,
        }
    )
    monkeypatch.setattr(control_plane, "_settings", lambda: settings)
    monkeypatch.setattr(control_plane, "_session_factory", lambda: factory)
    monkeypatch.setattr(control_plane, "_schema_ready", threading.Event())
    monkeypatch.setattr(control_plane, "_state", {"last_cycle": None, "last_started": 0.0})

    with TestClient(control_plane.app) as test_client:
        yield test_client


PROVISION_BODY = {
    "siteId": "SWP-PUNE-01",
    "label": "Pune North",
    "customer": "Blue Energy Motors",
    "chargers": 4,
    "dgCapacityKw": 500,
    "gridFeederKw": 250,
}


# ---------------------------------------------------------------------------
# health
# ---------------------------------------------------------------------------
def test_health_reports_the_process_and_the_database(client):
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    # The SQLite test database is reachable, and health says so: the dashboard
    # uses this field to distinguish "function up, database down" from a
    # plain outage.
    assert body["database"] == "up"
    # No credentials are ever echoed.
    assert "test-passcode" not in response.text


def test_api_health_mirrors_health_under_the_rewrite_prefix(client):
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/health").json()["status"] == "ok"


# ---------------------------------------------------------------------------
# the dashboard read
# ---------------------------------------------------------------------------
def test_trusted_document_is_rebuilt_from_the_database(client):
    observed = datetime(2026, 9, 5, 9, 30, tzinfo=timezone.utc)
    absent = ("battery_total_v", "battery_current_a", "battery_avg_temp_c")
    _seed(
        control_plane._session_factory(),
        [
            _parsed_vehicle("AP39WG5383", observed=observed, absent=absent),
            _parsed_vehicle(
                "AP39WG1111",
                observed=observed - timedelta(minutes=5),
                nulls=("speed_kmh",),
            ),
        ],
    )

    response = client.get("/api/telemetry/trusted")
    assert response.status_code == 200
    assert response.headers["X-Document-Vehicles"] == "2"
    assert response.headers["cache-control"] == "no-store"

    doc = response.json()
    # Exactly the shape lib/telemetry-source.ts's assertDocumentShape demands.
    assert isinstance(doc["vehicles"], list) and doc["vehicles"]
    assert isinstance(doc["pipeline_health"], dict)
    assert doc["provenance"]["input_shape"] == "postgres_snapshot"
    assert doc["provenance"]["database_written"] is True

    # The document is sorted by vehicle_id for stable rendering.
    [primary, secondary] = doc["vehicles"]
    assert primary["vehicle_id"] == "AP39WG1111"
    assert secondary["vehicle_id"] == "AP39WG5383"
    assert len(secondary["values"]) == 24  # all keys, always, explicit nulls
    assert len(secondary["field_status"]) == 24
    assert secondary["values"]["soc"] == 62.0
    assert secondary["field_status"]["soc"] == MEASURED
    for name in absent:
        assert secondary["field_status"][name] == ABSENT_UPSTREAM
        assert secondary["values"][name] is None
    assert sorted(secondary["missing_fields"]) == sorted(absent)
    # SQLite (this suite) returns naive datetimes; PostgreSQL/Neon returns them
    # tz-aware, and the document then carries the offset. Both must point at
    # the same instant.
    assert secondary["observed_at"].startswith(observed.strftime("%Y-%m-%dT%H:%M:%S"))

    assert primary["field_status"]["speed_kmh"] == "null_upstream"

    health = doc["pipeline_health"]
    assert health["vehicles_seen"] == 2
    assert health["vehicles_accepted"] == 2
    assert health["parameters_total"] == 24
    # Availability is fleet-wide (a union): each vehicle's gaps are covered by
    # the other's readings, so all 24 channels are measured somewhere.
    assert health["parameters_available"] == 24


def test_trusted_document_on_an_empty_database_is_a_valid_document(client):
    """No ingestion yet: a 200 document with zero vehicles, not a 5xx."""
    response = client.get("/api/telemetry/trusted")
    assert response.status_code == 200
    doc = response.json()
    assert doc["vehicles"] == []
    assert doc["pipeline_health"]["parameters_total"] == 24
    assert doc["pipeline_health"]["vehicles_accepted"] == 0
    # The reason is machine-findable and human-readable.
    assert "ingest" in doc["provenance"]["extra"]["note"].lower()


def test_trusted_document_without_a_database_is_a_503_with_a_sentence(client, monkeypatch):
    settings = control_plane._settings().model_copy(update={"database_url": ""})
    monkeypatch.setattr(control_plane, "_settings", lambda: settings)

    from fastapi import HTTPException

    def unconfigured_factory():
        raise HTTPException(
            status_code=503,
            detail="DATABASE_URL is not configured. Set it to the Neon connection string "
            "(postgresql+psycopg://user:password@host/db?sslmode=require).",
        )

    monkeypatch.setattr(control_plane, "_session_factory", unconfigured_factory)
    response = client.get("/api/telemetry/trusted")
    assert response.status_code == 503
    assert "DATABASE_URL" in response.json()["detail"]


# ---------------------------------------------------------------------------
# site provisioning -- same browser contract, new (durable) storage
# ---------------------------------------------------------------------------
def test_provision_site_accepts_the_shape_the_dashboard_sends(client):
    response = client.post("/api/provision-site", json=PROVISION_BODY)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["ok"] is True
    assert payload["siteId"] == "SWP-PUNE-01"
    assert payload["totalSites"] == 1
    assert "SWP-PUNE-01" in payload["message"]


def test_provision_site_persists_across_calls_and_lists(client):
    assert client.post("/api/provision-site", json=PROVISION_BODY).json()["totalSites"] == 1
    assert client.post("/api/provision-site", json=PROVISION_BODY).json()["totalSites"] == 2

    listing = client.get("/api/provisioned-sites").json()
    assert listing["ok"] is True
    assert listing["count"] == 2
    assert {s["siteId"] for s in listing["sites"]} == {"SWP-PUNE-01"}


def test_provision_site_rejects_an_invalid_site_id_with_a_json_detail(client):
    response = client.post(
        "/api/provision-site",
        json={"siteId": "x", "label": "", "customer": "BEM", "chargers": 0, "dgCapacityKw": 0, "gridFeederKw": 0},
    )
    assert response.status_code == 422
    assert "detail" in response.json()


# ---------------------------------------------------------------------------
# the file drop-zone, retired loudly
# ---------------------------------------------------------------------------
def test_ingest_upload_is_gone_with_an_explanation(client):
    response = client.post(
        "/api/ingest/upload",
        files={"file": ("capture.json", b'{"ok": true}', "application/json")},
    )
    assert response.status_code == 410
    assert "/api/ingest/run" in response.json()["detail"]


# ---------------------------------------------------------------------------
# ingestion: auth, cooldown, cycle
# ---------------------------------------------------------------------------
def test_ingest_fails_closed_on_vercel_without_a_secret(client, monkeypatch):
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.delenv("CRON_SECRET", raising=False)
    response = client.get("/api/cron/ingest")
    assert response.status_code == 401
    assert "CRON_SECRET" in response.json()["detail"]


def test_ingest_accepts_the_correct_bearer_secret(client, monkeypatch):
    settings = control_plane._settings().model_copy(update={"cron_secret": "s3cret"})
    monkeypatch.setattr(control_plane, "_settings", lambda: settings)

    ran = {}

    def fake_components(_settings):
        from telemetry.repository import WriteResult

        class FakeExtractor:
            @staticmethod
            def run_cycle(session):
                ran["cycle"] = True
                session.commit()
                return SimpleNamespace(
                    seen=8,
                    accepted=8,
                    rejected=0,
                    resolved_date="2026-09-05",
                    date_source="configured",
                    date_probes=0,
                    detail_ok=8,
                    detail_failed=0,
                    write=WriteResult(vehicles=8, states_written=8, history_written=8),
                    summary=lambda: "fake cycle",
                )

        return object(), object(), FakeExtractor()

    monkeypatch.setattr(control_plane, "_ingest_components", fake_components)

    ok = client.get("/api/cron/ingest", headers={"Authorization": "Bearer s3cret"})
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["ok"] is True
    assert body["trigger"] == "cron"
    assert body["summary"]["accepted"] == 8
    assert ran["cycle"] is True
    # The cycle is recorded for the dashboard's ingest-lag header logic.
    assert control_plane._state["last_cycle"]["summary"]["accepted"] == 8


def test_ingest_rejects_a_wrong_bearer_secret(client, monkeypatch):
    settings = control_plane._settings().model_copy(update={"cron_secret": "s3cret"})
    monkeypatch.setattr(control_plane, "_settings", lambda: settings)
    response = client.get("/api/cron/ingest", headers={"Authorization": "Bearer wrong"})
    assert response.status_code == 401
    assert response.json()["ok"] is False


def test_ingest_cooldown_answers_429_instead_of_hammering_upstream(client, monkeypatch):
    settings = control_plane._settings().model_copy(update={"ingest_min_interval_seconds": 60.0})
    monkeypatch.setattr(control_plane, "_settings", lambda: settings)
    with control_plane._cycle_lock:
        control_plane._state["last_started"] = time.monotonic()

    response = client.post("/api/ingest/run")
    assert response.status_code == 429
    assert "cooldown" in response.json()["detail"]


def test_ingest_without_required_configuration_is_a_503(client, monkeypatch):
    settings = control_plane._settings().model_copy(update={"api_secret_key": ""})
    monkeypatch.setattr(control_plane, "_settings", lambda: settings)
    response = client.post("/api/ingest/run")
    assert response.status_code == 503
    assert "API_SECRET_KEY" in response.json()["detail"]
