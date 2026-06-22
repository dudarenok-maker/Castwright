/* BookLibraryView — three-state render: skeleton / empty / populated.
   Pairs with docs/features/archive/21-book-library.md (Loading affordance section). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { accountSlice } from '../store/account-slice';
import { librarySlice, libraryActions } from '../store/library-slice';
import { tourSlice } from '../store/tour-slice';
import { uiSlice } from '../store/ui-slice';
import { continueListeningSlice } from '../store/continue-listening-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { BookLibraryView, applyLibraryFilters } from './book-library';
import type { ActiveAnalysisSummary, LibraryAuthor, LibraryBook } from '../lib/types';

import type { ContinueItem } from '../store/continue-listening-slice';

const mockGetContinueListening = vi.fn<() => Promise<ContinueItem[]>>(
  () => Promise.resolve([]),
);
const mockSetShelfStatus = vi.fn<() => Promise<void>>(() => Promise.resolve());

vi.mock('../lib/api', () => ({
  api: {
    /* WorkspacePathRow fires this on mount. Never resolve — the row just
       stays hidden, which is fine for these assertions. */
    getWorkspaceInfo: () => new Promise(() => {}),
    getContinueListening: () => mockGetContinueListening(),
    setShelfStatus: () => mockSetShelfStatus(),
  },
}));

const oneBook: LibraryBook = {
  bookId: 'b1',
  title: 'The Hollow Tide',
  author: 'Della Renwick',
  series: 'The Hollow Tide',
  seriesPosition: 1,
  isStandalone: false,
  status: 'complete',
  chapterCount: 59,
  completedChapters: 59,
  characterCount: 20,
  voiceCount: 20,
  lastWorkedOn: 'today',
  coverGradient: ['#000', '#fff'],
  tags: [],
};

const oneAuthor: LibraryAuthor = {
  name: 'Della Renwick',
  series: [{ name: 'The Hollow Tide', books: [oneBook] }],
};

