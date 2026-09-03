# Dashboard Parameters API — Usage Guide

> **Migration notice (2026-09-03, rev 2 — live two-tier contract).**
> `GET /api/dashboard-parameters`, described throughout this document, is
> **retired and blocked**. The live contract, verified against production via
> Postman, is **two-tier**:
>
> * **Tier 1 — `GET https://track.blueenergymotors.com/api/v1/vehicles`**
>   returns a high-level fleet summary. Each vehicle frame carries the
>   operational keys (SOC, odometer, speed, GPS, `last_updated`) and an
>   explicit `"battery": null`.
> * **Tier 2 — `GET /api/v1/vehicles/{vehicle_id}`** (e.g. `M456D745`) returns
>   the complete live diagnostic frame, including the battery block, under the
>   **abbreviated v1 keys**: `batt_v`, `chg_status`, `batt_temp`, `batt_a`,
>   `tot_power_kwh`, `max_cell_no`, `min_pack_no`, `min_cell_no`,
>   `max_t_pack`, `work_sts`.
>
> The engine fetches tier 1 once per poll, then tier 2 concurrently per
> vehicle (`Settings.detail_fetch_enabled`, `detail_fetch_workers`) and merges
> the frames before validation. The alias table lives in
> `telemetry.fields.PARAM_SPECS`; unknown keys are reported by the drift
> reporter, so a future rename is a one-line alias addition. A parameter is
> stored `NULL` only when no alias appears anywhere in the merged frame —
> nothing is pinned, nothing is defaulted to zero. The text below is the
> vendor's original guide, kept verbatim for authentication, the response
> envelope and the error table — substitute the v1 paths in any `curl` you
> copy from it.

Machine/API access to fleet dashboard data, authenticated with a secret key + passcode (separate from the browser username/password login).

## 1. Get API credentials (admin step)

Until the Administration UI section for this is built, create a client directly via the admin endpoint:

```bash
curl -X POST http://<server>/api/admin/api-clients \
  -H "Content-Type: application/json" \
  -d '{"name": "Fleet Ops Script", "customer": "GreenLine", "enabled": true}'
```

- `customer`: a key from `Configuration/customer_regs.json` (e.g. `"GreenLine"`). Leave blank/omit for an unrestricted client that sees the whole fleet.
- Response (only time the passcode is ever shown):

```json
{
  "ok": true,
  "client": {
    "client_id": "a1b2c3d4e5f6...",
    "name": "Fleet Ops Script",
    "secret_key": "sk_9f8e7d6c5b4a...",
    "passcode": "Xk3mQp9Lz2Rw",
    "customer": "GreenLine",
    "enabled": true,
    "created_at": "2026-08-21T10:15:00+00:00"
  }
}
```

**Save the `secret_key` and `passcode` now** — the passcode is never retrievable again. If lost, regenerate it:

```bash
curl -X POST http://<server>/api/admin/api-clients/<client_id>/regenerate-passcode
```

Other admin management calls:

```bash
# List all clients (passcodes never included)
curl http://<server>/api/admin/api-clients

# Disable a client — revokes all its outstanding tokens immediately
curl -X POST http://<server>/api/admin/api-clients/<client_id>/toggle

# Permanently remove a client
curl -X DELETE http://<server>/api/admin/api-clients/<client_id>
```

## 2. Exchange credentials for a token

```bash
curl -X POST http://<server>/api/auth/api-token \
  -H "Content-Type: application/json" \
  -d '{"secret_key": "sk_9f8e7d6c5b4a...", "passcode": "Xk3mQp9Lz2Rw"}'
```

Response:

```json
{
  "ok": true,
  "token": "3f2a9c...(128 hex characters)...b71d",
  "token_type": "Bearer",
  "expires_in": 3540
}
```

The token is valid for **59 minutes** (`expires_in` is seconds). It's a random opaque string — a new, unique value every time you request one, never reused.

## 3. Call the dashboard API

```bash
curl "http://<server>/api/dashboard-parameters?date=2026-08-21" \
  -H "Authorization: Bearer 3f2a9c...b71d"
```

Optional query params:

| Param     | Description                                              |
|-----------|------------------------------------------------------------|
| `date`    | `YYYY-MM-DD`, defaults to today (IST)                     |
| `vehicle` | Substring filter on top of whatever your client is already scoped to |

Response shape:

```json
{
  "ok": true,
  "summary": {
    "segments": [ /* ... EV Dashboard segments, scoped to caller ... */ ],
    "overall": { /* ... */ },
    "low_soc_alerts": [ /* ... */ ],
    "soh_drop_alerts": [ /* ... */ ]
  },
  "vehicles": {
    "AP39WG5383": {
      "last_updated": "2026-08-21 10:14:52",
      "soc": 78,
      "soh": 96.5,
      "odo": 41230,
      "residual_mileage": 114,
      "cycles": 312,
      "batt_temp": 34,
      "min_cell_v": 3.31,
      "max_cell_v": 3.36,
      "speed": 0,
      "regen_kwh": 12.4
    },
    "AP39WH5376": { "...": "..." }
  }
}
```

`residual_mileage` is the same physics-accurate rolling-average figure the "Res Mileage" badge on the vehicle cards shows — not the raw ECU estimate.

## 4. Scoping — automatic, no extra param needed

- A client created with a `customer` gets only that customer's vehicles in `vehicles`, and `summary` is restricted to the EV Dashboard segments those vehicles belong to.
- A client created with no `customer` sees the full fleet.
- A client can also be limited to a specific set of per-vehicle fields (e.g. only `soc` and `residual_mileage`) — configured per client in the Administration tab's API Access section. Leaving every field unchecked there means "no restriction — every field."

## 5. Token expiry

A `401` response with `"auth": "required"` means your token expired or is missing — repeat step 2 to get a fresh one. There is no refresh endpoint by design; re-authenticating with the secret key + passcode *is* the refresh.

## 6. Error responses

| Status | Meaning                                    |
|--------|---------------------------------------------|
| 400    | Bad `date` format                           |
| 401    | Missing/invalid/expired token, or bad secret key + passcode |
| 403    | Admin-only endpoint called without admin access |
| 500    | Server-side error (see server logs)         |

## Endpoint reference

| Method | Path                                                | Purpose                              |
|--------|------------------------------------------------------|---------------------------------------|
| POST   | `/api/auth/api-token`                                | Exchange secret key + passcode for a token |
| GET    | `/api/v1/vehicles`                                   | Fleet summary (tier 1; `battery: null`) |
| GET    | `/api/v1/vehicles/{vehicle_id}`                      | Live per-vehicle diagnostics (tier 2; battery block, v1 keys) |
| GET    | `/api/admin/api-clients`                             | List API clients                     |
| POST   | `/api/admin/api-clients`                             | Create an API client                 |
| POST   | `/api/admin/api-clients/<client_id>/regenerate-passcode` | Issue a new passcode              |
| POST   | `/api/admin/api-clients/<client_id>/toggle`          | Enable/disable a client              |
| DELETE | `/api/admin/api-clients/<client_id>`                 | Delete a client                      |

