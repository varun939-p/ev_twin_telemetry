"use client";

/**
 * Optional first-run convenience for unauthenticated LOCAL development only.
 * Production ingestion belongs to cron/the worker, never the browser. Every
 * Python write route stays bearer-protected when CRON_SECRET is configured.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { readIngestResponse } from "@/lib/ingest-response";
import type { TelemetrySource } from "@/lib/trusted-telemetry";

const TRIGGER_KEY = "twin-auto-ingest-triggered";
const TRIGGER_COOLDOWN_MS = 60_000;

export default function AutoIngestTrigger({ source, enabled = false }: {
  source: TelemetrySource;
  /** Retained for API compatibility; ingestion diagnostics are no longer rendered. */
  sourceNote: string | null;
  enabled?: boolean;
}) {
  const router = useRouter();
  const triggered = useRef(false);

  useEffect(() => {
    if (!enabled || source !== "waiting" || triggered.current) return;
    try {
      const last = Number(sessionStorage.getItem(TRIGGER_KEY));
      if (last > 0 && Date.now() - last < TRIGGER_COOLDOWN_MS) return;
    } catch {
      // Disabled browser storage is not a reason to crash the dashboard.
    }

    let cancelled = false;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // Deferring to a task lets React Strict Mode clean up its first effect
    // without aborting a real request and suppressing the second effect.
    const start = setTimeout(async () => {
      triggered.current = true;
      try { sessionStorage.setItem(TRIGGER_KEY, String(Date.now())); } catch { /* optional */ }
      timeout = setTimeout(() => controller.abort(), 65_000);
      try {
        const response = await fetch("/api/ingest/run", {
          method: "POST", headers: { Accept: "application/json" }, signal: controller.signal,
        });
        const result = await readIngestResponse(response);
        if (cancelled) return;
        if (result.refresh) router.refresh();
      } catch {
        // Local bootstrap remains best-effort and deliberately silent. The
        // dashboard no longer renders ingestion banners or toast notifications.
      } finally {
        clearTimeout(timeout);
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(start);
      clearTimeout(timeout);
      controller.abort();
    };
  }, [enabled, source, router]);

  // Keep the development-only bootstrap side effect, but expose no ingestion
  // banner, toast or live-region notification in the product UI.
  return null;
}
