import type { Middleware } from '@reduxjs/toolkit';
import { revisionsActions } from './revisions-slice';

/* #3395 pass 2, N1/N2 — keeps `revisions.bookId` in lockstep with the book
   `ui.stage` currently names. Runs after EVERY action and compares the two,
   rather than special-casing each ui-slice action that can change
   `stage.bookId` (openBook, hydrateFromUrl for router nav / going back to
   the library, goHome, manuscriptUploaded, analysisComplete, leaving to a
   non-book view, ...). Watching the derived value instead of the actions
   that produce it means a future book-changing action nobody remembered to
   wire up here can't silently drift the guard the way `chapters.
   currentBookId` did (N2: that field only moves on a successful hydrate,
   never on navigation itself, so a splice/generation write guarded on it
   could still land in the wrong book's `pending` mid-navigation).

   Dispatching `bookScopeChanged` here resets the revisions slice's four
   per-book fields (pending/dismissed/acceptedSelections/timeline) to empty
   the INSTANT the active book changes — before that book's own disk hydrate
   (or the lack of one) arrives — so there is no window where a leftover
   previous-book `pending` can be read, actioned against, or echoed back into
   the new book's revisions.json. */

interface ScopedRootState {
  ui: { stage: { bookId?: string } };
  revisions: { bookId: string | null };
}

export const revisionsScopeMiddleware: Middleware = (store) => (next) => (action) => {
  const result = next(action);
  const state = store.getState() as ScopedRootState;
  const activeBookId = state.ui.stage?.bookId ?? null;
  if (state.revisions.bookId !== activeBookId) {
    store.dispatch(revisionsActions.bookScopeChanged(activeBookId));
  }
  return result;
};
