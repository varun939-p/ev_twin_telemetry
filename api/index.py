"""Vercel ASGI adapter for the SAME FastAPI app used by local uvicorn.

Next rewrites /api/:path* to /api/index.py?__telemetry_path=:path*.
Vercel resolves the exact Python function URL, NOT /api/index.py/<suffix>
(the latter is an HTML Next.js 404 on the deployed routing layer).

The adapter restores the intended /api/... route and strips its internal
query parameter before invoking telemetry.main.app. It accepts the original
path, either bare function alias (/api/index.py or /api/index), and the legacy
suffix shape for local tooling. This is path adaptation only: ingestion,
authorization, schema, reads and cycle diagnostics all live in telemetry/.

The app export is ASGI. telemetry/** is included by vercel.json and runtime
dependencies come from api/requirements.txt. No background loop runs here.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode

# Make the repository-root `telemetry` package importable regardless of how
# the platform lays out the bundle: entry at <bundle>/api/index.py with the
# package traced to <bundle>/, copied under <bundle>/api/, or the whole
# repository rooted one level up.  `vercel.json` also pins
# functions."api/index.py".includeFiles = "telemetry/**" so the package ships
# with the function even when static import tracing misses it.
_HERE = Path(__file__).resolve().parent
_CANDIDATES = (
    _HERE.parent,  # <bundle>/  (entry at <bundle>/api/index.py)
    _HERE,         # <bundle>/api/  (package copied beside the entrypoint)
    _HERE.parent.parent,  # <bundle>/../ repo checked out one level up
)
for candidate in _CANDIDATES:
    if (candidate / "telemetry").is_dir() and str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

_startup_error: str | None = None
try:
    from telemetry.main import app as _control_plane  # noqa: E402  (path set up first)
except Exception:  # pragma: no cover
    import traceback
    _startup_error = traceback.format_exc()
    _control_plane = None

_MOUNTS = ("/api/index.py", "/api/index")
_ROUTE_QUERY = "__telemetry_path"


def _canonical_path(raw: str, forwarded_route: str | None = None) -> str:
    """Map original/destination variants onto the canonical FastAPI route.

    Only a bare function destination uses the forwarded query route. An
    original /api/health path always wins over a caller-supplied query value.
    Bearer protection still applies after routing; this is not an auth bypass.
    """
    path = (raw or "/").split("?", 1)[0].rstrip("/") or "/"
    for mount in _MOUNTS:
        if path == mount:
            rest = "/" + forwarded_route.lstrip("/") if forwarded_route else ""
        elif path.startswith(mount + "/"):
            rest = path[len(mount):]
        else:
            continue
        path = rest if rest == "/api" or rest.startswith("/api/") else f"/api{rest}"
        break
    return path.rstrip("/") or "/"


class PathNormalizer:
    """Pure-ASGI middleware: rewrite scope["path"] before routing."""

    def __init__(self, asgi_app: Any) -> None:
        self._app = asgi_app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope.get("type") in {"http", "websocket"}:
            scope = dict(scope)
            query = parse_qsl(scope.get("query_string", b"").decode("latin-1"), keep_blank_values=True)
            forwarded = next((value for key, value in query if key == _ROUTE_QUERY), None)
            scope["path"] = _canonical_path(scope.get("path", ""), forwarded)
            scope["raw_path"] = scope["path"].encode("utf-8")
            scope["query_string"] = urlencode([(key, value) for key, value in query if key != _ROUTE_QUERY]).encode("ascii")
            scope["root_path"] = ""
        await self._app(scope, receive, send)


async def _error_app(scope: dict, receive: Any, send: Any) -> None:
    if scope.get("type") == "http":
        import json
        body = json.dumps({
            "ok": False,
            "status": "startup_error",
            "detail": "FastAPI control plane failed to initialize on cold start.",
            "traceback": _startup_error,
        }).encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": 500,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
            ],
        })
        await send({"type": "http.response.body", "body": body})


_handler = PathNormalizer(_control_plane) if _control_plane is not None else _error_app

# VERCEL BUILD CONTRACT -- do not move `app` into an if/else, try/except, or
# function. Vercel's builder detection (@vercel/fs-detectors ->
# @vercel/python-analysis `findAppOrHandler`) statically parses this file and
# only accepts a MODULE-LEVEL `app = ...` / `app: T = ...` / `def app` /
# `from x import app`. Any other shape means api/index.py is not registered as
# a Serverless Function and the build aborts with:
#   Error: The pattern "api/index.py" defined in `functions` doesn't match any
#   Serverless Functions.
# tests/test_vercel_adapter.py::test_app_is_a_module_level_assignment guards this.
app = _handler
control_plane = _control_plane
