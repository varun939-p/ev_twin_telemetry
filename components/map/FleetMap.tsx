"use client";

import dynamic from "next/dynamic";

import type { MapCluster, MapPoint } from "@/lib/map-data";

/**
 * SSR boundary for the tile map.
 *
 * `leaflet` reads `window` at module scope, so the map can only be imported on
 * the client.  `ssr: false` here (rather than a `typeof window` guard inside
 * the component) means the map's ~150 KB never lands in the server bundle and
 * never blocks the page's first paint: the skeleton below renders instantly,
 * the map streams in behind it.
 */
const LeafletFleetMap = dynamic(() => import("./LeafletFleetMap"), {
  ssr: false,
  loading: () => (
    <div
      className="canvas-dark h-full w-full animate-pulse rounded-lg border border-line bg-surface-2"
      aria-label="Loading map"
    />
  ),
});

export default function FleetMap(props: { points: MapPoint[]; clusters: MapCluster[]; heightClass?: string }) {
  // Own the height so the loading skeleton occupies the exact frame the map
  // will — the old hardcoded h-[460px] under a h-[440px] map shifted the
  // whole page 20px when the bundle arrived.
  return (
    <div className={`${props.heightClass ?? "h-[460px]"} w-full`}>
      <LeafletFleetMap {...props} />
    </div>
  );
}
