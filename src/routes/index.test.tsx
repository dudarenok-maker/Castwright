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
import { MemoryRouter, Outlet, Routes, Route, useNavigate } from 'react-router';
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
import { analysisSlice, analysisActions } from '../store/analysis-slice';
import { persistenceMiddleware, flushBookPersistence } from '../store/persistence-middleware';
import { router as appRouter } from './index';
import {
  AnalysingRoute,
  AdvancedRoute,
  BooksRoute,
  ChangelogRoute,
  ConfirmRoute,
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
const setChapterExcludedMock = vi.fn();
const runAnalysisForChaptersMock = vi.fn();
let analyseResult: unknown = undefined;

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
    setChapterExcluded: (...a: unknown[]) => setChapterExcludedMock(...a),
    runAnalysisForChapters: (...a: unknown[]) => runAnalysisForChaptersMock(...a),
    analyseManuscript: (manuscriptId: string, opts: unknown) => {
      analyseMock(manuscriptId, opts);
      /* Never resolves by default — keeps the AnalysingView effect parked in
         its loading state without flushing a setState after the test asserts.
         A test that needs the run's `result` sets analyseResult. */
      return analyseResult ? Promise.resolve(analyseResult) : new Promise(() => {});
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
      analysis: analysisSlice.reducer,
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
  analyseResult = undefined;
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
       2026-05 lets the probe round-trip first, so that reset lands
       first and the fallback to manuscript.manuscriptId now matters.
       (The reset happens only under test: the hook compares against the
       module-level app store, not this test's store, so it always sees a
       difference. In the app the stage keeps its id — stageEqual ignores
       manuscriptId.) In real usage both ids ARE the same — the upload
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

/* #3435 (PR #3505 review pass 4) — the route takes a manuscript id only from
   a source that names its own book. The stage names a book before the slices
   hold it, and on a direct switch the stage still names the previous book for
   one render, so neither may be read without checking the book it names. */
describe('AnalysingRoute — the manuscript id comes only from its own book', () => {
  function holdSlices(store: ReturnType<typeof makeStore>, bookId: string, manuscriptId: string) {
    store.dispatch(
      manuscriptActions.hydrateFromBookState({
        state: { bookId, manuscriptId, title: `Book ${bookId}` } as any,
        sentences: null,
        wordCount: 100,
        format: 'plaintext',
      }),
    );
  }
  function libraryOf(store: ReturnType<typeof makeStore>, books: LibraryBook[]) {
    store.dispatch(
      libraryActions.hydrate({
        authors: [{ name: 'Della Renwick', series: [{ name: 'Standalones', books }] }],
      }),
    );
  }

  it("P4b: a direct switch from A's running Analysing view to B's never POSTs A's run from B, nor starts B", async () => {
    getBookStateMock.mockResolvedValue({ state: { chapters: [], castConfirmed: false } });
    const store = makeStore();
    libraryOf(store, [
      makeBook({ bookId: 'b1', manuscriptId: 'mA' }),
      makeBook({ bookId: 'b2', manuscriptId: 'mB', title: 'Book B' }),
    ]);
    holdSlices(store, 'b1', 'mA');
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'analysing', manuscriptId: 'mA' }));
    store.dispatch(
      analysisActions.setActiveStream({
        bookId: 'b1',
        manuscriptId: 'mA',
        phaseId: 1,
        phaseLabel: 'Parsing and attribution',
        phaseProgress: 0.3,
        remainingMs: null,
        lastTickAt: Date.now(),
        state: 'running',
        kind: 'main',
      }),
    );
    function GoTo() {
      const navigate = useNavigate();
      return <button onClick={() => navigate('/books/b2/analysing')}>go-b2</button>;
    }
    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books/b1/analysing']}>
          <GoTo />
          <Suspense fallback={<div data-testid="suspense-loading" />}>
            <Routes>
              <Route path="/books/:bookId/analysing" element={<AnalysingRoute />} />
            </Routes>
          </Suspense>
        </MemoryRouter>
      </Provider>,
    );
    /* Control: A's own view re-attaches to A's running run without a click. */
    await waitFor(() => expect(analyseMock).toHaveBeenCalledWith('mA', expect.any(Object)));
    analyseMock.mockClear();

    fireEvent.click(screen.getByText('go-b2'));
    /* useHydrateStage compares against the app's own store, so under test it
       resets the stage on the switch; in the app the stage keeps naming A for
       a render (stageEqual ignores manuscriptId). Put A's stage back so the
       route's stage-side id check is what is under test. */
    store.dispatch(uiActions.hydrateFromUrl({ kind: 'analysing', bookId: 'b1', manuscriptId: 'mA' }));
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledWith('b2'));
    /* B's read lands: the slices now hold B. */
    holdSlices(store, 'b2', 'mB');
    await new Promise((r) => setTimeout(r, 100));
    /* B has no running snapshot, so B's view waits for a click. */
    expect(analyseMock.mock.calls.map((c) => c[0])).toEqual([]);
    expect(await screen.findByRole('button', { name: /start analysis/i })).toBeInTheDocument();
  });

  it('a refresh with no stage id while the slices hold another book starts its own manuscript', async () => {
    const store = makeStore();
    holdSlices(store, 'b2', 'm-other');
    libraryOf(store, [makeBook({ bookId: 'b1', manuscriptId: 'm-own' })]);

    renderAtAnalysing(store);

    fireEvent.click(await screen.findByRole('button', { name: /start analysis/i }));
    await waitFor(() => expect(analyseMock).toHaveBeenCalledTimes(1));
    expect(analyseMock).toHaveBeenCalledWith('m-own', expect.any(Object));
  });

  it("shows its own book's title, never the other book's the slices hold", async () => {
    const store = makeStore();
    holdSlices(store, 'b2', 'm-other');
    libraryOf(store, [makeBook({ bookId: 'b1', manuscriptId: 'm-own', title: 'Own Title' })]);

    renderAtAnalysing(store);

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Own Title');
    expect(screen.queryByText(/Book b2/)).toBeNull();
  });

  it("a refresh with no stage id or library entry never analyses the other book the slices hold", async () => {
    const store = makeStore();
    holdSlices(store, 'b2', 'm-other');

    renderAtAnalysing(store);

    expect(await screen.findByText(/No manuscript loaded/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start analysis/i })).toBeNull();
    expect(analyseMock).not.toHaveBeenCalled();
  });

  it("control: a fresh upload's Start analyses the upload while the slices still name the previous book", async () => {
    /* uploadComplete sets the manuscript id and clears the slice's bookId (it
       must not keep the previous book's); the stage manuscriptUploaded set
       names the new book, so the route takes the id from there. */
    const store = makeStore();
    holdSlices(store, 'b2', 'm-other');
    store.dispatch(
      manuscriptActions.uploadComplete({
        bookId: 'b1',
        manuscriptId: 'm-upload',
        title: 'New',
        format: 'plaintext',
        wordCount: 100,
        sourceText: '',
      } as any),
    );
    expect(store.getState().manuscript.bookId).toBeNull();
    store.dispatch(uiActions.startNewBook());
    store.dispatch(uiActions.manuscriptUploaded({ bookId: 'b1', manuscriptId: 'm-upload' }));

    renderAtAnalysing(store);
    /* useHydrateStage compares against the app's own store, not this one, so
       under test it always resets the stage's id on mount; in the app the
       stage keeps it (stageEqual ignores manuscriptId). Put it back. */
    store.dispatch(uiActions.hydrateFromUrl({ kind: 'analysing', bookId: 'b1', manuscriptId: 'm-upload' }));

    fireEvent.click(await screen.findByRole('button', { name: /start analysis/i }));
    await waitFor(() => expect(analyseMock).toHaveBeenCalledWith('m-upload', expect.any(Object)));
  });

  function uploadFresh(store: ReturnType<typeof makeStore>, stageBookId: string) {
    store.dispatch(
      manuscriptActions.uploadComplete({
        bookId: 'b1',
        manuscriptId: 'm-upload',
        title: 'Uploaded Title',
        format: 'plaintext',
        wordCount: 12345,
        sourceText: '',
      } as any),
    );
    store.dispatch(uiActions.startNewBook());
    store.dispatch(uiActions.manuscriptUploaded({ bookId: stageBookId, manuscriptId: 'm-upload' }));
  }

  it('a fresh upload shows its own title and size before the book-state read lands', async () => {
    const store = makeStore();
    libraryOf(store, [makeBook({ bookId: 'b1', manuscriptId: 'm-upload', title: 'Library Title' })]);
    uploadFresh(store, 'b1');

    renderAtAnalysing(store);
    store.dispatch(uiActions.hydrateFromUrl({ kind: 'analysing', bookId: 'b1', manuscriptId: 'm-upload' }));

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Uploaded Title');
    expect(screen.getByText(/12,345/)).toBeInTheDocument();
  });

  it("control: an unattributed slice is not used when the stage names a different book", async () => {
    const store = makeStore();
    libraryOf(store, [makeBook({ bookId: 'b1', manuscriptId: 'm-own', title: 'Own Title' })]);
    uploadFresh(store, 'b9');

    renderAtAnalysing(store);
    store.dispatch(uiActions.hydrateFromUrl({ kind: 'analysing', bookId: 'b9', manuscriptId: 'm-upload' }));

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Own Title');
    expect(screen.queryByText(/Uploaded Title/)).toBeNull();
    expect(screen.queryByText(/12,345/)).toBeNull();
  });

  it("an unattributed upload slice is not used when the stage names the same book with a different manuscript", async () => {
    /* Upload N, then open X from the Library while it is analysing, before N's
       read lands: the slice still holds N's (bookId-less) upload and the stage
       names X's analysis, so X's view must not show N's title or size. */
    const store = makeStore();
    libraryOf(store, [makeBook({ bookId: 'b1', manuscriptId: 'm-x', title: 'Own Title' })]);
    uploadFresh(store, 'b1');

    renderAtAnalysing(store);
    store.dispatch(uiActions.hydrateFromUrl({ kind: 'analysing', bookId: 'b1', manuscriptId: 'm-x' }));

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Own Title');
    expect(screen.queryByText(/Uploaded Title/)).toBeNull();
    expect(screen.queryByText(/12,345/)).toBeNull();
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

  describe("forgets a wiped book's revisions cache and clears its preview (plan 286, OD31)", () => {
    beforeEach(() => {
      getLibraryMock.mockResolvedValue({ authors: [] });
      getWorkspaceInfoMock.mockResolvedValue({ root: '/tmp/audiobooks', source: 'env' });
    });
    const held = { bookId: 'b1', fileId: '000000000000002-a', rev: 2, pending: [{ id: 'p', chapterId: 1, characterId: 'c', segments: [] }], dismissed: [], acceptedSelections: {}, timeline: {} };
    /* OD31 — a finished, unresolved preview of b1 (marker set, stub built). */
    const previewOfB1 = { bookId: 'b1', characterId: 'c', previewChapterId: 1, remainingChapterIds: [2], reason: '', note: '',
      stub: { id: 'revision:1:c', chapterId: 1, characterId: 'c', segments: [] }, completed: { reviewOutcome: 'none' as const, stubFallback: true } };
    async function deleteB1(store: ReturnType<typeof makeStore>) {
      deleteBookMock.mockResolvedValue(undefined);
      renderBooks(store);
      fireEvent.click(screen.getByLabelText('Book options'));
      fireEvent.click(screen.getByRole('button', { name: /Delete book/i }));
      const confirm = screen.getAllByRole('button', { name: /Delete book/i });
      fireEvent.click(confirm[confirm.length - 1]);
      await waitFor(() => expect(deleteBookMock).toHaveBeenCalledWith('b1'));
    }
    it('deleting a book forgets its revisions cache and clears its preview', async () => {
      const store = makePopulatedStore();
      store.dispatch(revisionsSlice.actions.applyServerState(held));
      store.dispatch(uiActions.setPreviewRegen(previewOfB1));
      await deleteB1(store);
      await waitFor(() => expect(store.getState().revisions).toMatchObject({ bookId: null, fileId: null, rev: 0, pending: [] }));
      expect(store.getState().ui.previewRegen).toBeNull();
    });
    it('delete then re-import under the same id shows a clean cache', async () => {
      const store = makePopulatedStore();
      store.dispatch(revisionsSlice.actions.applyServerState(held));
      await deleteB1(store);
      await waitFor(() => expect(store.getState().revisions.bookId).toBeNull());
      store.dispatch(revisionsSlice.actions.hydrate({ bookId: 'b1', state: { ...held, fileId: null, rev: 0, pending: [] }, requestSeq: store.getState().revisions.adoptSeq }));
      expect(store.getState().revisions).toMatchObject({ bookId: 'b1', fileId: null, pending: [] });
    });
    it('a reparse forgets the cache and clears the preview', async () => {
      const store = makePopulatedStore();
      store.dispatch(revisionsSlice.actions.applyServerState(held));
      store.dispatch(uiActions.setPreviewRegen(previewOfB1));
      reparseBookMock.mockResolvedValue({ state: { chapters: [] }, chapterCount: 0, chapterTitles: [], chapters: [] });
      renderBooks(store);
      fireEvent.click(screen.getByLabelText('Book options'));
      fireEvent.click(screen.getByRole('button', { name: /Re-parse manuscript/i }));
      const confirm = screen.getAllByRole('button', { name: /Re-parse manuscript/i });
      fireEvent.click(confirm[confirm.length - 1]);
      await waitFor(() => expect(reparseBookMock).toHaveBeenCalledWith('b1'));
      await waitFor(() => expect(store.getState().revisions).toMatchObject({ bookId: null, fileId: null, rev: 0, pending: [] }));
      expect(store.getState().ui.previewRegen).toBeNull();
    });
    it('a manuscript replace forgets the cache and clears the preview', async () => {
      const store = makePopulatedStore();
      store.dispatch(revisionsSlice.actions.applyServerState(held));
      store.dispatch(uiActions.setPreviewRegen(previewOfB1));
      replaceManuscriptMock.mockResolvedValue({ chapterCount: 1 });
      renderBooks(store);
      fireEvent.click(screen.getByLabelText('Book options'));
      fireEvent.change(screen.getByTestId('replace-manuscript-input'), {
        target: { files: [new File(['# One'], 'new.md', { type: 'text/markdown' })] },
      });
      const confirm = screen.getAllByRole('button', { name: /Replace manuscript/i });
      fireEvent.click(confirm[confirm.length - 1]);
      await waitFor(() => expect(replaceManuscriptMock).toHaveBeenCalledWith('b1', expect.any(File)));
      await waitFor(() => expect(store.getState().revisions).toMatchObject({ bookId: null, fileId: null, rev: 0, pending: [] }));
      expect(store.getState().ui.previewRegen).toBeNull();
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

/* #3435 final review I1 — a main `result` lands on Confirm with the layout's
   book-state hydrate skipped, so the Confirm route's own re-read is where the
   Generate view's analysis gaps come back from the server. A main result can
   still carry a flagged chapter (decision B), so a gap backed by a failure
   record survives, and one for a current, unflagged chapter clears. */
describe('ConfirmRoute — analysis gaps from the server after a main result', () => {
  it('replaces the gaps from book-state: the attribution-collapse gap stays, the resolved one clears', async () => {
    const store = makeStore();
    store.dispatch(chaptersActions.setAnalysisGap({ chapterId: 1, message: 'Old 1.' }));
    store.dispatch(chaptersActions.setAnalysisGap({ chapterId: 2, message: 'Old 2.' }));
    getBookStateMock.mockResolvedValue({
      state: {
        bookId: 'b1',
        manuscriptId: 'm1',
        title: 'T',
        chapters: [
          { id: 1, title: 'Chapter 1', slug: '01-chapter-1', duration: '0:00' },
          { id: 2, title: 'Chapter 2', slug: '02-chapter-2', duration: '0:00' },
        ],
      },
      cast: null,
      analysis: {
        failedChapterIds: [2],
        failedChapterErrors: {
          '2': { code: 'attribution-collapse', message: 'Speaker attribution collapsed.', remediation: '', phase: 'attribution' },
        },
      },
    });
    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books/b1/confirm']}>
          <Suspense fallback={<div data-testid="suspense-loading" />}>
            <Routes>
              <Route path="/books/:bookId/confirm" element={<ConfirmRoute />} />
            </Routes>
          </Suspense>
        </MemoryRouter>
      </Provider>,
    );
    await waitFor(() =>
      expect(store.getState().chapters.analysisGapById).toEqual({ 2: { message: 'Speaker attribution collapsed.' } }),
    );
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

describe('ReadyRoute — Generate view local state is per book (#3435)', () => {
  /* GenerationView keeps its in-flight subset rows (progress, Cancel, error)
     in component state. ReadyRoute is the same route element for
     /books/a/generate and /books/b/generate, so without a per-book key a
     direct A -> B switch kept the instance and A's row showed on B's chapter
     with the same number. */
  function setup() {
    const store = makeStore();
    store.dispatch(
      libraryActions.hydrate({
        authors: [
          {
            name: 'Demo Author',
            series: [
              {
                name: 'Standalones',
                books: [
                  makeBook({ bookId: 'b1', title: 'Book One', manuscriptId: 'mns-a', status: 'generating' }),
                  makeBook({ bookId: 'b2', title: 'Book Two', manuscriptId: 'mns-b', status: 'generating' }),
                ],
              },
            ],
          },
        ],
      }),
    );
    store.dispatch(
      manuscriptActions.hydrateFromBookState({
        state: { bookId: 'b1', manuscriptId: 'mns-a', title: 'Book One' } as any,
        sentences: null,
        wordCount: 1000,
        format: 'plaintext',
      }),
    );
    store.dispatch(
      chaptersActions.setChapters([
        {
          id: 1,
          title: 'Chapter 1',
          duration: '00:00',
          state: 'queued',
          progress: 0,
          excluded: true,
          characters: {},
        } as Chapter,
        { id: 2, title: 'Chapter 2', duration: '00:30', state: 'queued', progress: 0, characters: {} },
      ]),
    );
    const layoutCtx = {
      showInfo: vi.fn(),
      showError: vi.fn(),
      pushToast: vi.fn(),
      ttsLifecycle: {
        coqui: { state: 'unreachable', onLoad: vi.fn(), onStop: vi.fn() },
        kokoro: { state: 'unreachable', onLoad: vi.fn(), onStop: vi.fn() },
        qwen: { state: 'unreachable', onLoad: vi.fn(), onStop: vi.fn() },
        qwen1_7b: { state: 'unreachable', onLoad: vi.fn(), onStop: vi.fn() },
        asr: { enabled: false, state: 'idle', device: null },
        qwen1_7bInstalled: false,
        evictionNotice: null,
        loadErrorNotice: null,
        tripNotice: null,
        dismissNotices: vi.fn(),
      },
      priorRoster: [],
      openFixCharacterAudio: vi.fn(),
    } as unknown as LayoutContext;
    function LayoutShim() {
      return (
        <>
          <GoTo />
          <Outlet context={layoutCtx} />
        </>
      );
    }
    function GoTo() {
      const navigate = useNavigate();
      return (
        <>
          <button onClick={() => navigate('/books/b2/generate')}>go-b2</button>
          <button onClick={() => navigate('/books/b1/generate?same=1')}>go-b1-again</button>
        </>
      );
    }
    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books/b1/generate']}>
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
    return store;
  }

  async function startInclude() {
    setChapterExcludedMock.mockResolvedValue({ id: 1, excluded: false });
    runAnalysisForChaptersMock.mockReturnValue(new Promise(() => {}));
    fireEvent.click(await screen.findByRole('button', { name: /\+ Include in book/i }));
    await screen.findByRole('button', { name: 'Cancel' });
  }

  beforeEach(() => {
    setChapterExcludedMock.mockReset();
    runAnalysisForChaptersMock.mockReset();
  });

  it("a direct switch to another book does not show the first book's in-flight row", async () => {
    setup();
    await startInclude();
    fireEvent.click(screen.getByText('go-b2'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull());
  });

  it('control: staying on the same book keeps the in-flight row', async () => {
    setup();
    await startInclude();
    fireEvent.click(screen.getByText('go-b1-again'));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });
});

describe('AnalysingRoute — local state is per book (#3435)', () => {
  /* AnalysingView's failed-row list is seeded from the book-state GET and
     never emptied by a book with no failures (the mount read returns early),
     so without a per-book key a direct A -> B switch kept A's rows. */
  function stateFor(failed: number[]) {
    return {
      state: { chapters: [{ id: 2, title: 'Chapter 2' }], castConfirmed: false },
      analysis: { failedChapterIds: failed },
    };
  }

  it("a direct switch to another book does not show the first book's failed rows", async () => {
    getBookStateMock.mockImplementation((id: string) =>
      Promise.resolve(stateFor(id === 'b1' ? [2] : [])),
    );
    const store = makeStore();
    function GoTo() {
      const navigate = useNavigate();
      return <button onClick={() => navigate('/books/b2/analysing')}>go-b2</button>;
    }
    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books/b1/analysing']}>
          <GoTo />
          <Suspense fallback={<div data-testid="suspense-loading" />}>
            <Routes>
              <Route path="/books/:bookId/analysing" element={<AnalysingRoute />} />
            </Routes>
          </Suspense>
        </MemoryRouter>
      </Provider>,
    );
    await screen.findByText(/Analysis failed on a previous attempt/i);
    fireEvent.click(screen.getByText('go-b2'));
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledWith('b2'));
    await waitFor(() =>
      expect(screen.queryByText(/Analysis failed on a previous attempt/i)).toBeNull(),
    );
  });
});

/* #3435 (PR #3505 review pass 4, P4c) — the stage names a book at once; the
   cast, chapters and manuscript slices hold a book only once its read lands.
   A `result` for book A that arrives on A's analysing stage while the slices
   still hold book B must not be loaded into them: they would mix the two
   books, and the layout (which keys its "already loaded" check on
   manuscript.bookId) would then never reload A. */
describe('AnalysingRoute — a result loads only into the slices of its own book', () => {
  const hero = { id: 'b-hero', name: 'Hero', role: 'Protagonist', color: 'peach' } as Character;
  const villain = { id: 'a-villain', name: 'Villain', role: 'Antagonist', color: 'magenta' } as Character;
  const chapterA = { id: 1, title: 'A one', slug: '01', duration: '0:00', characters: {} } as unknown as Chapter;
  const payloadA = {
    bookId: 'b1',
    manuscriptId: 'm1',
    title: 'Book A',
    phaseTimings: [],
    characters: [villain],
    chapters: [chapterA],
    sentences: [{ id: 1, chapterId: 1, characterId: 'a-villain', text: 'A speaks.' }],
    libraryMatches: [],
  };

  function hold(store: ReturnType<typeof makeStore>, book: { bookId: string; manuscriptId: string; title: string }, who: Character, text: string) {
    store.dispatch(
      manuscriptActions.hydrateFromBookState({
        state: book as any,
        sentences: [{ id: 1, chapterId: 1, characterId: who.id, text }] as any,
      }),
    );
    store.dispatch(castActions.hydrateCharacters([who]));
    store.dispatch(chaptersActions.setChapters([{ ...chapterA, title: `${book.title} one` }]));
    store.dispatch(chaptersActions.setCurrentBookId(book.bookId));
  }

  async function finishRun(store: ReturnType<typeof makeStore>) {
    analyseResult = payloadA;
    renderAtAnalysing(store);
    /* useHydrateStage resets the stage's id under test (it compares against
       the app's own store); in the app openBook's id survives. Put it back. */
    store.dispatch(uiActions.hydrateFromUrl({ kind: 'analysing', bookId: 'b1', manuscriptId: 'm1' }));
    fireEvent.click(await screen.findByRole('button', { name: /start analysis/i }));
    await waitFor(() => expect(analyseMock).toHaveBeenCalledWith('m1', expect.any(Object)));
    await waitFor(() => expect(store.getState().ui.stage).toMatchObject({ kind: 'confirm', bookId: 'b1' }));
  }

  it("A's result while the slices still hold book B leaves them B's whole, so A reloads from disk", async () => {
    const store = makeStore();
    hold(store, { bookId: 'b2', manuscriptId: 'm2', title: 'Book B' }, hero, 'B speaks.');
    /* Back on A's analysing stage (the Retrying pill) before A's read lands. */
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'analysing', manuscriptId: 'm1' }));
    await finishRun(store);
    const s = store.getState();
    /* Never one book's bookId over another's manuscriptId: manuscript.bookId
       still names B, which is what sends the layout to read A from disk. */
    expect({ bookId: s.manuscript.bookId, manuscriptId: s.manuscript.manuscriptId, title: s.manuscript.title }).toEqual({
      bookId: 'b2',
      manuscriptId: 'm2',
      title: 'Book B',
    });
    expect(s.manuscript.sentences.map((x: { text: string }) => x.text)).toEqual(['B speaks.']);
    expect(s.cast.characters.map((c: Character) => c.id)).toEqual(['b-hero']);
    expect(s.chapters.currentBookId).toBe('b2');
    expect(s.chapters.chapters.map((c: Chapter) => c.title)).toEqual(['Book B one']);
  });

  it("control: A's result while the slices hold A loads into them", async () => {
    const store = makeStore();
    hold(store, { bookId: 'b1', manuscriptId: 'm1', title: 'Book A' }, hero, 'Old A.');
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'analysing', manuscriptId: 'm1' }));
    await finishRun(store);
    const s = store.getState();
    expect(s.manuscript.bookId).toBe('b1');
    expect(s.manuscript.manuscriptId).toBe('m1');
    expect(s.cast.characters.map((c: Character) => c.id)).toEqual(['a-villain']);
    expect(s.chapters.currentBookId).toBe('b1');
    expect(s.chapters.chapters.map((c: Chapter) => c.title)).toEqual(['A one']);
  });
});
