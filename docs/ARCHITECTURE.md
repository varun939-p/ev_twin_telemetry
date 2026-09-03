# Phase 1 — Architecture & Schema Design

Telemetry extraction engine for an EV Battery Swap Station Digital Twin.
Source: `GET /api/v1/vehicles` → PostgreSQL → dashboard.

---

## 1. The four decisions that shape everything else

### 1.1 Split the snapshot from the history

The single most common mistake in this kind of engine is one wide table that is
both "the current state" and "the history". It forces the dashboard to run a
`DISTINCT ON (vehicle_id) ... ORDER BY vehicle_id, observed_at DESC` over the
entire history on every page load — a query whose cost grows forever, and which
will be the thing that dies on the day someone opens the dashboard during an
incident.

Three tables instead:

| Table | Grain | Role | Write pattern |
|---|---|---|---|
| `vehicles` | one row per vehicle id | dimension: first/last seen, ingest count | upsert on `vehicle_id` |
| `vehicle_state` | one row per vehicle | **the dashboard's read model** | upsert on `vehicle_id` |
| `telemetry` | one row per (vehicle, reading) | history, trends, SOH curves, audits | append + dedupe |

The dashboard reads `SELECT * FROM vehicle_state` — O(fleet size), constant,
indexed, no sort. History is written once and never read on the hot path.

`vehicle_state.vehicle_id` is the **primary key**, not a surrogate. That makes
the 1:1 guarantee a database constraint instead of an application convention,
and it makes the upsert conflict target a single column.

### 1.2 The upsert must be anti-regression, not just idempotent

Telemetry arrives out of order — that is normal, not exceptional. A naive
`ON CONFLICT DO UPDATE` lets a delayed frame overwrite a fresher one, and the
dashboard then shows a truck that went backwards in time.

So the snapshot upsert carries a `WHERE` clause evaluated *inside* the
statement, where no concurrent writer can slip between a read and a write:

```sql
INSERT INTO vehicle_state (...) VALUES (...)
ON CONFLICT (vehicle_id) DO UPDATE SET ...
WHERE (vehicle_state.last_updated IS NULL
       OR excluded.last_updated IS NULL
       OR excluded.last_updated >= vehicle_state.last_updated)
  AND (vehicle_state.odometer_km   IS NULL OR excluded.odometer_km   IS NULL
       OR excluded.odometer_km   >= vehicle_state.odometer_km)
  AND (vehicle_state.charge_cycles IS NULL OR excluded.charge_cycles IS NULL
       OR excluded.charge_cycles >= vehicle_state.charge_cycles);
```

Two rules, both from real ECU behaviour:

* **Timestamp rule** — a frame older than what we hold does not move the snapshot.
* **Monotonic counter rule** — `odometer_km` and `charge_cycles` never decrease.
  A rolled-back ECU or a swapped controller must not lower the odometer we show
  the customer, even when it arrives with a *newer* timestamp.

Rejected frames are still archived in `telemetry`. They are real observations;
they are simply not the latest truth.

**Verified:** `tests/test_repository.py::test_stale_frame_cannot_regress_the_snapshot`
and `::test_monotonic_counters_cannot_go_backwards_even_with_a_newer_timestamp`
run this against a live PostgreSQL.

### 1.3 One transaction per poll cycle, three statements

A cycle is: upsert `vehicles`, upsert `vehicle_state`, append `telemetry`. All
three in one transaction, using multi-`VALUES` upserts rather than per-row ORM
`merge()` calls (which would be 2N round trips under a lock).

Consequences worth having:

* A cycle is atomic — a crash mid-cycle leaves no half-written fleet.
* The whole cycle is idempotent — replaying it changes nothing, because the
  conflict targets and the `WHERE` clause make it a no-op.
* A 200-truck fleet is 3 statements, not 600.

### 1.4 Rotate the token between cycles, never during one

See §3 — this is the requirement most likely to lose data if done the obvious way.

---

## 2. Folder structure

Not a script. Every module has one reason to change, and the dependency graph is
a straight line — no cycles, and nothing in `telemetry/` imports from `tests/`
or `tools/`.

