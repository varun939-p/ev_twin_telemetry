/**
 * The three restored operational panels (management mandate):
 *   1. Swap Station Operations — bays + active transaction + vehicle queue
 *   2. Charger Status — dual-gun Charger A/B with per-gun kW
 *   3. Grid/DG Power Load — site draw vs feeder, DG state
 *
 * Rendered at tick 0, where `simulateSite` is a pure, deterministic function —
 * so the assertions are exact, and SSR === first client render by construction.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import FacilityPanels from "@/components/central/FacilityPanels";
import type { InboundSeed, PackSeed } from "@/lib/site-model";
import type { SwapStation } from "@/lib/fleet";

afterEach(cleanup);

const station: SwapStation = {
  id: "pune",
  name: "Pune Hub",
  lat: 18.5204,
  lon: 73.8567,
  assetCount: 14,
} as unknown as SwapStation;

const packs: PackSeed[] = [
  { vehicleId: "v1", batteryLabel: "Battery 1", soc: 62 },
  { vehicleId: "v2", batteryLabel: "Battery 2", soc: 48 },
  { vehicleId: "v3", batteryLabel: "Battery 3", soc: 91 },
];

const inbound: InboundSeed[] = [
  { vehicleId: "v9", carrierLabel: "CHASSIS-9", distanceKm: 12, etaMinutes: 18, soc: 40 },
];

describe("FacilityPanels — the three operational panels", () => {
  it("renders swap bay operations with real pack identities and the queue", () => {
    render(<FacilityPanels packs={packs} inbound={inbound} station={station} />);
    // bays 1..4 always render; occupied bays carry the REAL battery labels
    expect(screen.getByText("Bay 1")).toBeTruthy();
    expect(screen.getByText("Bay 4")).toBeTruthy();
    expect(screen.getByText("Battery 1")).toBeTruthy();
    // the vehicle queue surfaces the real inbound carrier + ETA
    expect(screen.getByText("Vehicle queue")).toBeTruthy();
    expect(screen.getByText("CHASSIS-9")).toBeTruthy();
    expect(screen.getByText("1 inbound")).toBeTruthy();
    // the active transaction caption from the dock state machine
    expect(screen.getByText(/Lane clear|Carrier inbound|Docking|Swap in progress|Pack seated|departing/)).toBeTruthy();
  });

  it("renders Charger A and B with two guns each and live kW figures", () => {
    render(<FacilityPanels packs={packs} inbound={inbound} station={station} />);
    expect(screen.getByText("Charger A")).toBeTruthy();
    expect(screen.getByText("Charger B")).toBeTruthy();
    // two guns per charger
    expect(screen.getAllByText("Gun 1").length).toBe(2);
    expect(screen.getAllByText("Gun 2").length).toBe(2);
    // per-gun statuses and rated totals
    expect(screen.getAllByText(/delivering|handshake|idle/).length).toBeGreaterThanOrEqual(4);
    expect(screen.getAllByText(/240 kW/).length).toBe(2); // rated per charger
  });

  it("renders grid/DG load with site draw, feeder limit and DG state", () => {
    render(<FacilityPanels packs={packs} inbound={inbound} station={station} />);
    expect(screen.getByText("Grid & DG load")).toBeTruthy();
    expect(screen.getByText("Site draw")).toBeTruthy();
    expect(screen.getByText("Diesel generator")).toBeTruthy();
    expect(screen.getByText(/Grid stable|DG assisting/)).toBeTruthy();
    // feeder budget line (250 kW model) and the modelled-load footnote
    expect(screen.getByText(/\/ 250 kW/)).toBeTruthy();
    expect(screen.getByText(/modelled until the site controller publishes/)).toBeTruthy();
  });

  it("badges every modelled surface (honesty boundary)", () => {
    render(<FacilityPanels packs={packs} inbound={inbound} station={station} />);
    // one "Facility model" badge per panel
    expect(screen.getAllByText("Facility model").length).toBe(3);
  });
});
