# EV Digital Twin Telemetry Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the EV Digital Twin telemetry frontend into a complete, 7-screen operational suite by expanding navigation, elevating the Central Dashboard (hero 3D canvas, dynamic scrollable site filter, unified alerts), eradicating map/tooltip bugs and z-index issues, reconciling truck counts, polishing active pages, and implementing four high-fidelity draft screens.

**Architecture:** Pure frontend architecture built on Next.js 16 App Router and React 19. All telemetry and data flows utilize the established server-component loading (`loadTelemetry`) and client-side Zustand store (`useTwin`). Zero backend or database files are touched.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5, Tailwind CSS 4, React-Leaflet, Zustand, Vitest.

**Spec:** `scratch/user_directive.txt`

## Global Constraints

- NEVER modify backend files (`api/`, `telemetry/`, Python files, database, cron or env files).
- ONLY modify frontend code (`app/`, `components/`, `lib/`).
- Preserve existing dark/cybernetic color scheme and typography (`bg-surface`, `text-ink`, `border-line`, etc.).
- Ensure `npm test` and `npm run build` pass with zero TypeScript and zero build errors.
- Ensure all interactive elements have working handlers (no dead buttons, no dead links).

---

### Task 1: Extend Sidebar Navigation & Opacity State Logic (Phase 1)

**Files:**
- Modify: `components/shell/Sidebar.tsx:26-155`
- Test: `tests/frontend/sidebar.test.tsx` (create new test)

**Interfaces:**
- Consumes: `usePathname()` from Next.js, `usePersistedBool()` from `@/lib/persisted`
- Produces: 7-item navigation rail (`NAV_ITEMS`) with visual opacity separation (`opacity-60` for items 4–7) and active draft transition.

- [ ] **Step 1: Write the failing test for 7-item Sidebar with opacity and draft badges**

```tsx
// tests/frontend/sidebar.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import Sidebar from "@/components/shell/Sidebar";

vi.mock("next/navigation", () => ({
  usePathname: () => "/digital-twin/central",
}));

describe("Sidebar navigation", () => {
  it("renders exactly 7 items in the correct order", () => {
    render(<Sidebar open={true} onNavigate={vi.fn()} />);
    const expected = [
      "Central Dashboard",
      "Battery Tracking",
      "Truck Telemetry",
      "Swap Station",
      "Charging Station",
      "DG",
      "Predictive Analysis",
    ];
    expected.forEach((label) => {
      expect(screen.getByText(label)).toBeDefined();
    });
  });

  it("marks items 4 through 7 with draft indicator or styling", () => {
    render(<Sidebar open={true} onNavigate={vi.fn()} />);
    const drafts = screen.getAllByText(/Draft/i);
    expect(drafts.length).toBeGreaterThanOrEqual(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frontend/sidebar.test.tsx`
Expected: FAIL with missing navigation items.

- [ ] **Step 3: Update `components/shell/Sidebar.tsx`**

Update `NAV_ITEMS` to include all 7 items:
1. Central Dashboard (`/digital-twin/central`)
2. Battery Tracking (`/digital-twin/battery-tracking`)
3. Truck Telemetry (`/digital-twin/truck-telemetry`)
4. Swap Station (`/digital-twin/swap-station`, `isDraft: true`)
5. Charging Station (`/digital-twin/charging-station`, `isDraft: true`)
6. DG (`/digital-twin/dg`, `isDraft: true`)
7. Predictive Analysis (`/digital-twin/predictive-analysis`, `isDraft: true`)

