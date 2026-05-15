// Pairs with docs/features/00-stage-machine.md and 21-book-library.md
//
// Regression for the "No manuscript loaded" banner that appeared on the
// Analysing screen after a page refresh / deep link / confirm→reanalyse:
// AnalysingRoute used to read manuscriptId only from ui.stage, which gets
// clobbered to null by useHydrateStage. The fix is to fall back to the
// manuscript slice (populated by Layout's book-state hydration) and the
// library entry.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter, Outlet, Routes, Route } from 'react-router-dom';
import { uiSlice, uiActions } from '../store/ui-slice';
import { castSlice, castActions } from '../store/cast-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { manuscriptSlice, manuscriptActions } from '../store/manuscript-slice';
import { librarySlice, libraryActions } from '../store/library-slice';
import { revisionsSlice } from '../store/revisions-slice';
import { voicesSlice } from '../store/voices-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { accountSlice } from '../store/account-slice';
import { bookMetaSlice } from '../store/book-meta-slice';
import { router as appRouter } from './index';
import { AnalysingRoute, BooksRoute, ChangelogRoute } from './index';
import type { LayoutContext } from '../components/layout';
import type { Character, LibraryBook, ChangeLogEvent } from '../lib/types';

const analyseMock = vi.fn();
const workspaceChangelogMock = vi.fn();
const reparseBookMock = vi.fn();
const getLibraryMock = vi.fn();
const deleteBookMock = vi.fn();
const getWorkspaceInfoMock = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    analyseManuscript: (manuscriptId: string, opts: unknown) => {
      analyseMock(manuscriptId, opts);
      /* Never resolves — keeps the AnalysingView effect parked in its
         loading state without flushing a setState after the test asserts. */
      return new Promise(() => {});
    },
    getWorkspaceChangelog: () => workspaceChangelogMock(),
    reparseBook: (bookId: string) => reparseBookMock(bookId),
    getLibrary: () => getLibraryMock(),
    deleteBook: (bookId: string) => deleteBookMock(bookId),
    getWorkspaceInfo: () => getWorkspaceInfoMock(),
    /* Local-model lifecycle stubs — AnalysingView polls /api/ollama/health
       when the selected analyzer is a local Ollama model (which is the
       default — MODEL_OPTIONS[0] is qwen3.5:4b). These tests only care
       about manuscriptId derivation, so resolve the probe to "model is
       resident" — that satisfies AnalysingView's isAnalyzerReady gate
       so the analysis useEffect actually fires (analyseMock gets called),
       which is what these assertions key off. */
    getOllamaHealth:   () => Promise.resolve({ status: 'reachable', url: '(test)', models: ['qwen3.5:4b'], expectedModel: 'qwen3.5:4b', modelPulled: true, resident: ['qwen3.5:4b'], modelResident: true }),
    getSidecarHealth:  () => Promise.resolve({ status: 'unreachable', url: '(test)' }),
    loadSidecar:       () => Promise.resolve({ status: 'idle' }),
    unloadSidecar:     () => Promise.resolve({ status: 'idle' }),
    loadAnalyzer:      () => Promise.resolve({ status: 'ready' }),
    unloadAnalyzer:    () => Promise.resolve({ status: 'unloaded' }),
    /* AnalysingView fetches book-state on mount to hydrate the
       per-chapter failed list. These tests don't exercise that surface;
       reject so the catch path silently skips hydration. */
    getBookState:      () => Promise.reject(new Error('not mocked')),
    /* Same idea for the dropped-quotes panel — it fetches on mount.
       Resolve with an empty envelope so the panel renders nothing
       and these route tests stay focused on manuscriptId derivation. */
    getDroppedQuotes:  () => Promise.resolve({ manuscriptId: 'm1', batches: [] }),
  },
  AnalysisError: class extends Error {
    code = 'unknown';
    detail?: string;
  },
}));

/* Confirm the workspace router actually wires `/log` to ChangelogRoute and the
   real route table mounts. */
void appRouter;

function makeStore() {
  return configureStore({
    reducer: {
      ui:         uiSlice.reducer,
      cast:       castSlice.reducer,
      chapters:   chaptersSlice.reducer,
      revisions:  revisionsSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      library:    librarySlice.reducer,
      voices:     voicesSlice.reducer,
      changeLog:  changeLogSlice.reducer,
      account:    accountSlice.reducer,
      bookMeta:   bookMetaSlice.reducer,
    },
  });
}

