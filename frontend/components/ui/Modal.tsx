"use client";

/**
 * Accessible modal.
 *
 * Used by the truck [Know More] 24-parameter pop-up.  Requirements it meets:
 *   * explicit [X] close control, plus Escape and backdrop click
 *   * focus is moved into the dialog on open and restored on close
 *   * background scroll is locked while open
 *   * rendered through a portal so no ancestor `overflow-hidden`/`transform`
 *     (the map card, the table's scroll container) can clip it
 *   * `role="dialog" aria-modal` + a labelled title for screen readers
 */

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export default function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  widthClass = "max-w-5xl",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  widthClass?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    if (!open) return;

    restoreRef.current = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
      // Minimal focus containment: Tab from the last focusable wraps to first.
      if (e.key === "Tab" && panelRef.current) {
        const nodes = panelRef.current.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])',
        );
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      }
    };

    document.addEventListener("keydown", onKey);
    // Focus the panel itself; the close button stays the first tab stop.
    const raf = requestAnimationFrame(() => panelRef.current?.focus());

    return () => {
      document.removeEventListener("keydown", onKey);
      cancelAnimationFrame(raf);
      document.body.style.overflow = overflow;
      restoreRef.current?.focus?.();
    };
  }, [open, close]);

  // No `mounted` flag is needed: the dialog can only be opened by an
  // interaction, so `open` is always false during SSR and on the hydrating
  // render. The `document` guard covers the server pass.
  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <div
        className="fixed inset-0 bg-black/45 backdrop-blur-[2px]"
        onClick={close}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : "Details"}
        tabIndex={-1}
        className={`rise-in relative z-10 w-full ${widthClass} overflow-hidden rounded-xl border border-line bg-surface shadow-2xl outline-none`}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line bg-surface-2 px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
            {subtitle && <div className="mt-0.5 text-xs text-ink-2">{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg border border-line bg-surface text-ink-2 transition hover:border-line-strong hover:bg-surface-3 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="scroll-thin max-h-[70vh] overflow-y-auto">{children}</div>

        {footer && <div className="border-t border-line bg-surface-2 px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
