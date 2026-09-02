"""A faithful stand-in for the upstream Dashboard Parameters API.

Exists so the engine's retry, 401-recovery and token-rotation paths can be
exercised end-to-end without production credentials -- and so `pytest` can
prove them instead of asserting on comments.

    python -m telemetry mock-server --port 8899 --vehicles 8 [--all-fields]

Control endpoints (tests drive these):
    POST /__control/fail?count=N     next N data requests return 500
    POST /__control/revoke           every issued token becomes invalid (401 "auth":"required")
    POST /__control/latency?ms=N     sleep N ms per data request
    POST /__control/bad-creds?on=1   the auth endpoint starts rejecting credentials
    GET  /__stats                    issued tokens, request counts, last vehicles served
"""

from __future__ import annotations

import json
import os
import random
import secrets
import threading
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

SECRET_KEY = "sk_mock_9f8e7d6c5b4a"
PASSCODE = "MockPasscode123"
TOKEN_LIFETIME = 3540  # 59 minutes, exactly as documented

# Fixed anchor for the simulated `last_updated` clock: deterministic across
# polls, and independent of when the server was started.
_IST_EPOCH = datetime(2026, 8, 21, 10, 0, tzinfo=ZoneInfo("Asia/Kolkata"))

VEHICLE_IDS = [
    "AP39WG5383", "AP39WH5376", "AP39WJ2210", "AP39WK8845",
    "AP39WL1102", "AP39WM7734", "AP39WN4419", "AP39WP9027",
]

# The 11 keys DASHBOARD_API_GUIDE.md documents.
DOCUMENTED_KEYS = (
    "last_updated", "soc", "soh", "odo", "residual_mileage", "cycles",
    "batt_temp", "min_cell_v", "max_cell_v", "speed", "regen_kwh",
)

# The 13 remaining parameters, under the inferred keys from telemetry/fields.py.
UNDOCUMENTED_KEYS = (
    "max_temp_c", "min_temp_c", "total_power_kwh", "charging_status",
    "battery_avg_temp_c", "battery_total_v", "battery_current_a",
    "max_cell_v_cell_no", "min_cell_v_pack_no", "min_cell_v_cell_no",
    "max_temp_pack_no", "work_status", "latitude", "longitude",
)