Apply conditional styling:
```tsx
const isDraft = item.isDraft;
const opacityClass = isDraft && !active ? "opacity-60 hover:opacity-100" : "opacity-100";
```
Render subtle `<span className="ml-auto rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider bg-surface-3 text-ink-3">Draft</span>` for draft items.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frontend/sidebar.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add components/shell/Sidebar.tsx tests/frontend/sidebar.test.tsx
git commit -m "feat(nav): expand sidebar to 7 items with draft state logic"
```

---

### Task 2: Global Ingestion Banner Purge (Step 2.1 & 10.1)

**Files:**
- Modify: `components/shell/AppShell.tsx:115-120`
- Test: `tests/frontend/ingestion-status.test.tsx`

**Interfaces:**
- Consumes: `AppShell` props
- Produces: Layout free of the disruptive Ingestion Overdue banner while maintaining underlying data flow.

- [ ] **Step 1: Check IngestionStatus render in `AppShell.tsx`**

Remove `<IngestionStatus health={ingestion} />` from the UI render in `components/shell/AppShell.tsx` while keeping `ingestion` in `AppShellProps` so internal contracts do not break.

- [ ] **Step 2: Verify `tests/frontend/ingestion-status.test.tsx` passes**

Run: `npx vitest run tests/frontend/ingestion-status.test.tsx`
Expected: PASS (component tests verify IngestionStatus itself works in isolation).

- [ ] **Step 3: Verify codebase search for overdue banners**

Grep for any remaining direct invocations of `IngestionStatus` in page layouts. Ensure none are rendered.

- [ ] **Step 4: Commit**

```bash
git add components/shell/AppShell.tsx
git commit -m "fix(ui): remove ingestion overdue banner globally from AppShell"
```

---

### Task 3: Map & GPS Bug Eradication (Phase 3)

**Files:**
- Modify: `components/map/LeafletFleetMap.tsx:375-440`
- Modify: `components/map/LeafletFleetMap.tsx:75-95` (z-index adjustments)
- Test: `tests/frontend/fleet-map.test.tsx`

**Interfaces:**
- Consumes: `points`, `clusters`, `cardTarget`
- Produces: Map rendering without rogue battery tooltip on individual vehicle marker hover, with correct z-index hierarchy and preserved cluster hovers.

- [ ] **Step 1: Write test in `tests/frontend/fleet-map.test.tsx` ensuring individual point hover does not render rogue battery card**

Add test checking that hovering over an individual vehicle point does not mount the rogue battery card with SOC/battery label.

- [ ] **Step 2: Update `HoverCard` in `components/map/LeafletFleetMap.tsx`**

Remove the `target.kind === "point"` battery-card branch in `HoverCard`:
```tsx
function HoverCard({ target }: { target: CardTarget | null }) {
  if (!target) return null;
  // Per directive: Eradicate rogue battery tooltip on Truck Telemetry map.
  // Individual marker hover tooltips displaying battery data must be gone entirely.
  if (target.kind === "point") return null;

  // Cluster-level hover (region name, carrier count, average SOC, load density) is preserved:
  const c = target.cluster;
  return (
    ...
  );
}
```

- [ ] **Step 3: Audit and enforce clean Z-index hierarchy**

Audit and align all map layers and controls:
- Tile layer and SVG panes: default
- Map controls (zoom, attribution): `z-[400]`
- Floating hover card: `z-[500]`
- Drawers / modals / popovers: `z-[600]` to `z-[1000]`
Ensure no controls bleed into header or dropdown menus.

- [ ] **Step 4: Run map tests to verify**

Run: `npx vitest run tests/frontend/fleet-map.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add components/map/LeafletFleetMap.tsx tests/frontend/fleet-map.test.tsx
git commit -m "fix(map): eradicate rogue battery tooltip and fix z-index hierarchy"
```

---

### Task 4: Central Dashboard Overhaul (Phase 2)

**Files:**
- Create: `components/central/SiteFilterBar.tsx`
- Modify: `components/central/SiteCanvas.tsx`
- Modify: `app/digital-twin/central/central-view.tsx`
- Test: `tests/frontend/central-view.test.tsx`

**Interfaces:**
- Consumes: `sites: SwapStation[]`, `stationId: string`, `onSelectSite: (id: string) => void`
- Produces:
  1. Horizontal scrollable tactile site filter with active badge & asset counts, defaulting to Pune.
  2. Hero 3D Site Canvas placed at the very top.
  3. Renamed KPI Metric Cards row placed directly below 3D canvas ("Trucks Incoming", "Batteries at Station", "Trucks on Road", "Low Battery Warning", "Data Freshness").
  4. Operational Panels and Inbound Queue.
  5. Unified "Need Attention" aggregate panel at bottom combining battery and truck anomalies.

- [ ] **Step 1: Create `components/central/SiteFilterBar.tsx`**

Build a horizontal, scrollable, tactile site filter bar:
- Smooth horizontal scroll buttons / scrollbar-hide
- Clear glowing active pill indicator
- Shows site name and asset count badge (e.g. "Pune (29)", "Rourkela (45)", etc.)
- Defaults to Pune or busiest site
- Accessible keyboard navigation

- [ ] **Step 2: Elevate `components/central/SiteCanvas.tsx`**

- Remove background clutter and set clean, dark framing.
- Wire all assets to their respective new routes:
  - Swap Station -> `/digital-twin/swap-station`
  - Charging Station -> `/digital-twin/charging-station`
  - DG -> `/digital-twin/dg`
  - Docked Truck -> `/digital-twin/truck-telemetry?vehicle_id=...`
- Add zoom/pan controls (Zoom In, Zoom Out, Reset View) with buttery-smooth transitions.
- Enhance visual fidelity with refined shadows, glows, and legible asset status badges.

- [ ] **Step 3: Restructure `app/digital-twin/central/central-view.tsx`**

Reorder layout hierarchy:
1. Header + `SiteFilterBar`
2. Hero `SiteCanvas` (card at top)
3. KPI Metric Cards row directly below canvas:
   - "Trucks Incoming" (`inbound.length`)
   - "Batteries at Station" (`sitePacks.length`)
   - "Trucks on Road" (`inService`)
   - "Low Battery Warning" (`belowReserve`)
   - "Data Freshness" (`medianAgeHours`)
4. Operational Panels (`FacilityPanels`)
5. Inbound Queue & Asset Drill-down rail
6. Unified `AttentionPanel` at bottom combining battery alerts (`batteryAlerts(vehicles, sites)`) and truck alerts (`truckAlerts(vehicles, sites)`).

- [ ] **Step 4: Write tests for Central Dashboard in `tests/frontend/central-view.test.tsx`**

Verify KPI renaming, site filter rendering, and layout order.

- [ ] **Step 5: Run tests to verify**

Run: `npx vitest run tests/frontend/central-view.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add components/central/SiteFilterBar.tsx components/central/SiteCanvas.tsx app/digital-twin/central/central-view.tsx tests/frontend/central-view.test.tsx
git commit -m "feat(central): overhaul central dashboard layout, hero 3D canvas, site filter, and unified attention panel"
```

---

### Task 5: Truck Telemetry Reconciliation & Polish (Phase 5)

**Files:**
- Modify: `app/digital-twin/truck-telemetry/truck-telemetry-view.tsx:90-145`
- Modify: `components/truck/TruckTable.tsx`
- Test: `tests/frontend/truck-reconciliation.test.tsx`

**Interfaces:**
- Consumes: `rows: TruckRow[]`
- Produces: 4 status categories ("Moving", "Charging", "Idle", "Standby / No Signal") summing to 106 total trucks.

- [ ] **Step 1: Write test for truck count reconciliation**

Verify that all 106 carriers are accounted for in the status breakdown:
`moving + charging + idle + unknown === rows.length`.

- [ ] **Step 2: Update `statusCounts` and status pills in `truck-telemetry-view.tsx`**

```tsx
const statusCounts = useMemo(() => {
  const c = { moving: 0, charging: 0, idle: 0, unknown: 0 };
  for (const r of rows) c[r.status] += 1;
  return c;
}, [rows]);
```
In `PageHeading` actions:
- Moving: `{statusCounts.moving} moving`
- Charging: `{statusCounts.charging} charging`
- Idle: `{statusCounts.idle} idle`
- Standby / No Signal: `{statusCounts.unknown} standby` (always rendered so sum equals total rows)
Display total summary: `{rows.length} total carriers`.

- [ ] **Step 3: Verify AttentionPanel is preserved on Truck Telemetry**

Ensure `AttentionPanel` remains prominently displayed below the map.

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run tests/frontend/truck-reconciliation.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/digital-twin/truck-telemetry/truck-telemetry-view.tsx tests/frontend/truck-reconciliation.test.tsx
git commit -m "feat(truck): reconcile 106 truck status counts and polish telemetry view"
```

