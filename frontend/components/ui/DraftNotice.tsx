import { Pill } from "@/components/ui/Pill";

/**
 * Draft banner for the three scaffolded routes.
 *
 * Explicit about scope so a reviewer never mistakes a placeholder for a
 * finished surface, and explicit about what "finishing" means — the shape of
 * the data the page is waiting for.
 */
export default function DraftNotice({
  scope,
  needs,
}: {
  scope: string;
  /** The channels / feeds this page needs before it can go deep. */
  needs: string[];
}) {
  return (
    <div className="rounded-xl border border-warn/35 bg-warn-soft px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="warn" dot>
          Draft scaffold
        </Pill>
        <p className="text-xs font-medium text-ink">{scope}</p>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-2">
        Structure and visual language only, per the review scope. Deep logic is intentionally not built here. To go
        live this page needs:{" "}
        {needs.map((n, i) => (
          <span key={n}>
            <span className="num text-ink">{n}</span>
            {i < needs.length - 1 ? ", " : ""}
          </span>
        ))}
        .
      </p>
    </div>
  );
}
