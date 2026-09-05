import { TRUSTED_DOC } from "@/lib/document";

import CentralView from "./central-view";

export const metadata = { title: "Central Dashboard" };

/** Server component — the validated document is read here and passed down. */
export default function CentralPage() {
  return <CentralView data={TRUSTED_DOC} />;
}
