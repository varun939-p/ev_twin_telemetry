"""The FastAPI control plane: provisioning and the manual ingestion door.

These routes had no coverage at all.  They matter here because they are the two
server endpoints the Next.js dashboard actually calls -- `/api/provision-site`
from `twin-view.tsx` and `/api/ingest/upload` from `DataIngestionPanel.tsx` --
both reached through the `next.config.mjs` rewrites.  The browser-side contract
is asserted explicitly, so a rename on either side fails a test rather than a
demo.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from telemetry import main as control_plane


@pytest.fixture
def client(tmp_path, monkeypatch):
    """TestClient with both write targets redirected into tmp_path."""
    monkeypatch.setattr(control_plane, "STORE_PATH", tmp_path / "provisioned_sites.json")
    monkeypatch.setattr(control_plane, "INGEST_DIR", tmp_path / "ingest")
    return TestClient(control_plane.app)


# ------------------------------------------------------------------- health
def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


# ------------------------------------------------------- site provisioning
def test_provision_site_accepts_the_shape_the_dashboard_sends(client):
    """Byte-for-byte the body `twin-view.tsx` builds in `handleProvisionSite`."""
    body = {
        "siteId": "SWP-PUNE-01",
        "label": "Pune North",
        "customer": "Blue Energy Motors",
        "chargers": 4,
        "dgCapacityKw": 500,
        "gridFeederKw": 250,
    }
    response = client.post("/api/provision-site", json=body)

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["ok"] is True
    assert payload["siteId"] == "SWP-PUNE-01"
    assert payload["totalSites"] == 1
    # `twin-view.tsx` renders `payload.message` verbatim.
    assert "SWP-PUNE-01" in payload["message"]


def test_provision_site_persists_and_counts(client):
    body = {
        "siteId": "SWP-HYD-01",
        "label": "Hyderabad",
        "customer": "Blue Energy Motors",
        "chargers": 4,
        "dgCapacityKw": 500,
        "gridFeederKw": 250,
    }
    assert client.post("/api/provision-site", json=body).json()["totalSites"] == 1
    assert client.post("/api/provision-site", json=body).json()["totalSites"] == 2

    listing = client.get("/api/provisioned-sites").json()
    assert listing["count"] == 2
    assert {s["siteId"] for s in listing["sites"]} == {"SWP-HYD-01"}


def test_provision_site_rejects_an_invalid_site_id_with_a_json_detail(client):
    response = client.post(
        "/api/provision-site",
        json={"siteId": "x", "label": "", "customer": "BEM", "chargers": 0, "dgCapacityKw": 0, "gridFeederKw": 0},
    )
    assert response.status_code == 422
    body = response.json()
    # The dashboard's 4xx branch reads `detail`, so the body must carry it.
    assert "detail" in body


# ----------------------------------------------------- manual data ingestion
def test_ingest_upload_accepts_a_json_capture(client, tmp_path):
    source = tmp_path / "capture.json"
    source.write_text(json.dumps({"ok": True, "vehicles": {}}), encoding="utf-8")

    with source.open("rb") as handle:
        response = client.post("/api/ingest/upload", files={"file": ("capture.json", handle, "application/json")})

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["ok"] is True
    assert payload["filename"] == "capture.json"
    assert payload["bytes"] > 0
    # `DataIngestionPanel` surfaces `message` verbatim on success.
    assert "capture.json" in payload["message"]
    # and the bytes actually reached the Data Layer
    assert (control_plane.INGEST_DIR / "capture.json").read_bytes() == source.read_bytes()


@pytest.mark.parametrize("name", ["telemetry.txt", "capture.xml", "notes"])
def test_ingest_upload_rejects_an_unsupported_type(client, tmp_path, name):
    source = tmp_path / name
    source.write_text("not telemetry", encoding="utf-8")

    with source.open("rb") as handle:
        response = client.post("/api/ingest/upload", files={"file": (name, handle, "text/plain")})

    assert response.status_code == 415
    # The panel prints `detail` for a 4xx, so it must be a readable sentence.
    assert ".csv or .json" in response.json()["detail"]


def test_ingest_upload_strips_client_supplied_path_traversal(client, tmp_path):
    source = tmp_path / "payload.json"
    source.write_text("{}", encoding="utf-8")

    with source.open("rb") as handle:
        response = client.post(
            "/api/ingest/upload",
            files={"file": ("../../../../etc/passwd.json", handle, "application/json")},
        )

    assert response.status_code == 200
    assert response.json()["filename"] == "passwd.json"
    assert list(control_plane.INGEST_DIR.iterdir()) == [control_plane.INGEST_DIR / "passwd.json"]
