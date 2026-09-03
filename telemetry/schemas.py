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
import logging
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

from .fields import COLUMN_NAMES, META_FIELDS, PARAM_SPECS, SPEC_BY_NAME, normalize_key, resolve_parameter_key

log = logging.getLogger(__name__)

__all__ = [
    "AuthResponse",
    "VehiclesPayload",
    "FieldError",
    "ParsedVehicle",
    "RejectedVehicle",
    "SiteProvisionRecord",
    "SiteProvisionRequest",
    "SiteProvisionResponse",
    "ValidatedPayload",
    "VehicleParams",
    "count_active_vehicles",
    "extract_vehicle_id",
    "flatten_vehicle_frame",
    "is_frame_active",
    "merge_vehicle_frames",
    "naive_to_aware",
    "parse_payload",
    "parse_source_timestamp",
    "report_dates",
    "vehicles_list_to_dict",
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
# tier-1 / tier-2 frame assembly
# ---------------------------------------------------------------------------
def flatten_vehicle_frame(frame: dict[str, Any]) -> dict[str, Any]:
    """Flatten one level of nested blocks (`battery`) into a flat key map.

    The live v1 detail frame nests the battery diagnostics under a `battery`
    object; the validator consumes flat frames.  Top-level scalars win over
    nested ones, and an explicit nested `null` never erases a real value --
    a `null` reading means "no measurement", which is what absence already
    means downstream.
    """
    flat = {key: value for key, value in frame.items() if not isinstance(value, dict)}
    for key, value in frame.items():
        if not isinstance(value, dict):
            continue
        for inner_key, inner in value.items():
            if isinstance(inner, dict) or inner is None:
                continue
            flat.setdefault(str(inner_key), inner)
    return flat


def merge_vehicle_frames(summary_frame: dict[str, Any], detail_response: Any) -> dict[str, Any]:
    """Combine the tier-1 summary frame with the tier-2 detail response.

    The detail may arrive flat, nested under `battery`, or wrapped in a small
    envelope (`{"ok": ..., "vehicle": {...}}`) -- all three shapes merge into
    one frame.  Detail values override summary values; explicit nulls in the
    detail never erase a summary value; the summary's `"battery": null`
    placeholder is dropped.  Non-dict detail responses are ignored, leaving
    the summary frame untouched.
    """
    if not isinstance(detail_response, dict):
        return summary_frame

    detail = detail_response
    inner = detail.get("vehicle")
    if isinstance(inner, dict) and len(detail) <= 3:
        detail = inner  # envelope tolerance: {"ok": true, "vehicle": {...}}

    merged = {
        key: value
        for key, value in summary_frame.items()
        if key != "battery" and not isinstance(value, dict)
    }
    sources = (detail, detail.get("battery") if isinstance(detail.get("battery"), dict) else {})
    for source in sources:
        for key, value in source.items():
            if key == "battery" or isinstance(value, dict) or value is None:
                continue
            merged[key] = value
    return merged


# ---------------------------------------------------------------------------
# list-wire tolerance (Pydantic v2 normalizers)
# ---------------------------------------------------------------------------
# The documented tier-1 shape is `{"vehicles": {"<ID>": {frame}}}`.  Some upstream
# builds (and every `once --dry-run` capture) ship `vehicles` as a *list* of
# frames instead, each carrying its own identity key.  `vehicles_list_to_dict`
# is registered as a `BeforeValidator` on `VehiclesPayload.vehicles`, so both
# wire shapes validate through the one and only gate -- and a frame we cannot
# name is dropped and logged rather than given an invented key.
_VEHICLE_ID_WIRE_KEYS: Final[tuple[str, ...]] = (
    "vehicle_id",
    "vehicleid",
    "vehicle",
    "id",
    "vid",
    "plate",
    "chassis",
    "chassis_no",
    "reg_no",
    "registration",
    "vehicle_number",
    "truck_id",
    "asset_id",
)
_NORMALIZED_VEHICLE_ID_KEYS: Final[frozenset[str]] = frozenset(
    normalize_key(key) for key in _VEHICLE_ID_WIRE_KEYS
)


def extract_vehicle_id(frame: Any) -> str | None:
    """The identity of one list-wire frame, or None when it carries none.

    Exact key match first (fast path), then the same case/separator-insensitive
    normalization `resolve_parameter_key` uses, so `vehicleId`, `VEHICLE-ID` and
    `vehicle_id` all identify the frame.  The value is returned verbatim
    (trimmed); upper-casing stays with `parse_payload`, exactly as for the
    dict wire shape.
    """
    if not isinstance(frame, dict):
        return None
    for key in _VEHICLE_ID_WIRE_KEYS:
        value = frame.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    raw_to_normalized = {key: normalize_key(str(key)) for key in frame}
    for key, normalized in raw_to_normalized.items():
        if normalized not in _NORMALIZED_VEHICLE_ID_KEYS:
            continue
        value = frame[key]
        if isinstance(value, (str, int)) and str(value).strip():
            return str(value).strip()
    return None


def vehicles_list_to_dict(value: Any) -> Any:
    """Normalizer for `VehiclesPayload.vehicles`: list wire -> dict wire.

    Dicts and None pass through untouched (the documented shape and the empty
    case).  A list is re-keyed onto `extract_vehicle_id(frame)`; duplicate ids
    keep the first frame, and frames with no usable identity key are dropped
    with a WARNING -- silence there would hide an upstream contract change.
    """
    if not isinstance(value, list):
        return value
    keyed: dict[str, Any] = {}
    duplicates = dropped = 0
    for frame in value:
        vehicle_id = extract_vehicle_id(frame)
        if vehicle_id is None:
            dropped += 1
            continue
        if vehicle_id in keyed:
            duplicates += 1
            continue
        keyed[vehicle_id] = frame
    if dropped or duplicates:
        log.warning(
            "vehicles arrived as a list: %d frame(s) kept, %d dropped (no usable id), "
            "%d duplicate id(s) ignored",
            len(keyed),
            dropped,
            duplicates,
        )
    return keyed


# ---------------------------------------------------------------------------
# live-batch quality (drives the date-resolution fallback in the extractor)
# ---------------------------------------------------------------------------
# A frame is "active" when it carries at least one real reading.  A roster
# entry that is only a timestamp plus the tier-1 `"battery": null` placeholder
# is a *dead* frame: the truck is listed but sent no telemetry, and a batch of
# those must not be mistaken for a live fleet.  Value `0` counts as a reading
# (a parked truck's speed is data); `null` and nested blocks do not.
_META_FRAME_KEYS: Final[frozenset[str]] = frozenset(
    normalize_key(key) for key in (*META_FIELDS, "updated_at", "timestamp", "ok")
) | _NORMALIZED_VEHICLE_ID_KEYS

_DATE_PREFIX_RE: Final = re.compile(r"^(\d{4}-\d{2}-\d{2})")


def is_frame_active(frame: Any) -> bool:
    """True when one raw wire frame carries at least one non-null reading."""
    if not isinstance(frame, dict):
        return False
    for key, value in frame.items():
        if value is None or isinstance(value, dict):
            continue
        if normalize_key(str(key)) in _META_FRAME_KEYS:
            continue
        return True
    return False


def count_active_vehicles(raw: Any) -> int:
    """Active frames in a raw tier-1 payload (dict or list wire shape)."""
    vehicles = raw.get("vehicles") if isinstance(raw, dict) else None
    vehicles = vehicles_list_to_dict(vehicles)
    if not isinstance(vehicles, dict):
        return 0
    return sum(1 for frame in vehicles.values() if is_frame_active(frame))


def report_dates(raw: Any, tz: ZoneInfo, limit: int = 4) -> list[str]:
    """Distinct reporting dates (YYYY-MM-DD, source-local) in a payload, newest first.

    The fleet's own `last_updated` values are the upstream telling us which
    date it actually has data for -- the first thing the live-date resolver
    probes when a batch comes back empty or dead.  Naive strings keep their
    calendar date as written; epoch values are read in `tz` (IST) because the
    upstream's `date` filter is server-local.  Unusable timestamps are skipped.
    """
    vehicles = raw.get("vehicles") if isinstance(raw, dict) else None
    vehicles = vehicles_list_to_dict(vehicles)
    if not isinstance(vehicles, dict):
        return []

    found: set[str] = set()
    for frame in vehicles.values():
        if not isinstance(frame, dict):
            continue
        raw_ts = None
        for key in ("last_updated", "updated_at", "timestamp"):
            candidate = frame.get(key)
            if candidate is not None and not isinstance(candidate, bool):
                raw_ts = candidate
                break
        if raw_ts is None:
            continue
        if isinstance(raw_ts, (int, float)):
            found.add(datetime.fromtimestamp(float(raw_ts), tz=tz).date().isoformat())
            continue
        text = str(raw_ts).strip()
        if text.lower() in _NULLISH:
            continue
        match = _DATE_PREFIX_RE.match(text)
        if match is None:
            continue
        try:
            datetime.strptime(match.group(1), "%Y-%m-%d")
        except ValueError:
            continue
        found.add(match.group(1))
    return sorted(found, reverse=True)[:limit]


def _canonicalise_keys(flat_frame: dict[str, Any]) -> dict[str, Any]:
    """Re-key a flat frame onto canonical parameter names.

    Exact alias match first, then `telemetry.fields.resolve_parameter_key`'s
    normalized table -- so `batt_v`, `BATT_V` and `batt-v` all land on
    `battery_total_v` without per-spelling registry entries.  Unresolvable
    keys are kept verbatim and later ignored by the model (`extra="ignore"`),
    which is exactly what the drift reporter wants to see.
    """
    canonical: dict[str, Any] = {}
    for key, value in flat_frame.items():
        name = resolve_parameter_key(str(key))
        canonical[name if name is not None else key] = value
    return canonical


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


class VehiclesPayload(BaseModel):
    """GET /api/v1/vehicles (tier 1) -- we only consume `.vehicles`.

    Tier 1 frames are fleet-summary level (`battery` arrives as an explicit
    null); the tier-2 detail frames fetched per vehicle are merged in by
    `telemetry.extractor` via `merge_vehicle_frames` before validation.

    `vehicles` accepts both wire shapes: the documented `{id: frame}` map and
    a list of self-identifying frames (`vehicles_list_to_dict`), so an
    upstream that ships the list shape degrades into a warning, not a crash.
    """

    model_config = ConfigDict(extra="ignore")

    ok: bool = True
    summary: dict[str, Any] | None = None
    vehicles: Annotated[dict[str, Any] | None, BeforeValidator(vehicles_list_to_dict)] = None

    @model_validator(mode="after")
    def _normalise(self) -> "VehiclesPayload":
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
    payload: VehiclesPayload,
    tz: ZoneInfo,
    *,
    require_all_fields: bool = False,
    ingest_time: datetime | None = None,
    fallback_observed_at: str = "ingest",
) -> ValidatedPayload:
    """Validate the whole `vehicles` object.

    Returns accepted frames plus a quarantine list; it never raises for bad data.

    NULL policy (revised for the two-tier v1 contract): a parameter is NULL
    only when the merged tier-1 + tier-2 frame genuinely lacks every alias for
    it, or carries an unusable sentinel.  Values the upstream sends are parsed
    and stored -- nothing is pinned, nothing is coerced into a fake zero.
    `require_all_fields` gates on all 24 parameters.
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

        # Soft per-field handling: a poisoned sensor must not null the other 23.
        #
        # The frame is flattened (tier-2 detail nests diagnostics under
        # `battery`) and re-keyed onto canonical names through the alias layer
        # (legacy guide keys AND the abbreviated v1 keys), then parsed.  A key
        # that is genuinely absent leaves the parameter NULL -- absence is
        # honest, a fabricated zero is not.
        flat = flatten_vehicle_frame(raw_frame)
        canonical_frame = _canonicalise_keys(flat)

        try:
            parsed = VehicleParams.model_validate(canonical_frame)
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

        values: dict[str, Any] = {}
        field_errors: list[FieldError] = []
        for spec in PARAM_SPECS:
            raw_value = canonical_frame.get(spec.name)
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

        # `missing` drives the UI's "awaiting upstream" state: a parameter is
        # missing only when NO alias for it appeared anywhere in the merged
        # tier-1 + tier-2 frame.
        missing = [spec.name for spec in PARAM_SPECS if spec.name not in canonical_frame]
        # Completeness gate covers all 24 parameters.  Default is False: a
        # truck that genuinely drops a channel is still worth rendering, with
        # the gap reported instead of papered over.
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


# ---------------------------------------------------------------------------
# site-provisioning (control plane) contracts
# ---------------------------------------------------------------------------
# Wire DTOs for the Next.js "Spin up isolated twin" form consumed by
# `telemetry.main` (POST /api/provision-site).  They are deliberately the
# camelCase names the browser emits (`SiteConfig` on the frontend) so the
# payload validates with zero translation, and they live *alongside* the
# database-layer models above -- nothing pre-existing is altered or removed.
#
# `vehicleFilter` (a client-side function on the frontend) is never serialised,
# so it is simply absent here; any extra keys are ignored via `extra="ignore"`.

_SITE_ID_RE: Final = re.compile(r"^[A-Za-z0-9._-]{3,32}$")


class SiteProvisionRequest(BaseModel):
    """Inbound payload from the "Spin up isolated twin" form."""

    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    siteId: str = Field(
        min_length=3,
        max_length=32,
        pattern=_SITE_ID_RE.pattern,
        description="Operator-chosen site key, e.g. SWP-PUNE-01",
    )
    label: str = Field(default="", max_length=64)
    customer: str = Field(min_length=1, max_length=64)
    chargers: int = Field(ge=0, le=512)
    dgCapacityKw: int = Field(ge=0, le=100_000)
    gridFeederKw: int = Field(ge=0, le=100_000)


class SiteProvisionRecord(SiteProvisionRequest):
    """A request plus the server-side audit trail, as stored on disk."""

    model_config = ConfigDict(extra="ignore")

    received_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    source: str = Field(default="nextjs-dashboard")


class SiteProvisionResponse(BaseModel):
    """200 body. `ok` is always true on this route; failures are non-2xx."""

    ok: bool = True
    siteId: str
    message: str
    totalSites: int
