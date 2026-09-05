# Digital Twin — frontend architecture

Reference for the internal review. Every path below is relative to `frontend/`.
The `@/` alias resolves to this directory.

---

## 1. What changed, in one paragraph

The old product was a two-tab viewer (`/`, `/trucks`, `/batteries`) built out of
static banner cards, a hand-rolled SVG India map and a blue-on-black theme. It
is gone. In its place is a single six-route **Digital Twin** application with a
persistent shell, a neutral high-contrast theme in both dark and light, a real
tile-based geographic map, and one shared state channel that makes the map, the
tables and the charts three views of the same selection. The 24-parameter
validated payload is passed through untouched — no page mutates, renames or
back-fills a field.

---

## 2. Route map

| Route | Depth | File |
| --- | --- | --- |
| `/` | redirect | `app/page.tsx` → `/digital-twin/central` |
| `/digital-twin/central` | **full** | `app/digital-twin/central/{page,central-view}.tsx` |
| `/digital-twin/truck-telemetry` | **full** | `app/digital-twin/truck-telemetry/{page,truck-telemetry-view}.tsx` |
| `/digital-twin/battery-tracking` | **full** | `app/digital-twin/battery-tracking/{page,battery-tracking-view}.tsx` |
| `/trucks`, `/batteries` | 308 | `next.config.mjs` → the routes above |
| `/digital-twin/{swap-station,chargers,dg}` | 307 | `next.config.mjs` → `/digital-twin/central` |

**There are exactly three pages.** Swap Station, Chargers and DG were removed
(routes deleted, sidebar entries deleted) — they are being built as a separate
workstream and will be re-integrated later. The redirects are **temporary
(307)** on purpose: those paths are coming back, and a 308 would be cached by
browsers and CDNs long after the real routes ship.

Every route follows the same split: `page.tsx` is a **server component** that
imports the trusted document and passes it down; `*-view.tsx` is the
**client component** that owns interaction. The 260 KB telemetry JSON is
therefore parsed on the server and never shipped as a raw asset.

---

## 3. Module inventory

### Shell and theme
| Path | Responsibility |
| --- | --- |
| `app/layout.tsx` | fonts (self-hosted Inter + JetBrains Mono), theme bootstrap script, metadata |
| `app/globals.css` | design tokens (`--surface`, `--ink`, `--accent`…), `.dark` variant, `@theme inline` bridge to Tailwind, keyframes |
| `app/fonts/*.woff2` | vendored variable faces — `next/font/local`, no build-time CDN fetch |
| `components/shell/AppShell.tsx` | sidebar + topbar + content grid, mobile drawer |
| `components/shell/Sidebar.tsx` | the expandable **Digital Twin** heading and its six children |
| `components/shell/ThemeToggle.tsx` | Light / Dark / System |
| `components/shell/LiveClock.tsx` | IST clock, `useSyncExternalStore`, hydration-safe |
| `lib/theme.tsx` | theme controller — subscribes to `localStorage` + `prefers-color-scheme` |
| `lib/persisted.ts` | `usePersistedBool`, same subscription pattern for UI flags |

### Domain logic (no JSX)
| Path | Responsibility |
| --- | --- |
| `lib/trusted-telemetry.ts` | **untouched.** Payload types, `PARAM_ORDER` (24), field status, geo helpers |
| `lib/fleet.ts` | filter model, `REGIONS`, `SOC_BRACKETS`, `SWAP_STATIONS`, battery registry, ETA maths |
| `lib/fleet-metrics.ts` | status derivation, `CoveredMetric` KPIs, alert taxonomy, table projections |
| `lib/map-data.ts` | map points, city clusters, the `ZOOM` ladder |
| `lib/site-model.ts` | the **only** modelled data in the app — facility simulation |
| `lib/document.ts` | server-only accessor for the trusted document |
| `lib/store.ts` | Zustand store: filters, hover pointer, selection pointer, camera intents |