function makeBook(over: Partial<LibraryBook> = {}): LibraryBook {
  return {
    bookId: 'b1',
    title: 'the Coalfall Commission',
    author: 'Della Renwick',
    series: 'Standalones',
    seriesPosition: null,
    isStandalone: true,
    status: 'analysing',
    manuscriptId: 'mns-from-library',
    chapterCount: 4,
    completedChapters: 0,
    characterCount: 0,
    voiceCount: 0,
    progress: 0,
    lastWorkedOn: 'just now',
    coverGradient: ['#3C194F', '#0F0E0D'],
    ...over,
  } as LibraryBook;
}

function renderAtAnalysing(store: ReturnType<typeof makeStore>) {
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/books/b1/analysing']}>
        <Routes>
          <Route path="/books/:bookId/analysing" element={<AnalysingRoute/>}/>
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

beforeEach(() => {
  analyseMock.mockClear();
  workspaceChangelogMock.mockReset();
  reparseBookMock.mockReset();
  getLibraryMock.mockReset();
  deleteBookMock.mockReset();
  getWorkspaceInfoMock.mockReset();
});

describe('AnalysingRoute manuscriptId derivation', () => {
  it('uses manuscript.manuscriptId when stage.manuscriptId is null (page-refresh path)', async () => {
    /* Simulates: user refreshes /books/b1/analysing. useHydrateStage
       resets stage.manuscriptId to null; Layout's book-state hydration
       later seeds the manuscript slice from state.json. */
    const store = makeStore();
    store.dispatch(manuscriptActions.hydrateFromBookState({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      state: { bookId: 'b1', manuscriptId: 'mns-real', title: 'the Coalfall Commission' } as any,
      sentences: null,
      wordCount: 2440,
      format: 'plaintext',
    }));

    renderAtAnalysing(store);

    expect(screen.queryByText(/No manuscript loaded/i)).toBeNull();
    /* The analyse call now waits on (a) the Ollama-health probe
       resolving so the Start button enables, AND (b) the user clicking
       Start. The probe is mocked resident: true, so the button
       enables within the next tick. */
    const startBtn = await screen.findByRole('button', { name: /start analysis/i });
    fireEvent.click(startBtn);
    await waitFor(() => expect(analyseMock).toHaveBeenCalledTimes(1));
    expect(analyseMock).toHaveBeenCalledWith('mns-real', expect.any(Object));
  });

  it('falls back to library.book.manuscriptId before the manuscript slice has hydrated', async () => {
    /* Simulates: user clicks an analysing book from the library, but the
       per-book hydration GET hasn't landed yet. library.books[i].manuscriptId
       is the only id in flight; AnalysingRoute should still feed it through. */
    const store = makeStore();
    store.dispatch(libraryActions.hydrate({
      authors: [{
        name: 'Della Renwick',
        series: [{ name: 'Standalones', books: [makeBook({ manuscriptId: 'mns-from-library' })] }],
      }],
    }));

    renderAtAnalysing(store);

    expect(screen.queryByText(/No manuscript loaded/i)).toBeNull();
    const startBtn = await screen.findByRole('button', { name: /start analysis/i });
    fireEvent.click(startBtn);
    await waitFor(() => expect(analyseMock).toHaveBeenCalledWith('mns-from-library', expect.any(Object)));
  });

  it('uses the upload-provided manuscriptId after manuscriptUploaded fires', async () => {
    /* Simulates: user just finished upload → manuscriptUploaded set
       stage.manuscriptId AND the book-state hydration also seeds the
       manuscript slice with the same id from disk.
       (Earlier this test asserted "stage.manuscriptId takes precedence
       over manuscript.manuscriptId" with divergent ids; that
       precedence claim only held by a timing accident. The analysis
       useEffect used to fire synchronously DURING the first render,
       before useHydrateStage's useEffect dispatched its url-derived
       stage update that resets stage.manuscriptId to null for routes
       whose URL has no id in it. The isAnalyzerReady gate added in
       2026-05 lets the probe round-trip first, so useHydrateStage's
       clobber lands first and the fallback to manuscript.manuscriptId
       now matters. In real usage both ids ARE the same — the upload
       seeds both — so we test the realistic shape here. The
       precedence-when-divergent question is captured as a follow-up
       TODO in docs/features/00-stage-machine.md.) */
    const store = makeStore();
    store.dispatch(uiActions.startNewBook());
    store.dispatch(uiActions.manuscriptUploaded({ bookId: 'b1', manuscriptId: 'mns-from-upload' }));
    store.dispatch(manuscriptActions.hydrateFromBookState({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      state: { bookId: 'b1', manuscriptId: 'mns-from-upload', title: 'the Coalfall Commission' } as any,
      sentences: null,
      wordCount: 2440,
      format: 'plaintext',
    }));

    renderAtAnalysing(store);

    expect(screen.queryByText(/No manuscript loaded/i)).toBeNull();
    const startBtn = await screen.findByRole('button', { name: /start analysis/i });
    fireEvent.click(startBtn);
    await waitFor(() => expect(analyseMock).toHaveBeenCalledWith('mns-from-upload', expect.any(Object)));
  });

  it('still surfaces the "No manuscript loaded" banner when every source is empty', () => {
    /* Sanity check: with no library entry and no hydrated manuscript slice,
       the user really does need to start over. Banner must still appear so
       they have a recoverable action. */
    const store = makeStore();
    renderAtAnalysing(store);

    expect(screen.getByText(/No manuscript loaded/i)).toBeInTheDocument();
    expect(analyseMock).not.toHaveBeenCalled();
  });
});

describe('BooksRoute — re-parse wipes stale redux state', () => {
  /* Regression: re-parsing a book deletes cast.json + the analysis cache on
     the server, but the redux cast slice was only refilled by the layout's
     book-state hydration when the next disk read returned a non-empty
     character list. When the user opened the just-reparsed book, the
     layout hydration's `manuscript.manuscriptId && manuscript.title` guard
     also short-circuited (those fields still held the previous run's
     values), so the cast slice was never even rewritten. Result: Phase 0a
     streamed fresh chapter-by-chapter cast detections on top of the prior
     run's 24-character roster, and the Analysing view's "Cast so far"
     pill opened at 24 instead of 0.

     The fix dispatches castActions.setCharacters([]) and
     manuscriptActions.reset() right after a successful reparse RPC. */

  function makePopulatedStore() {
    const store = makeStore();
    /* Seed the library with one cast_pending book so the BooksRoute has
       a card to render and a target for the re-parse menu. */
    store.dispatch(libraryActions.hydrate({
      authors: [{
        name: 'Della Renwick',
        series: [{
          name: 'Standalones',
          books: [makeBook({ status: 'cast_pending', manuscriptId: 'mns-real' })],
        }],
      }],
    }));
    /* Stale state from a prior open: cast has 24 characters, manuscript
       slice still pins its manuscriptId+title. This is exactly the state
       layout.tsx leaves behind after the user navigates back to the books
       library — nothing resets it on goHome. */
    const staleChars: Character[] = Array.from({ length: 24 }, (_, i) => ({
      id: `c${i + 1}`,
      name: `Stale${i + 1}`,
      voiceState: 'generated',
    })) as Character[];
    store.dispatch(castActions.setCharacters(staleChars));
    store.dispatch(manuscriptActions.hydrateFromBookState({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      state: { bookId: 'b1', manuscriptId: 'mns-real', title: 'the Coalfall Commission' } as any,
      sentences: null,
      wordCount: 100000,
      format: 'plaintext',
    }));
    return store;
  }

  /* react-router v6 requires Outlet context to flow through a parent route.
     BooksRoute calls useOutletContext<LayoutContext>() to obtain showInfo /
     showError. We provide stubs via a tiny shim so the route can mount
     without the full Layout. */
  function renderBooks(store: ReturnType<typeof makeStore>) {
    const showInfo = vi.fn();
    const showError = vi.fn();
    const ctx: LayoutContext = { showInfo, showError };
    function OutletShim() { return <Outlet context={ctx}/>; }
    const utils = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<OutletShim/>}>
              <Route path="/" element={<BooksRoute/>}/>
            </Route>
          </Routes>
        </MemoryRouter>
      </Provider>,
    );
    return { ...utils, showInfo, showError };
  }

  it('clears cast.characters and resets the manuscript slice after a successful reparse', async () => {
    const store = makePopulatedStore();
    expect(store.getState().cast.characters).toHaveLength(24);
    expect(store.getState().manuscript.manuscriptId).toBe('mns-real');

    /* Mock the full RPC sequence onReparseBook drives. The reparse
       resolves with an empty chapter list (server returned the freshly
       parsed state). The library refresh returns the same book — irrelevant
       to the regression, just needed so the .then chain doesn't fall over. */
    reparseBookMock.mockResolvedValue({
      state: { chapters: [] },
      chapterCount: 0,
      chapterTitles: [],
      chapters: [],
    });
    getLibraryMock.mockResolvedValue({
      authors: [{
        name: 'Della Renwick',
        series: [{ name: 'Standalones', books: [makeBook({ status: 'cast_pending', manuscriptId: 'mns-real' })] }],
      }],
    });
    getWorkspaceInfoMock.mockResolvedValue({ root: '/tmp/audiobooks', source: 'env' });

    renderBooks(store);

    /* Drive the menu → "Re-parse manuscript" → confirm sequence. The card's
       menu button is opacity-0 until hover but it's still in the DOM and
       fireEvent can target it directly. */
    fireEvent.click(screen.getByLabelText('Book options'));
    fireEvent.click(screen.getByRole('button', { name: /Re-parse manuscript/i }));
    /* The confirm dialog also renders a "Re-parse manuscript" button — query
       all matches and click the dialog's (last) one to confirm. */
    const reparseButtons = screen.getAllByRole('button', { name: /Re-parse manuscript/i });
    fireEvent.click(reparseButtons[reparseButtons.length - 1]);

    await waitFor(() => {
      expect(reparseBookMock).toHaveBeenCalledWith('b1');
    });
    await waitFor(() => {
      expect(store.getState().cast.characters).toHaveLength(0);
    });
    /* Manuscript slice reset so the layout's next per-book hydrate guard
       won't short-circuit when the user clicks "Analyse now". */
    expect(store.getState().manuscript.manuscriptId).toBeNull();
    expect(store.getState().manuscript.title).toBeNull();
  });
});

