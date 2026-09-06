import { afterEach, expect, it, vi } from "vitest";
import { medianFrameAgeHours } from "@/lib/fleet-metrics";
import { normalizeVehicle, parseTimestampMs, type TrustedVehicle } from "@/lib/trusted-telemetry";

afterEach(() => { vi.useRealTimers(); });

it("keeps persisted naive timestamps UTC rather than browser-local", () => {
  expect(parseTimestampMs("2026-09-03T12:00:00")).toBe(Date.parse("2026-09-03T12:00:00Z"));
  expect(parseTimestampMs("2026-09-03 12:00:00")).toBe(Date.parse("2026-09-03T12:00:00Z"));
  expect(parseTimestampMs("2026-09-03T17:30:00+05:30")).toBe(Date.parse("2026-09-03T12:00:00Z"));
});

it("keeps a generated_at-anchored median deterministic despite wall-clock changes", () => {
  const vehicle = normalizeVehicle({ vehicle_id: "TRUCK01", observed_at: "2026-09-03T12:00:00", values: {} } as TrustedVehicle);
  const anchor = new Date("2026-09-06T12:00:00Z");
  vi.useFakeTimers();
  vi.setSystemTime("2026-09-06T12:00:00Z");
  const server = medianFrameAgeHours([vehicle], anchor);
  vi.setSystemTime("2026-09-10T17:30:00Z");
  expect(medianFrameAgeHours([vehicle], anchor)).toBe(server);
  expect(server).toBe(72);
});
