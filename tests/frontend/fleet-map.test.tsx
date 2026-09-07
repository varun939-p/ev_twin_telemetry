/**
 * Integration tests for the Truck Telemetry map (`LeafletFleetMap`) — the
 * real component mounted over a real Leaflet map in jsdom.
 *
 * They pin the production bug fixes AND the advanced map UI contract:
 *   1. CLUSTER HIDE BUG — clicking a city cluster must move the CAMERA ONLY;
 *      the store's narrowing filters (geo/focus) must stay untouched so every
 *      other truck keeps rendering.
 *   2. EXIT LIVE VIEW — the button must clear selection/hover/focus state and
 *      fly the camera to the fixed wide-India frame in a single move.
 *   3. HOVER POPUPS — hovering a truck marker opens the floating card with
 *      the truck's ID, live coordinates and status, and publishes the
 *      table-highlight pointer.
 *   4. LIVE PULSING NODES — individual trucks render as light-blue pulsing
 *      divIcon nodes (`.live-node-ring`), not static pins.
 *   5. DENSITY HEATMAP — city clusters render as colour-tiered heat bubbles
 *      (green/amber/red by relative density) with the count as real text.
 */
import "./helpers/leaflet-dom-stubs"; // MUST be the first import (jsdom shims)
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import L from "leaflet";

import LeafletFleetMap from "@/components/map/LeafletFleetMap";
import { buildCityClusters, ZOOM, type MapPoint } from "@/lib/map-data";
import { useTwin } from "@/lib/store";

import { lastMap, resetMaps } from "./helpers/leaflet-dom-stubs";

afterEach(() => {
  // Stop in-flight camera animations BEFORE unmount: Leaflet's destroy path
  // deletes the canvas ctx while queued rAF frames can still fire in jsdom.
  act(() => {
    lastMap()?.stop();
  });
  cleanup();
  resetMaps();
  act(() => {
    useTwin.getState().exitLiveView();
    useTwin.setState({
      ev: "all",
      geo: { region: null, state: null, city: null },
      soc: "all",
      stationId: null,
      focus: null,
    });
  });
});

/* ------------------------------------------------------------- fixtures */

function makePoint(
  vehicleId: string,
  lat: number,
  lon: number,
  status: MapPoint["status"] = "moving",
  soc: number | null = 76,
  city: string | null = null,
  state: string | null = null,
): MapPoint {
  return { vehicleId, lat, lon, status, soc, batteryLabel: `Battery ${vehicleId.slice(-1)}`, chassis: `CHASSIS-${vehicleId}`, city, state, ageLabel: "frame 2m old" };
}

/**
 * Three cities calibrated so every density tier is exercised with the
 * self-calibrating palette (max = Pune's 5):
 *   Pune 5/5 = 1.00  -> high (severe, red)
 *   Mumbai 2/5 = 0.40 -> medium (amber)
 *   Bengaluru 1/5 = 0.20 -> low (green)
 */
const cityPoints: MapPoint[] = [
  makePoint("v1", 18.5204, 73.8567, "moving", 80, "Pune", "Maharashtra"),
  makePoint("v2", 18.5301, 73.8602, "charging", 61, "Pune", "Maharashtra"),
  makePoint("v3", 18.5102, 73.8421, "idle", 44, "Pune", "Maharashtra"),
  makePoint("v6", 18.5402, 73.8702, "moving", 91, "Pune", "Maharashtra"),
  makePoint("v7", 18.5002, 73.8321, "moving", 58, "Pune", "Maharashtra"),
  makePoint("v4", 19.076, 72.8777, "moving", 90, "Mumbai", "Maharashtra"),
  makePoint("v5", 19.081, 72.884, "moving", 52, "Mumbai", "Maharashtra"),
  makePoint("v8", 12.9716, 77.5946, "idle", 33, "Bengaluru", "Karnataka"),
];

/** City-less points, so the truck-marker layer shows without any zooming. */
const plainPoints: MapPoint[] = [
  makePoint("TRK-007", 18.5204, 73.8567, "moving", 76),
  makePoint("TRK-008", 19.076, 72.8777, "charging", 55),
  makePoint("TRK-009", 28.6139, 77.209, "idle", null),
];

/* ---------------------------------------------------------------- tests */

describe("LeafletFleetMap — cluster interactions", () => {
  it("clicking a city cluster moves the camera WITHOUT filtering the fleet", async () => {
    render(<LeafletFleetMap points={cityPoints} clusters={buildCityClusters(cityPoints)} />);
    await waitFor(() => expect(lastMap()).not.toBeNull());

    const flyToBounds = vi.spyOn(L.Map.prototype, "flyToBounds");

    const puneIcon = [...document.querySelectorAll(".leaflet-marker-icon")].find((el) =>
      (el.textContent ?? "").includes("Pune"),
    );
    expect(puneIcon).toBeTruthy();
    fireEvent.click(puneIcon!);

    // The camera flies to the cluster members, capped at the city radius…
    expect(flyToBounds).toHaveBeenCalledTimes(1);
    const [, opts] = flyToBounds.mock.calls[0] as unknown as [unknown, { maxZoom: number }];
    expect(opts.maxZoom).toBe(ZOOM.cluster);

    // …and the store's NARROWING filters are untouched: the old code set
    // geo = Maharashtra/Pune + focus = the Pune ids, which is what hid
    // every other truck on zoom-out. Both must stay empty/closed.
    const store = useTwin.getState();
    expect(store.geo).toEqual({ region: null, state: null, city: null });
    expect(store.focus).toBeNull();
    expect(store.liveView).toBe(false);
    expect(store.ev).toBe("all");
  });
});

