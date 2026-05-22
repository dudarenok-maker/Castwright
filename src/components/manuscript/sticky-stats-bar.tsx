import { IconChevR, IconChevL } from '../../lib/icons';
import type { Chapter } from '../../lib/types';

interface Props {
  currentChapter: Chapter;
  segmentCount: number;
  speakerCount: number;
  lowConfCount: number;
  prevChapter?: Chapter;
  nextChapter?: Chapter;
  onJumpLowConf: (direction: 1 | -1) => void;
  onPickChapter: (id: number) => void;
}

/* CSS-only sticky stats bar shown on the manuscript view. Pinned at
   `top-16` (under the 64px global topbar) with a backdrop blur — `z-30`
   sits above article body but below modals (z-50). Lives as a direct
   child of `<main>` so it sticks for the entire manuscript scroll, not
   just within the header card.

   No IntersectionObserver, no scroll listener, no React state — the
   browser handles sticky behaviour natively. Mirrors the
   `StickyAnalysisBar` pattern from the analysing view. */
export function ManuscriptStickyStatsBar({
  currentChapter,
  segmentCount,
  speakerCount,
  lowConfCount,
  prevChapter,
  nextChapter,
  onJumpLowConf,
  onPickChapter,
}: Props) {
  return (
    <div
      data-testid="manuscript-sticky-stats-bar"
      className="sticky top-16 z-30 -mx-3 md:-mx-6 px-3 md:px-6 py-2 mb-6 bg-canvas/85 backdrop-blur-md border-b border-ink/10 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ink/60"
    >
      {currentChapter.excluded ? (
        <span className="text-ink/55">
          Excluded at import — not analyzed, no audio will be generated.
        </span>
      ) : (
        <>
          <span>{segmentCount} segments</span>
          <span className="hidden sm:inline">·</span>
          <span>{speakerCount} speakers</span>
          <span className="hidden sm:inline">·</span>
          {lowConfCount === 0 ? (
            <span className="text-ink/40">0 low-confidence</span>
          ) : (
            <span
              className="inline-flex items-center gap-1 text-amber-700"
              role="group"
              aria-label="Low-confidence navigation"
            >
              <span className="tabular-nums">{lowConfCount} low-confidence</span>
              <button
                type="button"
                onClick={() => onJumpLowConf(-1)}
                title="Previous low-confidence (K)"
                aria-label="Previous low-confidence sentence"
                className="inline-flex items-center justify-center min-w-7 min-h-7 px-1.5 rounded border border-amber-700/30 bg-white hover:bg-amber-50 text-amber-700 text-xs leading-none"
              >
                ▲
              </button>
              <button
                type="button"
                onClick={() => onJumpLowConf(1)}
                title="Next low-confidence (J)"
                aria-label="Next low-confidence sentence"
                className="inline-flex items-center justify-center min-w-7 min-h-7 px-1.5 rounded border border-amber-700/30 bg-white hover:bg-amber-50 text-amber-700 text-xs leading-none"
              >
                ▼
              </button>
            </span>
          )}
        </>
      )}
      <span className="ml-auto flex items-center gap-1">
        <button
          onClick={() => prevChapter && onPickChapter(prevChapter.id)}
          disabled={!prevChapter}
          aria-label="Previous chapter"
          className="px-3 min-h-11 min-w-11 py-1 rounded-lg border border-ink/10 bg-white text-ink/70 hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1 text-xs font-medium"
        >
          <IconChevL className="w-3.5 h-3.5" /> Prev
        </button>
        <button
          onClick={() => nextChapter && onPickChapter(nextChapter.id)}
          disabled={!nextChapter}
          aria-label="Next chapter"
          className="px-3 min-h-11 min-w-11 py-1 rounded-lg border border-ink/10 bg-white text-ink/70 hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1 text-xs font-medium"
        >
          Next <IconChevR className="w-3.5 h-3.5" />
        </button>
      </span>
    </div>
  );
}
