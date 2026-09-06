"use client";

import { useSyncExternalStore } from "react";

/**
 * OBSERVED SOC HISTORY.
 *
 * The brief asks a flagged battery to explain itself on hover — "dropped 1% in
 * X time". That figure cannot come from the payload: the v1 contract carries
 * ONE frame per vehicle with no history, so any rate printed from a single
 * snapshot would be invented. This module refuses to invent it.
 *
 * Instead it records what the dashboard genuinely observes. Every time the
 * live poll delivers a document, each pack's SOC is sampled against its
 * `observed_at`. Once two DISTINCT frames have been seen, the delta between
 * them is a real measurement of a real change, and the tooltip says so.
 * Until then it reports honestly that it is still establishing a baseline.
 *
 * Design notes:
 *   * samples are keyed on `observedAt`, not on wall-clock arrival — polling
 *     the same unchanged frame 50 times must not manufacture 50 data points;
 *   * each vehicle keeps at most `MAX_SAMPLES`, so a wall display left running
 *     for a week cannot grow this map without bound (the leak this would
 *     otherwise become);
 *   * state lives outside React and is published through
 *     `useSyncExternalStore`, so a tooltip reading it can never tear against a
 *     concurrent render — the same pattern `lib/persisted.ts` uses.
 */

interface Sample {
  /** Epoch ms of the frame's own observation time. */
  at: number;
  soc: number;
}

/** Enough to describe a shift; bounded so memory cannot creep. */
const MAX_SAMPLES = 12;

const history = new Map<string, Sample[]>();
const listeners = new Set<() => void>();

/** Bumped on every real change so `useSyncExternalStore` can cache snapshots. */
let version = 0;

function emit() {
  version += 1;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Records one document's worth of SOC readings.
 *
 * Returns `true` when anything actually changed, so the caller's effect can
 * stay quiet on a poll that delivered an identical document.
 */
export function recordSocSamples(
  frames: ReadonlyArray<{ vehicleId: string; soc: number | null; observedAt: string | null }>,
): boolean {
  let changed = false;

  for (const frame of frames) {
    if (frame.soc === null || !frame.observedAt) continue;
    const at = Date.parse(frame.observedAt);
    if (!Number.isFinite(at)) continue;

    const series = history.get(frame.vehicleId) ?? [];
    const last = series[series.length - 1];

    // Same frame re-delivered by a poll: nothing new was observed.
    if (last && last.at === at) continue;
    // Out-of-order or replayed older frame: ignore rather than corrupt order.
    if (last && at < last.at) continue;

    series.push({ at, soc: frame.soc });
    if (series.length > MAX_SAMPLES) series.splice(0, series.length - MAX_SAMPLES);
    history.set(frame.vehicleId, series);
    changed = true;
  }

  if (changed) emit();
  return changed;
}

export interface SocTrend {
  /** Percentage points moved between the oldest and newest observed frame. */
  deltaPct: number;
  /** Milliseconds between those two frames. */
  elapsedMs: number;
  /** Human phrasing, e.g. "dropped 1% in 12 min". */
  label: string;
}

function humaniseDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = ms / 3_600_000;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)} h`;
  return `${Math.round(hours / 24)} d`;
}

/** Trend across the observed window, or `null` while a baseline is forming. */
export function socTrend(vehicleId: string): SocTrend | null {
  const series = history.get(vehicleId);
  if (!series || series.length < 2) return null;

  const first = series[0];
  const last = series[series.length - 1];
  const deltaPct = last.soc - first.soc;
  const elapsedMs = last.at - first.at;
  if (elapsedMs <= 0) return null;

  const magnitude = Math.abs(deltaPct);
  const window = humaniseDuration(elapsedMs);
  const label =
    deltaPct === 0
      ? `held steady at ${last.soc}% over ${window}`
      : `${deltaPct < 0 ? "dropped" : "recovered"} ${magnitude}% in ${window}`;

  return { deltaPct, elapsedMs, label };
}

/**
 * Subscribes to the trend for one vehicle.
 *
 * The server snapshot is `null`: history is a client-session observation and
 * pretending otherwise would produce a hydration mismatch.
 */
export function useSocTrend(vehicleId: string | null): SocTrend | null {
  return useSyncExternalStore(
    subscribe,
    () => (vehicleId ? cachedTrend(vehicleId) : null),
    () => null,
  );
}

/**
 * `useSyncExternalStore` demands a referentially stable snapshot between
 * changes — returning a fresh object every call would spin an infinite render
 * loop. Results are memoised per vehicle and invalidated by `version`.
 */
const trendCache = new Map<string, { version: number; value: SocTrend | null }>();

function cachedTrend(vehicleId: string): SocTrend | null {
  const hit = trendCache.get(vehicleId);
  if (hit && hit.version === version) return hit.value;
  const value = socTrend(vehicleId);
  trendCache.set(vehicleId, { version, value });
  return value;
}

/** Test/demo hook: forget everything observed so far. */
export function resetSocHistory() {
  history.clear();
  trendCache.clear();
  emit();
}
