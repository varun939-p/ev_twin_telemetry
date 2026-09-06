import { Suspense } from "react";

import { loadTelemetry } from "@/lib/document";

import TruckTelemetryView from "./truck-telemetry-view";

export const metadata = { title: "Truck Telemetry" };

/**
 * Server component: awaits the validated document and streams it as props, so
 * the payload never ships as a client import.
 *
 * The Suspense boundary is required by `useSearchParams()` inside the view
 * (deep links such as `?vehicle_id=...` are a client concern).
 */
export default async function TruckTelemetryPage() {
  const { doc } = await loadTelemetry();
  return (
    <Suspense fallback={<div className="h-[70vh] animate-pulse rounded-xl border border-line bg-surface" />}>
      <TruckTelemetryView data={doc} />
    </Suspense>
  );
}
