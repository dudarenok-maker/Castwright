/* Library slice — mirror of the on-disk workspace scan.

   Populated by api.getLibrary() and refreshed whenever the user returns to
   the books stage. The library view (book-library.tsx) reads from here
   instead of the static BOOKS seed. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ActiveAnalysisSummary, LibraryBook, LibraryResponse } from '../lib/types';

export interface LibraryState {
  loaded: boolean;
  authors: LibraryResponse['authors'];
  /** Flat denormalised list for quick lookup by bookId. */
  books: LibraryBook[];
  /** Paused/halted snapshots keyed by bookId, populated by the
   *  cold-boot `getActiveAnalyses()` scan. Kept as a separate map
   *  (rather than projected onto `books[].pausedSnapshot` directly)
   *  so the library-hydrate and snapshot-hydrate effects don't race —
   *  the BookCard reads via a `pausedSnapshotForBook` selector that
   *  looks the snapshot up at render time. */
  pausedSnapshots: Record<string, ActiveAnalysisSummary>;
}

const initialState: LibraryState = {
  loaded: false,
  authors: [],
  books: [],
  pausedSnapshots: {},
};

function flattenAuthors(authors: LibraryResponse['authors']): LibraryBook[] {
  const out: LibraryBook[] = [];
  for (const a of authors) for (const s of a.series) for (const b of s.books) out.push(b);
  return out;
}

export const librarySlice = createSlice({
  name: 'library',
  initialState,
  reducers: {
    hydrate: (s, a: PayloadAction<LibraryResponse>) => {
      s.loaded = true;
      s.authors = a.payload.authors;
      s.books = flattenAuthors(a.payload.authors);
    },
    /** Optimistically add a book after import. Server scan on next refresh
        is authoritative. */
    addBook: (s, a: PayloadAction<LibraryBook>) => {
      const existing = s.books.findIndex((b) => b.bookId === a.payload.bookId);
      if (existing >= 0) s.books[existing] = a.payload;
      else s.books.push(a.payload);
    },
    /** Replace the paused/halted snapshot map from a single
     *  `getActiveAnalyses()` response. Called from Layout's cold-boot
     *  effect — one network call serves both the top-bar pill hydrate
     *  and the per-card badge hydrate. */
    hydratePausedSnapshots: (s, a: PayloadAction<ActiveAnalysisSummary[]>) => {
      const next: Record<string, ActiveAnalysisSummary> = {};
      for (const snap of a.payload) next[snap.bookId] = snap;
      s.pausedSnapshots = next;
    },
  },
});

/** Selector — paused/halted snapshot for a specific book, or null when
 *  the book has no on-disk paused analysis. Used by BookCard to gate
 *  the "Paused — resume?" badge.
 *
 *  Defensive read on `pausedSnapshots` covers a test-harness path where
 *  `preloadedState.library` is constructed without all initial fields
 *  (a real production store always has it via `initialState`). */
export function selectPausedSnapshotForBook(
  state: { library: LibraryState },
  bookId: string,
): ActiveAnalysisSummary | null {
  return state.library.pausedSnapshots?.[bookId] ?? null;
}

/** Plan 73 — sorted union of every tag string across the library.
 *  Drives the library-chrome tag-chip filter row. Stable insertion
 *  order via `localeCompare` so the chip row doesn't shuffle as
 *  books mutate. */
export function selectAllTags(state: { library: LibraryState }): string[] {
  const set = new Set<string>();
  for (const b of state.library.books) {
    for (const t of b.tags ?? []) set.add(t);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/** Plan 73 — applies the search + active-tag filters to the library's
 *  flat book list. `search` matches case-insensitively against title
 *  OR author; `activeTags` requires every active tag to be present on
 *  the book (intersection semantics so picking two chips narrows, not
 *  widens). Empty `search` and empty `activeTags` → pass-through.
 *
 *  Lives as a pure helper so it can be exercised in isolation by
 *  library-slice.test.ts and reused from the orchestrator. */
export function filterBooks(
  books: LibraryBook[],
  search: string,
  activeTags: string[],
): LibraryBook[] {
  const q = search.trim().toLowerCase();
  return books.filter((b) => {
    if (q) {
      const hay = `${b.title} ${b.author}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (activeTags.length > 0) {
      const bookTags = b.tags ?? [];
      for (const t of activeTags) {
        if (!bookTags.includes(t)) return false;
      }
    }
    return true;
  });
}

export const libraryActions = librarySlice.actions;
