// Pairs with docs/features/22-book-library.md and 73-library-search-tags.md

import { describe, expect, it } from 'vitest';
import { librarySlice, libraryActions, selectAllTags, filterBooks } from './library-slice';
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
  tags: [],
  ...overrides,
});

const responseWith = (...books: LibraryBook[]): LibraryResponse => ({
  authors: [
    {
      name: 'Anon',
      series: [{ name: '', books }],
    },
  ],
});

describe('librarySlice — initial state', () => {
  it('starts empty and not loaded', () => {
    expect(librarySlice.getInitialState()).toEqual({
      loaded: false,
      authors: [],
      books: [],
      pausedSnapshots: {},
    });
  });
});

describe('librarySlice — hydrate', () => {
  it('flattens the author/series tree into a flat books list and marks loaded', () => {
    const start = librarySlice.getInitialState();
    const next = librarySlice.reducer(
      start,
      libraryActions.hydrate({
        authors: [
          {
            name: 'A',
            series: [
              { name: 'S1', books: [book({ bookId: 'b1' }), book({ bookId: 'b2' })] },
              { name: 'S2', books: [book({ bookId: 'b3' })] },
            ],
          },
          { name: 'B', series: [{ name: '', books: [book({ bookId: 'b4' })] }] },
        ],
      }),
    );
    expect(next.loaded).toBe(true);
    expect(next.books.map((b) => b.bookId)).toEqual(['b1', 'b2', 'b3', 'b4']);
    expect(next.authors).toHaveLength(2);
  });

  it('replaces prior content on rehydrate', () => {
    let s = librarySlice.reducer(
      undefined,
      libraryActions.hydrate(responseWith(book({ bookId: 'old' }))),
    );
    s = librarySlice.reducer(s, libraryActions.hydrate(responseWith(book({ bookId: 'new' }))));
    expect(s.books.map((b) => b.bookId)).toEqual(['new']);
  });
});

describe('librarySlice — addBook (optimistic insert)', () => {
  it('appends a new book to the flat list', () => {
    const start = librarySlice.reducer(
      undefined,
      libraryActions.hydrate(responseWith(book({ bookId: 'a' }))),
    );
    const next = librarySlice.reducer(start, libraryActions.addBook(book({ bookId: 'b' })));
    expect(next.books.map((b) => b.bookId)).toEqual(['a', 'b']);
  });

  it('upserts when bookId already exists rather than duplicating', () => {
    const start = librarySlice.reducer(
      undefined,
      libraryActions.hydrate(responseWith(book({ bookId: 'a', title: 'Old Title' }))),
    );
    const next = librarySlice.reducer(
      start,
      libraryActions.addBook(book({ bookId: 'a', title: 'New Title' })),
    );
    expect(next.books).toHaveLength(1);
    expect(next.books[0].title).toBe('New Title');
  });
});

/* Plan 73 — selectAllTags + filterBooks tests. The orchestrator
   composes these to drive the search input + chip-filter row. */
describe('librarySlice — selectAllTags (plan 73)', () => {
  function makeState(books: LibraryBook[]) {
    return {
      library: {
        loaded: true,
        authors: [],
        books,
        pausedSnapshots: {},
      },
    };
  }
  it('returns sorted union of tags across every book', () => {
    const s = makeState([
      book({ bookId: 'a', tags: ['favourite', 'series-1'] }),
      book({ bookId: 'b', tags: ['draft', 'series-1'] }),
      book({ bookId: 'c', tags: [] }),
    ]);
    expect(selectAllTags(s)).toEqual(['draft', 'favourite', 'series-1']);
  });
  it('returns [] when no book has tags', () => {
    const s = makeState([book({ bookId: 'a' }), book({ bookId: 'b' })]);
    expect(selectAllTags(s)).toEqual([]);
  });
  it('tolerates a book whose tags field is undefined (legacy disk)', () => {
    const legacy: LibraryBook = book({ bookId: 'legacy' });
    /* Simulate a pre-plan-73 slice payload by dropping the tags
       property — production scan always emits []. */
    delete (legacy as Partial<LibraryBook>).tags;
    const s = makeState([legacy, book({ bookId: 'b', tags: ['foo'] })]);
    expect(selectAllTags(s)).toEqual(['foo']);
  });
});

describe('librarySlice — filterBooks (plan 73)', () => {
  const books = [
    book({ bookId: 'a', title: 'Solway Bay', author: 'Mike D', tags: ['favourite'] }),
    book({ bookId: 'b', title: 'The Northern Star', author: 'Mike D', tags: ['favourite', 'series-1'] }),
    book({ bookId: 'c', title: "Carrick's Compass", author: 'Mike D', tags: ['series-1'] }),
    book({ bookId: 'd', title: 'Twilight Stations', author: 'Other Author', tags: [] }),
  ];
  it('returns every book when search is empty and no tags are active', () => {
    expect(filterBooks(books, '', []).map((b) => b.bookId)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('matches case-insensitive substring against title', () => {
    expect(filterBooks(books, 'northern', []).map((b) => b.bookId)).toEqual(['b']);
  });
  it('matches case-insensitive substring against author', () => {
    expect(filterBooks(books, 'other', []).map((b) => b.bookId)).toEqual(['d']);
  });
  it('trims whitespace before searching', () => {
    expect(filterBooks(books, '   bay   ', []).map((b) => b.bookId)).toEqual(['a']);
  });
  it('filters by single active tag', () => {
    expect(filterBooks(books, '', ['favourite']).map((b) => b.bookId)).toEqual(['a', 'b']);
  });
  it('intersects multiple active tags (book must have every active tag)', () => {
    expect(filterBooks(books, '', ['favourite', 'series-1']).map((b) => b.bookId)).toEqual(['b']);
  });
  it('composes search ∩ tags', () => {
    expect(filterBooks(books, 'star', ['series-1']).map((b) => b.bookId)).toEqual(['b']);
  });
  it('returns [] when search has no matches', () => {
    expect(filterBooks(books, 'zzzzzz', [])).toEqual([]);
  });
  it('returns [] when an active tag matches no book', () => {
    expect(filterBooks(books, '', ['nonexistent'])).toEqual([]);
  });
});
