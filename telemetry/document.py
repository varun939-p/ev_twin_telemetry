"""The trusted telemetry document: one builder, two sources.

The dashboard's single read contract -- the ``TrustedTelemetryDocument`` --
used to be produced by ``main_parser.py`` and handed to Next.js through a
file.  It is now produced here and served straight out of PostgreSQL by the
control plane (``telemetry/main.py``, mounted by ``api/index.py`` on Vercel);
``main_parser.py`` keeps using the same builder for offline captures.

Two entry points, identical output shape:

    document_from_parsed(result, ...)   a ValidatedPayload straight out of
                                        ``telemetry.schemas.parse_payload``
    document_from_state_rows(rows, ...) the ``vehicle_state`` snapshot table
                                        (one row per vehicle, what the
                                        repository upserts each cycle)

Every field that reaches the output is bookkeeping the validator or the
repository actually recorded.  A parameter is ``null`` in ``values`` only when
no alias for it appeared in the merged upstream frame (or validation rejected
it) -- never a fabricated zero.  The per-field ``field_status`` verdicts are
persisted on the snapshot row by the repository, so the DB-sourced document is
exactly as honest as the parse-sourced one: ``measured`` /
``absent_upstream`` / ``null_upstream`` / ``field_error``, consumed by the UI
to gray tiles out.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Final, Iterable, Sequence
from zoneinfo import ZoneInfo

from .fields import COLUMN_NAMES, SPEC_BY_NAME
from .schemas import ParsedVehicle, ValidatedPayload

SCHEMA_VERSION: Final = "1.0"

# Field-level status vocabulary consumed by the frontend.  Anything that is not
# MEASURED must be rendered grayed-out / "awaiting upstream".
MEASURED: Final = "measured"
ABSENT_UPSTREAM: Final = "absent_upstream"  # key never sent by the API
NULL_UPSTREAM: Final = "null_upstream"      # key sent, value was null/sentinel
FIELD_ERROR: Final = "field_error"          # key sent, value rejected -> NULL

VALIDATOR_PARSED: Final = "telemetry.schemas.parse_payload"
VALIDATOR_REPOSITORY: Final = "telemetry.repository.TelemetryRepository (PostgreSQL upsert)"

FIELD_STATUS_LEGEND: Final[dict[str, str]] = {
    MEASURED: "value present and passed validation -- render normally",
    ABSENT_UPSTREAM: "upstream did not send this key -- gray out, 'awaiting upstream'",
    NULL_UPSTREAM: "upstream sent the key with a null/empty value -- gray out, 'no reading'",
    FIELD_ERROR: "value was rejected by validation and stored NULL -- gray out, show error",
}


@dataclass(slots=True)
class Provenance:
    """Where the document's data came from -- recorded in the output for auditability."""

    source_file: str | None
    source_encoding: str
    source_bytes: int
    input_shape: str
    upstream_request: dict[str, Any] | None = None
    extra: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# shared per-field verdicts
# ---------------------------------------------------------------------------
def field_status(vehicle: ParsedVehicle, name: str, errored: set[str]) -> str:
    """One status per parameter, straight off the validator's own bookkeeping."""
    if name in errored:
        return FIELD_ERROR
    if name in vehicle.missing:
        return ABSENT_UPSTREAM  # upstream never sent this key -> UI grays it out
    if vehicle.values.get(name) is None:
        return NULL_UPSTREAM    # key sent, value unusable/empty
    return MEASURED


def statuses_for(vehicle: ParsedVehicle) -> dict[str, str]:
    """The full 24-key status map for one validated frame, in spec order."""
    errored = {err.field for err in vehicle.field_errors}
    return {name: field_status(vehicle, name, errored) for name in COLUMN_NAMES}


# ---------------------------------------------------------------------------
# vehicle blocks -- the parts shared by both sources
# ---------------------------------------------------------------------------
def source_observed_at(value: datetime | None, errors: Sequence[dict[str, Any]] | None) -> datetime | None:
    """Ingest-time history keys are not source observations.

    The validator records a last_updated error when it falls back to ingest
    time. Honor that existing verdict rather than making the age badge fresh
    just because our worker ran. This does not alter stored history keys.
    """
    if any(error.get("field") == "last_updated" for error in (errors or [])):
        return None
    return value


