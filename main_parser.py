"""Local-file bridge: raw Blue Energy capture -> validated -> trusted JSON.

    python main_parser.py --input uploads/blue_energy_response.json \
                          --output trusted_vehicle_telemetry.json

Invoked through the project interpreter, like every other entry point here
(`python -m telemetry ...`, `python tools/...`) -- no shebang, so it can never
silently pick up a system Python that lacks the pinned dependencies.

Pipeline (AWS credits pending, so this stage is file -> file, no DB, no HTTP):

    blue_energy_response.json
        -> read_text()            encoding sniff (the capture is UTF-16LE + CRLF)
        -> extract_document()     drop the console log preamble, keep the JSON
        -> normalise_envelope()   accept either payload shape (see below)
        -> VehiclesPayload        telemetry.schemas -- the ONLY gate to the data
        -> parse_payload()        per-field validation, `missing` / `field_errors`
        -> document_from_parsed() telemetry.document -- the shared builder
        -> trusted JSON            (serverless deploys skip this file entirely)

Architecture rule honoured: nothing reaches the output (or, later, PostgreSQL)
unless it came back out of `telemetry.schemas.parse_payload`.  This script owns
I/O and presentation only -- it re-implements no validation and relaxes none.

Two input shapes are accepted, because both occur in practice:

  1. **Upstream envelope** -- `{"ok": true, "summary": {...}, "vehicles":
     {"AP39WG5383": {...frame...}}}`, i.e. the verbatim body of
     `GET /api/v1/vehicles`.  Passed straight through.
  2. **`once --dry-run` capture** -- `{"request": {...}, "seen": N,
     "vehicles": [{"vehicle_id", "observed_at", "missing", "field_errors",
     "values"}]}`, i.e. what `python -m telemetry once --dry-run` prints (this
     is what `blue_energy_response.json` currently is: a UTF-16 console
     capture of a real 2026-08-28 pull, 100 vehicles).  Rebuilt into shape 1.

A parameter reaches the document as JSON `null` only when the capture it was
built from genuinely lacked every alias for it (never `0`).  Those gaps are
listed per vehicle in `missing_fields`, plus fleet-wide in
`pipeline_health.unavailable_parameters`.  That is what the frontend's
Pipeline Health Toggle reads to gray a tile out.  The live two-tier v1 API
populates the battery parameters that the historical 2026-08-28 capture
predates, so a fresh document shows them measured.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import tempfile
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Final
from zoneinfo import ZoneInfo

from telemetry.document import Provenance, document_from_parsed as build_output
from telemetry.fields import PARAM_SPECS, SPEC_BY_NAME
from telemetry.schemas import VehiclesPayload, parse_payload

log = logging.getLogger("main_parser")

# Used only when --input is omitted, so `python main_parser.py` works from the
# repo root whether or not the capture has been moved into uploads/.
DEFAULT_INPUT_CANDIDATES: Final[tuple[str, ...]] = (
    "blue_energy_response.json",
    "uploads/blue_energy_response.json",
)
DEFAULT_OUTPUT: Final = "trusted_vehicle_telemetry.json"

# Field-level status vocabulary consumed by the frontend.  Anything that is not
# MEASURED must be rendered grayed-out / "awaiting upstream".
MEASURED: Final = "measured"
ABSENT_UPSTREAM: Final = "absent_upstream"  # key never sent by the API
NULL_UPSTREAM: Final = "null_upstream"      # key sent, value was null/sentinel
FIELD_ERROR: Final = "field_error"          # key sent, value rejected -> NULL

_ENCODINGS: Final[tuple[str, ...]] = ("utf-16", "utf-8-sig", "utf-8")


# ---------------------------------------------------------------------------
# stage 1 -- read
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class RawCapture:
    text: str
    encoding: str
    path: Path
    bytes: int


def read_text(path: Path) -> RawCapture:
    """Decode the capture, sniffing the encoding instead of assuming UTF-8.

    The Blue Energy capture on disk is a Windows console redirect: UTF-16LE with
    a BOM and CRLF line endings.  A plain `open(...).read()` or a hard-coded
    `encoding="utf-8"` turns it into mojibake and `json.loads` fails on line 1,
    so the BOM decides and UTF-8 is the fallback.
    """
    blob = path.read_bytes()
    if blob.startswith((b"\xff\xfe", b"\xfe\xff")):
        candidates = ("utf-16",) + _ENCODINGS[1:]
    elif blob.startswith(b"\xef\xbb\xbf"):
        candidates = ("utf-8-sig", "utf-8")
    else:
        candidates = ("utf-8", "utf-16")

    last_error: Exception | None = None
    for encoding in candidates:
        try:
            return RawCapture(text=blob.decode(encoding), encoding=encoding, path=path, bytes=len(blob))
        except UnicodeDecodeError as exc:  # try the next candidate
            last_error = exc
    raise ValueError(f"{path}: not decodable as {', '.join(candidates)} ({last_error})")


def extract_document(capture: RawCapture) -> dict[str, Any]:
    """Return the JSON object in the capture, ignoring any console log preamble.

    `once --dry-run` writes its log lines to stdout *and* the JSON to stdout, so
    a redirected capture is "N log lines, then the document".  Rather than
    hard-coding a line count, take the first line that opens a JSON value and
    parse from there to EOF -- stable if the log format or level ever changes.
    """
    text = capture.text
    try:
        document = json.loads(text)
    except json.JSONDecodeError:
        lines = text.splitlines()
        start = next((i for i, line in enumerate(lines) if line.lstrip()[:1] in {"{", "["}), None)
        if start is None:
            raise ValueError(f"{capture.path}: no JSON object found in the capture") from None
        skipped = start
        document = json.loads("\n".join(lines[start:]))
    else:
        skipped = 0

    if not isinstance(document, dict):
        raise ValueError(f"{capture.path}: expected a JSON object, got {type(document).__name__}")
    if skipped:
        log.info("skipped %d log line(s) before the JSON document", skipped)
    return document


# ---------------------------------------------------------------------------
# stage 2 -- normalise to the upstream envelope shape
# ---------------------------------------------------------------------------
def normalise_envelope(document: dict[str, Any], capture: RawCapture) -> tuple[dict[str, Any], Provenance]:
    """Map either accepted input shape onto `{"ok": ..., "vehicles": {id: frame}}`.

    `VehiclesPayload` (and therefore `parse_payload`) consumes the *upstream*
    shape: a dict keyed by vehicle id whose values are raw frames.  A dry-run
    capture instead holds a list of already-parsed records, so it is rebuilt
    frame-by-frame here.

    The rebuild rule matters: a key is dropped **only** when the capture's own
    `missing` list says the upstream never sent it.  Keys that were sent with a
    null value are kept as null.  Those two cases are different upstream faults
    ("field not provisioned" vs "field provisioned, sensor returned nothing")
    and `parse_payload` reports them differently -- `missing` vs a null value --
    so collapsing them here would erase information the UI needs.
    """
    provenance = Provenance(
        source_file=str(capture.path),
        source_encoding=capture.encoding,
        source_bytes=capture.bytes,
        input_shape="unknown",
        upstream_request=document.get("request") if isinstance(document.get("request"), dict) else None,
    )

    vehicles = document.get("vehicles")

    if isinstance(vehicles, dict):  # shape 1: verbatim upstream envelope
        provenance.input_shape = "upstream_envelope"
        return {"ok": document.get("ok", True), "summary": document.get("summary"), "vehicles": vehicles}, provenance

    if isinstance(vehicles, list):  # shape 2: `once --dry-run` capture
        provenance.input_shape = "dry_run_capture"
        frames: dict[str, Any] = {}
        for index, record in enumerate(vehicles):
            if not isinstance(record, dict):
                raise ValueError(f"{capture.path}: vehicles[{index}] is {type(record).__name__}, expected object")
            vehicle_id = str(record.get("vehicle_id") or "").strip()
            if not vehicle_id:
                raise ValueError(f"{capture.path}: vehicles[{index}] has no vehicle_id")
            values = record.get("values")
            if not isinstance(values, dict):
                raise ValueError(f"{capture.path}: vehicles[{index}] ({vehicle_id}) has no `values` object")

            absent = {str(name) for name in record.get("missing") or []}
            # Drop only what the upstream never sent; keep explicit nulls.
            frame: dict[str, Any] = {key: value for key, value in values.items() if key not in absent}
            observed_at = record.get("observed_at")
            if observed_at:
                # `values` carries the 24 parameters only -- the frame timestamp
                # lives beside it in the capture, so put it back where the
                # validator expects it (AliasChoices: last_updated/updated_at/
                # timestamp).  Already UTC-aware, so no timezone is invented.
                frame["last_updated"] = observed_at
            frames[vehicle_id] = frame

        provenance.extra = {
            "capture_seen": document.get("seen"),
            "capture_accepted": document.get("accepted"),
            "capture_rejected": document.get("rejected"),
        }
        return {"ok": True, "summary": document.get("summary"), "vehicles": frames}, provenance

    raise ValueError(
        f"{capture.path}: unrecognised payload -- `vehicles` must be an object "
        f"(upstream envelope) or a list (`once --dry-run` capture), got {type(vehicles).__name__}"
    )


# ---------------------------------------------------------------------------
# stage 3 -- write
# ---------------------------------------------------------------------------
# Presentation lives in telemetry.document (shared with the serverless
# control plane); this script only owns I/O and the CLI.

def write_json(path: Path, document: dict[str, Any]) -> None:
    """Atomic write: a half-written file must never be what the frontend reads."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(document, stream, indent=2, ensure_ascii=False, default=str)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------
