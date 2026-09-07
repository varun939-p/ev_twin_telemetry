import { describe, expect, it } from "vitest";

import { snapToTerrestrialCorridor } from "@/lib/map-data";
import { nearestCity } from "@/lib/trusted-telemetry";

describe("Coastal & Terrestrial Map-Matching (Option B)", () => {
  it("leaves standard terrestrial coordinates in India untouched", () => {
    // Pune
    const pune = snapToTerrestrialCorridor(18.5204, 73.8567);
    expect(pune.lat).toBe(18.5204);
    expect(pune.lon).toBe(73.8567);
    expect(pune.isCoastalCorrected).toBe(false);

    // Mumbai
    const mumbai = snapToTerrestrialCorridor(19.076, 72.8777);
    expect(mumbai.lat).toBe(19.076);
    expect(mumbai.lon).toBe(72.8777);
    expect(mumbai.isCoastalCorrected).toBe(false);

    // Delhi
    const delhi = snapToTerrestrialCorridor(28.6139, 77.209);
    expect(delhi.lat).toBe(28.6139);
    expect(delhi.lon).toBe(77.209);
    expect(delhi.isCoastalCorrected).toBe(false);

    // Bengaluru
    const blr = snapToTerrestrialCorridor(12.9716, 77.5946);
    expect(blr.lat).toBe(12.9716);
    expect(blr.lon).toBe(77.5946);
    expect(blr.isCoastalCorrected).toBe(false);
  });

  it("leaves terrestrial vehicles in Nellore city untouched", () => {
    // AP39WN4419: in Nellore city center (on land)
    const res = snapToTerrestrialCorridor(14.46882, 80.02467);
    expect(res.lat).toBe(14.46882);
    expect(res.lon).toBe(80.02467);
    expect(res.isCoastalCorrected).toBe(false);
  });

  it("snaps offshore marine-drifted AP39 vehicles to the legitimate terrestrial corridor", () => {
    // AP39WP9027: reported ~30 km offshore at Krishnapatnam
    const wp = snapToTerrestrialCorridor(14.22669, 80.42159);
    expect(wp.isCoastalCorrected).toBe(true);
    expect(wp.lat).toBeGreaterThanOrEqual(14.24);
    expect(wp.lon).toBeLessThanOrEqual(80.134); // on land at port terminal

    // AP39WH5376: coastal beach edge
    const wh = snapToTerrestrialCorridor(14.45769, 80.18623);
    expect(wh.isCoastalCorrected).toBe(true);
    expect(wh.lon).toBeLessThanOrEqual(80.145);

    // AP39WL1102: reported ~24 km offshore in Bay of Bengal
    const wl = snapToTerrestrialCorridor(14.61521, 80.38116);
    expect(wl.isCoastalCorrected).toBe(true);
    expect(wl.lat).toBe(14.61521);
    expect(wl.lon).toBeLessThanOrEqual(80.10);

    // AP39WM7734: reported ~21 km offshore in Bay of Bengal
    const wm = snapToTerrestrialCorridor(14.64579, 80.34699);
    expect(wm.isCoastalCorrected).toBe(true);
    expect(wm.lat).toBe(14.64579);
    expect(wm.lon).toBeLessThanOrEqual(80.10);

    // AP39WG5383: reported ~20 km offshore
    const wg = snapToTerrestrialCorridor(14.78444, 80.24479);
    expect(wg.isCoastalCorrected).toBe(true);
    expect(wg.lat).toBe(14.78444);
    expect(wg.lon).toBeLessThanOrEqual(80.06);
  });

  it("resolves Nellore for Andhra Pradesh coastal freight corridor vehicles", () => {
    const near = nearestCity(14.45769, 80.138);
    expect(near).not.toBeNull();
    expect(near?.name).toBe("Nellore");
    expect(near?.state).toBe("Andhra Pradesh");
  });

  it("rejects out-of-bounds coordinates (like Guangzhou, China) from attributing to Indian cities", () => {
    // 76250314010057 in Guangzhou, China
    const china = nearestCity(23.103963, 113.338983);
    expect(china).toBeNull();
  });
});