---

### Task 6: Battery Tracking Polish & Interactivity (Phase 4)

**Files:**
- Modify: `app/digital-twin/battery-tracking/battery-tracking-view.tsx`
- Modify: `components/battery/BatteryTable.tsx`
- Test: `tests/frontend/battery-tracking.test.tsx`

**Interfaces:**
- Consumes: `vehicles: TrustedVehicle[]`, `registry`
- Produces: Polished battery tracking view with preserved AttentionPanel, clear human-readable column headers, and 100% functional clickables.

- [ ] **Step 1: Audit all column headers, filter chips, and badges**

Verify plain-English, self-explanatory wording.
Ensure sorting, modal opening, and row clicking work seamlessly.

- [ ] **Step 2: Verify AttentionPanel is intact**

Ensure `AttentionPanel` remains at the top of the battery page.

- [ ] **Step 3: Commit**

```bash
git add app/digital-twin/battery-tracking/battery-tracking-view.tsx
git commit -m "feat(battery): verify AttentionPanel and polish interactivity"
```

---

### Task 7: Swap Station Draft Screen (Phase 6)

**Files:**
- Create: `app/digital-twin/swap-station/page.tsx`
- Create: `app/digital-twin/swap-station/swap-station-view.tsx`
- Create: `components/station/SwapBayGrid.tsx`
- Test: `tests/frontend/swap-station.test.tsx`

