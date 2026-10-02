// Pairs with docs/features/archive/00-stage-machine.md and 21-book-library.md
//
// Regression for the "No manuscript loaded" banner that appeared on the
// Analysing screen after a page refresh / deep link / confirm→reanalyse:
// AnalysingRoute used to read manuscriptId only from ui.stage, which gets
// clobbered to null by useHydrateStage. The fix is to fall back to the
// manuscript slice (populated by Layout's book-state hydration) and the
// library entry.

import { Suspense } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter, Outlet, Routes, Route } from 'react-router';
import { uiSlice, uiActions } from '../store/ui-slice';
import { castSlice, castActions } from '../store/cast-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { manuscriptSlice, manuscriptActions } from '../store/manuscript-slice';
import { librarySlice, libraryActions } from '../store/library-slice';
import { queueSlice } from '../store/queue-slice';
import { revisionsSlice } from '../store/revisions-slice';
import { voicesSlice } from '../store/voices-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { accountSlice } from '../store/account-slice';
import { bookMetaSlice } from '../store/book-meta-slice';
import { tourSlice } from '../store/tour-slice';
import { persistenceMiddleware, flushBookPersistence } from '../store/persistence-middleware';
import { router as appRouter } from './index';
import {
  AnalysingRoute,
  AdvancedRoute,
  BooksRoute,
  ChangelogRoute,
  ReadyRoute,
  SetupRoute,
} from './index';
import { chaptersActions } from '../store/chapters-slice';
import type { LayoutContext } from '../components/layout';
import type { Chapter, Character, LibraryBook, ChangeLogEvent } from '../lib/types';

const analyseMock = vi.fn();
const workspaceChangelogMock = vi.fn();
const reparseBookMock = vi.fn();
const getLibraryMock = vi.fn();
const deleteBookMock = vi.fn();
const replaceManuscriptMock = vi.fn();
const putBookStateMock = vi.fn();
const getBookStateMock = vi.fn();
const getWorkspaceInfoMock = vi.fn();
const completeSetupMock = vi.fn();

/* #3195 R2 — SetupRoute's onFinish is what the "corruptSettingsFile sync"
   test below exercises; the five-step wizard behind SetupView is pinned by
   its own suite (components/setup/setup-wizard.test.tsx), so stub the view
   down to the one affordance the route owns: the finish callback. */
vi.mock('../views/setup', () => ({
  SetupView: ({ onFinish }: { onFinish: () => void }) => (
    <button type="button" onClick={onFinish}>
      Finish setup
    </button>
  ),
}));

/* #3084 F7 — the AdvancedRoute case below pins the URL → stage derivation
   only; AdvancedView's own rows, scrolling and highlighting are pinned by
   src/views/advanced.test.tsx (and it would call api.getConfig, which this
   file's api mock does not carry). Same shape as the SetupView stub above. */
vi.mock('../views/advanced', () => ({
  AdvancedView: () => <div data-testid="advanced-view" />,
}));

