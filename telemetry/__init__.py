"""EV Battery Swap Station Digital Twin -- telemetry extraction engine.

Package layout
--------------
    config.py     env-driven settings (no hard-coded credentials)
    fields.py     the 24-parameter registry (single source of truth)
    schemas.py    Pydantic validation of the upstream JSON
    api.py        HTTP transport: retry / backoff / 401 handling
    auth.py       Bearer token manager with 55-minute rotation
    mapping.py    raw frame -> ParsedVehicle, drift detection
    extractor.py  one poll cycle
    orchestrator.py  the continuous loop + signal handling
    metrics.py    Prometheus text exposition (optional)
    logging_setup.py
    db/           models + repository (all SQL lives here)
"""

__version__ = "1.0.0"