**Interfaces:**
- Consumes: `data: TrustedTelemetryDocument`
- Produces: Complete, interactive draft screen for Pune Swap Station with sample data and 8-bay status grid.

- [ ] **Step 1: Create `app/digital-twin/swap-station/page.tsx`**

Server component loading telemetry and rendering `SwapStationView`.

- [ ] **Step 2: Build `swap-station-view.tsx` & `SwapBayGrid.tsx`**

Include:
- Header with "Draft view • Live integration pending" badge
- Site overview card: Pune Central Hub, operational status, 8-bay capacity, active power feed
- Visual representation of the swap bays and crane
- 8-bay slot grid: Bay ID (Bay 01 - 08), Battery ID (e.g. `BAT-PN-104`), SOC gauge (with color tiers), status (Charging / Ready for Swap / Cooling), ETA to full charge
- Operational summary: Daily swap count (e.g. 48 swaps completed today), Average swap duration (3.4 mins)
- Interactive sample detail modal when clicking a bay

- [ ] **Step 3: Write tests and verify**

Run: `npx vitest run tests/frontend/swap-station.test.tsx`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add app/digital-twin/swap-station/ components/station/ tests/frontend/swap-station.test.tsx
git commit -m "feat(swap-station): build high-fidelity swap station draft screen"
```

---

### Task 8: Charging Station Draft Screen (Phase 7)

**Files:**
- Create: `app/digital-twin/charging-station/page.tsx`
- Create: `app/digital-twin/charging-station/charging-station-view.tsx`
- Create: `components/charging/ChargerTable.tsx`
- Create: `components/charging/PowerUtilizationChart.tsx`
- Test: `tests/frontend/charging-station.test.tsx`

**Interfaces:**
- Consumes: `data: TrustedTelemetryDocument`
- Produces: Complete draft screen with charger overview cards, 6-charger details table, power consumption summary, and 24-hour utilization chart.

- [ ] **Step 1: Create `app/digital-twin/charging-station/page.tsx`**

Server component loading telemetry and rendering `ChargingStationView`.

- [ ] **Step 2: Build `charging-station-view.tsx` and components**

Include:
- Header with "Draft view • Live integration pending" badge
- Overview KPI cards: Total Chargers (6), Active Charging (4), Available (2), Under Maintenance (0)
- Charger details table: Gun ID, Type (DC Fast 120kW / AC 22kW), Status (Active / Idle), Connected Vehicle/Battery ID, Current SOC, Instantaneous Power (kW), ETA to 100%
- Power consumption card: Total Site Draw (340 kW), Grid Draw (290 kW), DG Draw (50 kW)
- 24-hour utilization visualization: Responsive SVG bar/timeline chart displaying hourly load profiles without external charting dependencies
- Interactive filters and detail clickables

- [ ] **Step 3: Write tests and verify**

Run: `npx vitest run tests/frontend/charging-station.test.tsx`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add app/digital-twin/charging-station/ components/charging/ tests/frontend/charging-station.test.tsx
git commit -m "feat(charging): build charging station draft screen with charger table and power charts"
```

---

### Task 9: Diesel Generator (DG) Draft Screen (Phase 8)

**Files:**
- Create: `app/digital-twin/dg/page.tsx`
- Create: `app/digital-twin/dg/dg-view.tsx`
- Create: `components/dg/DgUsageTable.tsx`
- Test: `tests/frontend/dg.test.tsx`

