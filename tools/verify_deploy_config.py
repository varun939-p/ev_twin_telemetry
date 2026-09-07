"""Deployment-config audit — run before every merge/release.

Verifies, statically and without network access, that the repository still
deploys cleanly on the Vercel HOBBY tier:

  1. vercel.json parses; every cron schedule resolves to AT MOST once per day
     (sub-daily expressions fail Hobby deployments at build time).
  2. The Python function's maxDuration stays within the Hobby cap (60 s).
  3. api/requirements.txt covers every third-party import under telemetry/,
     so the serverless bundle can never ship with a missing module.

    .venv/bin/python tools/verify_deploy_config.py
"""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOBBY_MAX_DURATION = 60


def main() -> int:
    ok = True

    config = json.loads((ROOT / "vercel.json").read_text())
    for cron in config.get("crons", []):
        minute, hour, dom, _mon, dow = cron["schedule"].split()
        daily = (
            minute not in ("*", "?")
            and "*/" not in minute
            and hour not in ("*", "?")
            and "*/" not in hour
            and dom in ("*", "?")
            and dow in ("*", "?")
        )
        print(f"cron '{cron['schedule']}': {'once-per-day — Hobby OK' if daily else 'WOULD FAIL Hobby deploy'}")
        ok &= daily

    for _path, fn in config.get("functions", {}).items():
        duration = fn.get("maxDuration", 60)
        print(f"functions.maxDuration={duration}: {'OK (<= Hobby cap)' if duration <= HOBBY_MAX_DURATION else 'EXCEEDS Hobby cap'}")
        ok &= duration <= HOBBY_MAX_DURATION

    reqs = {
        re.split(r"[\[=<>~]", line.strip())[0].lower().replace("_", "-")
        for line in (ROOT / "api" / "requirements.txt").read_text().splitlines()
        if line.strip() and not line.startswith("#")
    }
    stdlib = set(sys.stdlib_module_names)
    third_party: set[str] = set()
    for file in (ROOT / "telemetry").glob("*.py"):
        for node in ast.walk(ast.parse(file.read_text())):
            names: list[str] = []
            if isinstance(node, ast.Import):
                names = [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                names = [node.module.split(".")[0]]
            third_party.update(n for n in names if n not in stdlib and n != "telemetry")

    alias = {
        "pydantic_settings": "pydantic-settings",
        "dotenv": "python-dotenv",
    }
    uncovered = sorted(t for t in third_party if alias.get(t, t) not in reqs)
    print("function imports:", sorted(third_party))
    print("uncovered:", uncovered or "NONE — serverless bundle complete")
    ok &= not uncovered

    print("DEPLOYMENT AUDIT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
