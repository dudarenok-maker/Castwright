import type { SeriesMemorySummary } from '../../lib/types';
import { CastwaveGlyph } from '../../lib/castwave-glyph';

export function SeriesMemoryChip({ summary, bookCount, onOpen }: {
  summary: SeriesMemorySummary; bookCount: number; onOpen: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="series-memory-chip"
      onClick={onOpen}
      className="inline-flex items-center gap-1.5 rounded-full px-3 min-h-[44px] sm:min-h-0 sm:py-1 text-xs font-semibold text-white dark:text-ink bg-gradient-to-r from-magenta to-peach hover:-translate-y-px transition-transform"
    >
      <CastwaveGlyph className="w-3.5 h-3.5" />
      Your cast · {summary.carriedCount} voices, {bookCount} books
    </button>
  );
}