**Interfaces:**
- Consumes: `data: TrustedTelemetryDocument`
- Produces: DG draft screen with historical usage logs, P&L analysis, fuel tracking, and strategic predictive optimization cards.

- [ ] **Step 1: Create `app/digital-twin/dg/page.tsx`**

Server component loading telemetry and rendering `DgView`.

- [ ] **Step 2: Build `dg-view.tsx` and `DgUsageTable.tsx`**

Include:
- Header with "Draft view • Historical data integration planned" badge
- DG status card: 500 kVA Cummins Silent Unit, Status (Standby / Auto-cutover ready), Fuel Level (84% - 420L / 500L tank), Last Run (Yesterday, 14:20), MTD Runtime (18.6 hrs)
- Monthly DG usage table: Date, Runtime (hrs), Fuel Consumed (L), Power Generated (kWh), Trigger Reason (e.g. "Grid Outage - Feeder Line 3", "Peak Tariff Shaving")
- P&L Financial Impact card: MTD DG Cost (₹1,48,200), Grid Equivalent Cost (₹78,400), Net Outage Cost Delta (+₹69,800)
- Strategic Objective Statement: Clear explanation of how historical DG data drives automated predictive power demand and cost reduction.
- Interactive modal / clickables for usage entries

- [ ] **Step 3: Write tests and verify**

Run: `npx vitest run tests/frontend/dg.test.tsx`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add app/digital-twin/dg/ components/dg/ tests/frontend/dg.test.tsx
git commit -m "feat(dg): build diesel generator draft screen with usage table and P&L cards"
```

---

### Task 10: Predictive Analysis Draft Screen (Phase 9)

**Files:**
- Create: `app/digital-twin/predictive-analysis/page.tsx`
- Create: `app/digital-twin/predictive-analysis/predictive-analysis-view.tsx`
- Create: `components/predictive/PredictionGrid.tsx`
- Create: `components/predictive/BatteryHealthTable.tsx`
- Test: `tests/frontend/predictive-analysis.test.tsx`

**Interfaces:**
- Consumes: `data: TrustedTelemetryDocument`
- Produces: 2x2 analytical prediction cards, demand forecast chart, 30-day battery health projection table, and AI insights panel.

- [ ] **Step 1: Create `app/digital-twin/predictive-analysis/page.tsx`**

Server component loading telemetry and rendering `PredictiveAnalysisView`.

- [ ] **Step 2: Build `predictive-analysis-view.tsx` and components**

Include:
- Header with "Draft view • Models under development" badge
- 2x2 grid of analysis modules:
  1. Demand Forecasting (hourly swap peak prediction)
  2. Predictive Maintenance (thermal & cell degradation alerts)
  3. Route Pattern Analysis (highway corridor efficiency)
  4. Power Consumption Forecast (tariff shaving & pre-cooling)
- Demand Forecast visual timeline/chart
- Battery Health Prediction table: Battery ID, Current SOH (%), Projected 30-Day SOH (%), Risk Rating (Normal / Watchlist / High Risk), Recommended Preventive Action
- Key Insights & Automated Recommendations panel
- Interactive detail drawers/modals on card click

- [ ] **Step 3: Write tests and verify**

Run: `npx vitest run tests/frontend/predictive-analysis.test.tsx`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add app/digital-twin/predictive-analysis/ components/predictive/ tests/frontend/predictive-analysis.test.tsx
git commit -m "feat(predictive): build predictive analysis draft screen with 2x2 grid and health forecast table"
```

---

### Task 11: Global Polish, Verification & Zero-Lag Build (Phases 10 & 11)

**Files:**
- Modify: Any files needing polish, memoization, or accessibility touchups
- Test: Full Vitest suite & Next.js production build

**Interfaces:**
- Consumes: Whole application
- Produces: Error-free, zero-warning production build with all 7 routes functional.

- [ ] **Step 1: Run complete test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 2: Run Next.js production build**

Run: `npm run build`
Expected: Zero TypeScript errors, zero build errors, all 7 routes compiled.

- [ ] **Step 3: Review against the 25-point Final Validation Checklist**

Verify every single item from Checklist in `scratch/user_directive.txt`.

- [ ] **Step 4: Final commit**

```bash
git add .
git commit -m "chore: complete digital twin telemetry overhaul with 7 routes and zero-lag build"
```