```
telemetry/
├── fields.py          THE 24-PARAMETER REGISTRY (single source of truth)
├── config.py          env-driven settings (pydantic-settings); no literals
├── exceptions.py      retryable vs fatal — the classification that drives policy
├── schemas.py         Pydantic: raw JSON -> validated frames (quarantine included)
├── api.py             HTTP only: retry, backoff, error classification
├── auth.py            token lifecycle: 55-min proactive rotation
├── mapping.py         drift detection: missing / unrecognised upstream keys
├── extractor.py       ONE cycle: fetch -> validate -> write
├── orchestrator.py    the loop: scheduling, backoff, signals, health
├── metrics.py         Prometheus text exposition (stdlib only)
├── logging_setup.py   human or JSON logs
├── models.py          SQLAlchemy 2.0 typed ORM (3 tables + indexes)
├── repository.py      ALL SQL lives here; the only place upserts are built
└── __main__.py        CLI: run | init-db | schema | once | fields | mock-server

tests/                 94 tests (66 run without a DB): registry, validation,
                       rotation, retry, upserts, mock fidelity, end-to-end loop
tools/mock_server.py   a faithful stand-in for the upstream API
tools/smoke_test.sh    mock upstream -> engine -> PostgreSQL, end to end
deploy/schema.sql      the DDL PostgreSQL actually runs (generated, not hand-typed)
docs/ARCHITECTURE.md   this document
```

**Why `fields.py` is the keystone.** The 24 parameters are declared once, with
their wire aliases, types, ranges and monotonicity. The Pydantic model, the ORM
columns and the upsert column lists are all *generated* from it. Renaming a
column or teaching the engine a new upstream alias is a one-line change in one
file — not a hunt through three modules that will inevitably drift apart.

**Why `repository.py` owns all SQL.** The upsert is the subtlest code in the
system. Confining it to one module means the rest of the engine can be tested
against SQLite while the SQL itself is tested against real PostgreSQL — which is
exactly how the test suite is split.

---

## 3. Token rotation: the 55-minute requirement

The upstream contract (`DASHBOARD_API_GUIDE.md` §2, §5):

* `POST /api/auth/api-token` → `{"token": "...", "expires_in": 3540}` — 59 minutes.
* There is **no refresh endpoint**. Re-authenticating *is* the refresh.
* Every token is a fresh, unique opaque string, never reused.
* `401` + `"auth": "required"` means the token died.

The naive implementation — cache a token, retry on 401 — loses data in three
ways: a poll that starts at minute 58:50 straddles the expiry; a retry after
re-auth may land outside the polling window; and if re-auth itself fails the
engine has no bounded behaviour.

So rotation is **proactive and bounded**:

```
refresh_at = obtained_at + min(TOKEN_REFRESH_INTERVAL,          # 3300 s = 55 min
                               expires_in - SAFETY_MARGIN)       # 3540 - 240 = 3300 s
```

* Rotation happens at the **top of a cycle**, never mid-request. No poll can
  straddle the expiry boundary, because 4 minutes of headroom always remain.
* `min()` means that if the server ever shortens `expires_in`, we follow it
  automatically instead of drifting past a new deadline.
* A **reactive backstop** remains for clock skew and for the admin `toggle`
  endpoint, which revokes outstanding tokens immediately: on a 401 the engine
  re-authenticates and retries the *same* poll **exactly once**, so that poll
  still lands.
* If a *freshly minted* token is also rejected, that is not an expiry — it is bad
  credentials or a disabled client. The engine raises `AuthRejectedError`, backs
  off for 5 minutes, and does **not** hammer the auth endpoint. Retrying a bad
  passcode every 60 s is how an API client gets disabled.

**Verified:** `tests/test_auth.py` drives a fake clock (no 55-minute sleeps) and
`tests/test_loop_e2e.py::test_revoked_token_recovers_without_losing_the_cycle`
revokes every token mid-run against a live mock upstream, then asserts exactly
one re-authentication, zero failed cycles, and that the retried poll was still
written to PostgreSQL.

