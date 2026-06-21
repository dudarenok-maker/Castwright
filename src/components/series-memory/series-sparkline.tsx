// src/components/series-memory/series-sparkline.tsx
import type { SeriesMemorySummary } from '../../lib/types';

export function SeriesSparkline({ summary, onOpen }: { summary: SeriesMemorySummary; onOpen: () => void }) {
  // Bar height base = principals, but never less than carried-present — a carried
  // character below the principal line-floor must not overflow the bar (ALG-3).
  const baseFor = (p: SeriesMemorySummary['perBook'][number]) => Math.max(p.principalCount, p.carriedPresent, 1);
  const max = Math.max(1, ...summary.perBook.map(baseFor));
  return (
    <div className="mt-1 rounded-xl border border-peach/20 bg-peach/8 px-3.5 py-2.5">
      <button
        type="button" onClick={onOpen}
        data-testid="series-sparkline"
        aria-label={`${summary.carriedCount} of your cast carried across ${summary.spanBooks} books`}
        className="flex items-end gap-1 h-8"
      >
        {summary.perBook.map((p) => {
          const base = baseFor(p);
          const h = (base / max) * 100;
          const carriedPct = (p.carriedPresent / base) * 100; // ≤ 100 by construction
          return (
            <span key={p.bookId} data-testid="sparkline-bar"
              className="flex flex-col-reverse w-2.5 rounded-sm overflow-hidden" style={{ height: `${h}%` }}>
              <span className="bg-gradient-to-t from-peach to-magenta block" style={{ height: `${carriedPct}%` }} />
              <span className="bg-ink/10 block" style={{ height: `${100 - carriedPct}%` }} />
            </span>
          );
        })}
      </button>
      <p className="mt-2 text-xs text-ink/60">{summary.carriedCount} of your cast, kept true across the series.</p>
    </div>
  );
}
