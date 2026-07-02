/* Shared presentational chip for an in-flight analysis substage (fs-33/fs-57
   "Detect emotions" and fs-58 "Review script"). Both call sites render an
   identical spinner + status label + optional chapter/ETA detail + percent
   shape; the only difference is whether a Cancel affordance is offered
   (Detect emotions has one, Review script currently doesn't — `onCancel` is
   optional and simply omits the button when absent). Pure presentational —
   callers own their own progress state/dispatch and pass in already-derived
   text. */

import { IconSpinner } from '../lib/icons';

export interface SubstageProgressPillProps {
  /** data-testid on the pill container. */
  testId: string;
  /** data-testid on the optional detail span. */
  detailTestId: string;
  /** Status/phase label, e.g. "Detecting emotions" or "Reviewing script". */
  status: string;
  /** Pre-formatted chapter-count/ETA text (e.g. via `formatSubstageDetail`).
      Rendered only when non-null. */
  detailText: string | null;
  /** 0-100 integer percent already rounded by the caller. */
  percent: number;
  /** className for the status label span — detect-emotions-button's label
      truncates at a fixed width; review-script's does not. */
  labelClassName?: string;
  /** When present, renders a trailing Cancel button that invokes it. */
  onCancel?: () => void;
}

export function SubstageProgressPill({
  testId,
  detailTestId,
  status,
  detailText,
  percent,
  labelClassName = 'text-ink/70',
  onCancel,
}: SubstageProgressPillProps) {
  return (
    <div
      data-testid={testId}
      className="shrink-0 inline-flex items-center gap-2 px-4 min-h-11 rounded-full border border-ink/15 text-sm"
    >
      <IconSpinner className="w-4 h-4 animate-spin text-magenta" />
      <span className={labelClassName}>{status}</span>
      {detailText && (
        <span
          data-testid={detailTestId}
          className="text-ink/50 tabular-nums text-xs whitespace-nowrap"
        >
          {detailText}
        </span>
      )}
      <span className="tabular-nums text-ink/50">{percent}%</span>
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-ink/50 hover:text-magenta underline"
        >
          Cancel
        </button>
      )}
    </div>
  );
}