def _vehicle_entry(
    vehicle_id: str,
    values: dict[str, Any],
    observed_at: datetime | None,
    statuses: dict[str, str],
    field_errors: Sequence[dict[str, Any]],
    missing_fields: Sequence[str],
) -> dict[str, Any]:
    """One entry of ``document.vehicles``, all 24 keys present, spec order."""
    measured = [name for name in COLUMN_NAMES if statuses[name] == MEASURED]
    completeness = round(100.0 * len(measured) / len(COLUMN_NAMES), 1)
    observed_at = source_observed_at(observed_at, field_errors)
    observed_iso = observed_at.isoformat() if observed_at else None
    signature = _signature(vehicle_id, observed_iso, values)
    return {
        "vehicle_id": vehicle_id,
        "observed_at": observed_iso,
        "observed_at_utc": observed_iso,
        "trusted": True,  # reached here => it passed validation (directly or via the repository)
        "signature": signature,  # stable digest; dedupe/idempotency downstream
        "measured_count": len(measured),
        "completeness_pct": completeness,
        # --- the three lists the Pipeline Health Toggle consumes -----------
        "missing_fields": list(missing_fields),  # absent upstream
        "null_fields": [n for n in COLUMN_NAMES if statuses[n] == NULL_UPSTREAM],
        "field_errors": list(field_errors),
        # --- per-field flags, all 24 keys, spec order ----------------------
        "field_status": {name: statuses[name] for name in COLUMN_NAMES},
        # --- the readings themselves, all 24 keys, spec order --------------
        "values": {name: values.get(name) for name in COLUMN_NAMES},
    }


def _signature(vehicle_id: str, observed_iso: str | None, values: dict[str, Any]) -> str:
    """Stable digest of a frame, equivalent to `ParsedVehicle.signature()`."""
    blob = json.dumps(
        {"vehicle_id": vehicle_id, "observed_at": observed_iso, "values": {k: values.get(k) for k in COLUMN_NAMES}},
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:32]


