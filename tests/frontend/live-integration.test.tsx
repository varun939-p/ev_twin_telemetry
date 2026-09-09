import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import fs from "node:fs";
import { batteryRegistry } from "@/lib/fleet";
import { assetStatus, truckRows, chargingNow } from "@/lib/fleet-metrics";
import {
  formatValue,
  orderedParams,
  WORK_STATUS_LABEL,
  CHARGING_STATUS_LABEL,
  type TrustedTelemetryDocument,
  type TrustedVehicle,
} from "@/lib/trusted-telemetry";
import TruckDetailModal from "@/components/truck/TruckDetailModal";

afterEach(cleanup);

describe("Live Integration & Code Dictionary Verification", () => {
  it("verifies workst dictionary mapping", () => {
    expect(WORK_STATUS_LABEL["0"]).toBe("Init");
    expect(WORK_STATUS_LABEL["1"]).toBe("Ready-Green");
    expect(WORK_STATUS_LABEL["2"]).toBe("Start");
    expect(WORK_STATUS_LABEL["3"]).toBe("Run/Working");
    expect(WORK_STATUS_LABEL["4"]).toBe("Stop");

    expect(formatValue(0, "", "work_status")).toBe("Init (0)");
    expect(formatValue(1, "", "work_status")).toBe("Ready-Green (1)");
    expect(formatValue(2, "", "work_status")).toBe("Start (2)");
    expect(formatValue(3, "", "work_status")).toBe("Run/Working (3)");
    expect(formatValue(4, "", "work_status")).toBe("Stop (4)");
  });

  it("verifies chg_status dictionary mapping", () => {
    expect(CHARGING_STATUS_LABEL[0]).toBe("Not charging");
    expect(CHARGING_STATUS_LABEL[1]).toBe("Charging");

    expect(formatValue(0, "", "charging_status")).toBe("Not charging");
    expect(formatValue(1, "", "charging_status")).toBe("Charging");
  });

  it("verifies 255 sentinel formatting coercion", () => {
    expect(formatValue(255, "", "min_cell_v_cell_no")).toBeNull();
    expect(formatValue(255, "", "max_cell_v_cell_no")).toBeNull();
    expect(formatValue(255, "", "min_cell_v_pack_no")).toBeNull();
    expect(formatValue(255, "", "max_temp_pack_no")).toBeNull();
  });

  it("verifies assetStatus mappings for card status", () => {
    const makeVehicle = (workst: string | number | null, chg: number | null, speed: number | null): TrustedVehicle =>
      ({
        vehicle_id: "TEST_V1",
        observed_at: "2026-09-09T10:00:00Z",
        values: {
          work_status: workst,
          charging_status: chg,
          speed_kmh: speed,
        },
        field_status: {
          work_status: workst !== null ? "measured" : "absent_upstream",
          charging_status: chg !== null ? "measured" : "absent_upstream",
          speed_kmh: speed !== null ? "measured" : "absent_upstream",
        },
        field_errors: [],
        missing_fields: [],
        null_fields: [],
        measured_count: 3,
        completeness_pct: 12.5,
        trusted: true,
        signature: "sig123",
      } as unknown as TrustedVehicle);

    // workst 4 => stopped
    expect(assetStatus(makeVehicle("4", 0, 0))).toBe("stopped");
    expect(assetStatus(makeVehicle(4, 0, 0))).toBe("stopped");

    // chg_status 1 => charging
    expect(assetStatus(makeVehicle("1", 1, 0))).toBe("charging");

    // speed > 0 or workst 3 => moving (Active)
    expect(assetStatus(makeVehicle("3", 0, 0))).toBe("moving");
    expect(assetStatus(makeVehicle("1", 0, 25))).toBe("moving");

    // speed == 0 and workst in 0,1,2 => idle
    expect(assetStatus(makeVehicle("0", 0, 0))).toBe("idle");
    expect(assetStatus(makeVehicle("1", 0, 0))).toBe("idle");
    expect(assetStatus(makeVehicle("2", 0, 0))).toBe("idle");
  });

  it("verifies TruckDetailModal renders 'Not Reported' pill instead of 'Rejected' for 255 sentinels", () => {
    const vehicleWithSentinel = {
      vehicle_id: "RJ09GE9008",
      observed_at: "2026-09-09T10:34:40Z",
      trusted: true,
      signature: "test-sig-1234567890",
      measured_count: 23,
      completeness_pct: 95.8,
      missing_fields: [],
      null_fields: [],
      field_errors: [
        {
          field: "min_cell_v_cell_no",
          raw: 255.0,
          error: "sentinel or unparseable value -> stored NULL",
        },
      ],
      field_status: {
        max_cell_v_cell_no: "measured",
        min_cell_v_cell_no: "field_error",
        min_cell_v_pack_no: "measured",
        max_temp_pack_no: "measured",
        min_cell_v: "measured",
        max_cell_v: "measured",
      },
      values: {
        max_cell_v_cell_no: 161,
        min_cell_v_cell_no: null, // 255 coerced to null
        min_cell_v_pack_no: 1,
        max_temp_pack_no: 1,
        min_cell_v: 3.273,
        max_cell_v: 3.279,
      },
    } as unknown as TrustedVehicle;

    const mockDoc: TrustedTelemetryDocument = {
      schema_version: "1.0",
      generated_at: new Date().toISOString(),
      provenance: {} as any,
      pipeline_health: {
        vehicles_seen: 1,
        vehicles_accepted: 1,
        vehicles_quarantined: 0,
        parameters_total: 24,
        parameters_available: 23,
        parameters_unavailable_upstream: 1,
        fleet_completeness_pct: 95.8,
        oldest_observed_at: null,
        newest_observed_at: null,
        available_parameters: [],
        unavailable_parameters: [],
        attention: [],
      },
      field_status_legend: {} as any,
      vehicles: [vehicleWithSentinel],
      quarantined: [],
    };

    const params = orderedParams(mockDoc);

    render(
      <TruckDetailModal
        vehicle={vehicleWithSentinel}
        sites={[]}
        params={params}
        batteryLabel="BATT-001"
        open={true}
        onClose={() => {}}
      />
    );

    // Verify cell 161 is displayed normally as a number
    expect(screen.getByText("161")).toBeTruthy();

    // Verify "Not Reported" pill is rendered for min_cell_v_cell_no
    const notReportedPills = screen.getAllByText("Not Reported");
    expect(notReportedPills.length).toBeGreaterThan(0);

    // CRITICAL: Ensure NO red "Rejected" pill is rendered for the 255 sentinel!
    expect(screen.queryByText("Rejected")).toBeNull();
  });

  it("evaluates live database dump if available", () => {
    const docPath = "C:/Users/Varun Paruchuri/.gemini/antigravity-ide/brain/78667e0d-c2c4-40e1-b1dc-35f295f3d23b/scratch/latest_live_doc.json";
    if (!fs.existsSync(docPath)) return;

    const rawDoc = JSON.parse(fs.readFileSync(docPath, "utf-8")) as TrustedTelemetryDocument;
    const vehicles = rawDoc.vehicles;
    expect(vehicles.length).toBeGreaterThan(90);

    const rows = truckRows(vehicles, batteryRegistry(vehicles));
    expect(rows.length).toBe(vehicles.length);

    const charging = chargingNow(vehicles);
    expect(charging.totalFrames).toBe(vehicles.length);
    expect(charging.measuredFrames).toBeGreaterThan(90);

    // Verify no 255 sentinels reached values
    for (const v of vehicles) {
      for (const f of ["min_cell_v_cell_no", "max_cell_v_cell_no", "min_cell_v_pack_no", "max_temp_pack_no"] as const) {
        expect(v.values[f]).not.toBe(255);
      }
    }
  });
});
