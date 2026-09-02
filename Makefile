# EV Battery Swap Station Digital Twin -- telemetry extraction engine
#
#   make setup     create the venv and install dependencies
#   make mock      start the stand-in upstream API (terminal 1)
#   make initdb    create tables + indexes
#   make run       start the extraction loop (terminal 2)
#   make test      run the suite (needs TEST_DATABASE_URL for the SQL tests)

PY      ?= python3
VENV    ?= .venv
BIN      = $(VENV)/bin
PG_URL  ?= postgresql+psycopg://postgres:postgres@127.0.0.1:5432/twin

.DEFAULT_GOAL := help
.PHONY: help setup mock initdb schema fields once run test smoke lint clean

help: ## show this help
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

setup: ## create .venv and install requirements
	$(PY) -m venv $(VENV)
	$(BIN)/pip install --upgrade pip
	$(BIN)/pip install -r requirements.txt

mock: ## run the mock upstream API on :8899
	$(BIN)/python -m telemetry mock-server --port 8899 --vehicles 8 --all-fields

initdb: ## create tables and indexes
	$(BIN)/python -m telemetry init-db

schema: ## print the PostgreSQL DDL (paste into an Alembic revision)
	$(BIN)/python -m telemetry schema

fields: ## print the 24-parameter mapping table
	$(BIN)/python -m telemetry fields

once: ## run one extraction cycle
	$(BIN)/python -m telemetry once

run: ## run the continuous extraction loop
	$(BIN)/python -m telemetry run

test: ## run the test suite (PostgreSQL tests need TEST_DATABASE_URL)
	TEST_DATABASE_URL=$(PG_URL) PYTHONPATH=. $(BIN)/python -m pytest

smoke: ## end-to-end smoke test: mock upstream -> engine -> PostgreSQL
	PYTHON=$(BIN)/python DATABASE_URL=$(PG_URL) bash tools/smoke_test.sh

clean:
	rm -rf .pytest_cache **/__pycache__
