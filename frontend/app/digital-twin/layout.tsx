import type { ReactNode } from "react";

import AppShell from "@/components/shell/AppShell";
import { TRUSTED_DOC, feedFreshnessLabel } from "@/lib/document";

/**
 * Digital Twin segment layout — the only chrome in the product.
 *
 * A server component: it reads the validated document to compute the feed
 * freshness chip and hands the shell two primitives (a string and a number),
 * so the 260 KB payload stays out of the client bundle for every route that
 * does not actually need it.
 */
export default function DigitalTwinLayout({ children }: { children: ReactNode }) {
  return (
    <AppShell feedAgeLabel={feedFreshnessLabel()} frameCount={TRUSTED_DOC.vehicles.length}>
      {children}
    </AppShell>
  );
}
