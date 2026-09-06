import { Pill, type Tone } from "@/components/ui/Pill";
import { INGESTION_LABELS, type IngestionHealth } from "@/lib/ingestion-status";

export default function IngestionStatus({ health }: { health: IngestionHealth | null }) {
  const state = health?.state ?? "unknown";
  const tone: Tone = state === "healthy" ? "ok"
    : ["failed", "overdue", "configuration_error", "backend_unreachable", "database_unreachable"].includes(state) ? "danger"
    : state === "running" ? "info" : "warn";
  const attempt = health?.last_attempt;

  return (
    <section aria-label="Ingestion status" aria-live="polite" className="mb-5 rounded-lg border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Pill tone={tone} dot>{INGESTION_LABELS[state]}</Pill>
        <p className="text-xs leading-relaxed text-ink-2">
          {health?.detail ?? "The backend has not supplied ingestion diagnostics. Check the worker or cron; a reachable dashboard alone does not prove ingestion is running."}
        </p>
      </div>
      {attempt && (
        <p className="mt-2 text-[11px] text-ink-2">
          {/* UTC strings from the server, not browser-local Date formatting:
              hydration must not depend on the viewer's timezone or clock. */}
          {attempt.finished_at ? "Last poll completed" : "Poll started"}: {attempt.finished_at ?? attempt.started_at}
          {" · "}{attempt.trigger}
          {attempt.summary && <> · {attempt.summary.accepted} vehicles accepted · date {attempt.summary.resolved_date ?? "server default"}</>}
          {health.expected_interval_seconds > 0 && <> · expected every {health.expected_interval_seconds}s</>}
        </p>
      )}
    </section>
  );
}
