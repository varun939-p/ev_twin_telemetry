import DraftNotice from "@/components/ui/DraftNotice";
import { KpiCard, Metric } from "@/components/ui/Metric";
import { Pill } from "@/components/ui/Pill";
import { Card, CardHeader, EmptyState, Hairline, PageHeading } from "@/components/ui/Surface";

/**
 * DG (backup diesel generator) — DRAFT scaffold (3:00 PM review scope).
 *
 * Structure mirrors Chargers, which mirrors Truck / Battery: KPI strip,
 * register, analytics slot, nameplate.  Every live value renders its honest
 * "awaiting upstream" state — the DG is not on the vehicle feed at all, and a
 * fabricated fuel gauge in a client demo is exactly the kind of number that
 * gets quoted back at you in procurement.
 */

const AWAITING = "The DG controller is not on the v1 feed — this tile is wired and waiting.";

export const metadata = { title: "DG" };

export default function DgPage() {
  return (
    <div className="space-y-4">
      <PageHeading
        title="Backup Diesel Generator"
        subtitle="125 kVA standby set on the site bus — picks up whatever the grid feeder cannot."
        actions={<Pill tone="warn" dot>Draft</Pill>}
      />

      <DraftNotice
        scope="DG — structure only, matching the Chargers and Battery page patterns."
        needs={["dg_running", "dg_load_kw", "fuel_level_pct", "runtime_hours", "coolant_temp_c", "start_events"]}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Run state" value={null} tone="warn" unavailableReason={AWAITING} />
        <KpiCard label="Load picked up" value={null} unit="kW" tone="info" unavailableReason={AWAITING} />
        <KpiCard label="Fuel level" value={null} unit="%" tone="ok" unavailableReason={AWAITING} />
        <KpiCard label="Runtime this month" value={null} unit="h" tone="neutral" unavailableReason={AWAITING} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            eyebrow="Analytics"
            title="Run history & fuel burn"
            description="Start events against site demand — the report generator from Battery Tracking, pointed at DG series."
          />
          <Hairline />
          <div className="p-4">
            <EmptyState
              title="No DG run history to plot"
              hint="Needs dg_running transitions plus fuel_level_pct sampled over time."
            />
          </div>
        </Card>

        <Card>
          <CardHeader eyebrow="Nameplate" title="Set specification" />
          <Hairline />
          <div className="grid grid-cols-2 gap-2 p-4">
            <Metric label="Rated output" value={125} unit=" kVA" />
            <Metric label="Continuous" value={100} unit=" kW" />
            <Metric label="Tank" value={230} unit=" L" />
            <Metric label="Transfer" value="Auto" />
          </div>
          <Hairline />
          <p className="px-4 py-3 text-[11px] leading-relaxed text-ink-2">
            Nameplate figures are site configuration, not telemetry — they come from the provisioning record, which is
            why they render as values while every live reading above renders as awaiting upstream.
          </p>
        </Card>
      </div>

      <Card>
        <CardHeader eyebrow="Event log" title="Start / stop events" description="Append-only log, sourced from the DG controller." />
        <Hairline />
        <div className="p-4">
          <EmptyState title="No events" hint="Populated once the controller publishes start_events." />
        </div>
      </Card>
    </div>
  );
}
