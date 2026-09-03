"use client";

/**
 * Host-side glue: owns the selected asset, aligns both components to the same
 * executive canvas, and — Phase 3 — is the one place that knows how a
 * provisioning request leaves the browser.
 *
 * The POST goes to the *relative* `/api/provision-site`, which `next.config.mjs`
 * rewrites to the Python control plane.  Same-origin for the browser, so it works
 * in the sandboxed preview and behind locked-down corporate proxies alike; the
 * FastAPI service also carries CORS for a direct `http://localhost:3000` client.
 * Neither component depends on the other, and neither knows the backend exists.
 */

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import DigitalTwinDashboard, { type ProvisionOutcome } from "@/components/telemetry/DigitalTwinDashboard";
import TruckHeatmap from "@/components/telemetry/TruckHeatmap";
import ViewNav from "@/components/telemetry/ViewNav";
import { useFilters } from "@/lib/FilterContext";
import type { Cluster, SiteConfig, TrustedTelemetryDocument } from "@/lib/trusted-telemetry";

const PROVISION_ENDPOINT = "/api/provision-site";

export default function TwinView({ data }: { data: TrustedTelemetryDocument }) {
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | undefined>(undefined);
  const router = useRouter();
  const { setFocus } = useFilters();

  /** Heatmap drill-down: set the global focus and route to the live view. */
  const handleClusterClick = useCallback(
    (cluster: Cluster) => {
      setFocus({
        id: cluster.id,
        label: `${cluster.city.name}, ${cluster.city.state}`,
        vehicleIds: cluster.members.map((m) => m.vehicleId),
      });
      router.push("/trucks");
    },
    [router, setFocus],
  );

  /** Transmit a site config to the Python backend.  Never throws: a down backend
   *  becomes a readable `ProvisionOutcome`, not an unhandled rejection. */
  const handleProvisionSite = useCallback(async (site: SiteConfig): Promise<ProvisionOutcome> => {
    const body = {
      siteId: site.siteId,
      label: site.label,
      customer: site.customer,
      chargers: site.chargers,
      dgCapacityKw: site.dgCapacityKw,
      gridFeederKw: site.gridFeederKw,
    };

    try {
      const response = await fetch(PROVISION_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        // 5xx here usually means the rewrite could not reach uvicorn at all --
        // present that as "backend down", not as a scary opaque server error.
        if (response.status >= 500) {
          return { ok: false, message: `Backend unreachable or errored (HTTP ${response.status}) — is uvicorn running on :8000?` };
        }
        // 4xx (e.g. 422 validation): surface the backend's own explanation.
        const detail = await response.text().catch(() => "");
        let message = `Provisioning rejected (HTTP ${response.status}).`;
        try {
          const parsed = JSON.parse(detail) as { detail?: unknown };
          if (parsed.detail) message += ` ${JSON.stringify(parsed.detail)}`;
        } catch {
          if (detail) message += ` ${detail.slice(0, 160)}`;
        }
        return { ok: false, message };
      }

      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      return { ok: true, message: payload?.message ?? `Site ${site.siteId} provisioned.` };
    } catch {
      // Network-level failure: backend offline, proxy down, DNS, etc.
      return { ok: false, message: "Backend unreachable — is `uvicorn telemetry.main:app` running on :8000?" };
    }
  }, []);

  return (
    <main className="min-h-screen bg-[#05070d]">
      <ViewNav active="fleet" />
      <DigitalTwinDashboard
        data={data}
        selectedVehicleId={selectedVehicleId}
        onVehicleChange={setSelectedVehicleId}
        onProvisionSite={handleProvisionSite}
      />
      <div className="mx-auto max-w-[1680px] px-5 pb-10 lg:px-8">
        <TruckHeatmap vehicles={data.vehicles} onSelectVehicle={setSelectedVehicleId} onClusterClick={handleClusterClick} />
      </div>
    </main>
  );
}
