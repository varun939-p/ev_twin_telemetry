"""Rigorous validation of the upstream JSON *before* it can reach the database.

Design rules
------------
1. Nothing that has not passed through this module is allowed near SQLAlchemy.
2. A bad field must not cost us a whole vehicle, and a bad vehicle must not
   cost us the whole fleet: per-field failures become NULL + a logged
   `FieldError`, per-vehicle failures are quarantined, the cycle continues.
3. Wire field names live in `telemetry.fields`, never re-typed here.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Annotated, Any, Final
from zoneinfo import ZoneInfo

from pydantic import (
    AliasChoices,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    ValidationError,
    ValidationInfo,
    create_model,
    field_validator,
    model_validator,
)

from .fields import COLUMN_NAMES, PARAM_SPECS, SPEC_BY_NAME

__all__ = [
    "AuthResponse",
    "DashboardPayload",
    "FieldError",
    "ParsedVehicle",
    "RejectedVehicle",
    "ValidatedPayload",
    "VehicleParams",
    "naive_to_aware",
    "parse_payload",
    "parse_source_timestamp",
]

# Strings the upstream (or an idle ECU) may emit in place of a number.
_NULLISH: Final[frozenset[str]] = frozenset(
    {"", "-", "--", "n/a", "na", "nan", "null", "none", "undefined", "unknown", "err", "error"}
)

_LAST_UPDATED_FORMATS: Final[tuple[str, ...]] = (
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d %H:%M:%S.%f",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _clean_scalar(value: Any) -> Any:
    """Sentinel strings -> real None; strip text; never let bool pose as a number."""
    if value is None:
        return None
    if isinstance(value, bool):
        # P1 (Boolean Trap): True/False must NEVER be silently read as 1/0 on a
        # numeric channel.  A JSON boolean where a measurement belongs is a
        # contract violation, so it is rejected here -- before any code path can
        # coerce it into an integer.
        raise ValueError(f"boolean is not a valid scalar value: {value!r}")
    if isinstance(value, str):
        text = value.strip()
        if text.lower() in _NULLISH:
            return None
        return text
    return value


def naive_to_aware(value: datetime, tz: ZoneInfo) -> datetime:
    """Upstream `last_updated` is a naive local (IST) string -> store aware UTC."""
    if value.tzinfo is None:
        return value.replace(tzinfo=tz).astimezone(timezone.utc)
    return value.astimezone(timezone.utc)


def parse_source_timestamp(raw: Any, tz: ZoneInfo) -> datetime | None:
    """Parse the upstream `last_updated` value; None when unusable."""
    raw = _clean_scalar(raw)
    if raw is None:
        return None
    if isinstance(raw, datetime):
        return naive_to_aware(raw, tz)
    if isinstance(raw, (int, float)):  # epoch seconds
        return datetime.fromtimestamp(float(raw), tz=timezone.utc)
    text = str(raw).strip().replace("Z", "+00:00")
    for fmt in _LAST_UPDATED_FORMATS:
        try:
            return naive_to_aware(datetime.strptime(text, fmt), tz)
        except ValueError:
            continue
    try:  # last resort: ISO-8601 with offset
        return naive_to_aware(datetime.fromisoformat(text), tz)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# per-field validators
# ---------------------------------------------------------------------------
def _coerce_by_spec(value: Any, info: ValidationInfo) -> Any:
    """One before-validator for all 24 parameters; the spec is looked up by field name."""
    spec = SPEC_BY_NAME[info.field_name]
    value = _clean_scalar(value)
    if value is None:
        return None

    if spec.kind == "str":
        text = str(value).strip()
        if len(text) > 64:
            raise ValueError("value longer than 64 characters")
        return text

    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"not a number: {value!r}") from exc
    if number != number:  # NaN
        return None
    # P1 (Min/Max Bypass): the physical-limit checks must run BEFORE any return.
    # The old code returned the rounded integer above them, so integer fields
    # (charging_status, cell numbers, cycles) skipped their bounds entirely.
    if spec.minimum is not None and number < spec.minimum:
        raise ValueError(f"below minimum {spec.minimum}: {number}")
    if spec.maximum is not None and number > spec.maximum:
        raise ValueError(f"above maximum {spec.maximum}: {number}")
    if spec.kind == "int":
        # Integer rounding happens here, not via an `int` annotation: Pydantic
        # refuses to coerce 78.0 -> int, and an ECU sending `soc: 78.0` must not
        # take the whole frame down with it.
        return int(round(number))
    return number


def _build_vehicle_params_model() -> type[BaseModel]:
    """Generate `VehicleParams` from the parameter registry.

    `create_model` only registers a field when it appears in the keyword
    annotations, so the FieldInfo is carried inside `Annotated[...]` -- passing
    it as a namespace value silently drops the aliases and makes the field
    required, which is exactly the failure mode this builder avoids.
    """
    annotations: dict[str, Any] = {}

    for spec in PARAM_SPECS:
        # The annotation is the *post*-validator type: text parameters stay text,
        # everything else is normalised to float (ints are rounded in the validator).
        field_type = str | None if spec.kind == "str" else float | None
        annotations[spec.name] = Annotated[
            field_type,
            BeforeValidator(_coerce_by_spec),
            Field(
                default=None,
                alias=spec.aliases[0],
                validation_alias=AliasChoices(*spec.aliases),
                description=(f"{spec.label} ({spec.unit})" if spec.unit else spec.label),
                json_schema_extra={
                    "unit": spec.unit,
                    "logical_type": spec.kind,
                    "label": spec.label,
                    "documented_upstream": spec.documented,
                },
            ),
        ]

    annotations["last_updated"] = Annotated[
        datetime | None,
        Field(
            default=None,
            alias="last_updated",
            validation_alias=AliasChoices("last_updated", "updated_at", "timestamp"),
            description="Source-side frame timestamp (naive IST) -> stored as UTC",
        ),
    ]

    return create_model(  # type: ignore[call-overload]
        "VehicleParams",
        __base__=BaseModel,
        __config__=ConfigDict(
            extra="ignore",  # upstream adds fields over time; ignore, never crash
            populate_by_name=True,
            str_strip_whitespace=True,
        ),
        **annotations,
    )


VehicleParams: Final[type[BaseModel]] = _build_vehicle_params_model()


def localise_last_updated(parsed: Any, tz: ZoneInfo) -> datetime | None:
    value = parsed.last_updated
    if isinstance(value, datetime):
        return naive_to_aware(value, tz)
    return parse_source_timestamp(value, tz)


# ---------------------------------------------------------------------------
# envelope models
# ---------------------------------------------------------------------------
class AuthResponse(BaseModel):
    """POST /api/auth/api-token"""

    model_config = ConfigDict(extra="ignore")

    ok: bool = True
    token: str = Field(min_length=8)
    token_type: str = "Bearer"
    expires_in: int = Field(default=3540, gt=0)

    @field_validator("token")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("empty token")
        return v


class DashboardPayload(BaseModel):
    """GET /api/dashboard-parameters -- we only consume `.vehicles`."""

    model_config = ConfigDict(extra="ignore")

    ok: bool = True
    summary: dict[str, Any] | None = None
    vehicles: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _normalise(self) -> "DashboardPayload":
        if self.vehicles is None:
            self.vehicles = {}
        return self


# ---------------------------------------------------------------------------
# results
# ---------------------------------------------------------------------------
class FieldError(BaseModel):
    field: str
    raw: Any = None
    error: str


class ParsedVehicle(BaseModel):
    """A vehicle frame that passed validation, ready for the repository."""

    vehicle_id: str
    observed_at: datetime | None = None
    values: dict[str, Any]
    field_errors: list[FieldError] = Field(default_factory=list)
    missing: list[str] = Field(default_factory=list)

    def signature(self) -> str:
        """Stable digest of the reading -- used to skip no-op writes."""
        blob = json.dumps(
            {
                "observed_at": self.observed_at.isoformat() if self.observed_at else None,
                "values": {k: self.values.get(k) for k in COLUMN_NAMES},
            },
            sort_keys=True,
            default=str,
        )
        return hashlib.sha256(blob.encode()).hexdigest()


class RejectedVehicle(BaseModel):
    vehicle_id: str
    reason: str
    errors: list[FieldError] = Field(default_factory=list)


class ValidatedPayload(BaseModel):
    ok: list[ParsedVehicle] = Field(default_factory=list)
    rejected: list[RejectedVehicle] = Field(default_factory=list)
    seen: int = 0

    @property
    def accepted(self) -> int:
        return len(self.ok)


_VEHICLE_ID_RE: Final = re.compile(r"^[A-Za-z0-9._-]{3,32}$")


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------
def parse_payload(
    payload: DashboardPayload,
    tz: ZoneInfo,
    *,
    require_all_fields: bool = False,
    ingest_time: datetime | None = None,
    fallback_observed_at: str = "ingest",
) -> ValidatedPayload:
    """Validate the whole `vehicles` object.

    Returns accepted frames plus a quarantine list; it never raises for bad data.
    """
    result = ValidatedPayload()
    vehicles = payload.vehicles or {}
    result.seen = len(vehicles)

    for raw_id, raw_frame in vehicles.items():
        vehicle_id = str(raw_id).strip().upper()
        if not _VEHICLE_ID_RE.match(vehicle_id):
            result.rejected.append(
                RejectedVehicle(vehicle_id=vehicle_id or "<empty>", reason="malformed vehicle id")
            )
            continue
        if not isinstance(raw_frame, dict):
            result.rejected.append(
                RejectedVehicle(
                    vehicle_id=vehicle_id,
                    reason=f"frame is {type(raw_frame).__name__}, expected object",
                )
            )
            continue

        try:
            parsed = VehicleParams.model_validate(raw_frame)
        except ValidationError as exc:
            result.rejected.append(
                RejectedVehicle(
                    vehicle_id=vehicle_id,
                    reason="frame failed validation",
                    errors=[
                        FieldError(
                            field=".".join(str(part) for part in err["loc"]),
                            raw=err.get("input"),
                            error=err["msg"],
                        )
                        for err in exc.errors()
                    ],
                )
            )
            continue

        # Soft per-field handling: a poisoned sensor must not null the other 23.
        values: dict[str, Any] = {}
        field_errors: list[FieldError] = []
        for spec in PARAM_SPECS:
            raw_value = next((raw_frame[alias] for alias in spec.aliases if alias in raw_frame), None)
            coerced = getattr(parsed, spec.name)
            if coerced is not None and spec.kind == "int":
                # The field is annotated `float | None` (see _build_vehicle_params_model),
                # so put the integer-ness back before it reaches JSON or the driver.
                coerced = int(coerced)
            values[spec.name] = coerced
            if coerced is None and raw_value is not None:
                # The key WAS present but the value was a sentinel ("", "N/A", "-",
                # "null") or otherwise unusable.  Absent keys are tracked separately
                # in `missing`, so a hit here always means "the truck sent junk".
                field_errors.append(
                    FieldError(
                        field=spec.name,
                        raw=raw_value,
                        error="sentinel or unparseable value -> stored NULL",
                    )
                )

        missing = [
            spec.name for spec in PARAM_SPECS if not any(alias in raw_frame for alias in spec.aliases)
        ]
        if require_all_fields and missing:
            result.rejected.append(
                RejectedVehicle(
                    vehicle_id=vehicle_id,
                    reason=f"missing {len(missing)} required parameter(s): {', '.join(missing)}",
                )
            )
            continue

        observed_at = localise_last_updated(parsed, tz)
        if observed_at is None:
            if fallback_observed_at == "ingest" and ingest_time is not None:
                observed_at = ingest_time
                field_errors.append(
                    FieldError(field="last_updated", raw=None, error="missing; keyed on ingest time")
                )

        result.ok.append(
            ParsedVehicle(
                vehicle_id=vehicle_id,
                observed_at=observed_at,
                values=values,
                field_errors=field_errors,
                missing=missing,
            )
        )

    return result
