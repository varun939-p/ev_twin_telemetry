"use client";

/**
 * DigitalTwinDashboard -- real-time asset layer of the digital twin.
 *
 * Data contract unchanged: every figure comes from the validated document and a
 * parameter whose `field_status` is not "measured" is rendered as an explicitly
 * disabled tile -- never as `0`.  All presentation is cosmetic; no selector or
 * validation behaviour lives in this file beyond consuming `lib/trusted-telemetry`.
 *
 * Presentation philosophy (executive tier): deep, translucent surfaces with soft
 * hairlines and generous negative space instead of boxy borders; muted,
 * wide-tracked micro-labels so the data values carry the page; a single pulsing
 * "Live" status instead of debug pills.  All ages derive from the document's own
 * `generated_at`, so server and client markup match exactly.
 */

import { useMemo, useState } from "react";

import { batteryRegistry, type BatteryIdentity } from "@/lib/fleet";
import {
  FIELD_GROUPS,
  STATUS_COPY,
  fleetSummary,
  formatAge,
  formatValue,
  frameAgeHours,
  isMeasured,
  numericValue,
  orderedParams,
  type FieldStatus,
  type ParameterHealth,
  type SiteConfig,
  type TrustedTelemetryDocument,
  type TrustedVehicle,
} from "@/lib/trusted-telemetry";

/* ------------------------------------------------------------------ props */

export interface ProvisionOutcome {
  ok: boolean;
  message: string;
}

export interface DigitalTwinDashboardProps {
  data: TrustedTelemetryDocument;
  sites?: SiteConfig[];
  activeSiteId?: string;
  onProvisionSite?: (site: SiteConfig) => void | Promise<ProvisionOutcome | void>;
  selectedVehicleId?: string;
  onVehicleChange?: (vehicleId: string) => void;
  className?: string;
}

const DEFAULT_SITES: SiteConfig[] = [
  { siteId: "FLEET", label: "Fleet-wide twin", customer: "Blue Energy Motors", chargers: 0, dgCapacityKw: 0, gridFeederKw: 0 },
];

/* ------------------------------------------------------------------ style */

const CARD = "rounded-2xl border border-white/[0.06] bg-slate-900/40 backdrop-blur-md";
const EYEBROW = "text-[10px] font-medium uppercase tracking-[0.24em] text-slate-500";
const HAIRLINE = "h-px bg-white/[0.06]";

/* ---------------------------------------------------------------- live pill */

function LiveBadge({ lastSync }: { lastSync: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-full border border-emerald-400/20 bg-emerald-400/[0.08] px-4 py-2">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
      </span>
      <span className="text-xs font-medium tracking-wide text-emerald-300">Live System Active</span>
      <span className="text-[10px] text-emerald-200/50">· last sync {lastSync}</span>
    </div>
  );
}

/* --------------------------------------------------------------- pipeline */

const PIPELINE = [
  { id: "grid", label: "Grid Data", sub: "Feeder load & tariffs", state: "upstream" },
  { id: "forecaster", label: "Forecaster", sub: "Demand model", state: "upstream" },
  { id: "twin", label: "Digital Twin", sub: "Real-time asset info", state: "active" },
  { id: "optimizer", label: "Optimizer", sub: "Charge vs DG arbitrage", state: "gated" },
  { id: "scheduler", label: "Scheduler", sub: "Slot & swap assignment", state: "gated" },
] as const;