class Fleet:
    """Random-walk vehicle state, so consecutive polls actually differ."""

    def __init__(self, count: int, all_fields: bool) -> None:
        self.all_fields = all_fields
        self.lock = threading.Lock()
        self.tokens: dict[str, float] = {}       # token -> issued_at (monotonic)
        self.revoked_before = 0.0                # monotonic cutoff
        self.fail_remaining = 0
        self.latency_ms = 0
        self.bad_creds = False
        self.counts = {"auth": 0, "auth_failed": 0, "data": 0, "data_401": 0, "data_500": 0}
        self.ticks = 0
        self.frozen = False  # when True, state does not advance -> identical frames
        ids = VEHICLE_IDS[:count] or VEHICLE_IDS
        self.state: dict[str, dict[str, float]] = {vid: self._seed(i) for i, vid in enumerate(ids)}

    # ------------------------------------------------------------------ data
    # Every simulated signal is always present in the state dict -- the
    # `all_fields` flag decides what gets *emitted*, not what gets computed.
    @staticmethod
    def _seed(index: int) -> dict[str, float]:
        rng = random.Random(1000 + index)
        batt = rng.uniform(24, 42)
        return {
            # documented by DASHBOARD_API_GUIDE.md
            "soc": rng.uniform(25, 95),
            "soh": rng.uniform(92, 99),
            "odo": rng.uniform(20000, 90000),
            "residual_mileage": rng.uniform(40, 220),
            "cycles": rng.randint(120, 900),
            "batt_temp": batt,
            "min_cell_v": rng.uniform(3.20, 3.35),
            "max_cell_v": rng.uniform(3.35, 3.45),
            "speed": 0.0,
            "regen_kwh": rng.uniform(2, 40),
            # the 14 parameters the guide does not document
            "max_temp_c": batt + 4,
            "min_temp_c": batt - 4,
            "total_power_kwh": rng.uniform(500, 4000),
            "charging_status": 0.0,
            "battery_avg_temp_c": batt,
            "battery_total_v": rng.uniform(480, 560),
            "battery_current_a": 0.0,
            "latitude": 14.4 + rng.uniform(-0.4, 0.4),   # around Ongole, AP
            "longitude": 80.1 + rng.uniform(-0.4, 0.4),
        }

    def _advance(self, state: dict[str, float], dt_minutes: float) -> None:
        charging = state["charging_status"] > 0.5
        if charging:
            state["soc"] = min(100.0, state["soc"] + dt_minutes * 1.6)
            state["battery_current_a"] = -random.uniform(40, 120)
            state["batt_temp"] = min(55.0, state["batt_temp"] + dt_minutes * 0.25)
            if state["soc"] >= 99.5:
                state["charging_status"] = 0.0
        else:
            speed = random.choice([0.0, 0.0, random.uniform(18, 62)])
            state["speed"] = speed
            state["odo"] += speed * dt_minutes / 60.0
            state["soc"] = max(5.0, state["soc"] - speed * dt_minutes / 60.0 * 0.9)
            state["residual_mileage"] = max(0.0, state["soc"] * 1.6)
            state["total_power_kwh"] += speed * dt_minutes / 60.0 * 0.85
            state["regen_kwh"] += speed * dt_minutes / 60.0 * 0.09
            state["battery_current_a"] = speed * 2.1
            state["batt_temp"] = max(22.0, state["batt_temp"] - dt_minutes * 0.1)
            if state["soc"] < 15 and random.random() < 0.15:
                state["charging_status"] = 1.0
            if state["speed"] == 0 and random.random() < 0.02:
                state["cycles"] += 1
        state["max_temp_c"] = state["batt_temp"] + random.uniform(2, 6)
        state["min_temp_c"] = state["batt_temp"] - random.uniform(2, 6)
        state["battery_avg_temp_c"] = state["batt_temp"]
        state["min_cell_v"] = 3.05 + state["soc"] / 100.0 * 0.35
        state["max_cell_v"] = state["min_cell_v"] + random.uniform(0.01, 0.06)
        state["battery_total_v"] = state["max_cell_v"] * 156

    def payload(self, *, date: str | None, vehicle: str | None) -> dict[str, Any]:
        with self.lock:
            if not self.frozen:
                self.ticks += 1
                for state in self.state.values():
                    self._advance(state, dt_minutes=1.0)
            # Advance the reported clock once per poll (not once per wall-clock
            # minute) so fast consecutive polls stay distinguishable -- otherwise
            # every sub-second poll looks like a duplicate frame.
            #
            # While frozen we anchor to the tick at which freezing started rather
            # than to now(): a clock derived from the wall time would still drift
            # across a second boundary between two polls and produce different
            # `last_updated` values, which is exactly the flakiness this mode
            # exists to remove.
            # `ticks - 1` in both branches: `ticks` is the count of polls served,
            # so the first poll must land on the epoch itself.  Anchoring the
            # frozen case to `ticks` instead would move the clock forward by a
            # minute the moment freezing starts, and nothing would ever collide.
            ist_now = _IST_EPOCH + timedelta(minutes=self.ticks - 1)
            vehicles: dict[str, Any] = {}
            for vid, state in self.state.items():
                if vehicle and vehicle.upper() not in vid:
                    continue
                vehicles[vid] = self._frame(vid, state, ist_now)

            # Build the summary from the internal state, NOT from the emitted
            # frames: with `all_fields=False` the frames only carry the 11
            # documented keys, so reading `charging_status` off them raises.
            fleet = list(self.state.values())
            return {
                "ok": True,
                "summary": {
                    "segments": [],
                    "overall": {
                        "vehicle_count": len(fleet),
                        "avg_soc": round(sum(s["soc"] for s in fleet) / max(1, len(fleet)), 2),
                        "charging": sum(1 for s in fleet if s["charging_status"] > 0.5),
                    },
                    "low_soc_alerts": [vid for vid, s in self.state.items() if s["soc"] < 20],
                    "soh_drop_alerts": [],
                },
                "vehicles": vehicles,
            }

    def _frame(self, vid: str, state: dict[str, float], ist_now: datetime) -> dict[str, Any]:
        rng = random.Random(hash(vid) & 0xFFFF)
        frame: dict[str, Any] = {
            "last_updated": ist_now.strftime("%Y-%m-%d %H:%M:%S"),
            "soc": round(state["soc"], 1),
            "soh": round(state["soh"], 2),
            "odo": round(state["odo"], 1),
            "residual_mileage": round(state["residual_mileage"]),
            "cycles": int(state["cycles"]),
            "batt_temp": round(state["batt_temp"], 1),
            "min_cell_v": round(state["min_cell_v"], 3),
            "max_cell_v": round(state["max_cell_v"], 3),
            "speed": round(state["speed"], 1),
            "regen_kwh": round(state["regen_kwh"], 2),
        }
        if self.all_fields:
            frame.update(
                {
                    "max_temp_c": round(state["max_temp_c"], 1),
                    "min_temp_c": round(state["min_temp_c"], 1),
                    "total_power_kwh": round(state["total_power_kwh"], 2),
                    "charging_status": int(state["charging_status"]),
                    "battery_avg_temp_c": round(state["battery_avg_temp_c"], 1),
                    "battery_total_v": round(state["battery_total_v"], 1),
                    "battery_current_a": round(state["battery_current_a"], 1),
                    "max_cell_v_cell_no": rng.randint(1, 156),
                    "min_cell_v_pack_no": rng.randint(1, 4),
                    "min_cell_v_cell_no": rng.randint(1, 156),
                    "max_temp_pack_no": rng.randint(1, 4),
                    "work_status": "CHARGING" if state["charging_status"] else ("RUNNING" if state["speed"] else "PARKED"),
                    "latitude": round(state["latitude"], 5),
                    "longitude": round(state["longitude"], 5),
                }
            )
        return frame

    # ------------------------------------------------------------------ auth
    def issue_token(self) -> dict[str, Any]:
        with self.lock:
            self.counts["auth"] += 1
            token = secrets.token_hex(64)  # 128 hex characters, as documented
            self.tokens[token] = time.monotonic()
            return {"ok": True, "token": token, "token_type": "Bearer", "expires_in": TOKEN_LIFETIME}

    def token_valid(self, token: str | None) -> bool:
        if not token:
            return False
        with self.lock:
            issued = self.tokens.get(token)
            if issued is None:
                return False
            if issued < self.revoked_before:
                return False
            return (time.monotonic() - issued) < TOKEN_LIFETIME

    def revoke_all(self) -> None:
        with self.lock:
            self.revoked_before = time.monotonic() + 1e-6

    def take_failure(self) -> bool:
        with self.lock:
            if self.fail_remaining > 0:
                self.fail_remaining -= 1
                self.counts["data_500"] += 1
                return True
            return False

    def stats(self) -> dict[str, Any]:
        with self.lock:
            return {
                "counts": dict(self.counts),
                "tokens_issued": len(self.tokens),
                "frozen": self.frozen,
                "fail_remaining": self.fail_remaining,
                "latency_ms": self.latency_ms,
                "bad_creds": self.bad_creds,
                "vehicles": sorted(self.state),
            }


