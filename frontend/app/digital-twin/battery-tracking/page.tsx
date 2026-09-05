import { Suspense } from "react";

import { TRUSTED_DOC } from "@/lib/document";

import BatteryTrackingView from "./battery-tracking-view";

export const metadata = { title: "Battery Tracking" };

/** Server component — see the comment in `lib/document.ts` for the boundary. */
export default function BatteryTrackingPage() {
  return (
    <Suspense fallback={<div className="h-[70vh] animate-pulse rounded-xl border border-line bg-surface" />}>
      <BatteryTrackingView data={TRUSTED_DOC} />
    </Suspense>
  );
}
