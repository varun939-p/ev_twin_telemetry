"""Field mapping diagnostics.

The upstream may rename keys, add keys, or -- because a client can be
field-restricted in the Administration tab -- silently omit keys.  None of those
should crash the engine, but all of them should be *visible*, because a silently
missing `soh` is exactly the kind of gap that turns into a wrong dashboard six
weeks later.

`audit_frame` returns, for one raw frame:
    present  -- canonical names we found (under any alias)
    missing  -- canonical names with no alias present at all
    unknown  -- upstream keys we do not recognise (possible rename or new field)

The extractor logs the unknown/missing sets once per distinct shape, not per
vehicle, so a 200-truck fleet produces one warning instead of two hundred.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from .fields import ALIAS_TO_NAME, META_FIELDS, PARAM_SPECS

log = logging.getLogger(__name__)


@dataclass(slots=True)
class FrameAudit:
    present: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    unknown: list[str] = field(default_factory=list)

    @property
    def coverage(self) -> float:
        return len(self.present) / len(PARAM_SPECS) if PARAM_SPECS else 1.0

    def shape_key(self) -> str:
        """Stable signature of the payload's shape, for log de-duplication."""
        return f"{len(self.present)}/{len(PARAM_SPECS)}|{','.join(sorted(self.missing))}|{','.join(sorted(self.unknown))}"


def audit_frame(frame: dict[str, Any]) -> FrameAudit:
    audit = FrameAudit()
    seen_keys = {str(k).lower() for k in frame}

    for spec in PARAM_SPECS:
        if any(alias.lower() in seen_keys for alias in spec.aliases):
            audit.present.append(spec.name)
        else:
            audit.missing.append(spec.name)

    for key in frame:
        lowered = str(key).lower()
        if lowered in ALIAS_TO_NAME or lowered in META_FIELDS:
            continue
        audit.unknown.append(str(key))

    return audit


class DriftReporter:
    """Log each distinct payload shape exactly once."""

    def __init__(self) -> None:
        self._seen: set[str] = set()
        self.last: FrameAudit | None = None

    def observe(self, vehicle_id: str, frame: dict[str, Any]) -> FrameAudit:
        audit = audit_frame(frame)
        self.last = audit
        key = audit.shape_key()
        if key in self._seen:
            return audit
        self._seen.add(key)

        log.info(
            "payload shape (first seen via %s): %d/%d parameters present",
            vehicle_id,
            len(audit.present),
            len(PARAM_SPECS),
        )
        if audit.missing:
            log.warning(
                "upstream payload is missing %d parameter(s): %s -- "
                "either the API client is field-restricted, or the key names differ. "
                "Add the real key to `aliases` in telemetry/fields.py.",
                len(audit.missing),
                ", ".join(audit.missing),
            )
        if audit.unknown:
            log.warning(
                "upstream payload has %d unrecognised key(s): %s -- "
                "possible rename or new parameter; map it in telemetry/fields.py to capture it.",
                len(audit.unknown),
                ", ".join(audit.unknown),
            )
        return audit