### Feature components
| Path | Responsibility |
| --- | --- |
| `components/map/FleetMap.tsx` | SSR-safe wrapper (`next/dynamic`, `ssr:false`) — the only import site |
| `components/map/LeafletFleetMap.tsx` | Leaflet map, camera controller, clusters, markers, overlay chrome |
| `components/truck/TruckFilterBar.tsx` | EV/Non-EV · Region · State · City, sits above the table |
| `components/truck/TruckTable.tsx` | 6 vital fields, hover sync, `[Know More]`, `Battery ID` deep link |
| `components/truck/TruckDetailModal.tsx` | all 24 parameters, grouped, with `[X]` |
| `components/battery/BatteryKpiStrip.tsx` | the 4 required KPI cards |
| `components/battery/BatteryFilterBar.tsx` | swap station · region · SOC bracket |
| `components/battery/BatteryTable.tsx` | pack register, SOC < 20 % in red, `Carrier ID` deep link |
| `components/central/SiteCanvas.tsx` | isometric SVG site — road, 4 bays, crane, 2 chargers, DG, grid |
| `components/alerts/AttentionPanel.tsx` | grouped "Need Attention" banner, scoped per page |
| `components/ui/*` | Surface/Card, Pill, Modal, Field, InfoTip, Metric/KpiCard |

---

## 4. Data flow

### 4.1 Ingest → page

```
frontend/data/trusted_vehicle_telemetry.json
        │  (import, server side only)
        ▼
lib/document.ts ── TRUSTED_DOC ──► app/**/page.tsx        [server component]
                                        │  props
                                        ▼
                                  *-view.tsx              [client component]
                                        │
                    ┌───────────────────┼────────────────────┐
                    ▼                   ▼                    ▼
             truckRows()         batteryRows()         buildMapPoints()
          lib/fleet-metrics     lib/fleet-metrics       lib/map-data
```

`truckRows` / `batteryRows` are **projections**, not copies: each row keeps a
`vehicle` reference to the original `TrustedVehicle`, so `[Know More]` renders
the 24-parameter payload straight from the source object. Nothing in the render
path writes to it.

### 4.2 The shared channel — `lib/store.ts`

One Zustand store carries three kinds of state:

```
filters   { ev, geo{region,state,city}, soc, stationId, focus }   cross-page
pointers  hovered: {vehicleId, origin, seq} | null                cross-view
          selected:{vehicleId, origin, seq} | null
camera    flyTo {lat,lon,zoom,seq} | null,  fitNonce,  liveView   map only
```

`origin` (`"map" | "table"`) is what makes the hover sync **bi-directional
without a feedback loop**. A component reacts to a pointer only when the origin
is not its own:

```
pin hover  → hover(id,"map")   → TruckTable highlights + scrolls the row
row hover  → hover(id,"table") → the marker grows and opens a permanent tooltip
```

`seq` is a monotonic counter so that re-selecting the same asset is still a new
event (a second click on the same pin must re-fly the camera).

Selectors are narrow (`useIsHovered(id)`, `useIsSelected(id)`), so hovering a
row re-renders two rows and one marker — not the 100-row table.

### 4.3 Map ↔ table ↔ filters

```
                        ┌──────────────── lib/store.ts ─────────────────┐
                        │ filters · pointers · camera                    │
                        └───┬───────────────┬──────────────────┬─────────┘
             read filters   │               │ read pointers    │ read filters
                            ▼               ▼                  ▼
                   applyVehicleFilters   TruckTable       BatteryTable
                            │            (hover/select)    (Recharts series)
                            ▼
                   truckRows → buildMapPoints → buildCityClusters
                            │
                            ▼
                        FleetMap
                     ┌──────┴───────────────────────────────┐
   cluster click ────┤ setGeo{state,city} + setFocus         │→ filters change
   marker  click ────┤ select(id,"map") + requestFly(ZOOM.asset)
   marker  hover ────┤ hover(id,"map")
                     └───────────────────────────────────────┘
```

Because the filter state and the pointer state live in the same store, clicking
the **"Pune 29"** cluster does three things at once with no page-level glue:
the table filters to `State = Maharashtra, City = Pune`, the filter bar's
selects show those values, and the camera frames the city.

### 4.4 Camera policy (the deep-zoom fix)

