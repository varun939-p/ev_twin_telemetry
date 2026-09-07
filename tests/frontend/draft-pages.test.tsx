import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/central/SiteCanvas", () => ({
  default: () => <div aria-label="Facility preview">Facility preview</div>,
}));

import ChargingStationDraft from "@/components/drafts/ChargingStationDraft";
import DgDraft from "@/components/drafts/DgDraft";
import PredictiveAnalysisDraft from "@/components/drafts/PredictiveAnalysisDraft";
import SwapStationDraft from "@/components/drafts/SwapStationDraft";
import { NAV_ITEMS } from "@/components/shell/Sidebar";

afterEach(cleanup);

describe("draft route navigation", () => {
  it("keeps the exact seven-item order and marks only items four through seven as drafts", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      "Central Dashboard",
      "Battery Tracking",
      "Truck Telemetry",
      "Swap Station",
      "Charging Station",
      "DG",
      "Predictive Analysis",
    ]);
    expect(NAV_ITEMS.map((item) => Boolean(item.draft))).toEqual([false, false, false, true, true, true, true]);
    expect(NAV_ITEMS.slice(3).map((item) => item.href)).toEqual([
      "/digital-twin/swap-station/overview",
      "/digital-twin/charging-station",
      "/digital-twin/dg/overview",
      "/digital-twin/predictive-analysis",
    ]);
  });
});

describe("functional sample-data draft pages", () => {
  it("opens details from each of the eight swap bays", () => {
    render(<SwapStationDraft />);
    const bays = screen.getAllByRole("button", { name: /Battery bay \d/i });
    expect(bays).toHaveLength(8);
    fireEvent.click(bays[0]);
    const dialog = screen.getByRole("dialog", { name: "Battery bay 1" });
    expect(within(dialog).getByText("BAT-PUN-104")).toBeTruthy();
    expect(screen.getByText("Battery Swaps Completed Today")).toBeTruthy();
    expect(screen.getByText("Average Battery Swap Time")).toBeTruthy();
  });

  it("filters charging points and opens a charging-point record", () => {
    render(<ChargingStationDraft />);
    fireEvent.click(screen.getByRole("button", { name: "Available" }));
    expect(screen.getByText("CHG-PUN-03")).toBeTruthy();
    expect(screen.queryByText("CHG-PUN-01")).toBeNull();
    fireEvent.click(screen.getByText("CHG-PUN-03"));
    const dialog = screen.getByRole("dialog", { name: "CHG-PUN-03" });
    expect(within(dialog).getByText("No battery connected")).toBeTruthy();
  });

  it("switches generator history months and opens a run record", () => {
    render(<DgDraft />);
    fireEvent.click(screen.getByRole("button", { name: "July 2026" }));
    expect(screen.getByText("05 Jul 2026")).toBeTruthy();
    expect(screen.queryByText("03 Aug 2026")).toBeNull();
    fireEvent.click(screen.getByText("05 Jul 2026"));
    const dialog = screen.getByRole("dialog", { name: "Generator run · 05 Jul 2026" });
    expect(within(dialog).getByText("DG-2026-07-05")).toBeTruthy();
  });

  it("opens a model plan and filters the battery-health prediction table", () => {
    render(<PredictiveAnalysisDraft />);
    fireEvent.click(screen.getByRole("button", { name: /Demand Forecasting/i }));
    expect(screen.getByRole("dialog", { name: "Demand Forecasting" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByRole("button", { name: "High" }));
    expect(screen.getByText("BAT-PUN-111")).toBeTruthy();
    expect(screen.queryByText("BAT-PUN-104")).toBeNull();
    expect(screen.getByText("Key predictive insights")).toBeTruthy();
  });
});
