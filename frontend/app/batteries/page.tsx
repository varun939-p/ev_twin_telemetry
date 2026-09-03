import document from "@/data/trusted_vehicle_telemetry.json";
import type { TrustedTelemetryDocument } from "@/lib/trusted-telemetry";

import BatteriesView from "./batteries-view";

/**
 * Server component: the validated document is read here and streamed as props
 * so it never enters the client bundle.  Same boundary contract as `/`.
 */
const trusted = document as unknown as TrustedTelemetryDocument;

export const metadata = { title: "Batteries Dashboard — Digital Twin" };

export default function BatteriesPage() {
  return <BatteriesView data={trusted} />;
}