vi.mock('../lib/api', () => ({
  api: {
    completeSetup: () => completeSetupMock(),
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
    replaceManuscript: (bookId: string, file: File) => replaceManuscriptMock(bookId, file),
    putBookState: (bookId: string, req: unknown) => putBookStateMock(bookId, req),
    getWorkspaceInfo: () => getWorkspaceInfoMock(),
    /* Local-model lifecycle stubs — AnalysingView polls /api/ollama/health
       when the selected analyzer is a local Ollama model (which is the
       default — MODEL_OPTIONS[0] is qwen3.5:4b). These tests only care
       about manuscriptId derivation, so resolve the probe to "model is
       resident" — that satisfies AnalysingView's isAnalyzerReady gate
       so the analysis useEffect actually fires (analyseMock gets called),
       which is what these assertions key off. */
    getOllamaHealth: () =>
      Promise.resolve({
        status: 'reachable',
        url: '(test)',
        models: ['qwen3.5:4b'],
        expectedModel: 'qwen3.5:4b',
        modelPulled: true,
        resident: ['qwen3.5:4b'],
        modelResident: true,
      }),
    getSidecarHealth: () => Promise.resolve({ status: 'unreachable', url: '(test)' }),
    /* useTtsLifecycle also polls /api/gpu/queue on the same tick. Stub
       to an empty queue so the "GPU busy · N waiting ·" prefix stays
       hidden in these tests. */
    getGpuQueueState: () => Promise.resolve({ queueDepth: 0, devices: [] }),
    /* useTtsLifecycle also polls the code-43 auto-revert trip status on the
       same tick (task 16/16.5, #2974) — resolve to null so no trip banner
       state lands, same pattern as getGpuQueueState above. */
    getGpuTripStatus: () => Promise.resolve(null),
    loadSidecar: () => Promise.resolve({ status: 'idle' }),
    unloadSidecar: () => Promise.resolve({ status: 'idle' }),
    loadAnalyzer: () => Promise.resolve({ status: 'ready' }),
    unloadAnalyzer: () => Promise.resolve({ status: 'unloaded' }),
    /* AnalysingView fetches book-state on mount to hydrate the
       per-chapter failed list. These tests don't exercise that surface;
       reject so the catch path silently skips hydration. */
    getBookState: (bookId: string) => getBookStateMock(bookId),
    /* Same idea for the dropped-quotes panel — it fetches on mount.
       Resolve with an empty envelope so the panel renders nothing
       and these route tests stay focused on manuscriptId derivation. */
    getDroppedQuotes: () => Promise.resolve({ manuscriptId: 'm1', batches: [] }),
    /* GenerationView's ChapterSegmentStrip lazy-fetches segments for
       done chapters when their row is expanded. Never resolve so the
       state update doesn't flush outside React's `act()` after a test
       asserts. */
    getChapterAudio: () => new Promise(() => {}),
    /* fs-21 — Layout's boot-splash readiness gate fetches this once on mount;
       resolve ready so the splash clears and the routed views render. */
    getSetupReadiness: () =>
      Promise.resolve({
        ready: true,
        completedAt: '2026-06-12T00:00:00.000Z',
        blockers: {
          sidecar: { status: 'pass', cause: 'pass', message: '', remediation: '' },
          ffmpeg: { status: 'pass', cause: 'pass', message: '', remediation: '' },
          tts: { status: 'pass', cause: 'pass', message: '', remediation: '' },
          analyzer: { status: 'pass', cause: 'pass', message: '', remediation: '' },
        },
        info: { gpu: 'cuda · 1.2 / 8.0 GB reserved' },
      }),
    /* fs-15 — book-library view fetches the continue-listening rail on
       mount. Never resolve so no rail state update escapes the test. */
    getContinueListening: () => new Promise(() => {}),
  },
  AnalysisError: class extends Error {
    code = 'unknown';
    detail?: string;
  },
}));

/* Confirm the workspace router actually wires `/log` to ChangelogRoute and the
   real route table mounts. */
void appRouter;

function makeStore(opts: { persist?: boolean } = {}) {
  return configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      chapters: chaptersSlice.reducer,
      revisions: revisionsSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      library: librarySlice.reducer,
      voices: voicesSlice.reducer,
      changeLog: changeLogSlice.reducer,
      account: accountSlice.reducer,
      bookMeta: bookMetaSlice.reducer,
      queue: queueSlice.reducer,
      tour: tourSlice.reducer,
    },
    ...(opts.persist
      ? { middleware: (getDefault) => getDefault().concat(persistenceMiddleware) }
      : {}),
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
        {/* Plan 89 C5 — route-leaf views are React.lazy now, so Suspense is
            required wherever AnalysingRoute mounts AnalysingView. */}
        <Suspense fallback={<div data-testid="suspense-loading" />}>
          <Routes>
            <Route path="/books/:bookId/analysing" element={<AnalysingRoute />} />
          </Routes>
        </Suspense>
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
  replaceManuscriptMock.mockReset();
  putBookStateMock.mockReset();
  putBookStateMock.mockResolvedValue(undefined);
  getBookStateMock.mockReset();
  getBookStateMock.mockRejectedValue(new Error('not mocked'));
  getWorkspaceInfoMock.mockReset();
  completeSetupMock.mockReset();
});

