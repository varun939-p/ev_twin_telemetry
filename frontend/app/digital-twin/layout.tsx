import type { ReactNode } from "react";

import AppShell from "@/components/shell/AppShell";
import LiveRefresh from "@/components/shell/LiveRefresh";
import { feedFreshnessLabel, loadTelemetry, measuredChannelCount } from "@/lib/document";

/**
 * Digital Twin segment layout — the only chrome in the product.
 *
 * A server component: it awaits the current document to compute the feed
 * chips and hands the shell primitives (strings and numbers), so the payload
 * stays out of the client bundle for every route.
 *
 * `loadTelemetry()` is called here AND in each page. That is intentional and
 * costs nothing: Next dedupes identical fetches within a render pass, so the
 * layout and its page share one upstream response.
 */
/**
 * Render on every request, always.
 *
 * Without this the rendering mode depends on the ENVIRONMENT: with credentials
 * configured the uncached token exchange opts the segment into dynamic
 * rendering, and without them the routes fall back to static ISR. Two
 * different behaviours from the same code, decided by a secret, is exactly the
 * kind of thing that behaves one way in staging and another in production.
 *
 * Dynamic is also simply correct for an authenticated operations surface:
 *   * fleet data must never sit in a shared/CDN HTML cache;
 *   * the freshness label ("42.0 h old") is computed at render time and would
 *     freeze for the whole revalidate window under static rendering.
 *
 * This is NOT a per-request upstream call. The document `fetch` carries its
 * own `next: { revalidate }`, so the data cache still collapses every
 * concurrent viewer onto one control-plane request.
 */
export const dynamic = "force-dynamic";

export default async function DigitalTwinLayout({ children }: { children: ReactNode }) {
  const { doc, source, note } = await loadTelemetry();

  return (
    <AppShell
      feedAgeLabel={feedFreshnessLabel(doc)}
      frameCount={doc.vehicles.length}
      measuredChannels={measuredChannelCount(doc)}
      source={source}
      sourceNote={note}
    >
      {/* Re-runs the server render on an interval so upstream changes appear
          without a reload. Pauses while the tab is hidden or offline. */}
      <LiveRefresh intervalSeconds={20} />
      {children}
    </AppShell>
  );
}
