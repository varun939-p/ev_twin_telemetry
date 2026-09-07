/**
 * Cross-component click-to-zoom contract: clicking a row in the "Need
 * Attention" panel must hand the vehicleId to the page's fly handler (which
 * selects the carrier and flies the map to its GPS fix).
 *
 * The TruckTable side of the same contract (`openOnMap` -> select +
 * requestFly) is covered by the wiring in the component; this test pins the
 * AttentionPanel side, which previously only selected without flying.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import AttentionPanel from "@/components/alerts/AttentionPanel";
import type { TwinAlert } from "@/lib/fleet-metrics";

afterEach(cleanup);

const alert: TwinAlert = {
  id: "a1",
  kind: "no-fix",
  scope: "truck",
  severity: "critical",
  vehicleId: "TRK-042",
  label: "CHASSIS-42",
  title: "No GPS fix for 6 h",
  comment: "The last measured position is 6 hours old.",
  metric: "6 h",
};

describe("AttentionPanel — click-to-zoom wiring", () => {
  it("hands the clicked alert's vehicleId to the map-fly handler", () => {
    const onRowClick = vi.fn();
    render(
      <AttentionPanel alerts={[alert]} title="Need Attention — Carriers" emptyMessage="none" onRowClick={onRowClick} />,
    );
    fireEvent.click(screen.getByText("No GPS fix for 6 h"));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenCalledWith("TRK-042");
  });

  it("keyboard activation (Enter) routes through the same handler", () => {
    const onRowClick = vi.fn();
    render(
      <AttentionPanel alerts={[alert]} title="Need Attention — Carriers" emptyMessage="none" onRowClick={onRowClick} />,
    );
    const row = screen.getByText("No GPS fix for 6 h").closest("[role='button']")!;
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onRowClick).toHaveBeenCalledWith("TRK-042");
  });

  it("without a handler it still publishes the store selection (default)", () => {
    render(<AttentionPanel alerts={[alert]} title="t" emptyMessage="none" />);
    fireEvent.click(screen.getByText("No GPS fix for 6 h"));
    // No crash + the row renders; store assertions live in the map tests.
    expect(screen.getByText("TRK-042")).toBeTruthy();
  });
});
