"""Central configuration.

Everything is read from the environment (`.env` supported via python-dotenv,
which pydantic-settings loads automatically).  No credential is ever hard-coded.

Required in production:
    API_SECRET_KEY, API_PASSCODE, DATABASE_URL

`API_BASE_URL` defaults to the verified Blue Energy Motors upstream
(`https://track.blueenergymotors.com`) and only needs setting when pointing the
engine at a staging host or the local mock server.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal
from urllib.parse import quote
from zoneinfo import ZoneInfo

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ---------------------------------------------------------------- API
    api_base_url: str = Field(
        default="https://track.blueenergymotors.com", description="Base URL, no trailing slash"
    )
    api_secret_key: str = Field(default="", description="secret_key issued with the API client")
    api_passcode: str = Field(default="", description="passcode issued with the API client (shown once)")
    auth_path: str = "/api/auth/api-token"
    # Data endpoints -- two-tier live contract (verified 2026-09 via Postman).
    # Tier 1: `/api/v1/vehicles` returns a high-level fleet summary in which
    #         every vehicle frame carries `"battery": null`.
    # Tier 2: `/api/v1/vehicles/{vehicle_id}` returns the complete live
    #         diagnostic frame, including the battery block, under the
    #         abbreviated v1 keys (batt_v, chg_status, batt_temp, ...).
    # `/api/dashboard-parameters` is retired and blocked upstream.  Override
    # VEHICLES_PATH only for a staging upstream that mounts the contract
    # elsewhere; the detail path is always derived from it.
    vehicles_path: str = "/api/v1/vehicles"
    request_timeout: float = Field(default=20.0, gt=0)

    # -------------------------------------------------- two-tier fetching
    detail_fetch_enabled: bool = Field(
        default=True,
        description="Tier 2: after the fleet summary, GET /api/v1/vehicles/{id} per vehicle "
        "for the live battery telemetry.  A failed detail fetch keeps the summary frame "
        "and logs -- it never kills the cycle.",
    )
    detail_fetch_workers: int = Field(
        default=8, ge=1, le=64, description="Concurrent tier-2 detail fetches per poll cycle."
    )

    # Optional server-side filters (see guide sections 3 & 4)
    api_date: str | None = Field(default=None, description="YYYY-MM-DD; empty => server default (today, IST)")
    api_vehicle_filter: str | None = Field(default=None, description="substring filter on vehicle id")

    # ------------------------------------------------- live date resolution
    # The upstream's `date` filter is the single biggest cause of silent data
    # loss: with no (or a stale) API_DATE the fleet list can come back empty,
    # or as a couple of dead roster entries, while a fresher batch is sitting
    # one query parameter away.  When a tier-1 batch carries fewer active
    # vehicles than `live_date_min_vehicles`, the engine probes for the
    # freshest date that actually holds a live fleet (the fleet's own
    # `last_updated` dates first, then a walk back over recent days) and
    # ingests that instead of nothing.  See `telemetry.extractor`.
    live_date_fallback: bool = Field(
        default=True,
        description="Probe for a fresher reporting date when a tier-1 batch is empty/dead.",
    )
    live_date_min_vehicles: int = Field(
        default=5,
        ge=1,
        description="Active-vehicle count a batch must reach to be accepted without probing.",
    )
    live_date_probe_days: int = Field(
        default=14,
        ge=1,
        le=60,
        description="How many days back the walk-back probe tier reaches (newest first).",
    )
    live_date_max_probes: int = Field(
        default=8,
        ge=1,
        le=32,
        description="Hard cap on tier-1 GETs spent per date resolution.",
    )
    live_date_reprobe_seconds: float = Field(
        default=900.0,
        ge=0,
        description="Cooldown before re-probing when the last resolution ended best-effort.",
    )

    # ------------------------------------------------------- token lifetime
    # The upstream token lives 3540 s (59 min).  We rotate proactively at 3300 s
    # (55 min) -- and never later than (lifetime - safety_margin) -- so a request
    # can never straddle an expiry boundary.
    token_refresh_interval: float = Field(default=3300.0, gt=0, description="proactive rotation, seconds (55 min)")
    token_expiry_safety_margin: float = Field(default=240.0, ge=0, description="seconds shaved off expires_in")

    # --------------------------------------------------------------- retry
    http_max_retries: int = Field(default=5, ge=0)
    backoff_base_seconds: float = Field(default=1.0, gt=0)
    backoff_max_seconds: float = Field(default=60.0, gt=0)

    # ------------------------------------------------------------------ DB
    database_url: str = Field(
        default="postgresql+psycopg://postgres:postgres@localhost:5432/twin",
        description="SQLAlchemy URL; postgresql+psycopg://... for production",
    )
    db_pool_size: int = Field(default=5, ge=0)
    db_max_overflow: int = Field(default=10, ge=0)
    db_pool_recycle: int = Field(default=1800, ge=-1)
    db_echo: bool = False
    db_schema: str = "public"

    # ---------------------------------------------------------------- loop
    poll_interval_seconds: float = Field(default=60.0, gt=0)
    shutdown_grace_seconds: float = Field(default=10.0, ge=0)
    # Pauses after a failed cycle.  The credential pause is long on purpose:
    # retrying a bad secret_key every 60 s is how an API client gets disabled.
    error_backoff_seconds: float = Field(default=30.0, ge=0)
    auth_backoff_seconds: float = Field(default=300.0, ge=0)

    # ------------------------------------------------------------ behaviour
    require_all_fields: bool = Field(
        default=False,
        description="True => reject a vehicle frame that is missing any of the 24 parameters "
        "(NULL fallback applies only to keys the live API truly leaves absent).",
    )
    write_unchanged: bool = Field(
        default=False,
        description="True => append a history row even when nothing changed since the last poll.",
    )
    # When a vehicle frame has no usable `last_updated`, what do we key the row on?
    #   ingest -> use the ingest timestamp (keeps history complete)
    #   drop   -> skip the vehicle and log it (strict, no invented timestamps)
    fallback_observed_at: Literal["ingest", "drop"] = "ingest"
    source_timezone: str = Field(default="Asia/Kolkata", description="tz of naive `last_updated` strings from the API")

    # -------------------------------------------------------------- logging
    log_level: str = "INFO"
    log_json: bool = False

    # ------------------------------------------------------------ metrics
    metrics_enabled: bool = False
    metrics_port: int = Field(default=9464, ge=1, le=65535)

    @field_validator("api_base_url")
    @classmethod
    def _strip_slash(cls, v: str) -> str:
        return v.rstrip("/")

    @field_validator("log_level")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.strip().upper()

    @property
    def tz(self) -> ZoneInfo:
        """Zone used to interpret naive timestamps coming from the upstream API."""
        return ZoneInfo(self.source_timezone)

    def auth_url(self) -> str:
        return f"{self.api_base_url}{self.auth_path}"

    def vehicles_url(self) -> str:
        return f"{self.api_base_url}{self.vehicles_path}"

    def vehicle_url(self, vehicle_id: str) -> str:
        """Tier-2 detail endpoint for one vehicle (`/api/v1/vehicles/{id}`)."""
        return f"{self.vehicles_url()}/{quote(vehicle_id.strip().upper(), safe='')}"

    def validate_required(self) -> None:
        """Fail fast at start-up instead of 30 minutes into a run."""
        missing = [
            name
            for name, value in (
                ("API_BASE_URL", self.api_base_url),
                ("API_SECRET_KEY", self.api_secret_key),
                ("API_PASSCODE", self.api_passcode),
                ("DATABASE_URL", self.database_url),
            )
            if not value
        ]
        if missing:
            raise RuntimeError(f"missing required environment variables: {', '.join(missing)}")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