---

## 4. Indexing

Every index exists because a specific query needs it. The indexes that *aren't*
there matter as much as the ones that are — each one is a tax on every insert,
and this table is insert-heavy by nature.

### `vehicle_state` (the dashboard's hot path)

| Index | Serves |
|---|---|
| `PRIMARY KEY (vehicle_id)` | the upsert conflict target; single-vehicle lookup |
| `ix_vehicle_state_charging (charging_status) WHERE charging_status = 1` | **partial index** — "who is charging right now?" over 2 vehicles, not the fleet |
| `ix_vehicle_state_last_updated (last_updated)` | staleness sweep: which trucks stopped reporting |
| `ix_vehicle_state_soc`, `ix_vehicle_state_soh` | low-SOC alerts / worst-SOH health board |

### `telemetry` (history)

| Index | Serves |
|---|---|
| `UNIQUE (vehicle_id, observed_at)` | dedupe key **and** the upsert conflict target; also serves "vehicle X, newest first" |
| `ix_telemetry_observed_at` | retention sweeps, cross-fleet time-range scans |

A separate `(vehicle_id, observed_at)` index is deliberately **not** created: it
would be a byte-for-byte duplicate of the btree PostgreSQL builds for the unique
constraint.

### Later, when history is large (not now)

At ~1 row/vehicle/minute, a 200-truck fleet writes ~105M rows/year. When that
starts to hurt:

1. **Partition `telemetry` by range on `observed_at`** (monthly). Retention
   becomes `DROP TABLE` instead of a multi-hour `DELETE`, and time-range scans
   prune partitions. This is the single highest-value change.
2. **Add a BRIN index on `observed_at`** — history is written in near-perfect
   time order, so BRIN gives ~1000× smaller index for time-range scans.
3. **Consider TimescaleDB hypertables** if the dashboard starts doing heavy
   time-bucket aggregation; otherwise plain partitioning is enough.

Do not add these on day one. An over-indexed insert-heavy table is slower than an
under-indexed one, and partitioning a table you can still `ALTER` cheaply is easy.

### Types, briefly

`NUMERIC(10,3)` for sensor readings the API sends with ≤3 decimals (exact, no
float drift in SOH trend lines), `DOUBLE PRECISION` for lat/long and energy
totals, `SMALLINT` for the 0/1 charging flag and cell numbers, `BIGINT` for
counters. `TIMESTAMPTZ` everywhere — see §5.

---

## 5. Timezone handling (silent data corruption, avoided)

The API returns `"last_updated": "2026-08-21 10:14:52"` — **naive**, and per the
guide's `date` parameter it is **IST**. Storing that as a naive `TIMESTAMP` and
later reading it as UTC shifts every reading by 5:30, which shows up as
impossible speed/energy deltas in the digital twin.

The engine parses the naive string with `SOURCE_TIMEZONE` (default
`Asia/Kolkata`), converts to UTC, and stores `TIMESTAMPTZ`. Both
`vehicle_state.last_updated` (source clock) and `telemetry.observed_at` (the
history key) are aware UTC. `ingested_at` records when *we* saw it — the
difference between the two is your end-to-end latency, for free.

---

## 6. Validation policy: never lose the fleet over one bad sensor

Three levels of failure, three different responses:

| Failure | Response | Why |
|---|---|---|
| One bad field (`soc: 480`, `"N/A"`, `""`) | field → `NULL`, logged as a `FieldError`, **row still written** | 23 good parameters beat 0 |
| One bad vehicle frame | quarantined in `rejected`, logged at ERROR, **fleet still written** | one broken ECU is not a fleet outage |
| Bad envelope / non-JSON / `ok: false` | cycle fails, backs off, retries next tick | nothing usable in it |

Sentinel strings (`""`, `"N/A"`, `"-"`, `"null"`) become `NULL` **and are
reported** — a truck that suddenly starts sending `N/A` is a fault you want to
see, not a value you want to silently swallow.

