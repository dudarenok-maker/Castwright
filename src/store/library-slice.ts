/* Library slice — mirror of the on-disk workspace scan.

   Populated by api.getLibrary() and refreshed whenever the user returns to
   the books stage. The library view (book-library.tsx) reads from here
   instead of the static BOOKS seed. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { LibraryBook, LibraryResponse } from '../lib/types';

export interface LibraryState {
  loaded: boolean;
  authors: LibraryResponse['authors'];
  /** Flat denormalised list for quick lookup by bookId. */
  books: LibraryBook[];
}

const initialState: LibraryState = {
  loaded: false,
  authors: [],
  books: [],
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
      const existing = s.books.findIndex(b => b.bookId === a.payload.bookId);
      if (existing >= 0) s.books[existing] = a.payload;
      else s.books.push(a.payload);
    },
  },
});

export const libraryActions = librarySlice.actions;