function renderView({ loaded, authors }: { loaded: boolean; authors: LibraryAuthor[] }) {
  const store = configureStore({
    reducer: {
      account: accountSlice.reducer,
      library: librarySlice.reducer,
      tour: tourSlice.reducer,
      continueListening: continueListeningSlice.reducer,
    },
    preloadedState: {
      library: {
        loaded,
        error: null,
        authors,
        books: authors.flatMap((a) => a.series.flatMap((s) => s.books)),
        pausedSnapshots: {},
      },
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
          onReplaceManuscript={vi.fn()}
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
    /* Reset to the default (empty) response so individual tests that
       don't care about the rail don't need to stub it themselves. */
    mockGetContinueListening.mockResolvedValue([]);
    mockSetShelfStatus.mockResolvedValue(undefined);
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

  it('empty state shows "Any book, fully cast." tagline (Wave 2 brand)', () => {
    renderView({ loaded: true, authors: [] });
    expect(screen.getByText('Any book, fully cast.')).toBeInTheDocument();
  });

  it('empty state workspace path reads castwright-workspace (not audiobook-workspace)', () => {
    renderView({ loaded: true, authors: [] });
    expect(screen.getByText(/castwright-workspace/)).toBeInTheDocument();
    expect(screen.queryByText(/audiobook-workspace/)).not.toBeInTheDocument();
  });

  it('renders the populated grid once loaded with authors', () => {
    renderView({ loaded: true, authors: [oneAuthor] });
    /* Author name only appears as the h2 above the series row — unique
       anchor for the populated branch. (The series + book titles repeat
       in multiple cells, so we can't key off them.) */
    expect(
      screen.getByRole('heading', { level: 2, name: 'Della Renwick' }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('library-skeleton')).not.toBeInTheDocument();
    expect(screen.queryByText(/your library is empty/i)).not.toBeInTheDocument();
  });

  it('book-options menu trigger is revealed on touch (coarse pointer) — fe-5', () => {
    renderView({ loaded: true, authors: [oneAuthor] });
    const trigger = screen.getAllByLabelText(/Book options/i)[0];
    expect(trigger).toHaveClass('coarse-pointer:opacity-100');
    // Desktop hover-reveal behavior preserved.
    expect(trigger).toHaveClass('opacity-0');
    expect(trigger).toHaveClass('group-hover:opacity-100');
  });

  /* Regression — the "Voices" totals tile must count DISTINCT voices across
     the whole library (deduped by voiceId), not sum each book's per-book
     count. A voice reused across a series was previously counted once per
     book it appeared in, so an 8-book series inflated the figure ~7×. */
  it('Voices total dedups voices shared across books (not a per-book sum)', () => {
    const bookA: LibraryBook = {
      ...oneBook,
      bookId: 'a',
      title: 'Book A',
      seriesPosition: 1,
      voiceCount: 3,
      voiceIds: ['narrator', 'wren', 'marlow'],
    };
    const bookB: LibraryBook = {
      ...oneBook,
      bookId: 'b',
      title: 'Book B',
      seriesPosition: 2,
      voiceCount: 3,
      voiceIds: ['narrator', 'wren', 'brann'],
    };
    const author: LibraryAuthor = {
      name: 'Della Renwick',
      series: [{ name: 'The Hollow Tide', books: [bookA, bookB] }],
    };
    renderView({ loaded: true, authors: [author] });
    /* Union {narrator, wren, marlow, brann} = 4 distinct voices.
       The old summing behaviour would have shown 6. */
    const tile = screen.getByTestId('stat-tile-voices');
    expect(tile).toHaveTextContent('4');
    expect(tile).not.toHaveTextContent('6');
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

  /* Bug 9 regression — title + seriesLine were previously gated on
     `!effectiveCoverUrl || coverLoadFailed`, so once a cover image loaded
     both pieces disappeared from the card entirely. Now an always-visible
     metadata strip below the cover surfaces them in every case. */
  it('shows the book title in a metadata strip even when a cover image loads', () => {
    const bookWithCover: LibraryBook = { ...oneBook, coverImageUrl: '/api/books/b1/cover' };
    const authorWithCover: LibraryAuthor = {
      ...oneAuthor,
      series: [{ name: 'The Hollow Tide', books: [bookWithCover] }],
    };
    renderView({ loaded: true, authors: [authorWithCover] });
    const strip = screen.getByTestId('book-meta-strip-b1');
    expect(strip).toBeInTheDocument();
    expect(strip).toHaveTextContent('The Hollow Tide');
  });

  it('shows the series line + position in the metadata strip when a cover image loads', () => {
    const bookWithCover: LibraryBook = { ...oneBook, coverImageUrl: '/api/books/b1/cover' };
    const authorWithCover: LibraryAuthor = {
      ...oneAuthor,
      series: [{ name: 'The Hollow Tide', books: [bookWithCover] }],
    };
    renderView({ loaded: true, authors: [authorWithCover] });
    const strip = screen.getByTestId('book-meta-strip-b1');
    expect(strip).toHaveTextContent(/The Hollow Tide.*Book 1/);
  });

  it('shows the metadata strip even when no cover image is set', () => {
    renderView({ loaded: true, authors: [oneAuthor] });
    const strip = screen.getByTestId('book-meta-strip-b1');
    expect(strip).toBeInTheDocument();
    expect(strip).toHaveTextContent('The Hollow Tide');
    expect(strip).toHaveTextContent(/Book 1/);
  });

  it('renders "Standalone" in the metadata strip for standalone books', () => {
    const bonus: LibraryBook = {
      ...oneBook,
      bookId: 'b2',
      title: 'the Coalfall Commission',
      seriesPosition: null,
      isStandalone: true,
      coverImageUrl: '/api/books/b2/cover',
    };
    const authorWithBonus: LibraryAuthor = {
      ...oneAuthor,
      series: [{ name: 'The Hollow Tide', books: [bonus] }],
    };
    renderView({ loaded: true, authors: [authorWithBonus] });
    const strip = screen.getByTestId('book-meta-strip-b2');
    expect(strip).toHaveTextContent('the Coalfall Commission');
    expect(strip).toHaveTextContent('Standalone');
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
      reducer: { account: accountSlice.reducer, library: librarySlice.reducer, tour: tourSlice.reducer },
      preloadedState: {
        library: {
          loaded: true,
          error: null,
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
          onReplaceManuscript={vi.fn()}
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
      reducer: { account: accountSlice.reducer, library: librarySlice.reducer, tour: tourSlice.reducer },
      preloadedState: {
        library: {
          loaded: true,
          error: null,
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
          onReplaceManuscript={vi.fn()}
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
      reducer: { account: accountSlice.reducer, library: librarySlice.reducer, tour: tourSlice.reducer },
      preloadedState: {
        library: {
          loaded: true,
          error: null,
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
          onReplaceManuscript={vi.fn()}
          onEditBook={vi.fn()}
          onStartNew={vi.fn()}
        />
      </Provider>,
    );
    expect(screen.queryByTestId('paused-badge-b1')).not.toBeInTheDocument();
  });

  it('reducer hydratePausedSnapshots replaces the map (entries dropped from the response are cleared)', () => {
    const snapA: ActiveAnalysisSummary = {
      bookId: 'a',
      bookTitle: 'A',
      manuscriptId: 'm',
      phaseId: 0,
      phaseLabel: 'p',
      phaseProgress: 0,
      state: 'paused',
      lastTickAt: 0,
      writtenAt: 0,
    };
    const snapB: ActiveAnalysisSummary = { ...snapA, bookId: 'b', bookTitle: 'B' };
    const store = configureStore({
      reducer: { library: librarySlice.reducer },
      preloadedState: {
        library: {
          loaded: true,
          error: null,
          authors: [],
          books: [],
          pausedSnapshots: { a: snapA, b: snapB },
        },
      },
    });
    act(() => {
      store.dispatch(libraryActions.hydratePausedSnapshots([snapA]));
    });
    expect(store.getState().library.pausedSnapshots).toEqual({ a: snapA });
  });

  it('renders the "Import portable bundle" button when onImportPortable is provided, and fires the handler on file pick (plan 75)', async () => {
    const onImportPortable = vi.fn();
    const store = configureStore({
      reducer: { account: accountSlice.reducer, library: librarySlice.reducer, tour: tourSlice.reducer },
      preloadedState: {
        library: { loaded: true, error: null, authors: [], books: [], pausedSnapshots: {} },
      },
    });
    render(
      <Provider store={store}>
        <BookLibraryView
          authors={[]}
          activeBookId={null}
          onOpenBook={vi.fn()}
          onDeleteBook={vi.fn()}
          onReparseBook={vi.fn()}
          onReplaceManuscript={vi.fn()}
          onEditBook={vi.fn()}
          onStartNew={vi.fn()}
          onImportPortable={onImportPortable}
        />
      </Provider>,
    );
    const button = screen.getByTestId('library-import-portable-button');
    expect(button).toBeInTheDocument();
    const input = screen.getByTestId('library-import-portable-input') as HTMLInputElement;
    const file = new File(['fake-zip-bytes'], 'demo.portable.zip', { type: 'application/zip' });
    /* Simulate the file-pick by populating files on the hidden input
       and firing change — jsdom does not run a real file picker. */
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onImportPortable).toHaveBeenCalledTimes(1);
    expect(onImportPortable.mock.calls[0][0]).toBeInstanceOf(File);
    expect(onImportPortable.mock.calls[0][0].name).toBe('demo.portable.zip');
  });

  it('omits the Import button entirely when onImportPortable is not provided (backward-compat)', () => {
    renderView({ loaded: true, authors: [] });
    expect(screen.queryByTestId('library-import-portable-button')).not.toBeInTheDocument();
  });

  describe('continue-listening rail (fs-15 E2)', () => {
    it('fetches rail data on mount, renders the rail, and navigates to listen view at the saved chapter on card click', async () => {
      mockGetContinueListening.mockResolvedValue([
        {
          bookId: 'book-1',
          title: 'A',
          chapterId: 2,
          currentSec: 120,
          remainingSec: 600,
          completionPct: 0.3,
          updatedAt: '2026-06-13T00:00:00Z',
        },
      ]);

      /* Build a store that includes ui + continueListening so we can assert
         navigation by inspecting ui.stage after the card click. */
      const store = configureStore({
        reducer: {
          account: accountSlice.reducer,
          library: librarySlice.reducer,
          tour: tourSlice.reducer,
          ui: uiSlice.reducer,
          continueListening: continueListeningSlice.reducer,
        },
        preloadedState: {
          library: { loaded: true, error: null, authors: [], books: [], pausedSnapshots: {} },
        },
      });

      render(
        <Provider store={store}>
          <BookLibraryView
            authors={[]}
            activeBookId={null}
            onOpenBook={vi.fn()}
            onDeleteBook={vi.fn()}
            onReparseBook={vi.fn()}
            onReplaceManuscript={vi.fn()}
            onEditBook={vi.fn()}
            onStartNew={vi.fn()}
          />
        </Provider>,
      );

      /* Wait for the async getContinueListening to resolve and the rail to paint. */
      await waitFor(() => {
        expect(screen.getByText('Continue listening')).toBeInTheDocument();
      });

      /* The card for the single item should be visible. */
      expect(screen.getByRole('button', { name: /Continue listening to A/i })).toBeInTheDocument();

      /* Click the card — should navigate to the listen view at chapter 2. */
      fireEvent.click(screen.getByRole('button', { name: /Continue listening to A/i }));

      const stage = store.getState().ui.stage;
      expect(stage).toEqual({
        kind: 'ready',
        bookId: 'book-1',
        view: 'listen',
        currentChapterId: 2,
        openProfileId: null,
      });
    });

    it('does not render the rail when getContinueListening returns empty', async () => {
      mockGetContinueListening.mockResolvedValue([]);

      renderView({ loaded: true, authors: [] });

      /* Give the mount effect a tick to resolve. */
      await act(async () => {});

      expect(screen.queryByText('Continue listening')).not.toBeInTheDocument();
    });
  });

  describe('applyShelfStatus failure recovery (fs-15 undismiss guard)', () => {
    it('restores the continue-listening card when setShelfStatus fails', async () => {
      const continueItem: ContinueItem = {
        bookId: 'book-1',
        title: 'A',
        chapterId: 2,
        currentSec: 120,
        remainingSec: 600,
        completionPct: 0.3,
        updatedAt: '2026-06-13T00:00:00Z',
      };

      /* setShelfStatus rejects so the catch path fires. */
      mockSetShelfStatus.mockRejectedValue(new Error('network'));
      /* getContinueListening re-fetch restores the item. */
      mockGetContinueListening
        .mockResolvedValueOnce([continueItem]) /* initial mount fetch */
        .mockResolvedValueOnce([continueItem]); /* recovery re-fetch in catch */

      const store = configureStore({
        reducer: {
          account: accountSlice.reducer,
          library: librarySlice.reducer,
          tour: tourSlice.reducer,
          ui: uiSlice.reducer,
          continueListening: continueListeningSlice.reducer,
          notifications: notificationsSlice.reducer,
        },
        preloadedState: {
          library: { loaded: true, error: null, authors: [], books: [], pausedSnapshots: {} },
        },
      });

      render(
        <Provider store={store}>
          <BookLibraryView
            authors={[]}
            activeBookId={null}
            onOpenBook={vi.fn()}
            onDeleteBook={vi.fn()}
            onReparseBook={vi.fn()}
            onReplaceManuscript={vi.fn()}
            onEditBook={vi.fn()}
            onStartNew={vi.fn()}
          />
        </Provider>,
      );

      /* Wait for the initial mount fetch to resolve and the rail to render. */
      await waitFor(() => {
        expect(screen.getByText('Continue listening')).toBeInTheDocument();
      });

      /* Card is visible before the action. */
      expect(screen.getByRole('button', { name: /Continue listening to A/i })).toBeInTheDocument();

      /* Open the overflow menu on the card, then click "Mark as finished".
         The menu portals to document.body so it's findable after the
         options button is clicked. */
      const optionsBtn = screen.getByRole('button', { name: /Continue-listening options/i });
      fireEvent.click(optionsBtn);
      const finishBtn = await screen.findByRole('menuitem', { name: /Mark as finished/i });
      fireEvent.click(finishBtn);

      /* After the dismiss, card disappears optimistically. */
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /Continue listening to A/i })).not.toBeInTheDocument();
      });

      /* After the catch runs (undismiss + re-fetch hydrate), card should be back. */
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Continue listening to A/i })).toBeInTheDocument();
      });

      /* undismiss cleared the id — the store's dismissedIds must be empty. */
      expect(store.getState().continueListening.dismissedIds).not.toContain('book-1');
    });
  });

  it('delete confirm dialog (grid/BookCard) warns that listening history will be removed (fs-16/D14)', () => {
    renderView({ loaded: true, authors: [oneAuthor] });
    /* Open the book card's options menu. */
    fireEvent.click(screen.getByLabelText(/Book options/i));
    /* Click the Delete book menu item to open the ConfirmDialog. */
    fireEvent.click(screen.getByRole('button', { name: /Delete book/i }));
    expect(screen.getByText(/listening history/i)).toBeInTheDocument();
  });

  it('renders the search input above the grid (plan 73)', () => {
    renderView({ loaded: true, authors: [oneAuthor] });
    expect(screen.getByTestId('library-search-input')).toBeInTheDocument();
  });

  it('filters books by debounced title-search and shows a no-results pane when nothing matches', async () => {
    renderView({ loaded: true, authors: [oneAuthor] });
    fireEvent.change(screen.getByTestId('library-search-input'), {
      target: { value: 'zzzzzz' },
    });
    /* useDebouncedValue lags ~150ms — wait for the no-results pane. */
    await waitFor(() => {
      expect(screen.getByTestId('library-no-results')).toBeInTheDocument();
    });
    /* The book grid itself collapses out under the no-results branch. */
    expect(screen.queryByText('Della Renwick')).not.toBeInTheDocument();
  });

  describe('view-mode toggle (plan 76)', () => {
    beforeEach(() => {
      /* jsdom ships a real localStorage — wipe between cases so the
         lazy-initialiser default isn't leaked across specs. */
      try {
        localStorage.removeItem('library.viewMode');
      } catch {
        /* swallow */
      }
    });

    it('renders the Cards + Table toggle pills', () => {
      renderView({ loaded: true, authors: [oneAuthor] });
      expect(screen.getByTestId('library-view-mode-toggle')).toBeInTheDocument();
      expect(screen.getByTestId('library-view-mode-card')).toBeInTheDocument();
      expect(screen.getByTestId('library-view-mode-table')).toBeInTheDocument();
    });

    it('defaults to card view when localStorage is empty', () => {
      renderView({ loaded: true, authors: [oneAuthor] });
      /* h2 with author name only renders in the card-view branch. */
      expect(
        screen.getByRole('heading', { level: 2, name: 'Della Renwick' }),
      ).toBeInTheDocument();
      expect(screen.getByTestId('library-view-mode-card')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    it('renders the table view (with the row testid) after clicking Table', () => {
      renderView({ loaded: true, authors: [oneAuthor] });
      fireEvent.click(screen.getByTestId('library-view-mode-table'));
      /* Card branch's h2 disappears; table-row testid materialises. */
      expect(
        screen.queryByRole('heading', { level: 2, name: 'Della Renwick' }),
      ).not.toBeInTheDocument();
      const row = screen.getByTestId('library-table-row-b1');
      expect(row).toBeInTheDocument();
      // The table's horizontal-overflow strip uses the shared thin scrollbar.
      const strip = row.closest('[class*="overflow-x-auto"]');
      expect(strip).not.toBeNull();
      expect(strip!.className).toMatch(/scrollbar-thin/);
      expect(screen.getByTestId('library-view-mode-table')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    it('persists viewMode to localStorage on toggle', () => {
      renderView({ loaded: true, authors: [oneAuthor] });
      fireEvent.click(screen.getByTestId('library-view-mode-table'));
      expect(localStorage.getItem('library.viewMode')).toBe('table');
      fireEvent.click(screen.getByTestId('library-view-mode-card'));
      expect(localStorage.getItem('library.viewMode')).toBe('card');
    });

    it('reads persisted viewMode from localStorage on mount', () => {
      localStorage.setItem('library.viewMode', 'table');
      renderView({ loaded: true, authors: [oneAuthor] });
      expect(screen.getByTestId('library-table-row-b1')).toBeInTheDocument();
      expect(screen.getByTestId('library-view-mode-table')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    it('falls back to card view when localStorage value is garbage', () => {
      localStorage.setItem('library.viewMode', 'not-a-real-mode');
      renderView({ loaded: true, authors: [oneAuthor] });
      expect(
        screen.getByRole('heading', { level: 2, name: 'Della Renwick' }),
      ).toBeInTheDocument();
    });
  });

  /* Plan 81 (Wave 3, books) — phone viewports (<640px) must render the
     card grid even when the user's persisted localStorage preference
     is "table". Stub matchMedia so jsdom resolves the
     (max-width: 639px) query to true, then assert the orchestrator
     ignores the stored preference. The stored value is NOT cleared —
     a desktop session in the same workspace must still resume "table"
     when matchMedia goes false. */
  describe('mobile-viewport override (plan 81)', () => {
    let originalMatchMedia: typeof window.matchMedia | undefined;

    beforeEach(() => {
      try {
        localStorage.removeItem('library.viewMode');
      } catch {
        /* swallow */
      }
      originalMatchMedia = window.matchMedia;
    });

    afterEach(() => {
      if (originalMatchMedia) {
        window.matchMedia = originalMatchMedia;
      }
    });

    function stubMatchMedia(matches: boolean) {
      /* Minimal MediaQueryList shim — only the surface
         useIsMobileViewport reads. addEventListener / removeEventListener
         take the modern path; addListener / removeListener stay as
         no-ops so legacy fallback doesn't throw. */
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })) as unknown as typeof window.matchMedia;
    }

    it('forces card view on phone (375×667) even when localStorage requests table', () => {
      localStorage.setItem('library.viewMode', 'table');
      stubMatchMedia(true);
      renderView({ loaded: true, authors: [oneAuthor] });
      /* Card branch: h2 with the author name renders. Table branch
         renders <tr data-testid="library-table-row-…"> instead. */
      expect(
        screen.getByRole('heading', { level: 2, name: 'Della Renwick' }),
      ).toBeInTheDocument();
      expect(screen.queryByTestId('library-table-row-b1')).not.toBeInTheDocument();
      /* The stored preference is intact — desktop will resume table next session. */
      expect(localStorage.getItem('library.viewMode')).toBe('table');
    });

    it('honours stored table preference on tablet/desktop (matchMedia false)', () => {
      localStorage.setItem('library.viewMode', 'table');
      stubMatchMedia(false);
      renderView({ loaded: true, authors: [oneAuthor] });
      expect(screen.getByTestId('library-table-row-b1')).toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { level: 2, name: 'Della Renwick' }),
      ).not.toBeInTheDocument();
    });
  });

  it('shows Retry button when library.error is set (task-11)', () => {
    const store = configureStore({
      reducer: {
        account: accountSlice.reducer,
        library: librarySlice.reducer,
        tour: tourSlice.reducer,
        continueListening: continueListeningSlice.reducer,
      },
      preloadedState: {
        library: { loaded: true, error: 'Network', authors: [], books: [], pausedSnapshots: {} },
      },
    });
    render(
      <Provider store={store}>
        <BookLibraryView
          authors={[]}
          activeBookId={null}
          onOpenBook={vi.fn()}
          onDeleteBook={vi.fn()}
          onReparseBook={vi.fn()}
          onReplaceManuscript={vi.fn()}
          onEditBook={vi.fn()}
          onStartNew={vi.fn()}
        />
      </Provider>,
    );
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByText("Couldn't load your library")).toBeInTheDocument();
  });

  it('swaps skeleton → populated grid when hydrate dispatches', () => {
    /* The view's `authors` is a prop, not a selector — the parent route
       (routes/index.tsx) reads `library.authors` from the store and passes
       it down. Simulate that by rerendering with new props after dispatch,
       which mirrors the production behaviour where the parent re-renders
       on slice changes. */
    const store = configureStore({
      reducer: { account: accountSlice.reducer, library: librarySlice.reducer, tour: tourSlice.reducer },
      preloadedState: { library: { loaded: false, error: null, authors: [], books: [], pausedSnapshots: {} } },
    });
    const handlers = {
      onOpenBook: vi.fn(),
      onDeleteBook: vi.fn(),
      onReparseBook: vi.fn(),
      onReplaceManuscript: vi.fn(),
      onEditBook: vi.fn(),
      onStartNew: vi.fn(),
    };
    const { rerender } = render(
      <Provider store={store}>
        <BookLibraryView authors={[]} activeBookId={null} {...handlers} />
      </Provider>,
    );
    expect(screen.getByTestId('library-skeleton')).toBeInTheDocument();
    act(() => {
      store.dispatch(libraryActions.hydrate({ authors: [oneAuthor] }));
    });
    rerender(
      <Provider store={store}>
        <BookLibraryView authors={[oneAuthor]} activeBookId={null} {...handlers} />
      </Provider>,
    );
    expect(screen.queryByTestId('library-skeleton')).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Della Renwick' }),
    ).toBeInTheDocument();
  });
});

/* Helper for pure-function tests — mirrors makeBook in library-table.test.tsx */
function makeLibBook(over: Partial<LibraryBook> & Pick<LibraryBook, 'bookId' | 'title'>): LibraryBook {
  const base: LibraryBook = {
    bookId: over.bookId,
    title: over.title,
    author: 'Marin Vale',
    series: 'Northern Coast Trilogy',
    seriesPosition: 1,
    isStandalone: false,
    status: 'complete',
    chapterCount: 10,
    completedChapters: 10,
    characterCount: 5,
    voiceCount: 5,
    lastWorkedOn: 'today',
    coverGradient: ['#000', '#fff'],
    runtime: '5h 0m',
    tags: [],
  };
  return { ...base, ...over };
}

describe('applyLibraryFilters', () => {
  it('preserves seriesMemory when a search narrows the books', () => {
    const summary = {
      carriedCount: 8, bespokeCount: 5, designedCount: 5,
      confirmedBookCount: 3, spanBooks: 3, perBook: [],
    };
    const authors: LibraryAuthor[] = [
      {
        name: 'Marin Vale',
        series: [
          {
            name: 'Northern Coast Trilogy',
            seriesMemory: summary,
            books: [
              makeLibBook({ bookId: 'n1', title: 'North One' }),
              makeLibBook({ bookId: 'n2', title: 'North Two' }),
            ],
          },
        ],
      },
    ];
    const out = applyLibraryFilters(authors, { filter: 'all', search: 'North One', tags: [], languages: [] });
    // search narrowed books 2→1 but the series object kept its seriesMemory:
    expect(out[0].series[0].books).toHaveLength(1);
    expect(out[0].series[0].seriesMemory).toEqual(summary);
  });
});
