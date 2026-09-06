import { loadTelemetry } from "@/lib/document";

import CentralView from "./central-view";

export const metadata = { title: "Central Dashboard" };

/**
 * Server component. Awaits the live document (see `lib/telemetry-source.ts`)
 * and streams it down as props, so the payload never ships as a client import
 * and the credentials never leave the server.
 */
export default async function CentralPage() {
  const { doc } = await loadTelemetry();
  return <CentralView data={doc} />;
}
