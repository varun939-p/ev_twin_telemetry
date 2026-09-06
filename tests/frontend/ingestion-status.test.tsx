import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import IngestionStatus from "@/components/shell/IngestionStatus";
import { parseIngestionHealth, type IngestionHealth } from "@/lib/ingestion-status";

const health: IngestionHealth = {
  state: "upstream_stale", detail: "Last poll succeeded; upstream returned old observations within the probe budget.",
  expected_interval_seconds: 300, last_success_at: "2026-09-06T12:00:00+00:00", newest_observed_at: "2026-09-03T12:00:00+00:00",
  last_attempt: { started_at: "2026-09-06T11:59:50+00:00", finished_at: "2026-09-06T12:00:00+00:00", trigger: "cron", summary: { accepted: 8, resolved_date: "2026-09-03" } },
};
afterEach(cleanup);

describe("visible ingestion diagnosis", () => {
  it("distinguishes a successful poll of old upstream data", () => {
    render(<IngestionStatus health={health} />);
    expect(screen.getByRole("region", { name: "Ingestion status" }).textContent).toContain("Upstream data is old");
    expect(screen.getByText(/Last poll completed/).textContent).toContain("8 vehicles accepted");
    expect(screen.getByText(/Last poll completed/).textContent).toContain("2026-09-06T12:00:00+00:00");
  });

  it.each([
    ["failed", "Ingestion failed"], ["overdue", "Ingestion overdue"], ["partial", "Ingestion incomplete"],
    ["backend_unreachable", "Backend unreachable"], ["database_unreachable", "Database unreachable"],
  ] as const)("shows %s rather than blaming upstream", (state, label) => {
    render(<IngestionStatus health={{ ...health, state, detail: "Check the cycle logs." }} />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText("Upstream data is old")).toBeNull();
  });

  it("does not infer health when the backend has no diagnostic contract yet", () => {
    render(<IngestionStatus health={null} />);
    expect(screen.getByText("Ingestion status unknown")).toBeTruthy();
    expect(parseIngestionHealth("Internal Server Error")).toBeNull();
    expect(parseIngestionHealth({ state: "healthy" })).toBeNull();
    expect(parseIngestionHealth({ ...health, state: "toString" })).toBeNull();
  });
});
