/* #3519 — test seeding for the loaded-book pair. A manuscript identity action
   moves the pair by itself (register `loadedBookSlice.reducer`); a store that
   PRELOADS the manuscript slice, or stands in for it, seeds the pair with this. */

import type { LoadedBookState } from './loaded-book-slice';

/** The pair a hydrate of a book with these ids would have set. */
export function loadedPair(ids: {
  bookId?: string | null;
  manuscriptId?: string | null;
}): LoadedBookState {
  return { loadedBookId: ids.bookId ?? null, loadedManuscriptId: ids.manuscriptId ?? null };
}