def run(
    input_path: Path,
    output_path: Path,
    *,
    tz: ZoneInfo,
    require_all_fields: bool = False,
    fallback_observed_at: str = "ingest",
) -> int:
    generated_at = datetime.now(timezone.utc)

    capture = read_text(input_path)
    log.info("read %s (%d bytes, %s)", capture.path, capture.bytes, capture.encoding)

    document = extract_document(capture)
    envelope, provenance = normalise_envelope(document, capture)
    log.info("input shape: %s | %d vehicle frame(s)", provenance.input_shape, len(envelope["vehicles"]))

    # The one and only gate: VehiclesPayload -> parse_payload.
    #
    # `require_all_fields` gates on all 24 parameters; absence becomes NULL +
    # a `missing` entry rather than a fabricated zero.  It stays False by
    # default because a truck that
    # genuinely drops one of the 15 is still worth rendering -- the missing
    # parameter becomes NULL + a `FieldError` rather than taking the frame down.
    payload = VehiclesPayload.model_validate(envelope)
    result = parse_payload(
        payload,
        tz,
        require_all_fields=require_all_fields,
        ingest_time=generated_at,
        fallback_observed_at=fallback_observed_at,
    )

    log.info(
        "validation: seen=%d accepted=%d quarantined=%d field_errors=%d",
        result.seen,
        result.accepted,
        len(result.rejected),
        sum(len(v.field_errors) for v in result.ok),
    )
    if not result.ok:
        log.error("nothing passed validation -- refusing to write an empty trusted file")
        return 1

    absent = Counter(name for vehicle in result.ok for name in vehicle.missing)
    present = [p.name for p in PARAM_SPECS if not absent.get(p.name)]
    log.info("parameters measured: %d/%d", len(present), len(PARAM_SPECS))
    for name, hits in absent.most_common():
        spec = SPEC_BY_NAME[name]
        log.info(
            "  absent upstream: %-20s %-28s null in %d/%d vehicle(s) -> grayed out in UI",
            name,
            f"{spec.label} ({spec.unit})" if spec.unit else spec.label,
            hits,
            result.accepted,
        )

    output = build_output(
        result,
        provenance,
        tz=tz,
        require_all_fields=require_all_fields,
        generated_at=generated_at,
    )
    write_json(output_path, output)
    log.info("wrote %s (%d trusted vehicle frame(s))", output_path, len(output["vehicles"]))
    return 0


