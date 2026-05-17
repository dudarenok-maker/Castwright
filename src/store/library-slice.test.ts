// Pairs with docs/features/22-book-library.md

import { describe, expect, it } from 'vitest';
import { librarySlice, libraryActions } from './library-slice';
import type { LibraryBook, LibraryResponse } from '../lib/types';

const book = (overrides: Partial<LibraryBook> & Pick<LibraryBook, 'bookId'>): LibraryBook => ({
  title: overrides.bookId,
  author: 'Anon',
  series: '',
  seriesPosition: null,
  isStandalone: true,
  status: 'not_analysed',
  chapterCount: 0,
  completedChapters: 0,
  characterCount: 0,
  voiceCount: 0,
  lastWorkedOn: '2026-05-13',
  coverGradient: ['#000', '#fff'],
  ...overrides,
});

const responseWith = (...books: LibraryBook[]): LibraryResponse => ({
  authors: [{
    name: 'Anon',
    series: [{ name: '', books }],
  }],
});

describe('librarySlice — initial state', () => {
  it('starts empty and not loaded', () => {
    expect(librarySlice.getInitialState()).toEqual({ loaded: false, authors: [], books: [], pausedSnapshots: {} });
  });
});

describe('librarySlice — hydrate', () => {
  it('flattens the author/series tree into a flat books list and marks loaded', () => {
    const start = librarySlice.getInitialState();
    const next = librarySlice.reducer(start, libraryActions.hydrate({
      authors: [
        { name: 'A', series: [
          { name: 'S1', books: [book({ bookId: 'b1' }), book({ bookId: 'b2' })] },
          { name: 'S2', books: [book({ bookId: 'b3' })] },
        ]},
        { name: 'B', series: [
          { name: '', books: [book({ bookId: 'b4' })] },
        ]},
      ],
    }));
    expect(next.loaded).toBe(true);
    expect(next.books.map(b => b.bookId)).toEqual(['b1', 'b2', 'b3', 'b4']);
    expect(next.authors).toHaveLength(2);
  });

  it('replaces prior content on rehydrate', () => {
    let s = librarySlice.reducer(undefined, libraryActions.hydrate(responseWith(book({ bookId: 'old' }))));
    s = librarySlice.reducer(s, libraryActions.hydrate(responseWith(book({ bookId: 'new' }))));
    expect(s.books.map(b => b.bookId)).toEqual(['new']);
  });
});

describe('librarySlice — addBook (optimistic insert)', () => {
  it('appends a new book to the flat list', () => {
    const start = librarySlice.reducer(undefined, libraryActions.hydrate(responseWith(book({ bookId: 'a' }))));
    const next = librarySlice.reducer(start, libraryActions.addBook(book({ bookId: 'b' })));
    expect(next.books.map(b => b.bookId)).toEqual(['a', 'b']);
  });

  it('upserts when bookId already exists rather than duplicating', () => {
    const start = librarySlice.reducer(undefined,
      libraryActions.hydrate(responseWith(book({ bookId: 'a', title: 'Old Title' }))));
    const next = librarySlice.reducer(start, libraryActions.addBook(book({ bookId: 'a', title: 'New Title' })));
    expect(next.books).toHaveLength(1);
    expect(next.books[0].title).toBe('New Title');
  });
});