describe("LeafletFleetMap — density heatmap clusters", () => {
  it("renders colour-tiered heat bubbles calibrated to the busiest city", async () => {
    render(<LeafletFleetMap points={cityPoints} clusters={buildCityClusters(cityPoints)} />);
    await waitFor(() => expect(lastMap()).not.toBeNull());

    const blobs = [...document.querySelectorAll<HTMLElement>(".heat-blob")];
    expect(blobs.length).toBe(3);

    const tierOf = (city: string) =>
      blobs.find((b) => b.textContent?.includes(city))?.className.match(/heat-(low|medium|high)/)?.[1];

    // Self-calibrating palette: 5/5 severe, 2/5 medium, 1/5 low.
    expect(tierOf("Pune")).toBe("high");
    expect(tierOf("Mumbai")).toBe("medium");
    expect(tierOf("Bengaluru")).toBe("low");

    // Count stays real text inside the crisp core; a glow layer carries the heat.
    const pune = blobs.find((b) => b.textContent?.includes("Pune"))!;
    expect(pune.querySelector(".heat-count")?.textContent).toBe("5");
    expect(pune.querySelector(".heat-glow")).toBeTruthy();
  });
});

describe("LeafletFleetMap — live pulsing nodes", () => {
  it("renders every individual truck as a light-blue pulsing node", async () => {
    render(<LeafletFleetMap points={plainPoints} clusters={[]} />);
    await waitFor(() => expect(lastMap()).not.toBeNull());

    const nodes = [...document.querySelectorAll<HTMLElement>(".live-node")];
    expect(nodes.length).toBe(plainPoints.length);

    // Structure: core dot + pulsing ring, keyed by vehicle id.
    const trk7 = nodes.find((n) => n.dataset.vehicleId === "TRK-007");
    expect(trk7?.querySelector(".live-node-core")).toBeTruthy();
    expect(trk7?.querySelector(".live-node-ring")).toBeTruthy();

    // Selection/hover flips the active treatment (brighter core, faster
    // pulse). Leaflet REPLACES the icon element when the divIcon rebuilds,
    // so re-query the live DOM instead of trusting the captured node.
    act(() => {
      useTwin.getState().select("TRK-007", "table");
    });
    await waitFor(() => {
      const fresh = document.querySelector<HTMLElement>('[data-vehicle-id="TRK-007"]');
      expect(fresh?.className.includes("is-active")).toBe(true);
    });
  });
});

describe("LeafletFleetMap — hover popups", () => {
  it("hovering a truck marker opens the live card with ID, location and status", async () => {
    render(<LeafletFleetMap points={plainPoints} clusters={[]} />);
    await waitFor(() => expect(lastMap()).not.toBeNull());
    const map = lastMap()!;

    // Let the mount flight (wide-India frame) settle so projections are final.
    await waitFor(() => expect(map.getCenter().lat).toBeCloseTo(21.5, 0), { timeout: 4000 });

    // Markers are interactive DOM nodes (divIcons) — a real mouseover on the
    // node element is exactly what a user's cursor produces.
    const node = document.querySelector<HTMLElement>('[data-vehicle-id="TRK-007"]');
    expect(node).toBeTruthy();
    fireEvent.mouseOver(node!);

    // The Google-Maps-style card appears…
    await screen.findByText(/ID TRK-007/, {}, { timeout: 3000 });
    // …with the required content: live location, ID, current status.
    expect(screen.getByText("Moving")).toBeTruthy();
    expect(screen.getByText(/18\.5204° N/)).toBeTruthy();
    expect(screen.getByText(/73\.8567° E/)).toBeTruthy();
    expect(screen.getByText("SOC")).toBeTruthy();

    // Glued positioning: the card is placed via an inline transform.
    const cardRoot = screen.getByText(/ID TRK-007/).closest<HTMLDivElement>("div[class*='z-[900]']");
    expect(cardRoot?.style.transform).toMatch(/translate3d/);

    // …and the map→table link fires (row highlight pointer).
    expect(useTwin.getState().hovered?.vehicleId).toBe("TRK-007");
  });
});

describe("LeafletFleetMap — Exit Live View", () => {
  it("clears selection/hover/focus state and flies home to the India frame", async () => {
    render(<LeafletFleetMap points={plainPoints} clusters={[]} />);
    await waitFor(() => expect(lastMap()).not.toBeNull());

    // Simulate a drilled-in operator: a selected truck + a stale focus scope.
    act(() => {
      useTwin.getState().select("TRK-007", "map");
      useTwin.setState({ focus: { id: "f1", label: "drill", vehicleIds: ["TRK-007"] } });
    });
    const nonceBefore = useTwin.getState().fitNonce;

    const flyTo = vi.spyOn(L.Map.prototype, "flyTo");
    fireEvent.click(screen.getByRole("button", { name: /exit live view/i }));

    // a) every pointer/selection state is cleared…
    const store = useTwin.getState();
    expect(store.selected).toBeNull();
    expect(store.hovered).toBeNull();
    expect(store.focus).toBeNull();
    expect(store.liveView).toBe(false);
    expect(store.fitNonce).toBe(nonceBefore + 1);

    // …b) with ONE deterministic flight to the wide-India resting frame.
    expect(flyTo).toHaveBeenCalledTimes(1);
    expect(flyTo).toHaveBeenCalledWith([21.5, 79], ZOOM.fleet, expect.objectContaining({ duration: 0.7 }));
  });
});
