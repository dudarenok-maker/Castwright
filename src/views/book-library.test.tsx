/* BookLibraryView — three-state render: skeleton / empty / populated.
   Pairs with docs/features/21-book-library.md (Loading affordance section). */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, act } from '@testing-library/react';
import { accountSlice } from '../store/account-slice';
import { librarySlice, libraryActions } from '../store/library-slice';
import { BookLibraryView } from './book-library';
import type { LibraryAuthor, LibraryBook } from '../lib/types';

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
      library: { loaded, authors, books: authors.flatMap(a => a.series.flatMap(s => s.books)) },
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

  it('swaps skeleton → populated grid when hydrate dispatches', () => {
    /* The view's `authors` is a prop, not a selector — the parent route
       (routes/index.tsx) reads `library.authors` from the store and passes
       it down. Simulate that by rerendering with new props after dispatch,
       which mirrors the production behaviour where the parent re-renders
       on slice changes. */
    const store = configureStore({
      reducer: { account: accountSlice.reducer, library: librarySlice.reducer },
      preloadedState: { library: { loaded: false, authors: [], books: [] } },
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
