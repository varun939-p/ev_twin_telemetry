"use client";

/**
 * Optional first-run convenience for unauthenticated LOCAL development only.
 * Production ingestion belongs to cron/the worker, never the browser. Every
 * Python write route stays bearer-protected when CRON_SECRET is configured.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { readIngestResponse } from "@/lib/ingest-response";
import type { TelemetrySource } from "@/lib/trusted-telemetry";

const TRIGGER_KEY = "twin-auto-ingest-triggered";
const TRIGGER_COOLDOWN_MS = 60_000;

export default function AutoIngestTrigger({ source, sourceNote, enabled = false }: {
  source: TelemetrySource;
  sourceNote: string | null;
  enabled?: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<{ busy: boolean; message: string } | null>(null);
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
      setStatus({ busy: true, message: "Fetching telemetry from upstream…" });
      timeout = setTimeout(() => controller.abort(), 65_000);
      try {
        const response = await fetch("/api/ingest/run", {
          method: "POST", headers: { Accept: "application/json" }, signal: controller.signal,
        });
        const result = await readIngestResponse(response);
        if (cancelled) return;
        setStatus({ busy: false, message: result.message });
        if (result.refresh) router.refresh();
      } catch {
        if (cancelled) return;
        setStatus({ busy: false, message: controller.signal.aborted
          ? "Ingestion request timed out. Check ingestion status before retrying."
          : "Backend unreachable. Start the control plane and check BACKEND_URL." });
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

  if (!enabled || source !== "waiting" || !status) return null;
  return (
    <div role="status" aria-live="polite" className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-line bg-surface px-4 py-3 shadow-lg">
      <div className="flex items-start gap-3">
        {status.busy && <div aria-hidden className="mt-0.5 h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />}
        <div className="flex-1">
          <p className="text-xs font-medium text-ink">{status.message}</p>
          {sourceNote && <p className="mt-1 text-[11px] text-ink-2">{sourceNote}</p>}
        </div>
      </div>
    </div>
  );
}
