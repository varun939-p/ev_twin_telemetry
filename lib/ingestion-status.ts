/** Read-only ingestion evidence. Safe to share across the server/client boundary. */
export const INGESTION_LABELS = {
  healthy: "Ingestion healthy",
  upstream_stale: "Upstream data is old",
  date_limited: "Date-limited ingestion",
  overdue: "Ingestion overdue",
  failed: "Ingestion failed",
  partial: "Ingestion incomplete",
  running: "Ingestion running",
  never: "Awaiting first ingestion",
  configuration_error: "Ingestion not configured",
  unknown: "Ingestion status unknown",
  backend_unreachable: "Backend unreachable",
  database_unreachable: "Database unreachable",
} as const;

export type IngestionState = keyof typeof INGESTION_LABELS;

export interface IngestionHealth {
  state: IngestionState;
  detail: string;
  expected_interval_seconds: number;
  last_success_at: string | null;
  newest_observed_at: string | null;
  last_attempt: {
    started_at: string;
    finished_at: string | null;
    trigger: string;
    summary: { accepted: number; resolved_date: string | null } | null;
  } | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject proxy HTML/old API shapes instead of inferring a healthy poll. */
export function parseIngestionHealth(value: unknown): IngestionHealth | null {
  if (!record(value) || typeof value.state !== "string" || !Object.hasOwn(INGESTION_LABELS, value.state)) return null;
  if (typeof value.detail !== "string" || typeof value.expected_interval_seconds !== "number") return null;
  const attempt = value.last_attempt;
  const summary = record(attempt) ? attempt.summary : null;
  return {
    state: value.state as IngestionState,
    detail: value.detail,
    expected_interval_seconds: value.expected_interval_seconds,
    last_success_at: typeof value.last_success_at === "string" ? value.last_success_at : null,
    newest_observed_at: typeof value.newest_observed_at === "string" ? value.newest_observed_at : null,
    last_attempt: record(attempt) && typeof attempt.started_at === "string" ? {
      started_at: attempt.started_at,
      finished_at: typeof attempt.finished_at === "string" ? attempt.finished_at : null,
      trigger: typeof attempt.trigger === "string" ? attempt.trigger : "unknown",
      summary: record(summary) && typeof summary.accepted === "number" ? {
        accepted: summary.accepted,
        resolved_date: typeof summary.resolved_date === "string" ? summary.resolved_date : null,
      } : null,
    } : null,
  };
}

export function unavailableIngestion(
  state: "backend_unreachable" | "database_unreachable" | "unknown",
  detail: string,
): IngestionHealth {
  return { state, detail, expected_interval_seconds: 0, last_success_at: null, newest_observed_at: null, last_attempt: null };
}
