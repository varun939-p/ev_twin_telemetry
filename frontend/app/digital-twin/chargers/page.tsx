import DraftNotice from "@/components/ui/DraftNotice";
import { KpiCard, Metric } from "@/components/ui/Metric";
import { Pill } from "@/components/ui/Pill";
import { Card, CardHeader, EmptyState, Hairline, PageHeading } from "@/components/ui/Surface";

/**
 * Chargers — DRAFT scaffold (3:00 PM review scope).
 *
 * Deliberately a server component with NO simulation: unlike the Swap Station
 * page there is no real channel to anchor a model to, so every metric renders
 * in its honest "awaiting upstream" state.  The structure mirrors the Truck /
 * Battery pages exactly — KPI strip, register table, detail panel — so the
 * finished page is a data swap, not a redesign.
 */

const UNITS = [
  { id: "A", label: "Dual-gun Charger A", rated: 240, guns: ["A1", "A2"] },
  { id: "B", label: "Dual-gun Charger B", rated: 240, guns: ["B1", "B2"] },
];

const AWAITING = "No charger channel exists in the v1 vehicle feed — this tile is wired and waiting.";

export const metadata = { title: "Chargers" };

export default function ChargersPage() {
  return (
    <div className="space-y-4">
      <PageHeading
        title="Chargers"
        subtitle="Two dual-gun DC units on the site bus — four addressable guns."
        actions={<Pill tone="warn" dot>Draft</Pill>}
      />

      <DraftNotice
        scope="Chargers — structure only, matching the Truck / Battery page pattern."
        needs={["gun_status", "gun_power_kw", "session_id", "energy_delivered_kwh", "connector_temp_c"]}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Guns delivering" value={null} tone="accent" unavailableReason={AWAITING} />
        <KpiCard label="Site charger load" value={null} unit="kW" tone="info" unavailableReason={AWAITING} />
        <KpiCard label="Energy delivered today" value={null} unit="kWh" tone="ok" unavailableReason={AWAITING} />
        <KpiCard label="Faulted guns" value={null} tone="danger" unavailableReason={AWAITING} />
      </div>

      <Card>
        <CardHeader
          eyebrow="Asset register"
          title="Charger units"
          description="Same six-column density budget as the carrier and pack registers; per-gun detail will open in a [Know More] modal."
        />
        <Hairline />
        <div className="scroll-thin overflow-auto">
          <table className="w-full border-collapse text-left">
            <thead className="bg-surface-2">
              <tr className="border-b border-line">
                {["Unit", "Gun", "Status", "Power", "Session", "Connector temp"].map((h) => (
                  <th key={h} className="px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-3">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {UNITS.flatMap((unit) =>
                unit.guns.map((gun, i) => (
                  <tr key={gun} className="border-b border-line last:border-0">
                    <td className="px-3 py-2 text-[12px] font-medium text-ink">{i === 0 ? unit.label : ""}</td>
                    <td className="num px-3 py-2 text-[12px] text-ink-2">{gun}</td>
                    <td className="px-3 py-2">
                      <Pill tone="neutral">Awaiting upstream</Pill>
                    </td>
                    <td className="num px-3 py-2 text-[12px] text-ink-3" title={AWAITING}>
                      —
                    </td>
                    <td className="num px-3 py-2 text-[12px] text-ink-3">—</td>
                    <td className="num px-3 py-2 text-[12px] text-ink-3">—</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader eyebrow="Analytics" title="Session throughput" description="Will reuse the Battery Tracking report generator once session data lands." />
          <Hairline />
          <div className="p-4">
            <EmptyState
              title="No charger sessions to plot"
              hint="The generator component is shared with Battery Tracking — pointing it at a session series is a props change, not a new chart."
            />
          </div>
        </Card>

        <Card>
          <CardHeader eyebrow="Nameplate" title="Unit specification" />
          <Hairline />
          <div className="grid grid-cols-2 gap-2 p-4">
            {UNITS.map((u) => (
              <Metric key={u.id} label={u.label} value={u.rated} unit=" kW" tone="neutral" />
            ))}
            <Metric label="Guns per unit" value={2} />
            <Metric label="Site feeder" value={250} unit=" kW" />
          </div>
        </Card>
      </div>
    </div>
  );
}
