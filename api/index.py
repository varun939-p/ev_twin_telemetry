"""Vercel Python Serverless Function entrypoint.

Vercel's official pattern for a Python backend inside a Next.js deployment:
this file is auto-built as an ASGI serverless function, and the Next.js layer
(``next.config.mjs``) rewrites ``/api/:path*`` onto it, so the dashboard talks
to FastAPI on its own origin with zero CORS and zero extra infrastructure.

    next.js request                this function
    /api/telemetry/trusted  ───►  FastAPI route /api/telemetry/trusted
                                   (telemetry.main -- DB-backed control plane)

Why the wrapper
---------------
Vercel delivers the rewritten request with a path that has historically varied
between runtimes: sometimes the ORIGINAL browser path (``/api/...``), sometimes
the rewritten destination (``/api/index.py/...``).  Instead of betting on one
behaviour, the middleware below normalises every variant onto the canonical
route before FastAPI sees it:

    /api/telemetry/trusted              (original)        -> /api/telemetry/trusted
    /api/index.py/telemetry/trusted     (destination)     -> /api/telemetry/trusted
    /api/index.py                       (bare entrypoint) -> /api

Trailing slashes are tolerated (``redirect_slashes`` is off on the app --
Vercel's proxy does not replay FastAPI's 307 redirects reliably), and anything
unmatched gets a JSON 404, never an HTML error page.

The engine package (``telemetry/``) lives at the repository root and is traced
into the function bundle by Vercel's Python builder; runtime dependencies come
from ``api/requirements.txt``.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

# Make the repository root importable regardless of where the platform puts the
# function (cwd is normally the deployment root; this also covers flat layouts).
_ROOT = Path(__file__).resolve().parent.parent
for candidate in (_ROOT, _ROOT.parent):
    if (candidate / "telemetry").is_dir() and str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from telemetry.main import app as _control_plane  # noqa: E402  (path set up first)

_MOUNT = "/api/index.py"


def _canonical_path(raw: str) -> str:
    """Map any path variant the platform may hand us onto a real FastAPI route."""
    if not raw:
        return "/"
    path = raw.split("?", 1)[0]
    if path.startswith(_MOUNT):
        rest = path[len(_MOUNT):]
        # /api/index.py/api/telemetry/...  ->  /api/telemetry/...
        # /api/index.py/telemetry/...      ->  /api/telemetry/... (be liberal)
        if rest.startswith("/api"):
            path = rest
        elif rest:
            path = f"/api{rest}"
        else:
            path = "/api"
    # One trailing slash is tolerated everywhere except the root.
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/") or "/"
    return path or "/"


class PathNormalizer:
    """Pure-ASGI middleware: rewrite scope["path"] before routing."""

    def __init__(self, asgi_app: Any) -> None:
        self._app = asgi_app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope.get("type") in {"http", "websocket"}:
            scope["path"] = _canonical_path(scope.get("path", ""))
            # FastAPI routing uses root_path + path; keep root_path empty so the
            # canonical path is matched verbatim.
            scope["root_path"] = ""
        await self._app(scope, receive, send)


app = PathNormalizer(_control_plane)

# `app` is what the runtime detects.  Expose the raw ASGI app too, for tooling
# that wants the FastAPI instance (tests, uvicorn --dev).
control_plane = _control_plane
