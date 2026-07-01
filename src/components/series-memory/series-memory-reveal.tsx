import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { IconClose } from '../../lib/icons';
import type { SeriesMemoryDetail, CarriedCharacter } from '../../lib/types';

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty',
];
// Spell out ≤20, numerals above (per the copy rule — "Fifty-six" is clumsy at headline size).
const spell = (n: number) =>
  n >= 0 && n <= 20 ? ONES[n][0].toUpperCase() + ONES[n].slice(1) : String(n);

// Collapse consecutive book indices into ranges: [1,2,4,5,6,12] → "1, 2, 4–6, 12".
function rangeLabel(indices: number[]): string {
  const s = [...indices].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}–${s[j]}`);
    i = j + 1;
  }
  return out.join(', ');
}

// Blob-download the already-fetched detail (works in mock mode; no endpoint round-trip).
function exportJson(detail: SeriesMemoryDetail, series: string) {
  const blob = new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${series}-series-memory.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function CarriedRow({ c, bookCount }: { c: CarriedCharacter; bookCount: number }) {
  const present = new Set(c.bookIndices);
  return (
    <div className="grid grid-cols-[1fr_auto] gap-3 items-center py-2 border-t border-white/10">
      <div>
        <div className="font-serif text-cream">{c.character}</div>
        <div className="text-[11px] text-cream/55">
          {c.voiceLabel}
          {c.voiceKind !== 'preset' && (
            <span className="ml-1.5 rounded px-1 py-0.5 bg-magenta/10 text-magenta text-[10px] font-semibold">
              {c.voiceKind === 'designed' ? 'Designed' : 'Cloned'}
            </span>
          )}
          {!c.carriedFullSpan && (
            <span className="text-cream/40"> · from Bk {c.bookIndices[0]}</span>
          )}
        </div>
      </div>
      <div className="flex gap-1 shrink-0" aria-label={`in books ${rangeLabel(c.bookIndices)}`}>
        {Array.from({ length: bookCount }, (_, i) => i + 1).map((idx) => (
          <span
            key={idx}
            className={`w-3 h-3 rounded-full ${present.has(idx) ? 'bg-gradient-to-r from-magenta to-peach' : 'bg-white/12'}`}
          />
        ))}
      </div>
    </div>
  );
}

export function SeriesMemoryReveal({
  author,
  series,
  bookCount,
  onClose,
  onShare,
  fetcher = api.getSeriesMemory,
}: {
  author: string;
  series: string;
  bookCount: number;
  onClose: () => void;
  onShare: (d: SeriesMemoryDetail) => void;
  fetcher?: (a: string, s: string) => Promise<SeriesMemoryDetail>;
}) {
  const [detail, setDetail] = useState<SeriesMemoryDetail | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetcher(author, series)
      .then((d) => {
        if (live) setDetail(d);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [author, series, fetcher]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal
      aria-labelledby="sm-reveal-heading"
      className="fixed inset-0 z-50 grid sm:place-items-center bg-ink/40"
      onClick={onClose}
    >
      <div
        // h-full on phone (full-screen sheet), height-capped + internally
        // scrollable on desktop — matches the house modal pattern (queue /
        // rebaseline). The old `min-h-screen sm:min-h-0 overflow-auto` had NO
        // max-height, so a large carried cast grew the panel past the viewport
        // and pushed the footer (Share / Export) off-screen — unusable.
        className="bg-[#1b1714] text-cream w-full sm:max-w-2xl sm:rounded-2xl p-7 h-full sm:h-auto sm:max-h-[90vh] overflow-y-auto scrollbar-thin"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sticky so Close stays reachable while scrolling a long cast list;
            negative margins extend its background to the padded panel edges. */}
        <div className="flex justify-end sticky top-0 z-10 -mx-7 -mt-7 px-7 pt-7 pb-2 bg-[#1b1714]">
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-white/10 text-cream/60"
            aria-label="Close"
          >
            <IconClose className="w-4 h-4" />
          </button>
        </div>
        {failed ? (
          <p className="text-cream/60">Couldn't load series memory.</p>
        ) : !detail ? (
          <p className="text-cream/60">Loading…</p>
        ) : (
          <>
            <p className="text-[11px] uppercase tracking-[0.14em] text-magenta font-semibold">
              series memory · {series}
            </p>
            <h2 id="sm-reveal-heading" className="font-serif text-2xl mt-2">
              {spell(bookCount)} books in, and not a voice has changed.
            </h2>
            <p className="text-cream/60 mt-1 mb-5">
              {spell(detail.carried.count)} voices, yours — book after book.
            </p>
            {detail.carried.characters.map((c) => (
              <CarriedRow key={c.voiceId + c.character} c={c} bookCount={bookCount} />
            ))}
            <div className="mt-5 flex justify-between items-center">
              <button
                onClick={() => onShare(detail)}
                className="rounded-full px-5 py-2.5 font-semibold text-ink bg-gradient-to-r from-magenta to-peach"
              >
                Share this cast
              </button>
              <button
                onClick={() => exportJson(detail, series)}
                className="text-xs text-cream/60 underline"
              >
                Export data (.json)
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