The old map called `fitCamera` with a minimum span, which on a single asset
collapsed to the tightest possible view. The camera now has exactly three
inputs, all in `CameraController` inside `LeafletFleetMap.tsx`, and every one is
clamped by the `ZOOM` ladder in `lib/map-data.ts`:

| Trigger | Target | Zoom cap |
| --- | --- | --- |
| `fitNonce` — Exit Live View, Clear filters | bounds of everything in scope | `ZOOM.fleet` (5) |
| filtered scope changed | bounds of the new scope | `ZOOM.fleet + 1`, or `ZOOM.asset` (11) for a single asset |
| `flyTo` — pin / row / alert click | that coordinate | `ZOOM.asset` (11), hard-capped at `ZOOM.max` (15) |

Zoom 11 is roughly a 5 km radius: streets are legible and the surrounding
depot is still on screen. A scope change is ignored while `liveView` is on, so
a filter side-effect can never yank the camera off the truck being watched.
`[Exit Live View]` is a high-contrast overlay button, top-left, that clears the
selection and bumps `fitNonce`.

### 4.5 Deep links between pages

```
Truck table  Battery ID  → /digital-twin/battery-tracking?battery_id=<ID>
Battery table Carrier ID → /digital-twin/truck-telemetry?vehicle_id=<ID>
Central canvas bay          → /digital-twin/battery-tracking?battery_id=<ID>
Central canvas docking truck → /digital-twin/truck-telemetry?vehicle_id=<ID>
```

Each destination view reads the parameter with `useSearchParams()` inside a
`<Suspense>` boundary, resolves it to a row, and publishes
`select(id, "table")` — which is the same event a click would raise, so the
arriving page scrolls, highlights and (on the truck page) flies the camera
exactly as if the operator had done it by hand.

### 4.6 Filter options are derived from the data

`buildGeoIndex(vehicles)` in `lib/fleet.ts` walks the fleet once and returns
only the regions, states and cities that actually carry assets, each with a
count. Nothing in the dropdowns is hardcoded: the Region select currently
offers North·42 / West·41 / East·15 / South·2 and the State select offers the
7 states present, instead of the previous static list of 29 states of which 22
were empty. Counts are computed on the **unfiltered** fleet so options never
vanish mid-drill-down.

### 4.7 Live telemetry pipeline

```
vendor v1 API  ──►  main_parser.py  ──►  FastAPI            ──►  Next server        ──►  browser
(secret_key +       validates every     GET /api/telemetry/     lib/telemetry-          props only
 passcode)          frame, writes       trusted                 source.ts
                    the document
```

`lib/telemetry-source.ts` is the ONLY module that knows where telemetry comes
from. It is marked `server-only`, so importing it from a client component is a
build error rather than a leaked fleet credential — no telemetry variable is
`NEXT_PUBLIC_*` and the browser never talks to the vendor.

What it does per render (see `.env.example` for every variable):

1. exchanges `secret_key` + `passcode` for a 59-minute bearer token, cached
   in-process and retired 120s early, with concurrent exchanges de-duplicated;
2. fetches the validated document with an explicit abort budget;
3. structurally gates the payload, so a proxy error page or an HTML login
   redirect can never render as a fleet of zero trucks;
4. runs it through the same `normalizeDocument` the snapshot goes through;
5. on **any** failure returns the committed snapshot tagged
   `source: "snapshot"` with the reason.

The header chip states which of the two you are looking at — `Live · 100
frames · 10/24 · 42 h old` or `Snapshot`, with the failure reason in its
tooltip. An operator never has to guess whether the screen is current.

The segment is `force-dynamic`. Without it the rendering mode would depend on
whether credentials happen to be set (the uncached token POST opts into
dynamic rendering), which is the classic "works in staging, differs in prod"
trap. Data freshness still comes from the fetch-level `revalidate`, so every
concurrent viewer shares one upstream request.

### 4.8 The 24-parameter contract

`TelemetryParam` is derived from the `PARAM_ORDER` tuple, and `TelemetryValues`
is `Record<TelemetryParam, ParamValue>` — all 24 keys, required. A typo is a
compile error, and a compile-time assertion pins the tuple at exactly 24.