class Handler(BaseHTTPRequestHandler):
    fleet: Fleet

    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------- plumbing
    def _send(self, status: int, body: dict[str, Any]) -> None:
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length))
        except ValueError:
            return {}

    def log_message(self, *_args) -> None:
        return None

    # -------------------------------------------------------------- routes
    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        query = parse_qs(urlparse(self.path).query)

        if path == "/api/auth/api-token":
            payload = self._body()
            with self.fleet.lock:
                bad = self.fleet.bad_creds
            if bad or payload.get("secret_key") != SECRET_KEY or payload.get("passcode") != PASSCODE:
                with self.fleet.lock:
                    self.fleet.counts["auth_failed"] += 1
                self._send(401, {"ok": False, "error": "invalid credentials"})
                return
            self._send(200, self.fleet.issue_token())
            return

        if path == "/__control/freeze":
            self.fleet.frozen = query.get("on", ["1"])[0] not in {"0", "false", "no"}
            self._send(200, {"ok": True, "frozen": self.fleet.frozen})
            return
        if path == "/__control/revoke":
            self.fleet.revoke_all()
            self._send(200, {"ok": True, "revoked": True})
            return
        if path == "/__control/fail":
            self.fleet.fail_remaining = int(query.get("count", ["1"])[0])
            self._send(200, {"ok": True, "fail_remaining": self.fleet.fail_remaining})
            return
        if path == "/__control/latency":
            self.fleet.latency_ms = int(query.get("ms", ["0"])[0])
            self._send(200, {"ok": True, "latency_ms": self.fleet.latency_ms})
            return
        if path == "/__control/bad-creds":
            self.fleet.bad_creds = query.get("on", ["1"])[0] not in {"0", "false", "no"}
            self._send(200, {"ok": True, "bad_creds": self.fleet.bad_creds})
            return

        self._send(404, {"ok": False, "error": "not found"})

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)

        if path == "/__stats":
            self._send(200, self.fleet.stats())
            return

        if path == "/api/dashboard-parameters":
            auth = self.headers.get("Authorization", "")
            token = auth[7:].strip() if auth.lower().startswith("bearer ") else None
            if not self.fleet.token_valid(token):
                with self.fleet.lock:
                    self.fleet.counts["data_401"] += 1
                # Exactly the shape the guide documents in section 5.
                self._send(401, {"ok": False, "auth": "required", "error": "token expired or missing"})
                return

            if self.fleet.take_failure():
                self._send(500, {"ok": False, "error": "internal server error"})
                return

            if self.fleet.latency_ms:
                time.sleep(self.fleet.latency_ms / 1000.0)

            date = query.get("date", [None])[0]
            if date is not None:
                try:
                    datetime.strptime(date, "%Y-%m-%d")
                except ValueError:
                    self._send(400, {"ok": False, "error": "bad date format, expected YYYY-MM-DD"})
                    return

            with self.fleet.lock:
                self.fleet.counts["data"] += 1
            self._send(200, self.fleet.payload(date=date, vehicle=query.get("vehicle", [None])[0]))
            return

        self._send(404, {"ok": False, "error": "not found"})


def make_server(port: int = 0, vehicles: int = 8, all_fields: bool = True, host: str = "127.0.0.1") -> ThreadingHTTPServer:
    """Bind to 127.0.0.1 by default; set MOCK_BIND=0.0.0.0 to expose it (compose)."""
    fleet = Fleet(vehicles, all_fields)
    handler = type("BoundHandler", (Handler,), {"fleet": fleet})
    server = ThreadingHTTPServer((host, port), handler)
    server.fleet = fleet  # type: ignore[attr-defined]
    return server


def serve(port: int = 8899, vehicles: int = 8, all_fields: bool = True) -> int:
    host = os.environ.get("MOCK_BIND", "127.0.0.1")
    server = make_server(port, vehicles, all_fields, host=host)
    host, bound_port = server.server_address[:2]
    print(f"mock dashboard API on http://{host}:{bound_port}")
    print(f"  POST /api/auth/api-token         secret_key={SECRET_KEY} passcode={PASSCODE}")
    print(f"  GET  /api/dashboard-parameters   {vehicles} vehicles, all_fields={all_fields}")
    print("  control: POST /__control/fail?count=N | /__control/revoke | /__control/latency?ms=N | /__control/bad-creds?on=1")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(serve())
