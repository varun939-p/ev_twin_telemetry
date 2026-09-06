"""The production rewrite must land on a real function, not a .py/path suffix."""
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from api.index import PathNormalizer, _canonical_path


def test_canonical_original_path_takes_precedence_over_caller_query():
    assert _canonical_path("/api/health", "ingest/run") == "/api/health"
    assert _canonical_path("/api/index.py", "telemetry/trusted") == "/api/telemetry/trusted"
    assert _canonical_path("/api/index", "/api/health/") == "/api/health"
    assert _canonical_path("/api/index.py/health/") == "/api/health"
    assert _canonical_path("/api/index.py-not-a-mount", "health") == "/api/index.py-not-a-mount"


def test_destination_query_recovers_route_without_losing_body_headers_or_other_query():
    app = FastAPI()

    @app.post("/api/ingest/run")
    async def echo(request: Request):
        return {"query": list(request.query_params.multi_items()), "auth": request.headers.get("authorization"),
                "body": await request.json()}

    with TestClient(PathNormalizer(app)) as client:
        response = client.post("/api/index.py?__telemetry_path=ingest%2Frun&date=2026-09-06&x=a&x=b",
                               headers={"Authorization": "Bearer test-only"}, json={"check": True})
    assert response.status_code == 200
    assert response.json() == {"query": [["date", "2026-09-06"], ["x", "a"], ["x", "b"]],
                               "auth": "Bearer test-only", "body": {"check": True}}