`REQUIRE_ALL_FIELDS=true` inverts this into strict mode: any frame missing any of
the 24 parameters is rejected outright. Default is `false`, because §7.

---

## 7. ⚠️ The gap you need to close: 14 of the 24 wire keys are not documented

**This is the one thing in this design that needs your input before go-live.**

`DASHBOARD_API_GUIDE.md` §3 shows a sample vehicle frame with **11 keys**:
`last_updated`, `soc`, `soh`, `odo`, `residual_mileage`, `cycles`, `batt_temp`,
`min_cell_v`, `max_cell_v`, `speed`, `regen_kwh`. That is 10 of your 24
parameters plus the timestamp.

The other **14 parameters are in your spec but not in the guide**:

| # | Parameter | Key the engine tries (in order) |
|---|---|---|
| 9 | Maximum Temperature | `max_temp_c`, `max_temp`, `temp_max`, `max_temperature` |
| 10 | Minimum Temperature | `min_temp_c`, `min_temp`, `temp_min`, `min_temperature` |
| 13 | Total Power Consumption | `total_power_kwh`, `total_power_consumption_kwh`, `power_kwh`, `energy_kwh` |
| 14 | Charging Status | `charging_status`, `charge_status`, `is_charging` |
| 15 | Battery Average Temperature | `battery_avg_temp_c`, `avg_temp`, `batt_avg_temp`, `battery_average_temp` |
| 16 | Battery Total Voltage | `battery_total_v`, `total_v`, `pack_v`, `batt_total_v`, `battery_voltage` |
| 17 | Battery Current | `battery_current_a`, `current_a`, `batt_current`, `pack_current_a` |
| 18 | Max Cell Voltage Cell Number | `max_cell_v_cell_no`, `max_cell_v_cell_number`, `max_v_cell_no` |
| 19 | Min Cell Voltage Battery Number | `min_cell_v_pack_no`, `min_cell_v_battery_number`, `min_v_pack_no` |
| 20 | Min Cell Voltage Cell Number | `min_cell_v_cell_no`, `min_cell_v_cell_number`, `min_v_cell_no` |
| 21 | Max Temperature Battery Number | `max_temp_pack_no`, `max_temp_battery_number`, `max_t_pack_no` |
| 22 | Vehicle Work Status | `work_status`, `vehicle_work_status`, `veh_work_status`, `workstate` |
| 23 | Latitude | `latitude`, `lat` |
| 24 | Longitude | `longitude`, `lon`, `lng` |

These are **educated guesses** following the guide's naming style (`batt_temp`,
`min_cell_v`), each with three or four plausible aliases. They are *not* verified.

### How the design contains the risk

1. **Nothing crashes.** Missing keys become `NULL`; unrecognised keys are
   ignored. The engine runs from day one on the 10 documented parameters.
2. **The gap is loud, not silent.** `mapping.py` logs, once per distinct payload
   shape: *"upstream payload is missing 14 parameter(s): ... either the API
   client is field-restricted, or the key names differ."* And for keys it does
   not recognise: *"possible rename or new parameter; map it in
   telemetry/fields.py."*
3. **Fixing it is one line.** Add the real key to that parameter's `aliases`
   tuple in `telemetry/fields.py`. The Pydantic model, the ORM and the upsert all
   pick it up automatically.

### To close it, run this against the real API

```bash
python -m telemetry once --dry-run
```

That prints every vehicle's accepted values, the `missing` list and any
`field_errors` — the exact diff between the guide and reality. Or just look at
one raw frame:

```bash
curl -s "$API_BASE_URL/api/v1/vehicles" \
  -H "Authorization: Bearer $TOKEN" | python -m json.tool | head -60
```

### One more scoping trap from guide §4

A client can be limited to a specific set of per-vehicle fields in the
Administration tab. If yours is, those columns will be permanently `NULL` no
matter what the keys are called. Check the client's field restriction before
chasing a naming mismatch — and leave `REQUIRE_ALL_FIELDS=false` if the client is
deliberately restricted.

---

## 8. Failure handling matrix

