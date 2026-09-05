import { Suspense } from "react";

import { TRUSTED_DOC } from "@/lib/document";

import TruckTelemetryView from "./truck-telemetry-view";

export const metadata = { title: "Truck Telemetry" };

/**
 * Server component: reads the validated document and streams it as props, so
 * the 260 KB payload never ships as a client import.
 *
 * The Suspense boundary is required by `useSearchParams()` inside the view
 * (deep links such as `?vehicle_id=...` are a client concern) — without it the
 * whole route would be forced to dynamic rendering.
 */
export default function TruckTelemetryPage() {
  return (
    <Suspense fallback={<div className="h-[70vh] animate-pulse rounded-xl border border-line bg-surface" />}>
      <TruckTelemetryView data={TRUSTED_DOC} />
    </Suspense>
  );
}
