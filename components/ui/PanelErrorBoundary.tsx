"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * PANEL-LEVEL ERROR BOUNDARY.
 *
 * A dashboard is a collection of independent readings. If the map throws
 * because a single frame has a malformed coordinate, the operator should lose
 * the map — not the alert list, the KPIs and the register with it. Wrapping
 * each data surface individually turns a total blackout into one degraded
 * tile with a retry.
 *
 * This is a CLASS component on purpose: `getDerivedStateFromError` and
 * `componentDidCatch` have no hook equivalent, and React still offers no
 * function-component API for catching render errors.
 *
 * It deliberately does NOT catch:
 *   * errors in event handlers (those never unmount the tree), or
 *   * server-side render errors (Next's own error.tsx owns those).
 *
 * `resetKey` lets a boundary recover by itself: when the underlying data
 * changes — a new document arrives from the poll — the boundary clears and
 * re-renders its children. A transient bad frame therefore heals on the next
 * refresh with no operator action.
 */
interface Props {
  children: ReactNode;
  /** Shown in the fallback so the operator knows what is missing. */
  name: string;
  /** Change this to clear the error and retry (e.g. the document timestamp). */
  resetKey?: string | number;
}

interface State {
  error: Error | null;
  resetKey: string | number | undefined;
}

export default class PanelErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  /**
   * Clears the error when `resetKey` changes. Implemented as a derived-state
   * comparison rather than `componentDidUpdate` + `setState`, which would
   * render the fallback once more before recovering.
   */
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) {
      return { error: null, resetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // One structured line per failure. Wire to Sentry/Datadog here; the shape
    // is intentionally flat so a log drain can index it.
    console.error(`[panel:${this.props.name}]`, error.message, info.componentStack);
  }

  private retry = () => this.setState({ error: null });

  render() {
    if (this.state.error === null) return this.props.children;

    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-2 rounded-xl border border-danger/30 bg-danger-soft p-4"
      >
        <p className="text-[13px] font-semibold text-danger">{this.props.name} could not be rendered</p>
        <p className="max-w-prose text-[12px] leading-relaxed text-ink-2">
          The rest of the dashboard is unaffected. This panel will recover on its own when the next
          telemetry document arrives.
        </p>
        <p className="num max-w-prose break-words text-[11px] text-ink-3">{this.state.error.message}</p>
        <button
          type="button"
          onClick={this.retry}
          className="cursor-pointer rounded-md border border-line bg-surface px-2.5 py-1 text-[12px] font-medium text-ink-2 transition hover:text-ink"
        >
          Retry now
        </button>
      </div>
    );
  }
}