def _resolve_input(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit)
    for candidate in DEFAULT_INPUT_CANDIDATES:
        path = Path(candidate)
        if path.is_file():
            log.info("--input not given; using %s", path)
            return path
    raise FileNotFoundError(
        "no input capture found; looked for: " + ", ".join(DEFAULT_INPUT_CANDIDATES) + " (pass --input PATH)"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="main_parser.py",
        description="Validate a local Blue Energy capture and export trusted vehicle telemetry JSON.",
    )
    parser.add_argument("--input", default=None, help="raw capture (default: %(default)s -> uploads/)")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="trusted JSON destination (default: %(default)s)")
    parser.add_argument(
        "--timezone",
        default=None,
        help="IANA zone for naive upstream timestamps (default: Settings.source_timezone, Asia/Kolkata)",
    )
    parser.add_argument(
        "--require-all-fields",
        action="store_true",
        help="quarantine any vehicle missing a parameter -- NOT for the current 15-of-24 upstream",
    )
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-8s %(name)-14s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        stream=sys.stdout,
    )

    if args.timezone:
        tz = ZoneInfo(args.timezone)
    else:
        # Architecture-faithful default: the same SOURCE_TIMEZONE the extractor
        # uses, so this stage and the DB stage can never disagree about IST.
        from telemetry.config import Settings

        tz = Settings().tz

    try:
        input_path = _resolve_input(args.input)
        return run(
            input_path,
            Path(args.output),
            tz=tz,
            require_all_fields=args.require_all_fields,
        )
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        log.error("%s", exc)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())