describe('SetupRoute — corruptSettingsFile sync from the completeSetup response (#3195 P2/R2)', () => {
  function renderAtSetup(store: ReturnType<typeof makeStore>) {
    return render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/setup']}>
          <Suspense fallback={<div data-testid="suspense-loading" />}>
            <Routes>
              <Route path="/setup" element={<SetupRoute />} />
              <Route path="/" element={<div data-testid="home" />} />
            </Routes>
          </Suspense>
        </MemoryRouter>
      </Provider>,
    );
  }

  it('finishing setup with corruptSettingsFile: true in the response updates the account slice', async () => {
    completeSetupMock.mockResolvedValueOnce({
      completedAt: '2026-06-12T00:00:00.000Z',
      corruptSettingsFile: true,
    });
    const store = makeStore();
    renderAtSetup(store);
    expect(store.getState().account.corruptSettingsFile).toBe(false);

    fireEvent.click(await screen.findByRole('button', { name: 'Finish setup' }));

    await waitFor(() => expect(completeSetupMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(store.getState().account.corruptSettingsFile).toBe(true));
    // and the route still navigates home afterwards
    await screen.findByTestId('home');
  });

  it('finishing setup with corruptSettingsFile: false clears a flag that was set', async () => {
    completeSetupMock.mockResolvedValueOnce({
      completedAt: '2026-06-12T00:00:00.000Z',
      corruptSettingsFile: false,
    });
    const store = makeStore();
    store.dispatch(accountSlice.actions.setCorruptSettingsFile(true));
    renderAtSetup(store);

    fireEvent.click(await screen.findByRole('button', { name: 'Finish setup' }));

    await waitFor(() => expect(completeSetupMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(store.getState().account.corruptSettingsFile).toBe(false));
  });
});

describe('AnalysingRoute manuscriptId derivation', () => {
  it('uses manuscript.manuscriptId when stage.manuscriptId is null (page-refresh path)', async () => {
    /* Simulates: user refreshes /books/b1/analysing. useHydrateStage
       resets stage.manuscriptId to null; Layout's book-state hydration
       later seeds the manuscript slice from state.json. */
    const store = makeStore();
    store.dispatch(
      manuscriptActions.hydrateFromBookState({
        state: { bookId: 'b1', manuscriptId: 'mns-real', title: 'the Coalfall Commission' } as any,
        sentences: null,
        wordCount: 2440,
        format: 'plaintext',
      }),
    );

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
    store.dispatch(
      libraryActions.hydrate({
        authors: [
          {
            name: 'Della Renwick',
            series: [
              { name: 'Standalones', books: [makeBook({ manuscriptId: 'mns-from-library' })] },
            ],
          },
        ],
      }),
    );

    renderAtAnalysing(store);

    expect(screen.queryByText(/No manuscript loaded/i)).toBeNull();
    const startBtn = await screen.findByRole('button', { name: /start analysis/i });
    fireEvent.click(startBtn);
    await waitFor(() =>
      expect(analyseMock).toHaveBeenCalledWith('mns-from-library', expect.any(Object)),
    );
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
       TODO in docs/features/archive/00-stage-machine.md.) */
    const store = makeStore();
    store.dispatch(uiActions.startNewBook());
    store.dispatch(uiActions.manuscriptUploaded({ bookId: 'b1', manuscriptId: 'mns-from-upload' }));
    store.dispatch(
      manuscriptActions.hydrateFromBookState({
        state: { bookId: 'b1', manuscriptId: 'mns-from-upload', title: 'the Coalfall Commission' } as any,
        sentences: null,
        wordCount: 2440,
        format: 'plaintext',
      }),
    );

    renderAtAnalysing(store);

    expect(screen.queryByText(/No manuscript loaded/i)).toBeNull();
    const startBtn = await screen.findByRole('button', { name: /start analysis/i });
    fireEvent.click(startBtn);
    await waitFor(() =>
      expect(analyseMock).toHaveBeenCalledWith('mns-from-upload', expect.any(Object)),
    );
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

/* #3084 F7 — AdvancedRoute is the FIRST route in this file whose stage
   carries a query param, so this is the file's first "reads a search param
   into ui.stage" case (there is no HelpRoute equivalent to copy from).
   Modelled on renderAtAnalysing above; Suspense is required because the
   route leaf views are React.lazy. */
function renderAtAdvanced(store: ReturnType<typeof makeStore>, path = '/advanced') {
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[path]}>
        <Suspense fallback={<div data-testid="suspense-loading" />}>
          <Routes>
            <Route path="/advanced" element={<AdvancedRoute />} />
          </Routes>
        </Suspense>
      </MemoryRouter>
    </Provider>,
  );
}

describe('AdvancedRoute — focus query param hydrates the stage (#3084 wave 2b, F7)', () => {
  /* The `await`s here are load-bearing, not decoration. AdvancedView is
     React.lazy (src/routes/index.tsx:82), so the FIRST render suspends: React
     throws that render away and re-renders from the Suspense boundary, and
     AdvancedRoute's own useHydrateStage effect only commits once the lazily
     imported module has resolved. Reading store.getState() synchronously
     therefore reads the stage BEFORE hydration. That passed only while an
     earlier test in the same worker had already warmed the module registry,
     and failed when this file's tests ran alone — verified: the no-param
     sibling below failed identically in a cold process. Waiting for the
     stubbed AdvancedView to mount is what makes these deterministic in either
     order. */
  it('reads ?focus= into ui.stage.focusKey', async () => {
    const store = makeStore();
    renderAtAdvanced(store, '/advanced?focus=analyzer.gemini.maxInputTokensPerRequest');
    await screen.findByTestId('advanced-view');
    await waitFor(() =>
      expect(store.getState().ui.stage).toMatchObject({
        kind: 'advanced',
        focusKey: 'analyzer.gemini.maxInputTokensPerRequest',
      }),
    );
  });

  it('omits focusKey with no query param', async () => {
    const store = makeStore();
    renderAtAdvanced(store);
    await screen.findByTestId('advanced-view');
    await waitFor(() => expect(store.getState().ui.stage).toMatchObject({ kind: 'advanced' }));
    expect((store.getState().ui.stage as { focusKey?: string }).focusKey).toBeUndefined();
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

     The fix dispatches castActions.hydrateCharacters([]) and
     manuscriptActions.reset() right after a successful reparse RPC. */

  function makePopulatedStore(opts: { persist?: boolean } = {}) {
    const store = makeStore(opts);
    /* Seed the library with one cast_pending book so the BooksRoute has
       a card to render and a target for the re-parse menu. */
    store.dispatch(
      libraryActions.hydrate({
        authors: [
          {
            name: 'Della Renwick',
            series: [
              {
                name: 'Standalones',
                books: [makeBook({ status: 'cast_pending', manuscriptId: 'mns-real' })],
              },
            ],
          },
        ],
      }),
    );
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
    store.dispatch(
      manuscriptActions.hydrateFromBookState({
        state: { bookId: 'b1', manuscriptId: 'mns-real', title: 'the Coalfall Commission' } as any,
        sentences: null,
        wordCount: 100000,
        format: 'plaintext',
      }),
    );
    return store;
  }

  /* react-router v6 requires Outlet context to flow through a parent route.
     BooksRoute calls useOutletContext<LayoutContext>() to obtain showInfo /
     showError. We provide stubs via a tiny shim so the route can mount
     without the full Layout. */
  function renderBooks(store: ReturnType<typeof makeStore>) {
    const showInfo = vi.fn();
    const showError = vi.fn();
    /* Stub ttsLifecycle — these tests don't exercise the TTS pill; the
       BooksRoute itself doesn't read it. Keeping the shape compliant so the
       LayoutContext type doesn't complain. */
    const ctx: LayoutContext = {
      showInfo,
      showError,
      pushToast: vi.fn(),
      ttsLifecycle: {
        coqui: {
          state: 'unreachable',
          onLoad: vi.fn(async () => {}),
          onStop: vi.fn(async () => {}),
        },
        kokoro: {
          state: 'unreachable',
          onLoad: vi.fn(async () => {}),
          onStop: vi.fn(async () => {}),
        },
        qwen: {
          state: 'unreachable',
          onLoad: vi.fn(async () => {}),
          onStop: vi.fn(async () => {}),
        },
        qwen1_7b: {
          state: 'unreachable',
          onLoad: vi.fn(async () => {}),
          onStop: vi.fn(async () => {}),
        },
        asr: { enabled: false, state: 'idle', device: null },
        qwen1_7bInstalled: false,
        evictionNotice: null,
        loadErrorNotice: null,
        tripNotice: null,
        dismissNotices: vi.fn(),
      },
      priorRoster: [],
      openFixCharacterAudio: vi.fn(),
    };
    function OutletShim() {
      return <Outlet context={ctx} />;
    }
    const utils = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<OutletShim />}>
              <Route path="/" element={<BooksRoute />} />
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
      authors: [
        {
          name: 'Della Renwick',
          series: [
            {
              name: 'Standalones',
              books: [makeBook({ status: 'cast_pending', manuscriptId: 'mns-real' })],
            },
          ],
        },
      ],
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

  /* #3376 — the redux reset is a hydrate-style mirror of a wipe the server
     already did, not a user edit. The RPC is async, so by the time it
     resolves the user may have opened ANOTHER book (ui.stage now names it);
     a persisted `cast/setCharacters([])` would then schedule a cast PUT of
     an empty roster at that book's real cast.json. */
  it('does not persist an empty cast at whichever book is open when the re-parse resolves', async () => {
    const store = makePopulatedStore({ persist: true });
    let resolveReparse!: (v: unknown) => void;
    reparseBookMock.mockReturnValue(new Promise((r) => (resolveReparse = r)));
    getLibraryMock.mockResolvedValue({ authors: [] });
    getWorkspaceInfoMock.mockResolvedValue({ root: '/tmp/audiobooks', source: 'env' });

    renderBooks(store);
    fireEvent.click(screen.getByLabelText('Book options'));
    fireEvent.click(screen.getByRole('button', { name: /Re-parse manuscript/i }));
    const reparseButtons = screen.getAllByRole('button', { name: /Re-parse manuscript/i });
    fireEvent.click(reparseButtons[reparseButtons.length - 1]);
    await waitFor(() => expect(reparseBookMock).toHaveBeenCalledWith('b1'));

    /* The user opens a different book while the re-parse is still in flight. */
    store.dispatch(uiActions.openBook({ id: 'b2', status: 'complete' }));
    resolveReparse({ state: { chapters: [] }, chapterCount: 0, chapterTitles: [], chapters: [] });

    await waitFor(() => expect(store.getState().cast.characters).toHaveLength(0));
    expect((store.getState().ui.stage as { bookId?: string }).bookId).toBe('b2');
    /* Send b2's queued write now rather than sleeping out the debounce. */
    await store.dispatch(flushBookPersistence('b2') as never);
    expect(putBookStateMock).not.toHaveBeenCalled();
  });

  /* #3395 pass 6, O1 — each handler's "is the wiped book open?" guard must
     read the LIVE stage after its await. The render-time `bookId` is always
     null on the Library, so a book opened while the RPC was in flight kept
     its pre-wipe revisions and wrote them back into the wiped file. */
  describe('leaves a book opened while its wipe RPC was in flight', () => {
    function openedBookId(store: ReturnType<typeof makeStore>) {
      return (store.getState().ui.stage as { bookId?: string }).bookId;
    }

    beforeEach(() => {
      getLibraryMock.mockResolvedValue({ authors: [] });
      getWorkspaceInfoMock.mockResolvedValue({ root: '/tmp/audiobooks', source: 'env' });
    });

    it('re-parse', async () => {
      const store = makePopulatedStore();
      let resolveReparse!: (v: unknown) => void;
      reparseBookMock.mockReturnValue(new Promise((r) => (resolveReparse = r)));
      renderBooks(store);
      fireEvent.click(screen.getByLabelText('Book options'));
      fireEvent.click(screen.getByRole('button', { name: /Re-parse manuscript/i }));
      const confirm = screen.getAllByRole('button', { name: /Re-parse manuscript/i });
      fireEvent.click(confirm[confirm.length - 1]);
      await waitFor(() => expect(reparseBookMock).toHaveBeenCalledWith('b1'));

      store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
      expect(openedBookId(store)).toBe('b1');
      resolveReparse({ state: { chapters: [] }, chapterCount: 0, chapterTitles: [], chapters: [] });

      await waitFor(() => expect(store.getState().ui.stage.kind).toBe('books'));
    });

    it('manuscript replace', async () => {
      const store = makePopulatedStore();
      let resolveReplace!: (v: unknown) => void;
      replaceManuscriptMock.mockReturnValue(new Promise((r) => (resolveReplace = r)));
      renderBooks(store);
      fireEvent.click(screen.getByLabelText('Book options'));
      fireEvent.change(screen.getByTestId('replace-manuscript-input'), {
        target: { files: [new File(['# One'], 'new.md', { type: 'text/markdown' })] },
      });
      const confirm = screen.getAllByRole('button', { name: /Replace manuscript/i });
      fireEvent.click(confirm[confirm.length - 1]);
      await waitFor(() => expect(replaceManuscriptMock).toHaveBeenCalledWith('b1', expect.any(File)));

      store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
      resolveReplace({ chapterCount: 1 });

      await waitFor(() => expect(store.getState().ui.stage.kind).toBe('books'));
    });

    it('delete', async () => {
      const store = makePopulatedStore();
      let resolveDelete!: (v?: unknown) => void;
      deleteBookMock.mockReturnValue(new Promise((r) => (resolveDelete = r)));
      renderBooks(store);
      fireEvent.click(screen.getByLabelText('Book options'));
      fireEvent.click(screen.getByRole('button', { name: /Delete book/i }));
      const confirm = screen.getAllByRole('button', { name: /Delete book/i });
      fireEvent.click(confirm[confirm.length - 1]);
      await waitFor(() => expect(deleteBookMock).toHaveBeenCalledWith('b1'));

      store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
      resolveDelete();

      await waitFor(() => expect(store.getState().ui.stage.kind).toBe('books'));
    });
  });

  /* #3395 pass 5, N1 — a revisions write recorded for b1 before its disk
     read landed (the user left first) is replayed on b1's next hydrate. The
     server has wiped b1 by then, so each handler that mirrors a wipe must
     drop the record too, or the stale take comes back on the wiped book. */
  describe('drops the book\'s recorded pre-hydrate revisions writes', () => {
    function seedRecordedWrites(store: ReturnType<typeof makeStore>) {
      store.dispatch(revisionsSlice.actions.bookScopeChanged('b1'));
      store.dispatch(revisionsSlice.actions.markRevisionPlayable({ chapterId: 3 }));
      store.dispatch(revisionsSlice.actions.bookScopeChanged(null));
      expect(store.getState().revisions.windowActions.b1).toHaveLength(1);
    }

    beforeEach(() => {
      getLibraryMock.mockResolvedValue({ authors: [] });
      getWorkspaceInfoMock.mockResolvedValue({ root: '/tmp/audiobooks', source: 'env' });
    });

    it('after a re-parse', async () => {
      const store = makePopulatedStore();
      seedRecordedWrites(store);
      reparseBookMock.mockResolvedValue({ state: { chapters: [] }, chapterCount: 0, chapterTitles: [], chapters: [] });
      renderBooks(store);
      fireEvent.click(screen.getByLabelText('Book options'));
      fireEvent.click(screen.getByRole('button', { name: /Re-parse manuscript/i }));
      const confirm = screen.getAllByRole('button', { name: /Re-parse manuscript/i });
      fireEvent.click(confirm[confirm.length - 1]);
      await waitFor(() => expect(store.getState().cast.characters).toHaveLength(0));
      expect(store.getState().revisions.windowActions.b1).toBeUndefined();
    });

    it('after a manuscript replace', async () => {
      const store = makePopulatedStore();
      seedRecordedWrites(store);
      replaceManuscriptMock.mockResolvedValue({ chapterCount: 1 });
      renderBooks(store);
      fireEvent.click(screen.getByLabelText('Book options'));
      fireEvent.change(screen.getByTestId('replace-manuscript-input'), {
        target: { files: [new File(['# One'], 'new.md', { type: 'text/markdown' })] },
      });
      const confirm = screen.getAllByRole('button', { name: /Replace manuscript/i });
      fireEvent.click(confirm[confirm.length - 1]);
      await waitFor(() => expect(replaceManuscriptMock).toHaveBeenCalledWith('b1', expect.any(File)));
      await waitFor(() => expect(store.getState().cast.characters).toHaveLength(0));
      expect(store.getState().revisions.windowActions.b1).toBeUndefined();
    });

    it('after a delete', async () => {
      const store = makePopulatedStore();
      seedRecordedWrites(store);
      deleteBookMock.mockResolvedValue(undefined);
      renderBooks(store);
      fireEvent.click(screen.getByLabelText('Book options'));
      fireEvent.click(screen.getByRole('button', { name: /Delete book/i }));
      const confirm = screen.getAllByRole('button', { name: /Delete book/i });
      fireEvent.click(confirm[confirm.length - 1]);
      await waitFor(() => expect(deleteBookMock).toHaveBeenCalledWith('b1'));
      /* Let the handler's library refresh settle before asserting. */
      await waitFor(() => expect(getLibraryMock).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(store.getState().revisions.windowActions.b1).toBeUndefined();
    });
  });
});

describe('BooksRoute — edit book metadata from the card menu', () => {
  /* Covers the "Edit details" entry in the card's "…" menu. The modal
     collects the patch; the route handler routes it through
     api.putBookState(bookId, { slice: 'state', patch }) and refreshes
     the library so the card heading updates in place. Mirrors the
     reparse/delete pattern — errors surface through showError and the
     modal can be retried. */

  function makeLibStore(bookOver: Partial<LibraryBook> = {}) {
    const store = makeStore();
    store.dispatch(
      libraryActions.hydrate({
        authors: [
          {
            name: 'Della Renwick',
            series: [
              {
                name: 'Standalones',
                books: [makeBook({ status: 'complete', manuscriptId: 'mns-real', ...bookOver })],
              },
            ],
          },
        ],
      }),
    );
    return store;
  }

  function renderBooks(store: ReturnType<typeof makeStore>) {
    const showInfo = vi.fn();
    const showError = vi.fn();
    /* Stub ttsLifecycle — these tests don't exercise the TTS pill; the
       BooksRoute itself doesn't read it. Keeping the shape compliant so the
       LayoutContext type doesn't complain. */
    const ctx: LayoutContext = {
      showInfo,
      showError,
      pushToast: vi.fn(),
      ttsLifecycle: {
        coqui: {
          state: 'unreachable',
          onLoad: vi.fn(async () => {}),
          onStop: vi.fn(async () => {}),
        },
        kokoro: {
          state: 'unreachable',
          onLoad: vi.fn(async () => {}),
          onStop: vi.fn(async () => {}),
        },
        qwen: {
          state: 'unreachable',
          onLoad: vi.fn(async () => {}),
          onStop: vi.fn(async () => {}),
        },
        qwen1_7b: {
          state: 'unreachable',
          onLoad: vi.fn(async () => {}),
          onStop: vi.fn(async () => {}),
        },
        asr: { enabled: false, state: 'idle', device: null },
        qwen1_7bInstalled: false,
        evictionNotice: null,
        loadErrorNotice: null,
        tripNotice: null,
        dismissNotices: vi.fn(),
      },
      priorRoster: [],
      openFixCharacterAudio: vi.fn(),
    };
    function OutletShim() {
      return <Outlet context={ctx} />;
    }
    const utils = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<OutletShim />}>
              <Route path="/" element={<BooksRoute />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </Provider>,
    );
    return { ...utils, showInfo, showError };
  }

  it("opens the modal seeded with the book's current title, then saves through api.putBookState and refreshes the library", async () => {
    const store = makeLibStore();
    getWorkspaceInfoMock.mockResolvedValue({ root: '/tmp/audiobooks', source: 'env' });
    putBookStateMock.mockResolvedValue(undefined);
    getLibraryMock.mockResolvedValue({
      authors: [
        {
          name: 'Della Renwick',
          series: [
            {
              name: 'Standalones',
              books: [makeBook({ status: 'complete', manuscriptId: 'mns-real', title: 'Renamed' })],
            },
          ],
        },
      ],
    });

    renderBooks(store);

    fireEvent.click(screen.getByLabelText('Book options'));
    fireEvent.click(screen.getByRole('button', { name: /Edit details/i }));

    /* Modal seeded with the existing title. */
    const titleInput = (await screen.findByLabelText('Title')) as HTMLInputElement;
    expect(titleInput.value).toBe('the Coalfall Commission');

    /* Edit the title. The Standalone checkbox is already checked
       (the seed sets isStandalone: true), so series/position stay
       disabled — we exercise only the title rename path here. */
    fireEvent.change(titleInput, { target: { value: "the Coalfall Commission (Director's Cut)" } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => {
      expect(putBookStateMock).toHaveBeenCalledTimes(1);
    });
    expect(putBookStateMock).toHaveBeenCalledWith('b1', {
      slice: 'state',
      patch: expect.objectContaining({
        title: "the Coalfall Commission (Director's Cut)",
        author: 'Della Renwick',
        isStandalone: true,
        seriesPosition: null,
      }),
    });
    /* Library refetch is fired on success so the card reflects the new title. */
    await waitFor(() => {
      expect(getLibraryMock).toHaveBeenCalled();
    });
  });

  it('flipping standalone off then setting seriesPosition writes both fields', async () => {
    const store = makeLibStore();
    getWorkspaceInfoMock.mockResolvedValue({ root: '/tmp/audiobooks', source: 'env' });
    putBookStateMock.mockResolvedValue(undefined);
    getLibraryMock.mockResolvedValue({ authors: [] });

    renderBooks(store);
    fireEvent.click(screen.getByLabelText('Book options'));
    fireEvent.click(screen.getByRole('button', { name: /Edit details/i }));

    /* Uncheck Standalone to enable Series + Position inputs. */
    const standaloneToggle = await screen.findByLabelText(/Standalone/i);
    fireEvent.click(standaloneToggle);

    /* Now fill in series + position. */
    const seriesInput = screen.getByLabelText('Series') as HTMLInputElement;
    fireEvent.change(seriesInput, { target: { value: 'The Hollow Tide' } });
    const positionInput = screen.getByLabelText('Position in series') as HTMLInputElement;
    fireEvent.change(positionInput, { target: { value: '8' } });

    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => {
      expect(putBookStateMock).toHaveBeenCalledTimes(1);
    });
    expect(putBookStateMock.mock.calls[0][1]).toMatchObject({
      slice: 'state',
      patch: expect.objectContaining({
        isStandalone: false,
        series: 'The Hollow Tide',
        seriesPosition: 8,
      }),
    });
  });

  it('surfaces an error toast and leaves the menu re-openable when putBookState rejects', async () => {
    const store = makeLibStore();
    getWorkspaceInfoMock.mockResolvedValue({ root: '/tmp/audiobooks', source: 'env' });
    putBookStateMock.mockRejectedValue(new Error('disk locked'));

    const { showError } = renderBooks(store);

    fireEvent.click(screen.getByLabelText('Book options'));
    fireEvent.click(screen.getByRole('button', { name: /Edit details/i }));

    const titleInput = (await screen.findByLabelText('Title')) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => {
      expect(showError).toHaveBeenCalledTimes(1);
    });
    expect(showError).toHaveBeenCalledWith(
      expect.stringContaining('the Coalfall Commission'),
      'disk locked',
      'Edit',
    );
    /* Library refetch must NOT have fired on the failure path. */
    expect(getLibraryMock).not.toHaveBeenCalled();
  });
});

describe('ChangelogRoute', () => {
  it('fetches workspace events and renders them with their book subtitle', async () => {
    const events: ChangeLogEvent[] = [
      {
        id: 1,
        at: '2026-05-13T15:00:00.000Z',
        ts: 'Just now',
        date: 'today',
        type: 'regenerate',
        title: 'Regenerated Chapter 3',
        note: 'Reason: voice tuning updated.',
        actor: 'you',
        chapterId: 3,
        revertible: true,
        bookId: 'sb',
        bookTitle: 'Solway Bay',
        author: 'Demo',
      },
      {
        id: 2,
        at: '2026-05-13T12:00:00.000Z',
        ts: 'earlier',
        date: 'today',
        type: 'cast_confirm',
        title: 'Confirmed the cast',
        note: '6 characters.',
        actor: 'you',
        bookId: 'ns',
        bookTitle: 'Northern Star',
        author: 'Demo',
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
          {/* Plan 89 C5 — ChangeLogView is lazy now, wrap in Suspense. */}
          <Suspense fallback={<div data-testid="suspense-loading" />}>
            <Routes>
              <Route path="/log" element={<ChangelogRoute />} />
            </Routes>
          </Suspense>
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

describe('ReadyRoute — cross-book Generate view title (regression)', () => {
  /* Bug: user analysing Book A clicks the global generation pill to jump
     to Book B's Generate view (still streaming). The manuscript slice is
     pinned to Book A (its title, manuscriptId, sentences). Pre-fix the
     Generate H1 read `manuscript.title || activeBook?.title || null`
     unguarded, so the user saw "Generating <BookA>" on Book B's screen
     until the per-book disk hydrate completed (or forever, since
     Layout's hydration short-circuit skipped re-fetching when manuscript
     was already populated). Fix: anchor the manuscript slice to a
     bookId and prefer the library entry's title whenever the slice
     points at a different book. */
  it("renders Book B's title on Book B's /generate even when the manuscript slice is still pinned to Book A", async () => {
    const store = makeStore();
    /* Library has both books — the user is meant to see Book B's title. */
    store.dispatch(
      libraryActions.hydrate({
        authors: [
          {
            name: 'Demo Author',
            series: [
              {
                name: 'Standalones',
                books: [
                  makeBook({
                    bookId: 'b1',
                    title: 'the Coalfall Commission',
                    manuscriptId: 'mns-a',
                    status: 'analysing',
                  }),
                  makeBook({
                    bookId: 'b2',
                    title: 'Mystery Novel',
                    manuscriptId: 'mns-b',
                    status: 'generating',
                  }),
                ],
              },
            ],
          },
        ],
      }),
    );
    /* Manuscript slice still holds Book A's data because the user just
       came from the analysing view for Book A. */
    store.dispatch(
      manuscriptActions.hydrateFromBookState({
        state: { bookId: 'b1', manuscriptId: 'mns-a', title: 'the Coalfall Commission' } as any,
        sentences: null,
        wordCount: 1000,
        format: 'plaintext',
      }),
    );
    /* Need at least one chapter row in the chapters slice or
       GenerationView's allComplete math + "X of Y complete" header
       wouldn't have anything to render. */
    const chapter: Chapter = {
      id: 1,
      title: 'Chapter 1',
      duration: '00:30',
      state: 'queued',
      progress: 0,
      characters: {},
    };
    store.dispatch(chaptersActions.setChapters([chapter]));

    /* Plan 90 — ReadyViewSwitch now reads priorRoster + pushToast off the
       Layout's outlet context. Wrap the route with a parent that supplies
       a stub LayoutContext via <Outlet context={...}/>. */
    const layoutCtx: LayoutContext = {
      showInfo: vi.fn(),
      showError: vi.fn(),
      pushToast: vi.fn(),
      ttsLifecycle: {
        coqui: {
          state: 'unreachable',
          onLoad: vi.fn(async () => {}),
          onStop: vi.fn(async () => {}),
        },
        kokoro: {
          state: 'unreachable',
          onLoad: vi.fn(async () => {}),
          onStop: vi.fn(async () => {}),
        },
        qwen: {
          state: 'unreachable',
          onLoad: vi.fn(async () => {}),
          onStop: vi.fn(async () => {}),
        },
        qwen1_7b: {
          state: 'unreachable',
          onLoad: vi.fn(async () => {}),
          onStop: vi.fn(async () => {}),
        },
        asr: { enabled: false, state: 'idle', device: null },
        qwen1_7bInstalled: false,
        evictionNotice: null,
        loadErrorNotice: null,
        tripNotice: null,
        dismissNotices: vi.fn(),
      },
      priorRoster: [],
      openFixCharacterAudio: vi.fn(),
    };
    function LayoutShim() {
      return <Outlet context={layoutCtx} />;
    }
    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books/b2/generate']}>
          {/* Plan 89 C5 — GenerationView is lazy, wrap in Suspense. */}
          <Suspense fallback={<div data-testid="suspense-loading" />}>
            <Routes>
              <Route element={<LayoutShim />}>
                <Route path="/books/:bookId/:view" element={<ReadyRoute />} />
              </Route>
            </Routes>
          </Suspense>
        </MemoryRouter>
      </Provider>,
    );

    /* The Generate H1 reads "Generating <title>" via MixedHeading.
       Both halves render in the same heading element, so a substring
       match against the title alone is enough. The await is required
       because GenerationView is React.lazy now (plan 89 C5) — the
       initial paint is the Suspense fallback. */
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toContain('Mystery Novel');
    expect(heading.textContent).not.toContain('the Coalfall Commission');
  });
});
