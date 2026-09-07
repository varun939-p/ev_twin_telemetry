/**
 * Integration tests for the Truck Telemetry map (`LeafletFleetMap`) — the
 * real component mounted over a real Leaflet map in jsdom.
 *
 * They pin the three production bugs, in the order they were reported:
 *   1. CLUSTER HIDE BUG — clicking a city cluster must move the CAMERA ONLY;
 *      the store's narrowing filters (geo/focus) must stay untouched so every
 *      other truck keeps rendering. (The old code called setGeo+setFocus and
 *      collapsed the dataset to that one city.)
 *   2. EXIT LIVE VIEW — the button must clear selection/hover/focus state and
 *      fly the camera to the fixed wide-India frame in a single move.
 *   3. HOVER POPUPS — hovering a truck marker opens the floating card with
 *      the truck's ID, live coordinates and status, and publishes the
 *      table-highlight pointer.
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

/** Two cities with 3 + 2 carriers — realistic cluster fixture. */
const cityPoints: MapPoint[] = [
  makePoint("v1", 18.5204, 73.8567, "moving", 80, "Pune", "Maharashtra"),
  makePoint("v2", 18.5301, 73.8602, "charging", 61, "Pune", "Maharashtra"),
  makePoint("v3", 18.5102, 73.8421, "idle", 44, "Pune", "Maharashtra"),
  makePoint("v4", 19.076, 72.8777, "moving", 90, "Mumbai", "Maharashtra"),
  makePoint("v5", 19.081, 72.884, "moving", 52, "Mumbai", "Maharashtra"),
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
    // geo = Maharashtra/Pune + focus = the 3 Pune ids, which is what hid
    // every other truck on zoom-out. Both must stay empty/closed.
    const store = useTwin.getState();
    expect(store.geo).toEqual({ region: null, state: null, city: null });
    expect(store.focus).toBeNull();
    expect(store.liveView).toBe(false);
    expect(store.ev).toBe("all");
  });
});

describe("LeafletFleetMap — hover popups", () => {
  it("hovering a truck marker opens the live card with ID, location and status", async () => {
    render(<LeafletFleetMap points={plainPoints} clusters={[]} />);
    await waitFor(() => expect(lastMap()).not.toBeNull());
    const map = lastMap()!;

    // Let the mount flight (wide-India frame) settle so projections are final.
    await waitFor(() => expect(map.getCenter().lat).toBeCloseTo(21.5, 0), { timeout: 4000 });

    // Real Leaflet canvas hit-testing: a mousemove over the truck's pixel.
    const target = map.latLngToContainerPoint([18.5204, 73.8567]);
    const canvas = document.querySelector(".leaflet-overlay-pane canvas") ?? document.querySelector("canvas");
    expect(canvas).toBeTruthy();
    fireEvent.mouseMove(canvas!, { clientX: target.x, clientY: target.y });

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
