"""Load a REAL captured extraction cycle into PostgreSQL — no synthetic data.

`live_capture.json` is the console capture of an ACTUAL engine run against the
Blue Energy upstream (2026-09-04, tier-1 `/api/v1/vehicles` + tier-2 detail
fetches, `"accepted": 100`). Embedded in it is the cycle's validated result:
one frame per vehicle in exactly the engine's `ParsedVehicle` shape
(`vehicle_id`, `observed_at`, `missing`, `field_errors`, `values` — all 24
parameters).

This tool takes those REAL validated frames and puts them through the REAL
storage path — `TelemetryRepository.write_cycle` (dimension + state upserts,
history append) — then records an honest `ingestion_runs` journal row with
``trigger="replay"`` and a summary that names the capture file and its newest
observation. Nothing is invented: absent channels stay absent, `observed_at`
stays the ORIGINAL capture timestamp (so the dashboard's freshness labels tell
the truth about data age), and the provenance chain in the served document
points at PostgreSQL exactly as in live operation.

    .venv/bin/python tools/replay_capture.py [capture.json]

Re-running is safe: state upserts converge and history dedupes on
(vehicle_id, observed_at).
"""

from __future__ import annotations

import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Make the repo package importable when run as a script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from telemetry.config import get_settings  # noqa: E402
from telemetry.db import build_engine, build_session_factory, init_schema  # noqa: E402
from telemetry.ingestion import cycle_payload  # noqa: E402
from telemetry.models import IngestionRun  # noqa: E402
from telemetry.repository import TelemetryRepository  # noqa: E402
from telemetry.schemas import ParsedVehicle  # noqa: E402

DEFAULT_CAPTURE = Path("live_capture.json")


def extract_result_json(raw: bytes) -> dict:
    """Pull the embedded cycle-result JSON out of a UTF-16 console capture.

    The capture is engine log output; the result object is the pretty-printed
    JSON block that starts at a line that is exactly ``{`` and ends at the
    matching last ``}`` block. We locate it structurally rather than by line
    numbers so the tool survives log-format drift.
    """
    text = raw.decode("utf-16")
    lines = text.splitlines()
    start = next(i for i, l in enumerate(lines) if l.strip() == "{")
    # The result block runs to the LAST line that is exactly "}" — later log
    # lines (if any) would follow the closing brace of the JSON object.
    end = max(i for i, l in enumerate(lines) if l.strip() == "}")
    return json.loads("\n".join(lines[start : end + 1]))


def main() -> int:
    capture = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_CAPTURE
    if not capture.exists():
        print(f"[replay] capture file not found: {capture}", file=sys.stderr)
        return 2

    result = extract_result_json(capture.read_bytes())
    frames = [
        ParsedVehicle(
            vehicle_id=v["vehicle_id"],
            observed_at=v.get("observed_at"),
            values=v.get("values") or {},
            field_errors=v.get("field_errors") or [],
            missing=v.get("missing") or [],
        )
        for v in result.get("vehicles", [])
    ]
    if not frames:
        print("[replay] capture contains no vehicle frames — nothing to do", file=sys.stderr)
        return 2

    newest = max((f.observed_at for f in frames if f.observed_at), default=None)
    print(
        f"[replay] {len(frames)} validated REAL frames "
        f"(newest observation: {newest.isoformat() if newest else 'n/a'})",
        file=sys.stderr,
    )

    settings = get_settings()
    engine = build_engine(settings)
    factory = build_session_factory(engine)
    init_schema(engine)

    started_at = datetime.now(timezone.utc)
    session = factory()
    try:
        run = IngestionRun(
            id=str(uuid.uuid4()), trigger="replay", started_at=started_at, status="running"
        )
        session.add(run)
        session.commit()

        write = TelemetryRepository(session).write_cycle(frames, ingested_at=started_at)
        session.flush()

        run.status = "success"
        run.finished_at = datetime.now(timezone.utc)
        run.summary = {
            "mode": "replay",
            "capture_source": capture.name,
            "capture_newest_observed_at": newest.isoformat() if newest else None,
            "seen": len(frames),
            "accepted": len(frames),
            "rejected": 0,
            "field_errors": sum(len(f.field_errors) for f in frames),
            "states_written": write.states_written,
            "history_written": write.history_written,
            "unchanged_skipped": write.skipped_unchanged,
            "stale_skipped": write.states_skipped_stale,
            "detail_ok": 0,
            "detail_failed": 0,
            "resolved_date": None,
            "date_source": "replay",
            "date_probes": 0,
            "date_probe_errors": 0,
            "missing_timestamps": sum(1 for f in frames if f.observed_at is None),
            "note": (
                "Replay of a REAL captured engine cycle. Live polling starts "
                "automatically once API_SECRET_KEY and API_PASSCODE are set in .env."
            ),
        }
        session.commit()

        print(f"[replay] journal: {json.dumps(cycle_payload(run))[:400]}", file=sys.stderr)
        total = session.execute(select(IngestionRun)).scalars().all()
        print(f"[replay] OK — {write.states_written} states, {write.history_written} history rows; "
              f"{len(total)} journal row(s).", file=sys.stderr)
        return 0
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
        engine.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
