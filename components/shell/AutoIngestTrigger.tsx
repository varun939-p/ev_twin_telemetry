"use client";

/**
 * AUTO-INGEST TRIGGER — fires when the dashboard has no data.
 *
 * When the dashboard loads and finds the database empty (or very stale), this
 * component automatically triggers an ingestion cycle by calling the backend.
 * It then refreshes the page to show the newly fetched data.
 *
 * This solves the "first deploy" problem: the operator configures credentials,
 * deploys to Vercel, opens the dashboard, and sees real data within seconds
 * instead of waiting for the cron job or manually triggering ingestion.
 *
 * SAFETY:
 *   * Only triggers when `source === "waiting"` (no data in DB)
 *   * Only triggers ONCE per page load (tracked by sessionStorage)
 *   * Respects a 60-second cooldown to prevent rapid-fire triggers
 *   * Never blocks the UI — fires asynchronously and refreshes when done
 */

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { TelemetrySource } from "@/lib/trusted-telemetry";

const TRIGGER_KEY = "twin-auto-ingest-triggered";
const TRIGGER_COOLDOWN_MS = 60_000; // 60 seconds between triggers

export default function AutoIngestTrigger({
  source,
  sourceNote,
}: {
  source: TelemetrySource;
  sourceNote: string | null;
}) {
  const router = useRouter();
  const [triggering, setTriggering] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const triggeredRef = useRef(false);

  useEffect(() => {
    // Only trigger when waiting for data
    if (source !== "waiting") return;

    // Check if we already triggered recently (prevent rapid-fire)
    const lastTriggered = sessionStorage.getItem(TRIGGER_KEY);
    if (lastTriggered) {
      const elapsed = Date.now() - parseInt(lastTriggered, 10);
      if (elapsed < TRIGGER_COOLDOWN_MS) {
        return;
      }
    }

    // Only trigger once per page load
    if (triggeredRef.current) return;
    triggeredRef.current = true;

    // Mark that we're triggering
    setTriggering(true);
    setMessage("Fetching live data from upstream API...");
    sessionStorage.setItem(TRIGGER_KEY, Date.now().toString());

    // Trigger ingestion via the dashboard-specific endpoint (no CRON_SECRET needed)
    fetch("/api/ingest/trigger", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    })
      .then((res) => {
        if (res.ok) {
          setMessage("Data received! Refreshing dashboard...");
          // Wait a moment for the user to see the message, then refresh
          setTimeout(() => {
            router.refresh();
          }, 1500);
        } else {
          return res.json().then((data) => {
            console.error("Auto-ingest failed:", data);
            setMessage(`Could not fetch data: ${data.detail || "Unknown error"}`);
            setTriggering(false);
          });
        }
      })
      .catch((err) => {
        console.error("Auto-ingest error:", err);
        setMessage("Could not connect to ingestion endpoint.");
        setTriggering(false);
      });
  }, [source, router]);

  // Only show UI when triggering or when there's a message
  if (!triggering && !message) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-line bg-surface px-4 py-3 shadow-lg">
      <div className="flex items-start gap-3">
        {triggering && (
          <div className="mt-0.5 h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        )}
        <div className="flex-1">
          <p className="text-xs font-medium text-ink">{message}</p>
          {sourceNote && (
            <p className="mt-1 text-[11px] text-ink-3">{sourceNote}</p>
          )}
        </div>
      </div>
    </div>
  );
}
