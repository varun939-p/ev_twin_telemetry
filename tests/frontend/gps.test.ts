import { describe, expect, it } from "vitest";

import { geographicCentroid, normalizeGpsCoordinates } from "@/lib/gps";

describe("frontend GPS boundary", () => {
  it("preserves exact WGS84 latitude/longitude decimals in Leaflet order", () => {
    expect(normalizeGpsCoordinates(18.52043017, 73.85674391)).toEqual({
      lat: 18.52043017,
      lon: 73.85674391,
    });
  });

  it("repairs a clearly swapped India coordinate pair", () => {
    expect(normalizeGpsCoordinates(73.85674391, 18.52043017)).toEqual({
      lat: 18.52043017,
      lon: 73.85674391,
    });
  });

  it("rejects impossible coordinate values instead of plotting at a fallback", () => {
    expect(normalizeGpsCoordinates(240, 410)).toBeNull();
    expect(normalizeGpsCoordinates(null, 73.8)).toBeNull();
  });

  it("uses a spherical centroid for aggregate map locations", () => {
    const centroid = geographicCentroid([
      { lat: 18.5204, lon: 73.8567 },
      { lat: 18.5304, lon: 73.8667 },
      { lat: 18.5104, lon: 73.8467 },
    ]);
    expect(centroid?.lat).toBeCloseTo(18.5204, 4);
    expect(centroid?.lon).toBeCloseTo(73.8567, 4);
  });
});