`normalizeVehicle()` (run once at the document boundary in `lib/document.ts`)
is the runtime half: it guarantees all 24 keys and a verdict per key whatever
the backend actually sends. Missing → `absent_upstream` + `null` (never `0`);
present-but-empty → `null_upstream`; listed in `field_errors` → `field_error`.
The backend measures 8 of 24 today; when it provisions the rest, the new keys
arrive as `measured` and every view populates with **no frontend change**,
because everything iterates `PARAM_ORDER` and reads `field_status`.

---

## 5. Honesty contract

The upstream v1 feed measures 8 of the 24 parameters. The dashboard never
papers over the other 16.

* `CoveredMetric<T>` in `lib/fleet-metrics.ts` returns `{value: null, reason}`
  when the channel that would compute it is absent. `KpiCard` renders `—` plus
  the reason. **A missing value is never rendered as `0`.**
* On Battery Tracking, *Batteries Charging Right Now* and *Current Running
  Load kW* are wired end to end but currently show "Awaiting upstream" —
  `charging_status`, `battery_total_v` and `battery_current_a` are absent on
  every frame. The moment the backend provisions them the cards light up with
  no UI change.
* Anything modelled rather than measured carries a `ModelBadge`. The only
  modelled module is `lib/site-model.ts` (bay charge progression, gun power,
  crane motion, DG state) and it is labelled everywhere it surfaces.
* Chargers, the DG and the grid feeder are drawn on the Central canvas as
  facility context but have **no** route and are deliberately **not
  clickable** — no `role="link"`, no pointer cursor. A control that looks
  interactive and does nothing is the fastest way to lose an operator's trust.

---

## 6. Alerting

`truckAlerts()` and `batteryAlerts()` are separate functions with separate
scopes — a pack anomaly cannot leak onto the carrier page, enforced by the data
source rather than by a filter someone might forget.

Two decisions worth flagging at review:

1. **Grouping.** A feed that is 40 h old produces ~100 identical "stale
   telemetry" rows. `AttentionPanel` groups by `AlertKind`, shows the three
   worst per group and collapses the rest behind "Show all N". A banner nobody
   scrolls is a banner nobody reads.
2. **Range shortfall is gated on motion and freshness.** The naive test
   (`range < distance to nearest hub`) flagged 64 of 100 carriers, because a
   parked truck 900 km from a hub is not stranded — it is simply parked. The
   alert now fires only when the carrier is moving *and* the frame is fresh.

---

## 7. Resilience notes for the demo

* **Fonts** are vendored (`app/fonts/`). `next/font/google` fetches at build
  time and fails on an air-gapped runner; that will not block a release.
* **Map tiles** come from the CARTO CDN. On the first `tileerror` the map
  lazily imports `data/india_states.json` and draws a vector basemap, so a
  blocked CDN degrades to real surveyed borders with live markers instead of a
  grey rectangle. The 300 KB file is not in the main bundle.
* **Leaflet** is loaded only through `components/map/FleetMap.tsx`
  (`ssr: false`) — it touches `window` at import time.
* `npm run build` → 8 routes, all statically prerendered. `tsc --noEmit` and
  `eslint` are clean, including React 19's `set-state-in-effect` and
  `refs`-during-render rules.

---

## 8. Known gaps

* Verified end to end against a stand-in control plane: unlocking
  `battery_total_v` and `charging_status` upstream moved the header chip from
  8/24 to 10/24 and flipped "Batteries charging right now" from *Awaiting
  upstream* to **20**, with no frontend change. "Current running load"
  correctly stayed `—`, because it also needs `battery_current_a`.
* Interaction is verified in a real headless Chromium, not just by SSR
  output: sidebar route set, Know More modal (24/24 parameters + close), the
  Battery-ID and canvas deep links, dataset-derived dropdown contents, and the
  camera ladder (fleet z5 → cluster z9 → asset z11 → Exit Live View z5).
* `POST /api/provision-site` is still proxied in `next.config.mjs` but no page
  calls it — the provisioning UI was part of the deleted legacy dashboard and
  needs a home if it is still wanted.
