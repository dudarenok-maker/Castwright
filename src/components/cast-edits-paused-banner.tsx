/* Plan 291 (#4031), Task 12 — the UX half of invariant 7 ("lock until
   reloaded"): while a book's analysis runs (or its era is latched) its cast
   is read-only, and this banner says so on every surface that edits it
   (Cast, the profile drawer, Voices, Confirm).

   UX only. Correctness rests on the persistence middleware's catch-all
   (persistence-middleware.ts), which builds no cast save for a read-only
   book whatever a control does; the controls disabled through
   `pausedControlProps` just stop offering a change that would be refused.
   Controls that save through their own routes (merge, orphan links, aliases,
   voice design, the tier pin, ...) stay live. Since R55 (PR #4103 pass 5) the
   server refuses the cast-identity ones (a merge, an accepted suggestion, an
   orphan link or reject, an unlinked alias, a new character) with 409
   `book_busy` while the analysis runs, and the client takes the read-only toast
   path (`handleCastIdentityBusy`, cast-gate.ts). */

import { useAppSelector } from '../store';
import { selectCastReadOnly, stageBookId } from '../store/book-busy-slice';

export const CAST_EDITS_PAUSED_TEXT = 'Re-analysis running — cast edits are paused';
export const CAST_EDITS_PAUSED_TOOLTIP = 'Paused while the re-analysis runs — available again when it finishes';

/** Is the cast of the book the stage names read-only? Structural, so a
    hand-built test store without the gate's slices reads as editable. */
export function useCastReadOnly(): boolean {
  return useAppSelector((s) => {
    const bookId = stageBookId(s);
    return bookId ? selectCastReadOnly(s, bookId) : false;
  });
}

/** The attributes of a control that is disabled while the cast is read-only:
    `aria-disabled` and a tooltip, with the control left focusable so the
    tooltip stays reachable. The handler must still ignore the click. */
export function pausedControlProps(readOnly: boolean): { 'aria-disabled'?: true; title?: string } {
  return readOnly ? { 'aria-disabled': true, title: CAST_EDITS_PAUSED_TOOLTIP } : {};
}

/** Is a re-analysis of the stage's book LIVE: the cast is read-only AND a
    snapshot for it that is not halted exists (running or paused) or the busy
    cache lists `analysis`. The post-run window (era latched, nothing live)
    keeps the controls disabled for a round trip but is not announced: the copy
    would be wrong, e.g. on a first upload. */
export function useCastRunLive(): boolean {
  return useAppSelector((s) => {
    const bookId = stageBookId(s);
    if (!bookId || !selectCastReadOnly(s, bookId)) return false;
    const snap = s.analysis?.activeStream;
    if (snap && snap.bookId === bookId && snap.state !== 'halted') return true;
    return s.bookBusy?.busyByBook?.[bookId]?.includes('analysis') ?? false;
  });
}

/** The ONE app-level status region (mounted in Layout, outside every
    `space-y` stack): persistent and zero-size sr-only, so a screen reader
    announces the text when a run goes live, once, whatever surfaces are open. */
export function CastEditsPausedStatus() {
  const live = useCastRunLive();
  return (
    <div role="status" className="sr-only">
      {live ? CAST_EDITS_PAUSED_TEXT : null}
    </div>
  );
}

/** The visible banner of one surface: mounted only while a run is live,
    aria-hidden (the app-level status region announces it), and nothing at all
    otherwise, so it is never an empty child of its stack. */
export function CastEditsPausedBanner({ className = '' }: { className?: string }) {
  const live = useCastRunLive();
  if (!live) return null;
  return (
    <div
      data-testid="cast-edits-paused-banner"
      aria-hidden="true"
      className={`rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3 flex items-center gap-3 coarse-pointer:min-h-[44px] ${className}`}
    >
      <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
      <p className="text-sm text-amber-900 flex-1">{CAST_EDITS_PAUSED_TEXT}</p>
    </div>
  );
}
