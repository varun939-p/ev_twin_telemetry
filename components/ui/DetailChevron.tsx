import type { MouseEvent } from "react";

/**
 * Row detail affordance.
 *
 * Replaces a repeated "Know More" text button. In a 100-row register the same
 * two words on every line becomes visual noise and steals width from the data;
 * a single chevron reads instantly as "there is more behind this row".
 *
 * Accessibility is NOT sacrificed for the smaller target:
 *   * `aria-label` carries the full intent, naming the asset;
 *   * `title` gives sighted users the same text on hover;
 *   * the hit area stays 28x28 (above the 24px WCAG 2.2 target minimum) even
 *     though the glyph is 14px;
 *   * `stopPropagation` keeps the click off the row's own select handler.
 */
export default function DetailChevron({
  onClick,
  label,
}: {
  onClick: () => void;
  /** Asset name, woven into the accessible label. */
  label: string;
}) {
  return (
    <button
      type="button"
      title={`Open the 24-parameter detail for ${label}`}
      aria-label={`Open the 24-parameter detail for ${label}`}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onClick();
      }}
      className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-ink-3 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
    >
      <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" aria-hidden>
        <path
          d="M7.5 4.5L13 10l-5.5 5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
