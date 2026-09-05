import { TRUSTED_DOC } from "@/lib/document";

import SwapStationView from "./swap-station-view";

export const metadata = { title: "Swap Station" };

export default function SwapStationPage() {
  return <SwapStationView data={TRUSTED_DOC} />;
}
