"use client";

import { useCallback, useState } from "react";
import DigitalTwinDashboard, { type ProvisionOutcome } from "../components/telemetry/DigitalTwinDashboard";
import TruckHeatmap from "../components/telemetry/TruckHeatmap";
import doc from "../trusted_vehicle_telemetry.json";
import type { SiteConfig, TrustedTelemetryDocument } from "../lib/trusted-telemetry";

const trusted = doc as unknown as TrustedTelemetryDocument;
const PROVISION_ENDPOINT = "/api/provision-site";

export default function Page() {
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | undefined>(undefined);

  const handleProvisionSite = useCallback(async (site: SiteConfig): Promise<ProvisionOutcome> => {
    const body = {
      siteId: site.siteId, label: site.label, customer: site.customer,
      chargers: site.chargers, dgCapacityKw: site.dgCapacityKw, gridFeederKw: site.gridFeederKw,
    };
    
    try {
      const response = await fetch(PROVISION_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        if (response.status >= 500) {
          return { ok: false, message: `Backend unreachable (HTTP ${response.status}) — is uvicorn running on :8000?` };
        }
        const detail = await response.text().catch(() => "");
        return { ok: false, message: `Provisioning rejected (HTTP ${response.status}). ${detail.slice(0, 100)}` };
      }
      
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      return { ok: true, message: payload?.message ?? `Site ${site.siteId} provisioned successfully.` };
    } catch {
      return { ok: false, message: "Backend unreachable — is Python FastAPI running on :8000?" };
    }
  }, []);

  return (
    <main className="min-h-screen bg-[#05070d]">
      <DigitalTwinDashboard 
        data={trusted} 
        selectedVehicleId={selectedVehicleId} 
        onVehicleChange={setSelectedVehicleId} 
        onProvisionSite={handleProvisionSite} 
      />
      <div className="mx-auto max-w-[1680px] px-5 pb-10 lg:px-8">
        <TruckHeatmap vehicles={trusted.vehicles} onSelectVehicle={setSelectedVehicleId} />
      </div>
    </main>
  );
}