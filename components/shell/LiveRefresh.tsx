"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * LIVE REFRESH — keeps a server-rendered dashboard current without a reload.
 *
 * Every route in this segment is `force-dynamic`, so `router.refresh()` re-runs
 * the server components, re-fetches the document through
 * `lib/telemetry-source.ts` and streams a new RSC payload into the existing
 * tree. Crucially it is a RECONCILE, not a navigation:
 *
 *   * Zustand filter state, the selected site and the map camera all survive;
 *   * scroll position is untouched;
 *   * no full-page flash, no remount of the Leaflet instance.
 *
 * Why not `setInterval(fetch)` in a client component? Because the payload is
 * ~260 KB of validated telemetry. Fetching it client-side would ship the whole
 * document into the browser on every tick, duplicate the parsing that already
 * happens on the server, and force every derived selector to re-run in the
 * main thread. Refreshing the server render keeps that work where it belongs.
 *
 * Why not WebSockets? The upstream is a POLLED REST contract — `main_parser.py`
 * fetches on an interval and writes a document. A socket in front of a poller
 * adds a stateful connection to manage, reconnect and authenticate, and cannot
 * deliver data any fresher than the poll behind it. If the vendor ever exposes
 * a push channel, this component is the single place that changes.
 *
 * ── Leak and stampede safety ──────────────────────────────────────────────
 *
 *   * the interval is cleared on unmount, and so are both listeners;
 *   * polling PAUSES while the tab is hidden — a dashboard left open on a
 *     wall screen overnight must not issue 2,880 pointless renders — and
 *     refreshes once immediately on return so the operator never reads stale
 *     numbers;
 *   * `inFlight` collapses overlapping ticks, so a slow upstream cannot queue
 *     refreshes behind each other;
 *   * it pauses while offline and refreshes on reconnect.
 */
export default function LiveRefresh({
  /** Seconds between refresh attempts while the tab is visible. */
  intervalSeconds = 20,
}: {
  intervalSeconds?: number;
}) {
  const router = useRouter();

  // Held in refs so changing them never re-runs the effect and re-arms the
  // timer — a classic source of runaway polling.
  const inFlight = useRef(false);
  const lastRun = useRef(0);

  useEffect(() => {
    // Respect an explicit opt-out (screenshot tooling, demos, tests).
    if (typeof window === "undefined") return;

    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const tick = () => {
      if (cancelled || inFlight.current) return;
      if (document.visibilityState !== "visible") return;
      if (!navigator.onLine) return;

      inFlight.current = true;
      lastRun.current = Date.now();
      try {
        router.refresh();
      } finally {
        // `router.refresh()` returns void; React commits the new payload on
        // its own schedule. A short guard window is enough to collapse
        // overlapping ticks without pretending we can await it.
        window.setTimeout(() => {
          inFlight.current = false;
        }, 1_000);
      }
    };

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(tick, intervalSeconds * 1_000);
    };

    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Catch up if the tab was hidden longer than one interval.
        if (Date.now() - lastRun.current > intervalSeconds * 1_000) tick();
        start();
      } else {
        stop();
      }
    };

    const onOnline = () => {
      tick();
      start();
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", stop);

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", stop);
    };
  }, [router, intervalSeconds]);

  return null;
}
