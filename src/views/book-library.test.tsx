/* BookLibraryView — three-state render: skeleton / empty / populated.
   Pairs with docs/features/21-book-library.md (Loading affordance section). */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, act } from '@testing-library/react';
import { accountSlice } from '../store/account-slice';
import { librarySlice, libraryActions } from '../store/library-slice';
import { BookLibraryView } from './book-library';
import type { ActiveAnalysisSummary, LibraryAuthor, LibraryBook } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    /* WorkspacePathRow fires this on mount. Never resolve — the row just
       stays hidden, which is fine for these assertions. */
    getWorkspaceInfo: () => new Promise(() => {}),
  },
}));

const oneBook: LibraryBook = {
  bookId:            'b1',
  title:             'The Hollow Tide',
  author:            'Della Renwick',
  series:            'The Hollow Tide',
  seriesPosition:    1,
  isStandalone:      false,
  status:            'complete',
  chapterCount:      59,
  completedChapters: 59,
  characterCount:    20,
  voiceCount:        20,
  lastWorkedOn:      'today',
  coverGradient:     ['#000', '#fff'],
};

const oneAuthor: LibraryAuthor = {
  name:   'Della Renwick',
  series: [{ name: 'The Hollow Tide', books: [oneBook] }],
};

function renderView({ loaded, authors }: { loaded: boolean; authors: LibraryAuthor[] }) {
  const store = configureStore({
    reducer: {
      account: accountSlice.reducer,
      library: librarySlice.reducer,
    },
    preloadedState: {
      library: { loaded, authors, books: authors.flatMap(a => a.series.flatMap(s => s.books)), pausedSnapshots: {} },
    },
  });
  return {
    store,
    ...render(
      <Provider store={store}>
        <BookLibraryView
          authors={authors}
          activeBookId={null}
          onOpenBook={vi.fn()}
          onDeleteBook={vi.fn()}
          onReparseBook={vi.fn()}
          onEditBook={vi.fn()}
          onStartNew={vi.fn()}
        />
      </Provider>,
    ),
  };
}

