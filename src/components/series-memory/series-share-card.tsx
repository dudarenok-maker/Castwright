// src/components/series-memory/series-share-card.tsx
import type { SeriesMemoryDetail } from '../../lib/types';
import { CastwaveGlyph } from '../../lib/castwave-glyph';

const CAP = 45;

export function SeriesShareCard({ detail, seriesName, owner }: {
  detail: SeriesMemoryDetail; seriesName: string; owner?: string;
}) {
  const { count, designedCount } = detail.carried;
  const leadDesigned = designedCount >= count / 2 && designedCount > 0;
  const heroNum = leadDesigned ? designedCount : count;
  const heroLabel = leadDesigned ? 'designed voices' : 'voices';
  const names = detail.carried.characters.map((c) => c.character);
  const shown = names.length > CAP ? names.slice(0, CAP) : names;
  const overflow = names.length - shown.length;
  const nameSize = names.length > 50 ? 'text-[10px]' : names.length > 34 ? 'text-xs' : 'text-sm';
  const { spanBooks } = detail.series;

  return (
    <div
      data-testid="series-share-card"
      className="aspect-[4/5] w-full max-w-sm mx-auto rounded-2xl bg-[#1b1714] text-cream p-7 flex flex-col"
    >
      {/* Wordmark */}
      <div className="flex items-center gap-1.5 font-semibold">
        <CastwaveGlyph className="w-3.5 h-3.5 text-magenta" />
        Castwright
      </div>

      {/* Series label */}
      <p className="text-[10px] uppercase tracking-[0.2em] text-magenta font-semibold mt-4">
        Series memory · {seriesName}
      </p>

      {/* Hero number */}
      <div data-testid="card-hero-number" className="font-serif text-5xl font-bold mt-1">
        {heroNum}{' '}
        <span className="text-xl text-cream/70 font-normal">{heroLabel}</span>
      </div>

      {/* Elevated claim */}
      <p className="font-serif text-peach text-lg font-semibold">
        kept true across all {spanBooks} books
      </p>

      {/* Quiet claim */}
      <p className="text-cream/70 text-sm mt-1">{spanBooks} books. The same cast.</p>

      {/* Cast wall */}
      <div className="flex-1 flex flex-wrap content-center justify-center items-center gap-x-2 gap-y-1 my-4 text-center">
        {shown.map((n, i) => (
          <span key={n + i} className={`font-serif ${nameSize} inline-flex items-center`}>
            {n}
            {i < shown.length - 1 && (
              <CastwaveGlyph className="w-2 h-2 text-magenta/60 mx-1.5" />
            )}
          </span>
        ))}
        {overflow > 0 && (
          <span className={`${nameSize} text-cream/50`}>
            {' '}…and {overflow} more of your cast
          </span>
        )}
      </div>

      {/* Footer */}
      <div className="flex justify-between items-end text-[11px]">
        <span className="text-cream/60">
          {owner != null ? `${owner}'s` : 'Your'} cast · kept true
        </span>
        <span className="text-magenta font-bold">castwright.ai</span>
      </div>
    </div>
  );
}