def _parameters_block(vehicles_out: Sequence[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Fleet-wide per-parameter health, computed from the vehicle entries."""
    measured_counts: Counter[str] = Counter()
    status_counts: dict[str, Counter[str]] = {name: Counter() for name in COLUMN_NAMES}
    attention: list[dict[str, Any]] = []

    for entry in vehicles_out:
        measured_counts.update(name for name in COLUMN_NAMES if entry["field_status"][name] == MEASURED)
        for name in COLUMN_NAMES:
            status_counts[name][entry["field_status"][name]] += 1
        if entry["completeness_pct"] < 50.0 or not entry["observed_at"]:
            attention.append(
                {
                    "vehicle_id": entry["vehicle_id"],
                    "reason": "no usable frame timestamp" if not entry["observed_at"] else "low completeness",
                    "measured_count": entry["measured_count"],
                    "completeness_pct": entry["completeness_pct"],
                    "observed_at": entry["observed_at"],
                }
            )

    accepted = max(len(vehicles_out), 1)
    parameters: list[dict[str, Any]] = []
    for name in COLUMN_NAMES:
        spec = SPEC_BY_NAME[name]
        hits = measured_counts.get(name, 0)
        parameters.append(
            {
                "field": name,
                "label": spec.label,
                "unit": spec.unit,
                "logical_type": spec.kind,
                "documented_upstream": spec.documented,
                "vehicles_with_value": hits,
                "coverage_pct": round(100.0 * hits / accepted, 1),
                # A parameter the upstream never sent anywhere in this batch.
                "status": "available" if hits else "unavailable_upstream",
                "status_breakdown": dict(status_counts[name]),
            }
        )
    available = [p for p in parameters if p["status"] == "available"]
    unavailable = [p for p in parameters if p["status"] != "available"]
    return available, unavailable, attention


def _document(
    *,
    vehicles_out: list[dict[str, Any]],
    provenance: Provenance,
    generated_at: datetime,
    source_timezone: str,
    require_all_fields: bool,
    seen: int,
    quarantined: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    """Assemble the final document around prepared vehicle entries."""
    available, unavailable, attention = _parameters_block(vehicles_out)
    accepted = max(len(vehicles_out), 1)
    oldest = min((v["observed_at"] for v in vehicles_out if v["observed_at"]), default=None)
    newest = max((v["observed_at"] for v in vehicles_out if v["observed_at"]), default=None)

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at.isoformat(),
        "provenance": {
            **asdict(provenance),
            "validator": provenance.input_shape.startswith("postgres") and VALIDATOR_REPOSITORY or VALIDATOR_PARSED,
            "source_timezone": source_timezone,
            "require_all_fields": require_all_fields,
            "database_written": provenance.input_shape.startswith("postgres"),
        },
        "pipeline_health": {
            "vehicles_seen": seen,
            "vehicles_accepted": len(vehicles_out),
            "vehicles_quarantined": len(quarantined),
            "parameters_total": len(COLUMN_NAMES),
            "parameters_available": len(available),
            "parameters_unavailable_upstream": len(unavailable),
            "fleet_completeness_pct": round(
                100.0 * sum(v["measured_count"] for v in vehicles_out) / (accepted * len(COLUMN_NAMES)), 1
            ),
            "oldest_observed_at": oldest,
            "newest_observed_at": newest,
            "available_parameters": available,
            # Parameters the frontend must gray out (coverage-driven), with labels/units.
            "unavailable_parameters": unavailable,
            "attention": attention,
        },
        "field_status_legend": FIELD_STATUS_LEGEND,
        "vehicles": vehicles_out,
        "quarantined": list(quarantined),
    }


# ---------------------------------------------------------------------------
# source 1 -- a validated payload (main_parser.py, `once --dry-run`)
# ---------------------------------------------------------------------------
def document_from_parsed(
    result: ValidatedPayload,
    provenance: Provenance,
    *,
    tz: ZoneInfo,
    require_all_fields: bool,
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    """Shape the validated frames for the Next.js dashboard.

    ``values`` always contains all 24 keys in product-spec order -- absent
    fields are explicit ``null``, never omitted -- so the frontend can render a
    fixed grid and gray a tile from ``field_status[key] != "measured"`` without
    any key-existence checks of its own.
    """
    generated_at = generated_at or datetime.now(timezone.utc)
    vehicles_out = [
        _vehicle_entry(
            vehicle.vehicle_id,
            vehicle.values,
            vehicle.observed_at,
            statuses_for(vehicle),
            [err.model_dump() for err in vehicle.field_errors],
            list(vehicle.missing),
        )
        for vehicle in result.ok
    ]
    return _document(
        vehicles_out=vehicles_out,
        provenance=provenance,
        generated_at=generated_at,
        source_timezone=str(tz),
        require_all_fields=require_all_fields,
        seen=result.seen,
        quarantined=[item.model_dump() for item in result.rejected],
    )


# ---------------------------------------------------------------------------
# source 2 -- the vehicle_state snapshot table (the serverless control plane)
# ---------------------------------------------------------------------------
def document_from_state_rows(
    rows: Iterable[Any],
    *,
    settings_tz: ZoneInfo,
    require_all_fields: bool,
    generated_at: datetime | None = None,
    database_url_masked: str | None = None,
    last_cycle: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the document from ``vehicle_state`` ORM rows.

    The repository persists ``field_status`` / ``missing_fields`` /
    ``field_errors`` alongside the values, so no verdict is re-invented here:
    what the validator decided at ingest time is what the dashboard renders.

    Rows with no persisted verdicts (written by an older engine version)
    degrade to ``measured``/``absent_upstream`` from the values alone -- the
    frontend's ``normalizeVehicle`` applies the same inference as a second
    safety net.
    """
    generated_at = generated_at or datetime.now(timezone.utc)
    vehicles_out: list[dict[str, Any]] = []
    for row in rows:
        values = getattr(row, "raw_frame", None) or {
            name: getattr(row, name, None) for name in COLUMN_NAMES
        }
        statuses: dict[str, str] = dict(getattr(row, "field_status", None) or {})
        if not statuses:  # legacy row written before verdicts were persisted
            statuses = {
                name: (MEASURED if values.get(name) is not None else ABSENT_UPSTREAM)
                for name in COLUMN_NAMES
            }
        missing = list(getattr(row, "missing_fields", None) or [])
        field_errors = list(getattr(row, "field_errors", None) or [])
        vehicles_out.append(
            _vehicle_entry(
                row.vehicle_id,
                values,
                getattr(row, "last_updated", None),
                statuses,
                field_errors,
                missing,
            )
        )
    vehicles_out.sort(key=lambda v: v["vehicle_id"])

    provenance = Provenance(
        source_file=database_url_masked or "postgres://vehicle_state",
        source_encoding="utf-8",
        source_bytes=0,
        input_shape="postgres_snapshot",
        upstream_request=None,
        extra={
            "table": "vehicle_state",
            "rows": len(vehicles_out),
            **({"last_cycle": last_cycle} if last_cycle else {}),
        },
    )
    seen = len(vehicles_out)
    return _document(
        vehicles_out=vehicles_out,
        provenance=provenance,
        generated_at=generated_at,
        source_timezone=str(settings_tz),
        require_all_fields=require_all_fields,
        seen=seen,
        quarantined=[],
    )


def empty_document(
    *,
    settings_tz: ZoneInfo,
    require_all_fields: bool,
    reason: str,
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    """A structurally valid document with zero vehicles.

    Served when the database is reachable but the first ingestion has not
    landed yet.  The frontend renders its empty states and the header chip
    says why -- it must never be a 5xx, a crash, or fabricated data.
    """
    document = document_from_state_rows(
        [],
        settings_tz=settings_tz,
        require_all_fields=require_all_fields,
        generated_at=generated_at,
        database_url_masked="not-ingested-yet",
    )
    document["provenance"]["extra"]["note"] = reason
    return document
