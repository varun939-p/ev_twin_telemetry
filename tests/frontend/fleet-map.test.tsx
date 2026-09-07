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
 *   5. DENSITY RADAR FIELD — grouped carriers render as highly transparent,
 *      light-tinted, pulsing radar cells (green/amber/red by relative
 *      density) with NO count text on the map; a city with a SINGLE carrier
 *      renders as a live-blue pulsing node, not a bubble.
 *   6. MOUSE-LEAVE SNAP-BACK — the cursor leaving the map container glides
 *      the camera home to the wide fleet overview (debounced, cancellable).
 *   7. SNAP-BACK DISCIPLINE — an overview already at home never animates,
 *      and re-entering the map cancels a pending snap.
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

    // Radar fields carry no city text — the drill target is found by its
    // data-cluster-id anchor, exactly as an operator's hover-card click is.
    const puneIcon = document.querySelector<HTMLElement>('[data-cluster-id$="::Pune"]');
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

describe("LeafletFleetMap — density radar field", () => {
  it("renders tiered TRANSPARENT radar cells with no count text on the map", async () => {
    render(<LeafletFleetMap points={cityPoints} clusters={buildCityClusters(cityPoints)} />);
    await waitFor(() => expect(lastMap()).not.toBeNull());

    const blobs = [...document.querySelectorAll<HTMLElement>(".heat-blob")];
    // Pune (5) and Mumbai (2) are real fields; Bengaluru (1) is a singleton
    // and must render as a live node below — NOT a bubble.
    expect(blobs.length).toBe(2);

    const tierOf = (id: string) =>
      document
        .querySelector<HTMLElement>(`[data-cluster-id$="::${id}"]`)
        ?.className.match(/heat-(low|medium|high)/)?.[1];

    // Self-calibrating palette: 5/5 severe, 2/5 medium.
    expect(tierOf("Pune")).toBe("high");
    expect(tierOf("Mumbai")).toBe("medium");

    // THE MANDATE: no solid numbered bubbles. There is no count/city text
    // anywhere inside a field — the hover card owns the detail — and the
    // visual is three translucent layers: a breathing halo + two radar pings,
    // phase-shifted per cluster via the --ping-delay custom property.
    const pune = document.querySelector<HTMLElement>('[data-cluster-id$="::Pune"]')!;
    expect(pune.querySelector(".heat-count")).toBeNull();
    expect(pune.querySelector(".heat-city")).toBeNull();
    expect(pune.querySelector(".heat-halo")).toBeTruthy();
    expect(pune.querySelectorAll(".heat-ping").length).toBe(2);
    expect(pune.style.getPropertyValue("--ping-delay")).toMatch(/^-\d+(\.\d+)?s$/);
  });

  it("keeps the low tier reachable for small fields (self-calibrating)", async () => {
    // max=7: a 2-carrier city is 2/7 = 0.29 -> low. Rendered via the clusters
    // prop directly so the tier arithmetic is pinned independently of the
    // city aggregation.
    const clusters = [
      { id: "A::Big", city: "Big", state: "A", lat: 20, lon: 78, count: 7, avgSoc: 70, vehicleIds: ["a1"] },
      { id: "B::Small", city: "Small", state: "B", lat: 22, lon: 79, count: 2, avgSoc: 60, vehicleIds: ["b1"] },
    ];
    render(<LeafletFleetMap points={[]} clusters={clusters} />);
    await waitFor(() => expect(lastMap()).not.toBeNull());
    const small = document.querySelector<HTMLElement>('[data-cluster-id="B::Small"]')!;
    expect(small.className).toContain("heat-low");
    expect(document.querySelector<HTMLElement>('[data-cluster-id="A::Big"]')!.className).toContain("heat-high");
  });

  it("renders a single-carrier city as a live-blue pulsing node, not a bubble", async () => {
    render(<LeafletFleetMap points={cityPoints} clusters={buildCityClusters(cityPoints)} />);
    await waitFor(() => expect(lastMap()).not.toBeNull());

    // Bengaluru has exactly one carrier in the fixture.
    const singleton = document.querySelector<HTMLElement>('[data-cluster-id="Karnataka::Bengaluru"]');
    expect(singleton).toBeTruthy();
    expect(singleton!.className).toContain("live-node");
    expect(singleton!.querySelector(".live-node-core")).toBeTruthy();
    expect(singleton!.querySelector(".live-node-ring")).toBeTruthy();
    expect(document.querySelectorAll(".heat-blob").length).toBe(2);
  });
});

describe("LeafletFleetMap — mouse-leave snap-back", () => {
  it("glides home to the wide fleet overview when the cursor leaves the map", async () => {
    render(<LeafletFleetMap points={plainPoints} clusters={[]} />);
    await waitFor(() => expect(lastMap()).not.toBeNull());
    const map = lastMap()!;
    // Let the mount flight settle so the home frame is the baseline.
    await waitFor(() => expect(map.getCenter().lat).toBeCloseTo(21.5, 0), { timeout: 4000 });

    const flyTo = vi.spyOn(L.Map.prototype, "flyTo");

    // The operator wheel-zooms into one truck, then physically leaves the map.
    act(() => {
      map.setZoom(ZOOM.asset);
    });
    flyTo.mockClear();
    fireEvent.mouseLeave(document.querySelector(".canvas-dark")!);

    // Debounced (350 ms), then ONE flight to the fixed wide-India frame.
    await vi.waitFor(
      () =>
        expect(flyTo).toHaveBeenCalledWith([21.5, 79], ZOOM.fleet, expect.objectContaining({ duration: 0.9 })),
      { timeout: 2000 },
    );
  });

  it("never snaps when the overview is already at home, and re-enter cancels", async () => {
    render(<LeafletFleetMap points={plainPoints} clusters={[]} />);
    await waitFor(() => expect(lastMap()).not.toBeNull());
    const map = lastMap()!;
    await waitFor(() => expect(map.getCenter().lat).toBeCloseTo(21.5, 0), { timeout: 4000 });

    const flyTo = vi.spyOn(L.Map.prototype, "flyTo");
    flyTo.mockClear();

    // At the fleet frame a mouse-leave must not animate at all.
    fireEvent.mouseLeave(document.querySelector(".canvas-dark")!);
    await new Promise((r) => setTimeout(r, 550));
    expect(flyTo).not.toHaveBeenCalled();

    // A pending snap is cancelled the moment the cursor comes back.
    act(() => {
      map.setZoom(ZOOM.asset);
    });
    fireEvent.mouseLeave(document.querySelector(".canvas-dark")!);
    fireEvent.mouseEnter(document.querySelector(".canvas-dark")!);
    await new Promise((r) => setTimeout(r, 550));
    expect(flyTo).not.toHaveBeenCalled();
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
    const cardRoot = screen.getByText(/ID TRK-007/).closest<HTMLDivElement>("div[class*='z-[1200]']");
    expect(cardRoot?.style.transform).toMatch(/translate3d/);

    // CRYSTAL-CLEAR mandate: the callout must never blur or dim the map
    // behind it — no backdrop-filter utility anywhere on the card — and it
    // is the LIGHT callout (white card, explicit palette), not a token that
    // flips dark inside the .canvas-dark scope.
    expect(cardRoot?.className).not.toContain("backdrop-blur");
    expect(cardRoot?.innerHTML).toContain("bg-white/95");

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
