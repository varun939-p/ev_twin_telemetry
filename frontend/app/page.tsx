import document from "@/data/trusted_vehicle_telemetry.json";
import type { TrustedTelemetryDocument } from "@/lib/trusted-telemetry";

import TwinView from "./twin-view";

/**
 * Server component: the 260 KB validated document is read here and streamed as
 * props, so it never enters the client bundle.  Swap this import for a
 * `fetch()` against your FastAPI `/telemetry/trusted` route in production --
 * the components do not change.
 *
 * The cast is the TypeScript boundary only: the document was validated field by
 * field in the Python data layer (`telemetry.schemas.parse_payload`), which is
 * the layer that guarantees this shape.
 */
const trusted = document as unknown as TrustedTelemetryDocument;

export default function Page() {
  return <TwinView data={trusted} />;
}
