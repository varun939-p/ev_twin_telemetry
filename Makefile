# EV Battery Swap Station Digital Twin -- one repository, two runtimes
#
#   make setup     create the venv and install Python dependencies
#   make mock      start the stand-in upstream API (terminal 1)
#   make initdb    create tables + indexes (incl. the migration block)
#   make run       start the extraction loop (long-lived deployments)
#   make api       start the control plane (what Vercel's cron/render call)
#   make web       start the Next.js dashboard in dev mode
#   make test      run the suite (needs TEST_DATABASE_URL for the SQL tests)
#   make check     end-to-end pre-flight of the serverless request flow

PY      ?= python3
VENV    ?= .venv
BIN      = $(VENV)/bin
PG_URL  ?= postgresql+psycopg://postgres:postgres@127.0.0.1:5432/twin

.DEFAULT_GOAL := help
.PHONY: help setup mock initdb schema fields once run api web devstack web-build test check smoke lint clean

help: ## show this help
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

setup: ## create .venv and install requirements
	$(PY) -m venv $(VENV)
	$(BIN)/pip install --upgrade pip
	$(BIN)/pip install -r requirements.txt

mock: ## run the mock upstream API on :8899
	$(BIN)/python -m telemetry mock-server --port 8899 --vehicles 8 --all-fields

initdb: ## create tables + indexes and reconcile columns
	$(BIN)/python -m telemetry init-db

schema: ## print the PostgreSQL DDL (paste into an Alembic revision)
	$(BIN)/python -m telemetry schema

fields: ## print the 24-parameter mapping table
	$(BIN)/python -m telemetry fields

once: ## run one extraction cycle
	$(BIN)/python -m telemetry once

run: ## run the continuous extraction loop (dedicated server / Docker)
	$(BIN)/python -m telemetry run

api: ## run the control plane on :8000 (same app Vercel mounts as api/index.py)
	$(BIN)/python -m uvicorn telemetry.main:app --host 0.0.0.0 --port 8000 --reload

web: ## run the Next.js dashboard in dev mode (rewrites /api to the control plane)
	npm run dev

devstack: ## ONE command: real local PostgreSQL + replay data + control plane + polling worker + dashboard
	npm run dev:all

web-build: ## production build of the dashboard
	npm run build

test: ## run the test suite (PostgreSQL tests need TEST_DATABASE_URL)
	TEST_DATABASE_URL=$(PG_URL) PYTHONPATH=. $(BIN)/python -m pytest

check: ## end-to-end pre-flight: rewrite -> function -> upstream -> store -> document
	PYTHONPATH=. $(BIN)/python tools/serverless_check.py

smoke: ## end-to-end smoke test: mock upstream -> engine -> PostgreSQL
	PYTHON=$(BIN)/python DATABASE_URL=$(PG_URL) bash tools/smoke_test.sh

clean:
	rm -rf .pytest_cache **/__pycache__ .next
