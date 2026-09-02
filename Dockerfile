# Telemetry extraction engine -- slim, non-root, no build tools needed at runtime.
FROM python:3.13-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Install dependencies first so the layer is cached across code changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY telemetry ./telemetry
COPY tools ./tools

# Run as an unprivileged user; the container only makes outbound HTTP calls and
# writes to PostgreSQL.
RUN useradd --create-home --uid 10001 twin
USER twin

# Fail fast on SIGTERM instead of waiting for the default 10 s Docker grace period
# to escalate -- the loop finishes its in-flight cycle and exits 0.
STOPSIGNAL SIGTERM

# The engine is not a web server; expose the metrics port only when enabled.
EXPOSE 9464

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import os,sys; sys.exit(0 if os.environ.get('DATABASE_URL') else 1)"

ENTRYPOINT ["python", "-m", "telemetry"]
CMD ["run"]