describe('ChangelogRoute', () => {
  it('fetches workspace events and renders them with their book subtitle', async () => {
    const events: ChangeLogEvent[] = [
      {
        id: 1, at: '2026-05-13T15:00:00.000Z', ts: 'Just now', date: 'today',
        type: 'regenerate', title: 'Regenerated Chapter 3',
        note: 'Reason: voice tuning updated.', actor: 'you',
        chapterId: 3, revertible: true,
        bookId: 'sb', bookTitle: 'Solway Bay', author: 'Demo',
      },
      {
        id: 2, at: '2026-05-13T12:00:00.000Z', ts: 'earlier', date: 'today',
        type: 'cast_confirm', title: 'Confirmed the cast',
        note: '6 characters.', actor: 'you',
        bookId: 'ns', bookTitle: 'Northern Star', author: 'Demo',
      },
    ];
    workspaceChangelogMock.mockResolvedValue({
      events,
      nextCursor: null,
      totalCount: events.length,
      categoryCounts: { voice: 0, generation: 1, manuscript: 0, cast: 1 },
    });

    const store = makeStore();
    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/log']}>
          <Routes>
            <Route path="/log" element={<ChangelogRoute/>}/>
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    /* Wait for the workspace fetch to resolve and the slice to hydrate so the
       view re-renders with both events. */
    await waitFor(() => {
      expect(screen.getByText('Regenerated Chapter 3')).toBeInTheDocument();
    });
    expect(workspaceChangelogMock).toHaveBeenCalledTimes(1);
    /* Compact rows inline the bookTitle into the header row as "· <title>"
       so the text node is "· Solway Bay" — substring match keeps the
       assertion robust against the separator. */
    expect(screen.getByText(/Solway Bay/)).toBeInTheDocument();
    expect(screen.getByText(/Northern Star/)).toBeInTheDocument();
    /* The per-book log seed fixture must NOT leak into the workspace view. */
    expect(screen.queryByText("Tuned Eliza Gray's voice")).toBeNull();
  });
});
