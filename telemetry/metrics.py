"""Minimal Prometheus text exposition -- no extra dependency.

A telemetry engine that cannot answer "is it healthy right now?" is not
production-ready.  These counters/gauges are the minimum viable set:

    twin_cycles_total / twin_cycles_failed_total   is the loop alive?
    twin_http_requests_total{status}               is the upstream degraded?
    twin_auth_total / twin_auth_forced_total       is rotation happening on schedule?
    twin_vehicles_seen / _written / _rejected      is data actually landing?
    twin_last_successful_cycle_timestamp_seconds   THE staleness alert: if this
                                                   stops advancing, you have a
                                                   silent failure.
    twin_token_seconds_until_refresh               rotation countdown

Scrape it with Prometheus, or just `curl localhost:9464/metrics` during an incident.
"""

from __future__ import annotations

import threading
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Iterable


class Metrics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counters: dict[tuple[str, tuple[tuple[str, str], ...]], float] = defaultdict(float)
        self._gauges: dict[str, float] = {}
        self._help: dict[str, str] = {}

    # ------------------------------------------------------------- mutation
    def inc(self, name: str, value: float = 1.0, **labels: str) -> None:
        key = (name, tuple(sorted(labels.items())))
        with self._lock:
            self._counters[key] += value

    def set_gauge(self, name: str, value: float) -> None:
        with self._lock:
            self._gauges[name] = value

    def describe(self, name: str, text: str) -> None:
        with self._lock:
            self._help[name] = text

    # ------------------------------------------------------------ rendering
    def render(self) -> str:
        with self._lock:
            counters = dict(self._counters)
            gauges = dict(self._gauges)
            help_text = dict(self._help)

        lines: list[str] = []
        emitted_help: set[str] = set()

        def _help_for(metric: str) -> None:
            if metric in emitted_help:
                return
            emitted_help.add(metric)
            if metric in help_text:
                lines.append(f"# HELP {metric} {help_text[metric]}")
            lines.append(f"# TYPE {metric} {'gauge' if metric in gauges else 'counter'}")

        for (name, labels), value in sorted(counters.items()):
            _help_for(name)
            lines.append(f"{name}{_fmt_labels(labels)} {_fmt(value)}")
        for name, value in sorted(gauges.items()):
            _help_for(name)
            lines.append(f"{name} {_fmt(value)}")
        lines.append("")
        return "\n".join(lines)

    # ------------------------------------------------------------- defaults
    def install_defaults(self) -> None:
        for name, text in (
            ("twin_cycles_total", "Completed extraction cycles"),
            ("twin_cycles_failed_total", "Extraction cycles that ended in error"),
            ("twin_http_requests_total", "Upstream HTTP requests by outcome"),
            ("twin_auth_total", "Successful token acquisitions"),
            ("twin_auth_forced_total", "Token acquisitions forced by a 401"),
            ("twin_vehicles_seen", "Vehicles in the last payload"),
            ("twin_vehicles_written", "Vehicles written in the last cycle"),
            ("twin_vehicles_rejected_total", "Vehicle frames rejected by validation"),
            ("twin_history_rows_total", "Telemetry history rows written"),
            ("twin_last_successful_cycle_timestamp_seconds", "Unix time of the last successful cycle"),
            ("twin_token_seconds_until_refresh", "Seconds until the next proactive token rotation"),
            ("twin_cycle_duration_seconds", "Duration of the last cycle"),
        ):
            self.describe(name, text)


def _fmt_labels(labels: Iterable[tuple[str, str]]) -> str:
    items = list(labels)
    if not items:
        return ""
    inner = ",".join(f'{k}="{v}"' for k, v in items)
    return "{" + inner + "}"


def _fmt(value: float) -> str:
    if value == int(value):
        return str(int(value))
    return f"{value:.6g}"


class _Handler(BaseHTTPRequestHandler):
    metrics: Metrics  # injected by start_metrics_server

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        if self.path.split("?", 1)[0] not in {"/metrics", "/"}:
            self.send_error(404)
            return
        body = self.metrics.render().encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args) -> None:  # silence default stderr logging
        return None


def start_metrics_server(metrics: Metrics, port: int) -> ThreadingHTTPServer:
    handler = type("_BoundHandler", (_Handler,), {"metrics": metrics})
    server = ThreadingHTTPServer(("0.0.0.0", port), handler)
    thread = threading.Thread(target=server.serve_forever, name="metrics", daemon=True)
    thread.start()
    return server