function PipelineRail({ assets }: { assets: number }) {
  return (
    <section className={`${CARD} px-6 py-5`}>
      <div className="mb-4 flex items-center justify-between">
        <h2 className={EYEBROW}>Product Data Flow</h2>
        <span className="text-[11px] text-slate-600">Only the Twin reads validated telemetry today</span>
      </div>
      <ol className="flex items-center gap-0">
        {PIPELINE.map((stage, index) => {
          const active = stage.state === "active";
          return (
            <li key={stage.id} className="flex flex-1 items-center">
              <div className="flex items-center gap-3">
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  {active && <span className="absolute h-full w-full animate-ping rounded-full bg-cyan-400 opacity-50" />}
                  <span className={`relative h-2.5 w-2.5 rounded-full ${active ? "bg-cyan-400" : stage.state === "upstream" ? "bg-slate-600" : "bg-slate-700"}`} />
                </span>
                <span className="min-w-0">
                  <span className={`block text-sm font-medium ${active ? "text-cyan-200" : stage.state === "upstream" ? "text-slate-300" : "text-slate-500"}`}>
                    {stage.label}
                  </span>
                  <span className="block truncate text-[11px] text-slate-600">{active ? `${assets} assets live` : stage.sub}</span>
                </span>
              </div>
              {index < PIPELINE.length - 1 && <span className="mx-4 h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* -------------------------------------------------------------------- KPI */

function KpiStrip({
  summary,
  chargingNow,
  avgBatteryTempC,
}: {
  summary: ReturnType<typeof fleetSummary>;
  chargingNow: number;
  avgBatteryTempC: number | null;
}) {
  /** Operational-first strip: what the fleet is DOING right now.  Parameter
   *  completeness lives in the pipeline-health rail, not above the fold. */
  const items: { label: string; value: string; hint: string; tone?: "accent" | "warn" }[] = [
    { label: "Battery Assets", value: String(summary.assets), hint: `${summary.stationary} stationary` },
    { label: "Charging Now", value: String(chargingNow), hint: "packs on the charger", tone: "accent" },
    { label: "Median SOC", value: summary.socMedian === null ? "—" : `${summary.socMedian}%`, hint: `min ${summary.socMin ?? "—"}% across the fleet` },
    {
      label: "Low SOC Alerts",
      value: String(summary.lowSoc),
      hint: "packs under 20% — schedule swaps",
      tone: summary.lowSoc ? "warn" : undefined,
    },
    { label: "Avg Pack Temp", value: avgBatteryTempC === null ? "—" : `${avgBatteryTempC}°C`, hint: "fleet mean battery temperature" },
    {
      label: "Median Frame Age",
      value: formatAge(summary.medianFrameAgeHours),
      hint: `${summary.staleOver24h} over 24 h`,
      tone: summary.staleOver24h ? "warn" : undefined,
    },
  ];

  return (
    <section className={`${CARD} grid grid-cols-2 divide-x divide-white/[0.06] md:grid-cols-3 xl:grid-cols-6`}>
      {items.map((item) => (
        <div key={item.label} className="px-6 py-5">
          <p className={EYEBROW}>{item.label}</p>
          <p
            className={`mt-2 text-3xl font-semibold tracking-tight tabular-nums ${
              item.tone === "accent" ? "text-cyan-300" : item.tone === "warn" ? "text-amber-300" : "text-white"
            }`}
          >
            {item.value}
          </p>
          <p className="mt-1 text-[11px] text-slate-600">{item.hint}</p>
        </div>
      ))}
    </section>
  );
}

/* ----------------------------------------------------------- vehicle list */

function VehicleList({
  vehicles,
  registry,
  selectedId,
  onSelect,
  attentionIds,
  now,
}: {
  vehicles: TrustedVehicle[];
  registry: ReadonlyMap<string, BatteryIdentity>;
  selectedId: string;
  onSelect: (id: string) => void;
  attentionIds: Set<string>;
  now: Date;
}) {
  const [query, setQuery] = useState("");
  const [onlyAttention, setOnlyAttention] = useState(false);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return vehicles
      .filter((v) => (q ? v.vehicle_id.toLowerCase().includes(q) || (registry.get(v.vehicle_id)?.label.toLowerCase().includes(q) ?? false) : true))
      .filter((v) => (onlyAttention ? attentionIds.has(v.vehicle_id) : true))
      .sort((a, b) => {
        // Battery order first (Battery 1, Battery 2, ...), then the rest.
        const aIdx = registry.has(a.vehicle_id) ? 0 : 1;
        const bIdx = registry.has(b.vehicle_id) ? 0 : 1;
        return aIdx !== bIdx ? aIdx - bIdx : a.vehicle_id.localeCompare(b.vehicle_id);
      });
  }, [vehicles, query, onlyAttention, attentionIds, registry]);

  return (
    // `xl:self-start` is the load-bearing fix: it opts this column out of the grid's
    // default stretch so the card hugs its content instead of mirroring the tall
    // middle column. `h-full` and `flex-1` are deliberately gone.
    <section className={`${CARD} overflow-hidden xl:self-start`}>
      <header className="px-4 pb-3 pt-4">
        <div className="flex items-center justify-between">
          <h2 className={EYEBROW}>Assets</h2>
          <span className="text-[11px] tabular-nums text-slate-600">{rows.length}</span>
        </div>
        <div className="mt-3 flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search battery or carrier…"
            className="w-full rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-cyan-400/40"
          />
          <button
            type="button"
            onClick={() => setOnlyAttention((v) => !v)}
            className={`shrink-0 rounded-lg px-3 py-2 text-[11px] font-medium transition ${
              onlyAttention ? "bg-amber-400/15 text-amber-300" : "text-slate-500 hover:text-slate-300"
            }`}
          >
            Attention
          </button>
        </div>
      </header>

      <div className={HAIRLINE} />

      <ul className="max-h-[40rem] overflow-y-auto py-2">
        {rows.map((vehicle) => {
          const active = vehicle.vehicle_id === selectedId;
          const identity = registry.get(vehicle.vehicle_id);
          const ageHours = vehicle.observed_at ? frameAgeHours(vehicle.observed_at, now) : Number.NaN;
          const stale = Number.isFinite(ageHours) && ageHours > 24;
          const soc = typeof vehicle.values.soc === "number" ? vehicle.values.soc : null;
          return (
            <li key={vehicle.vehicle_id} className="px-2">
              <button
                type="button"
                onClick={() => onSelect(vehicle.vehicle_id)}
                className={`relative w-full rounded-xl px-3 py-2.5 text-left transition ${
                  active ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"
                }`}
              >
                {active && <span className="absolute left-0 top-2 h-[calc(100%-1rem)] w-0.5 rounded-full bg-cyan-400" />}
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] font-semibold text-white">{identity?.label ?? vehicle.vehicle_id}</span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-cyan-300">{soc === null ? "—" : `${soc}%`}</span>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-slate-600">
                  <span className="truncate font-mono">{identity?.chassis ?? vehicle.vehicle_id}</span>
                  <span className={stale ? "shrink-0 text-amber-400/90" : "shrink-0"}>
                    {Number.isFinite(ageHours) ? `${formatAge(ageHours)} old` : "no frame"}
                  </span>
                </div>
              </button>
            </li>
          );
        })}
        {rows.length === 0 && <li className="px-4 py-6 text-center text-xs text-slate-600">No asset matches that filter.</li>}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------- param tile */

function ParamTile({ vehicle, param }: { vehicle: TrustedVehicle; param: ParameterHealth }) {
  const status: FieldStatus = vehicle.field_status[param.field] ?? "absent_upstream";
  const measured = status === "measured";
  const copy = STATUS_COPY[status];
  const text = measured ? formatValue(vehicle.values[param.field] ?? null, param.unit) : null;
  const error = vehicle.field_errors.find((e) => e.field === param.field);

  return (
    <div
      aria-disabled={!measured}
      title={measured ? param.label : `${copy.short} — ${copy.detail}`}
      className={[
        "group rounded-xl p-3.5 transition",
        measured ? "bg-white/[0.03] hover:bg-white/[0.05]" : "cursor-not-allowed opacity-40",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-1">
        <p className="text-[9px] font-medium uppercase tracking-[0.18em] text-slate-500">{param.label}</p>
        {!measured && (
          <svg viewBox="0 0 20 20" className="h-3 w-3 shrink-0 text-slate-600" aria-hidden>
            <path
              fill="currentColor"
              d="M10 2a4 4 0 0 0-4 4v2H5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-1V6a4 4 0 0 0-4-4Zm2 6H8V6a2 2 0 1 1 4 0v2Z"
            />
          </svg>
        )}
      </div>
      <p className={`mt-2 text-xl font-semibold tracking-tight tabular-nums ${measured ? "text-white" : "text-slate-600"}`}>
        {text ?? "—"}
      </p>
      {measured ? (
        <p className="mt-1 text-[10px] text-slate-600">{param.unit || (param.logical_type === "int" ? "count" : "text")}</p>
      ) : (
        <p className="mt-1 truncate text-[9px] font-medium uppercase tracking-[0.14em] text-slate-600">{copy.short}</p>
      )}
      {error && <p className="mt-1 truncate text-[10px] text-rose-400/70">{error.error}</p>}
    </div>
  );
}

/* ------------------------------------------------------------ site config */

function SiteProvisioner({ sites, activeSite, onProvisionSite }: { sites: SiteConfig[]; activeSite: SiteConfig; onProvisionSite?: (site: SiteConfig) => void | Promise<ProvisionOutcome | void> }) {
  const [draft, setDraft] = useState<SiteConfig>({ siteId: "", label: "", customer: activeSite.customer, chargers: 4, dgCapacityKw: 500, gridFeederKw: 250 });
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const field = "w-full rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2 text-xs text-slate-100 outline-none focus:border-cyan-400/40";
  const label = "mb-1.5 block text-[9px] font-medium uppercase tracking-[0.18em] text-slate-600";

  const submit = async () => {
    if (submitting) return;
    if (!draft.siteId.trim()) { setMessage("Site ID is required."); return; }
    if (!onProvisionSite) { setMessage("Host app has not wired onProvisionSite yet."); return; }
    
    const site = { ...draft, siteId: draft.siteId.trim(), label: draft.label || draft.siteId.trim() };
    setSubmitting(true);
    setMessage("Contacting backend…");
    
    try {
      const outcome = await onProvisionSite(site);
      setMessage(outcome && typeof outcome === "object" ? outcome.message : `Provisioning request sent for ${site.siteId}.`);
    } catch {
      setMessage("Provisioning failed — backend unreachable.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className={`${CARD} px-5 py-5`}>
      <div className="flex items-center justify-between">
        <h2 className={EYEBROW}>Multi-Site Provisioning</h2>
        <span className="rounded-full border border-white/[0.08] px-2.5 py-0.5 font-mono text-[10px] text-slate-500">{activeSite.siteId}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {sites.map((site) => (
          <span key={site.siteId} className={`rounded-full px-3 py-1 text-[11px] ${site.siteId === activeSite.siteId ? "bg-cyan-400/10 text-cyan-200" : "text-slate-500"}`}>{site.label}</span>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div><label className={label} htmlFor="site-id">Site ID</label><input id="site-id" className={field} value={draft.siteId} onChange={(e) => setDraft({ ...draft, siteId: e.target.value })} placeholder="SWP-PUNE-01" /></div>
        <div><label className={label} htmlFor="site-customer">Customer</label><input id="site-customer" className={field} value={draft.customer} onChange={(e) => setDraft({ ...draft, customer: e.target.value })} /></div>
        <div><label className={label} htmlFor="site-chargers">Chargers</label><input id="site-chargers" type="number" min={0} className={field} value={draft.chargers} onChange={(e) => setDraft({ ...draft, chargers: Number(e.target.value) })} /></div>
        <div><label className={label} htmlFor="site-dg">DG Capacity (kW)</label><input id="site-dg" type="number" min={0} className={field} value={draft.dgCapacityKw} onChange={(e) => setDraft({ ...draft, dgCapacityKw: Number(e.target.value) })} /></div>
        <div className="col-span-2"><label className={label} htmlFor="site-feeder">Grid Feeder (kW)</label><input id="site-feeder" type="number" min={0} className={field} value={draft.gridFeederKw} onChange={(e) => setDraft({ ...draft, gridFeederKw: Number(e.target.value) })} /></div>
      </div>
      <button type="button" onClick={submit} disabled={submitting} className="mt-4 w-full rounded-lg bg-cyan-400/90 px-4 py-2.5 text-xs font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60">
        {submitting ? "Provisioning…" : "Spin up isolated twin"}
      </button>
      {message && <p className="mt-2 text-[11px] text-amber-400/90">{message}</p>}
    </section>
  );
}

/* -------------------------------------------------------------- dashboard */

export default function DigitalTwinDashboard({
  data,
  sites = DEFAULT_SITES,
  activeSiteId,
  onProvisionSite,
  selectedVehicleId,
  onVehicleChange,
  className = "",
}: DigitalTwinDashboardProps) {
  const activeSite = sites.find((s) => s.siteId === activeSiteId) ?? sites[0];
  const referenceTime = useMemo(() => new Date(data.generated_at), [data.generated_at]);

  const vehicles = useMemo(
    () => (activeSite.vehicleFilter ? data.vehicles.filter(activeSite.vehicleFilter) : data.vehicles),
    [data.vehicles, activeSite],
  );

  const params = useMemo(() => orderedParams(data), [data]);
  const summary = useMemo(() => fleetSummary(data, referenceTime), [data, referenceTime]);
  const attentionIds = useMemo(() => new Set(data.pipeline_health.attention.map((a) => a.vehicle_id)), [data]);

  /** Battery-first identity: built once over the full site scope so labels
   *  ("Battery 1", "Battery 2", ...) are stable everywhere. */
  const registry = useMemo(() => batteryRegistry(vehicles), [vehicles]);

  /** Operational roll-ups for the KPI strip. */
  const batteryStats = useMemo(() => {
    let chargingNow = 0;
    let tempSum = 0;
    let tempCount = 0;
    for (const vehicle of vehicles) {
      if (numericValue(vehicle, "charging_status") === 1) chargingNow += 1;
      const temp = numericValue(vehicle, "battery_temp_c");
      if (temp !== null) {
        tempSum += temp;
        tempCount += 1;
      }
    }
    return { chargingNow, avgBatteryTempC: tempCount ? Math.round((tempSum / tempCount) * 10) / 10 : null };
  }, [vehicles]);

  const [internalId, setInternalId] = useState(vehicles[0]?.vehicle_id ?? "");
  const [showUnavailable, setShowUnavailable] = useState(true);

  const selectedId = selectedVehicleId ?? internalId;
  const select = (id: string) => {
    setInternalId(id);
    onVehicleChange?.(id);
  };

  const selected = vehicles.find((v) => v.vehicle_id === selectedId) ?? vehicles[0];
  const paramByField = useMemo(() => new Map(params.map((p) => [p.field, p])), [params]);

  const selectedAge = selected?.observed_at ? frameAgeHours(selected.observed_at, referenceTime) : Number.NaN;
  const lastSync = data.pipeline_health.newest_observed_at ? formatAge(frameAgeHours(data.pipeline_health.newest_observed_at, referenceTime)) : "—";

  return (
    <div className={`min-h-screen bg-[#05070d] text-slate-100 ${className}`}>
      <div className="mx-auto max-w-[1680px] space-y-5 p-5 lg:p-8">
        {/* ---------------------------------------------------------- header */}
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.32em] text-cyan-400/90">EV Battery Swap Station</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">Digital Twin — Real-Time Asset Layer</h1>
            <p className="mt-1.5 text-sm text-slate-500">
              {activeSite.label} · {activeSite.customer} · {summary.assets} battery assets live
            </p>
          </div>
          <LiveBadge lastSync={lastSync} />
        </header>

        <PipelineRail assets={summary.assets} />
        <KpiStrip summary={summary} chargingNow={batteryStats.chargingNow} avgBatteryTempC={batteryStats.avgBatteryTempC} />

        {/* -------------------------------------------------------- main grid */}
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
          <div className="xl:col-span-2">
            <VehicleList vehicles={vehicles} registry={registry} selectedId={selected?.vehicle_id ?? ""} onSelect={select} attentionIds={attentionIds} now={referenceTime} />
          </div>

          <div className="space-y-5 xl:col-span-7">
            {selected ? (
              <section className={`${CARD} px-6 py-6`}>
                <header className="flex flex-wrap items-end justify-between gap-3 pb-5">
                  <div>
                    <p className={EYEBROW}>Battery Pack</p>
                    <h2 className="mt-1 text-xl font-semibold tracking-tight text-white">
                      {registry.get(selected.vehicle_id)?.label ?? selected.vehicle_id}
                    </h2>
                    <p className="mt-1 text-[11px] text-slate-600">
                      carrier <span className="font-mono text-slate-400">{registry.get(selected.vehicle_id)?.chassis ?? selected.vehicle_id}</span> ·{" "}
                      Frame {selected.observed_at ? new Date(selected.observed_at).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "missing"} ·{" "}
                      {Number.isFinite(selectedAge) ? `${formatAge(selectedAge)} old` : "unknown age"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-3xl font-semibold tracking-tight tabular-nums text-cyan-300">
                      {numericValue(selected, "soc") === null ? "—" : `${numericValue(selected, "soc")}%`}
                    </p>
                    <p className="text-[11px] text-slate-600">State of Charge — primary</p>
                  </div>
                </header>

                <div className={HAIRLINE} />

                {FIELD_GROUPS.map((group) => {
                  const fields = group.fields
                    .map((field) => paramByField.get(field))
                    .filter((p): p is ParameterHealth => Boolean(p))
                    .filter((p) => showUnavailable || isMeasured(selected, p.field));
                  if (fields.length === 0) return null;
                  return (
                    <div key={group.id} className="mt-6 first:mt-5">
                      <div className="mb-3 flex items-center gap-3">
                        <h3 className="text-[10px] font-medium uppercase tracking-[0.2em] text-slate-500">{group.title}</h3>
                        <span className="h-px flex-1 bg-white/[0.05]" />
                        <span className="font-mono text-[10px] tabular-nums text-slate-600">
                          {fields.filter((p) => isMeasured(selected, p.field)).length}/{fields.length} live
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                        {fields.map((param) => (
                          <ParamTile key={param.field} vehicle={selected} param={param} />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </section>
            ) : (
              <section className={`${CARD} px-6 py-14 text-center text-sm text-slate-500`}>
                No validated frame in this scope. {data.pipeline_health.vehicles_accepted} of {data.pipeline_health.vehicles_seen} frames were accepted —
                nothing is rendered rather than inventing one.
              </section>
            )}
          </div>

          <div className="space-y-5 xl:col-span-3 xl:self-start">
            {/* --------------------------------------------- pipeline health */}
            <section className={`${CARD} px-5 py-5`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className={EYEBROW}>Pipeline Health</h2>
                  <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
                    Validation gates held {summary.absentCells + summary.nullCells + summary.errorCells} unusable cells NULL. None displayed as zero.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={showUnavailable}
                  onClick={() => setShowUnavailable((v) => !v)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${showUnavailable ? "bg-amber-400/80" : "bg-white/[0.08]"}`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${showUnavailable ? "left-[1.375rem]" : "left-0.5"}`}
                  />
                </button>
              </div>
              <p className="mt-2 text-[11px] text-slate-600">
                {showUnavailable ? `Showing ${summary.deadParams} unavailable parameters grayed out.` : "Unavailable parameters hidden."}
              </p>

              <div className={`${HAIRLINE} my-4`} />

              <dl className="space-y-3">
                {(Object.keys(STATUS_COPY) as FieldStatus[]).map((status) => {
                  const count =
                    status === "measured"
                      ? summary.assets * 24 - (summary.absentCells + summary.nullCells + summary.errorCells)
                      : status === "absent_upstream"
                        ? summary.absentCells
                        : status === "null_upstream"
                          ? summary.nullCells
                          : summary.errorCells;
                  return (
                    <div key={status} className="flex items-center justify-between">
                      <dt className="flex items-center gap-2.5">
                        <span className={`h-1.5 w-1.5 rounded-full ${status === "measured" ? "bg-emerald-400" : status === "absent_upstream" ? "bg-slate-600" : status === "null_upstream" ? "bg-amber-400" : "bg-rose-400"}`} />
                        <span className="text-xs text-slate-400">{STATUS_COPY[status].short}</span>
                      </dt>
                      <dd className="font-mono text-xs tabular-nums text-slate-500">{count}</dd>
                    </div>
                  );
                })}
              </dl>
            </section>

            <section className={`${CARD} px-5 py-5`}>
              <h2 className={EYEBROW}>Unavailable Upstream ({data.pipeline_health.unavailable_parameters.length})</h2>
              <ul className="mt-4 space-y-3">
                {data.pipeline_health.unavailable_parameters.map((param) => (
                  <li key={param.field} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-xs text-slate-300">{param.label}</p>
                      <p className="truncate font-mono text-[10px] text-slate-600">{param.field}</p>
                    </div>
                    <span className="shrink-0 rounded-full border border-white/[0.08] px-2 py-0.5 font-mono text-[9px] text-slate-500">{param.coverage_pct}%</span>
                  </li>
                ))}
              </ul>
            </section>

            {data.pipeline_health.attention.length > 0 && (
              <section className="rounded-2xl border border-amber-400/15 bg-amber-400/[0.05] px-5 py-5">
                <h2 className={`${EYEBROW} text-amber-300`}>Needs Attention</h2>
                <ul className="mt-3 space-y-3">
                  {data.pipeline_health.attention.map((item) => (
                    <li key={item.vehicle_id}>
                      <button type="button" onClick={() => select(item.vehicle_id)} className="w-full text-left">
                        <p className="truncate font-mono text-xs text-amber-100 hover:underline">{item.vehicle_id}</p>
                        <p className="text-[10px] text-amber-200/60">
                          {item.reason} · {item.measured_count}/24 · {item.observed_at ? `${formatAge(frameAgeHours(item.observed_at, referenceTime))} old` : "no frame"}
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <SiteProvisioner sites={sites} activeSite={activeSite} onProvisionSite={onProvisionSite} />
          </div>
        </div>
      </div>
    </div>
  );
}
