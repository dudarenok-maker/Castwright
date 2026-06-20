/* MergeSuggestionCard — one dismissable card for a Tier-2b diminutive
   merge-suggestion (e.g. "These look like the same person: Оля + Ольга?").
   The parent manages the list and passes callbacks for accept (Merge) and
   dismiss (Dismiss) so this component stays stateless. */

import type { MergeSuggestion } from '../lib/api';

interface Props {
  suggestion: MergeSuggestion;
  /** Display name for the source (diminutive / duplicate) character. */
  sourceName: string;
  /** Display name for the target (canonical survivor) character. */
  targetName: string;
  onMerge: () => Promise<void> | void;
  onDismiss: () => Promise<void> | void;
}

export function MergeSuggestionCard({
  suggestion,
  sourceName,
  targetName,
  onMerge,
  onDismiss,
}: Props) {
  return (
    <div
      data-testid="merge-suggestion-card"
      role="status"
      className="w-full mb-3 px-4 py-3 rounded-2xl border border-amber-200 bg-amber-50/60 flex flex-col sm:flex-row sm:items-center gap-3"
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-ink">
          These look like the same person:{' '}
          <span className="text-amber-800">«{sourceName}»</span>
          {' + '}
          <span className="text-amber-800">«{targetName}»</span>
        </p>
        <p className="text-xs text-ink/60 mt-0.5">{suggestion.reason}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          data-testid="merge-suggestion-merge"
          onClick={() => void onMerge()}
          className="min-h-[44px] sm:min-h-0 px-3 py-1.5 rounded-full bg-amber-700 hover:bg-amber-800 text-white text-xs font-semibold transition-colors"
        >
          Merge
        </button>
        <button
          type="button"
          data-testid="merge-suggestion-dismiss"
          onClick={() => void onDismiss()}
          className="min-h-[44px] sm:min-h-0 px-3 py-1.5 rounded-full border border-ink/15 bg-white hover:bg-ink/5 text-ink/70 text-xs font-medium transition-colors"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
