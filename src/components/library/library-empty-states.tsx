/* Empty-state + skeleton renderers shared by `library-grid.tsx` and
   `library-table.tsx`. Behaviour-neutral lift — markup matches the
   pre-refactor JSX so existing `book-library.test.tsx` assertions
   keep resolving. */

import { CastwaveMark, IconPlus } from '../../lib/icons';
import { TAGLINE_SHORT } from '../../lib/brand';
import { PrimaryButton } from '../primitives';

export function EmptyLibrary({
  onStartNew,
  onTrySample,
  onStartTour,
  tourCompleted,
}: {
  onStartNew: () => void;
  onTrySample?: () => void;
  onStartTour?: () => void;
  tourCompleted?: boolean;
}) {
  return (
    <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-12 text-center">
      <span className="w-16 h-16 mx-auto rounded-full bg-magenta/10 grid place-items-center text-magenta">
        <CastwaveMark className="w-8 h-8" aria-hidden="true" />
      </span>
      <h3 className="mt-5 font-serif text-2xl font-bold text-ink">Your library is empty</h3>
      <p className="mt-2 text-sm text-ink/60">{TAGLINE_SHORT}</p>
      <p className="mt-2 text-sm text-ink/60 max-w-md mx-auto leading-relaxed">
        Books live on disk under{' '}
        <code className="px-1.5 py-0.5 rounded bg-ink/5 text-[12px]">
          castwright-workspace/books/&lt;Author&gt;/&lt;Series&gt;/&lt;Title&gt;/
        </code>
        . Import a manuscript and we'll lay it out for you.
      </p>
      <div className="mt-6">
        <div className="flex flex-col gap-3 items-center">
          {onStartTour && !tourCompleted && (
            <PrimaryButton variant="dark" onClick={onStartTour}>
              <span className="inline-flex items-center gap-2">Take the guided tour</span>
            </PrimaryButton>
          )}
          <PrimaryButton variant="dark" onClick={onStartNew}>
            <span className="inline-flex items-center gap-2">
              <IconPlus className="w-4 h-4" />
              Import your first book
            </span>
          </PrimaryButton>
        </div>
        {onTrySample && (
          <button
            onClick={onTrySample}
            className="mt-3 text-sm font-medium text-ink/70 underline underline-offset-2 hover:text-ink"
          >
            or try a sample book
          </button>
        )}
      </div>
    </div>
  );
}

/* Placeholder rendered while `library.loaded` is false. Mirrors the
   populated grid shape so the layout doesn't shift when real data swaps
   in. Reads as "loading" via Tailwind animate-pulse. */
export function LibrarySkeleton() {
  return (
    <div className="space-y-10" data-testid="library-skeleton" aria-hidden="true">
      <section>
        <div className="h-6 w-40 rounded bg-ink/6 animate-pulse mb-3" />
        <div className="mt-4 space-y-8">
          <div>
            <div className="flex items-baseline justify-between mb-3">
              <div className="h-3 w-28 rounded bg-ink/6 animate-pulse" />
              <div className="h-3 w-14 rounded bg-ink/4 animate-pulse" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              <div className="min-h-[180px] rounded-3xl bg-ink/4 animate-pulse" />
              <div className="min-h-[180px] rounded-3xl bg-ink/4 animate-pulse" />
              <div className="min-h-[180px] rounded-3xl bg-ink/4 animate-pulse" />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/* Filter / view-mode collapsed everything out of the grid (but the
   library itself isn't empty). Mirrors the grid's pre-refactor
   semantics — show the NewBookCard tile + a clear "no match" copy
   so the user knows they can adjust the filter or start a new book.
   Used by the table view; the grid renders only the NewBookCard tile
   in this case to preserve its pre-refactor layout. */
export function NoFilterMatch({ onStartNew }: { onStartNew: () => void }) {
  return (
    <div
      data-testid="library-no-filter-match"
      className="bg-white rounded-3xl border border-ink/10 shadow-card p-10 text-center"
    >
      <h3 className="font-serif text-xl font-bold text-ink">No books match your filters</h3>
      <p className="mt-2 text-sm text-ink/60 max-w-md mx-auto leading-relaxed">
        Try clearing the filter to see every book in the workspace, or start a new one.
      </p>
      <div className="mt-5">
        <PrimaryButton variant="dark" onClick={onStartNew}>
          <span className="inline-flex items-center gap-2">
            <IconPlus className="w-4 h-4" />
            Start a new book
          </span>
        </PrimaryButton>
      </div>
    </div>
  );
}