describe('BookLibraryView — loading affordance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders skeleton while library.loaded is false (no empty-state flash)', () => {
    renderView({ loaded: false, authors: [] });
    expect(screen.getByTestId('library-skeleton')).toBeInTheDocument();
    /* The empty-state copy must NOT paint during the fetch window — that's
       the original bug. */
    expect(screen.queryByText(/your library is empty/i)).not.toBeInTheDocument();
  });

  it('renders the empty-state once loaded with no authors', () => {
    renderView({ loaded: true, authors: [] });
    expect(screen.getByText(/your library is empty/i)).toBeInTheDocument();
    expect(screen.queryByTestId('library-skeleton')).not.toBeInTheDocument();
  });

  it('renders the populated grid once loaded with authors', () => {
    renderView({ loaded: true, authors: [oneAuthor] });
    /* Author name only appears as the h2 above the series row — unique
       anchor for the populated branch. (The series + book titles repeat
       in multiple cells, so we can't key off them.) */
    expect(screen.getByRole('heading', { level: 2, name: 'Della Renwick' })).toBeInTheDocument();
    expect(screen.queryByTestId('library-skeleton')).not.toBeInTheDocument();
    expect(screen.queryByText(/your library is empty/i)).not.toBeInTheDocument();
  });

  it('renders the cover <img> overlay when book.coverImageUrl is set', () => {
    const bookWithCover: LibraryBook = { ...oneBook, coverImageUrl: '/api/books/b1/cover' };
    const authorWithCover: LibraryAuthor = {
      ...oneAuthor,
      series: [{ name: 'The Hollow Tide', books: [bookWithCover] }],
    };
    renderView({ loaded: true, authors: [authorWithCover] });
    const img = screen.getByTestId('book-cover-b1') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/books/b1/cover');
  });

  it('omits the cover <img> when coverImageUrl is absent', () => {
    renderView({ loaded: true, authors: [oneAuthor] });
    expect(screen.queryByTestId('book-cover-b1')).not.toBeInTheDocument();
  });

  it('applies coverFraming via object-position + transform when set (plan 40)', () => {
    const bookWithFraming: LibraryBook = {
      ...oneBook,
      coverImageUrl: '/api/books/b1/cover',
      coverFraming: { offsetX: -50, offsetY: 50, zoom: 1.5 },
    };
    const author: LibraryAuthor = {
      ...oneAuthor,
      series: [{ name: 'The Hollow Tide', books: [bookWithFraming] }],
    };
    renderView({ loaded: true, authors: [author] });
    const img = screen.getByTestId('book-cover-b1') as HTMLImageElement;
    expect(img.style.objectPosition).toBe('25% 75%');
    expect(img.style.transform).toContain('scale(1.5)');
  });

  it('emits no extra style when coverFraming is absent (legacy / pre-plan-40 books)', () => {
    const bookWithCover: LibraryBook = { ...oneBook, coverImageUrl: '/api/books/b1/cover' };
    const author: LibraryAuthor = {
      ...oneAuthor,
      series: [{ name: 'The Hollow Tide', books: [bookWithCover] }],
    };
    renderView({ loaded: true, authors: [author] });
    const img = screen.getByTestId('book-cover-b1') as HTMLImageElement;
    expect(img.style.objectPosition).toBe('');
    expect(img.style.transform).toBe('');
  });

  it('renders the "Paused — resume?" badge when the cold-boot scan reports a paused snapshot', () => {
    const pausedSnap: ActiveAnalysisSummary = {
      bookId: 'b1',
      bookTitle: 'The Hollow Tide',
      manuscriptId: 'mns_b1',
      phaseId: 1,
      phaseLabel: 'Detecting characters',
      phaseProgress: 0.42,
      state: 'paused',
      lastTickAt: Date.now(),
      writtenAt: Date.now(),
    };
    const store = configureStore({
      reducer: { account: accountSlice.reducer, library: librarySlice.reducer },
      preloadedState: {
        library: {
          loaded: true,
          authors: [oneAuthor],
          books: [oneBook],
          pausedSnapshots: { b1: pausedSnap },
        },
      },
    });
    render(
      <Provider store={store}>
        <BookLibraryView
          authors={[oneAuthor]}
          activeBookId={null}
          onOpenBook={vi.fn()}
          onDeleteBook={vi.fn()}
          onReparseBook={vi.fn()}
          onEditBook={vi.fn()}
          onStartNew={vi.fn()}
        />
      </Provider>,
    );
    const badge = screen.getByTestId('paused-badge-b1');
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toMatch(/Paused — resume\?/);
  });

  it('renders the "Halted — review?" badge when the snapshot state is halted', () => {
    const haltedSnap: ActiveAnalysisSummary = {
      bookId: 'b1',
      bookTitle: 'The Hollow Tide',
      manuscriptId: 'mns_b1',
      phaseId: 2,
      phaseLabel: 'Linking refs',
      phaseProgress: 0.7,
      state: 'halted',
      haltCode: 'stage1_shrink_refused',
      haltReason: 'cast shrunk from 20 → 4',
      lastTickAt: Date.now(),
      writtenAt: Date.now(),
    };
    const store = configureStore({
      reducer: { account: accountSlice.reducer, library: librarySlice.reducer },
      preloadedState: {
        library: {
          loaded: true,
          authors: [oneAuthor],
          books: [oneBook],
          pausedSnapshots: { b1: haltedSnap },
        },
      },
    });
    render(
      <Provider store={store}>
        <BookLibraryView
          authors={[oneAuthor]}
          activeBookId={null}
          onOpenBook={vi.fn()}
          onDeleteBook={vi.fn()}
          onReparseBook={vi.fn()}
          onEditBook={vi.fn()}
          onStartNew={vi.fn()}
        />
      </Provider>,
    );
    const badge = screen.getByTestId('paused-badge-b1');
    expect(badge.textContent).toMatch(/Halted — review\?/);
  });

  it('omits the paused badge when no snapshot is present for the book', () => {
    renderView({ loaded: true, authors: [oneAuthor] });
    expect(screen.queryByTestId('paused-badge-b1')).not.toBeInTheDocument();
  });

  it('omits the paused badge when the book is the currently-active card (top-bar pill takes over)', () => {
    const pausedSnap: ActiveAnalysisSummary = {
      bookId: 'b1',
      bookTitle: 'The Hollow Tide',
      manuscriptId: 'mns_b1',
      phaseId: 1,
      phaseLabel: 'Detecting characters',
      phaseProgress: 0.42,
      state: 'paused',
      lastTickAt: Date.now(),
      writtenAt: Date.now(),
    };
    const store = configureStore({
      reducer: { account: accountSlice.reducer, library: librarySlice.reducer },
      preloadedState: {
        library: {
          loaded: true,
          authors: [oneAuthor],
          books: [oneBook],
          pausedSnapshots: { b1: pausedSnap },
        },
      },
    });
    render(
      <Provider store={store}>
        <BookLibraryView
          authors={[oneAuthor]}
          activeBookId="b1"
          onOpenBook={vi.fn()}
          onDeleteBook={vi.fn()}
          onReparseBook={vi.fn()}
          onEditBook={vi.fn()}
          onStartNew={vi.fn()}
        />
      </Provider>,
    );
    expect(screen.queryByTestId('paused-badge-b1')).not.toBeInTheDocument();
  });

  it('reducer hydratePausedSnapshots replaces the map (entries dropped from the response are cleared)', () => {
    const snapA: ActiveAnalysisSummary = {
      bookId: 'a', bookTitle: 'A', manuscriptId: 'm', phaseId: 0, phaseLabel: 'p',
      phaseProgress: 0, state: 'paused', lastTickAt: 0, writtenAt: 0,
    };
    const snapB: ActiveAnalysisSummary = { ...snapA, bookId: 'b', bookTitle: 'B' };
    const store = configureStore({
      reducer: { library: librarySlice.reducer },
      preloadedState: {
        library: {
          loaded: true, authors: [], books: [],
          pausedSnapshots: { a: snapA, b: snapB },
        },
      },
    });
    act(() => { store.dispatch(libraryActions.hydratePausedSnapshots([snapA])); });
    expect(store.getState().library.pausedSnapshots).toEqual({ a: snapA });
  });

  it('swaps skeleton → populated grid when hydrate dispatches', () => {
    /* The view's `authors` is a prop, not a selector — the parent route
       (routes/index.tsx) reads `library.authors` from the store and passes
       it down. Simulate that by rerendering with new props after dispatch,
       which mirrors the production behaviour where the parent re-renders
       on slice changes. */
    const store = configureStore({
      reducer: { account: accountSlice.reducer, library: librarySlice.reducer },
      preloadedState: { library: { loaded: false, authors: [], books: [], pausedSnapshots: {} } },
    });
    const handlers = {
      onOpenBook: vi.fn(), onDeleteBook: vi.fn(), onReparseBook: vi.fn(),
      onEditBook: vi.fn(), onStartNew: vi.fn(),
    };
    const { rerender } = render(
      <Provider store={store}>
        <BookLibraryView authors={[]} activeBookId={null} {...handlers}/>
      </Provider>,
    );
    expect(screen.getByTestId('library-skeleton')).toBeInTheDocument();
    act(() => {
      store.dispatch(libraryActions.hydrate({ authors: [oneAuthor] }));
    });
    rerender(
      <Provider store={store}>
        <BookLibraryView authors={[oneAuthor]} activeBookId={null} {...handlers}/>
      </Provider>,
    );
    expect(screen.queryByTestId('library-skeleton')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Della Renwick' })).toBeInTheDocument();
  });
});