| Situation | Behaviour | Bounded? |
|---|---|---|
| 500 / 502 / 503 / 504 | exponential backoff, full jitter, up to `HTTP_MAX_RETRIES` | yes |
| Timeout / DNS / connection reset | same as above | yes |
| 400 (bad `date`), 403, 404 | **not retried** — `UpstreamClientError`, our request is wrong | yes |
| 401 on the data endpoint | re-auth, retry that poll **once** | yes |
| 401 with a fresh token | `AuthRejectedError`, 5-minute backoff, `CRITICAL` log | yes |
| Non-JSON / `ok: false` | cycle fails, next tick retries | yes |
| Empty `vehicles` object | warning (check scoping / `?date`), no failure | — |
| DB unreachable / deadlock | cycle fails, 30 s backoff, loop continues | yes |
| Anything unexpected | logged with traceback, cycle fails, **the loop never dies** | yes |

Full jitter (`random.uniform(0, base * 2**n)`) is deliberate: if you run more
than one extractor, synchronised retries would arrive at the upstream in lockstep
and turn a brown-out into an outage.

The loop's sleep is anchored to a wall-clock deadline, not `sleep(interval)`, so
a slow cycle cannot make the poll rate drift downwards over a 24-hour run — and
if a cycle *overruns* the interval, the schedule re-anchors instead of firing a
burst of catch-up polls.

---

## 9. Write amplification: parked trucks are free

A truck parked overnight reports an identical frame every 60 seconds. Archiving
each one is pure write amplification.

The extractor keeps a digest of the last reading per vehicle; when a frame is
byte-identical, `vehicles.last_seen` and `ingest_count` still advance ("we saw
it") but no snapshot or history row is written. On an idle fleet this removes the
large majority of writes. `WRITE_UNCHANGED=true` turns it off if you want a
guaranteed heartbeat row per poll.

Independently, `UNIQUE (vehicle_id, observed_at)` guarantees that a replayed
frame can never create a duplicate history row — so the optimisation is safe to
disable without risking duplicates.

---

## 10. Operations

* **Startup is fail-fast.** Missing env vars or a bad first authentication exit
  with code 2 immediately, rather than 60 seconds into a container restart loop.
* **`SIGTERM` finishes the in-flight cycle, commits, and exits 0** — so a
  Kubernetes rollout or `docker stop` never truncates a transaction.
* **`pool_pre_ping=True`** because the poller idles ~60 s between writes and
  Postgres (or the firewall in between) will drop that socket; pre-ping turns a
  03:00 `OperationalError` into a transparent reconnect.
* **Prometheus metrics** (`METRICS_ENABLED=true`) expose the one alert that
  matters: `twin_last_successful_cycle_timestamp_seconds`. If it stops advancing,
  you have a silent failure — which is the failure mode telemetry pipelines
  actually die from. Also `twin_cycles_failed_total`, `twin_vehicles_rejected_total`,
  `twin_auth_forced_total`, `twin_token_seconds_until_refresh`.
* **Credentials** come only from the environment; the DB URL is redacted in
  logs and a token is only ever logged as `6f02a7…49da(len=128)`.
* **Migrations:** `init-db` uses `create_all`, which is right for first boot and
  CI. Promote `deploy/schema.sql` into an Alembic revision before your second
  schema change, so migrations are reviewable and reversible.

---

## 11. What I would do in Phase 3

In rough order of value:

1. **Close the 14-key gap** (§7) — one `--dry-run` against the real API.
2. **Alembic** — before the first schema change, not after.
3. **Partition `telemetry` by month** — before it passes ~50M rows.
4. **A read API for the dashboard** (FastAPI over `vehicle_state` + a
   time-range endpoint over `telemetry`) so the frontend never holds a DB
   credential.
5. **A `charging_events` derived table** — the swap station cares about
   charge-start/stop transitions, and deriving them at ingest is far cheaper
   than re-deriving them per dashboard load.
6. **SOH trend alerting** — `soh_drop_alerts` already exists upstream; storing
   the delta locally makes it your own alert instead of theirs.
