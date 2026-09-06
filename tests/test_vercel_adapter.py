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


def test_app_is_a_module_level_assignment():
    """Vercel only registers api/index.py as a Serverless Function when `app` is
    bound at module scope (static AST scan by @vercel/python-analysis). A build
    that hides `app = ...` inside if/else or try/except fails with:
      The pattern "api/index.py" defined in `functions` doesn't match any Serverless Functions.
    """
    import ast
    from pathlib import Path

    source = (Path(__file__).resolve().parents[1] / "api" / "index.py").read_text(encoding="utf-8")
    module = ast.parse(source)
    bound: set[str] = set()
    for node in module.body:  # module body only -- nested statements do not count
        if isinstance(node, ast.Assign):
            bound.update(t.id for t in node.targets if isinstance(t, ast.Name))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            bound.add(node.target.id)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            bound.add(node.name)
        elif isinstance(node, ast.ImportFrom):
            bound.update(alias.asname or alias.name for alias in node.names)
    assert "app" in bound, "api/index.py must bind `app` at module level for Vercel to discover it"


def test_vercel_json_registers_exactly_the_python_entrypoint():
    """`functions` keys are file paths relative to the project root; the Python
    file must exist at that exact path, and the Next.js rewrite must target it."""
    import json
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    config = json.loads((root / "vercel.json").read_text(encoding="utf-8"))
    functions = config["functions"]
    assert list(functions) == ["api/index.py"]
    assert (root / "api" / "index.py").is_file()
    assert (root / "api" / "requirements.txt").is_file()
    assert functions["api/index.py"]["includeFiles"] == "telemetry/**"
    # Any pinned runtime must be a published @vercel/python semver, never a bare
    # "python3.x" string (that is the legacy `builds` syntax and is rejected).
    runtime = functions["api/index.py"].get("runtime")
    if runtime is not None:
        assert runtime.startswith("@vercel/python@"), runtime
        assert runtime.split("@")[-1].count(".") == 2, runtime
