import { Suspense } from "react";

import { loadTelemetry } from "@/lib/document";

import BatteryTrackingView from "./battery-tracking-view";

export const metadata = { title: "Battery Tracking" };

/** Server component — see `lib/telemetry-source.ts` for the data boundary. */
export default async function BatteryTrackingPage() {
  const { doc } = await loadTelemetry();
  return (
    <Suspense fallback={<div className="h-[70vh] animate-pulse rounded-xl border border-line bg-surface" />}>
      <BatteryTrackingView data={doc} />
    </Suspense>
  );
}
