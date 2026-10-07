/* Task 13 (fs-65 Phase 3) — eager prosody auto-trigger keyed on library status.

   Tests drive the useEffect in layout.tsx by rendering <Layout> with a
   controlled store and dispatching library.books state changes.

   TDD contracts (per the plan's Task 13 step 1):
   1. A book appearing as cast_pending AFTER the seeded first render fires
      runProsodyPasses exactly once.
   2. A book already complete ON the first render is seeded (considered) and
      never fires (no backlog auto-spend).
   3. A background book (no active stage referencing it) transitioning fires.
   4. getBookState → {prosodyEnabled:false} → no runProsodyPasses (authoritative
      opt-out, ignores store selector).
   5. getBookState → {prosodyAnnotated:true} → no-op (watermark respected).
   6. Two books transitioning → each fires once (dedup by considered ref).
   7. {failed:1} → no putBookState + book is re-eligible (deleted from considered).
   8. {failed:0} → putBookState writes prosodyAnnotated:true watermark.
   9. A rejected runProsodyPasses removes the book from considered (retry-safe). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { MemoryRouter, Routes, Route } from 'react-router';

import { uiSlice } from './ui-slice';
import { castSlice } from './cast-slice';
import { chaptersSlice } from './chapters-slice';
import { revisionsSlice } from './revisions-slice';
import { manuscriptSlice } from './manuscript-slice';
import { librarySlice } from './library-slice';
import { voicesSlice } from './voices-slice';
import { changeLogSlice } from './change-log-slice';
import { accountSlice } from './account-slice';
import { bookMetaSlice } from './book-meta-slice';
import { exportsSlice } from './exports-slice';
import { analysisSlice, analysisActions } from './analysis-slice';
import { castDesignSlice } from './cast-design-slice';
import { queueSlice } from './queue-slice';
import { tourSlice } from './tour-slice';
import { listenProgressSlice } from './listen-progress-slice';
import { settingsSlice } from './settings-slice';
import { continueListeningSlice } from './continue-listening-slice';
import { notificationsSlice } from './notifications-slice';
import { prosodySlice, prosodyActions } from './prosody-slice';
import { scriptReviewSlice } from './script-review-slice';
import type { LibraryBook } from '../lib/types';

/* ── Module mocks ──────────────────────────────────────────────────────── */

const runProsodyPassesMock = vi.fn();
vi.mock('./prosody-thunk', async (importOriginal) => {
  // Mock only runProsodyPasses; keep the real buildProsodyProgressPayload
  // (and any other exports) so the onProgress wiring under test still maps
  // SubstageDetail → the updateProgress payload via the real shared helper.
  const actual = await importOriginal<typeof import('./prosody-thunk')>();
  return {
    ...actual,
    runProsodyPasses: (...args: unknown[]) => runProsodyPassesMock(...args),
  };
});

const getBookStateMock = vi.fn();
const putBookStateMock = vi.fn();
const detectEmotionsMock = vi.fn();
const detectInstructMock = vi.fn();

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return {
    ...mod,
    api: {
      /* Library + base infra */
      getLibrary: vi.fn(async () => ({ authors: [] })),
      getVoices: vi.fn(async () => ({ voices: [], dropped: [] })),
      getBaseVoices: vi.fn(async () => ({ voices: [] })),
      getUserSettings: vi.fn(async () => ({})),
      getBookState: (...args: unknown[]) => getBookStateMock(...args),
      putBookState: (...args: unknown[]) => putBookStateMock(...args),
      detectEmotions: (...args: unknown[]) => detectEmotionsMock(...args),
      detectInstruct: (...args: unknown[]) => detectInstructMock(...args),
      getAnalysisState: vi.fn(async () => null),
      getActiveAnalyses: vi.fn(async () => ({ snapshots: [] })),
      pollRevisions: vi.fn(async () => ({ pending: [], drift: [] })),
      pollRevisionsBulk: vi.fn(async () => ({ byBookId: {} })),
      getSidecarHealth: vi.fn(async () => ({ status: 'unreachable', url: '(test)' })),
      getGpuQueueState: vi.fn(async () => ({ queueDepth: 0, devices: [] })),
      getGpuTripStatus: vi.fn(async () => null),
      matchVoices: vi.fn(async () => ({ matches: [] })),
      getSeriesRoster: vi.fn(async () => ({ characters: [] })),
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
      getTourStatus: vi.fn(async () => ({ completedAt: null })),
      getChapterAudio: vi.fn(async () => ({
        url: '/api/books/b1/chapters/1/audio.mp3',
        durationSec: 600,
        peaks: [],
        sampleRate: 44100,
        segments: [],
      })),
      getListenProgress: vi.fn(async () => null),
      putListenProgress: vi.fn(async () => ({
        chapterId: 1,
        currentSec: 0,
        updatedAt: new Date().toISOString(),
      })),
      putListenStats: vi.fn(async () => ({})),
      setShelfStatus: vi.fn(async () => ({
        chapterId: 1,
        currentSec: 0,
        updatedAt: new Date().toISOString(),
      })),
    },
    AnalysisError: class extends Error {},
    ExportIncompleteError: class extends Error {
      missing: string[] = [];
    },
  };
});

/* Route-prefetch stubs — avoid post-teardown EnvironmentTeardownError. */
vi.mock('../routes/prefetch', () => ({
  importGenerationView: vi.fn(() => Promise.resolve({})),
  importUploadView: vi.fn(() => Promise.resolve({})),
}));

import { Layout } from '../components/layout';
import { uiActions } from './ui-slice';
import { queueActions } from './queue-slice';
import { selectAnalysisBusyForBook } from './analysis-substage-selectors';
import { api } from '../lib/api';
import { persistenceMiddleware } from './persistence-middleware';
import { isChapterTextEditedSinceRender, textHashForStale } from '../lib/stale-chapters';

/* ── Store factory ─────────────────────────────────────────────────────── */

function makeStore(withPersistence = false) {
  return configureStore({
    middleware: (getDefault) =>
      withPersistence ? getDefault().concat(persistenceMiddleware) : getDefault(),
    reducer: {
      ui: uiSlice.reducer,
      account: accountSlice.reducer,
      cast: castSlice.reducer,
      chapters: chaptersSlice.reducer,
      revisions: revisionsSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      library: librarySlice.reducer,
      voices: voicesSlice.reducer,
      changeLog: changeLogSlice.reducer,
      bookMeta: bookMetaSlice.reducer,
      exports: exportsSlice.reducer,
      analysis: analysisSlice.reducer,
      castDesign: castDesignSlice.reducer,
      queue: queueSlice.reducer,
      tour: tourSlice.reducer,
      listenProgress: listenProgressSlice.reducer,
      settings: settingsSlice.reducer,
      continueListening: continueListeningSlice.reducer,
      notifications: notificationsSlice.reducer,
      prosody: prosodySlice.reducer,
      scriptReview: scriptReviewSlice.reducer,
    },
  });
}

/* ── LibraryBook builder ────────────────────────────────────────────────── */

function makeBook(
  bookId: string,
  status: LibraryBook['status'] = 'cast_pending',
): LibraryBook {
  return {
    bookId,
    title: `Book ${bookId}`,
    author: 'Test Author',
    series: 'Standalones',
    seriesPosition: null,
    isStandalone: true,
    status,
    chapterCount: 3,
    completedChapters: 0,
    characterCount: 2,
    voiceCount: 1,
    lastWorkedOn: '2026-06-25',
    coverGradient: ['#000', '#fff'],
    tags: [],
  };
}

/* Wrap a flat list of books into a LibraryResponse so a test can dispatch
   `librarySlice.actions.hydrate(...)` — the action that flips `loaded` to true.
   The seed-on-mount baseline only runs once the library is actually loaded
   (mirrors getLibrary() resolving in production). */
function libResponse(books: LibraryBook[]) {
  return { authors: [{ name: 'Test Author', series: [{ name: 'Standalones', books }] }] };
}

/* Minimal BookStateResponse-shaped payload for getBookState — not opting out
   and not yet annotated by default. */
function defaultStateResponse(bookId: string) {
  return {
    state: {
      bookId,
      manuscriptId: `mns_${bookId}`,
      title: `Book ${bookId}`,
      author: 'Test Author',
      series: 'Standalones',
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'] as [string, string],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      prosodyEnabled: undefined,
      prosodyAnnotated: undefined,
    },
    cast: null,
    manuscript: null,
    manuscriptEdits: null,
    revisions: null,
    completedSlugs: [],
    chapterCharacters: {},
    changeLog: null,
  };
}

/* ── Render helper ─────────────────────────────────────────────────────── */

function renderLayout(store: ReturnType<typeof makeStore>) {
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/books/b1/cast']}>
        <Routes>
          <Route path="/books/:bookId/cast" element={<Layout />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

/* ── Tests ─────────────────────────────────────────────────────────────── */

describe('Layout — prosody auto-trigger (Task 13 / fs-65 Phase 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    /* Default: getBookState returns a non-opted-out, non-annotated state. */
    getBookStateMock.mockResolvedValue(defaultStateResponse('b1'));
    /* Default: runProsodyPasses succeeds with no failures. */
    runProsodyPassesMock.mockResolvedValue({ totalAnnotations: 0, totalChapters: 0, failed: 0, skipped: 0 });
    putBookStateMock.mockResolvedValue({});
  });

  // ── Test 2: seed-on-mount — book complete on first render is NOT triggered ──

  it('does NOT fire runProsodyPasses for a book that is already analysis-complete on first render (seed-on-mount)', async () => {
    const store = makeStore();
    /* The library hydrates (loaded=true) with a book ALREADY complete — it is
       seeded into `considered` as the baseline and must not fire — not even
       when it is the open book: its watermark is unset, and only a book
       explicitly marked unfinished is run on open (#3435, fs-65: pre-existing
       books are not retro-annotated). */
    store.dispatch(librarySlice.actions.hydrate(libResponse([makeBook('b1', 'cast_pending')])));
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));

    renderLayout(store);

    /* Wait enough time for any async effects to settle. */
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(runProsodyPassesMock).not.toHaveBeenCalled();
  });

  // ── Regression (boot seed-race): library hydrates AFTER mount ──
  // Reproduces the production hang: getLibrary() resolves after Layout mounts,
  // so the whole backlog of already-complete books arrives in ONE hydrate.
  // Before the fix, the seed ran against the empty pre-hydrate library, so every
  // book looked brand-new and fired runProsodyPasses at once (SSE/GPU/VRAM flood).

  it('does NOT fire for pre-existing complete books that arrive via async library hydrate AFTER mount (boot seed-race)', async () => {
    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));

    /* The real boot path: Layout mounts with an empty, unloaded library, then
       its own getLibrary() effect resolves with the WHOLE backlog of already-
       complete books in one hydrate. That first loaded snapshot is the seed
       baseline — nothing should fire. (Before the fix the seed ran against the
       empty pre-hydrate library, so all 15 books looked brand-new and fired at
       once — the SSE/GPU/VRAM flood that hung the app on restart.) */
    vi.mocked(api.getLibrary).mockResolvedValueOnce(
      libResponse([makeBook('b1', 'cast_pending'), makeBook('b2', 'cast_pending')]) as never,
    );

    renderLayout(store);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });

    expect(runProsodyPassesMock).not.toHaveBeenCalled();
  });

  // ── Test 1: book appearing AFTER the seeded first render fires once ──

  it('fires runProsodyPasses once when a book transitions to cast_pending AFTER the seeded first render', async () => {
    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));

    renderLayout(store);

    /* Wait for the seed pass (first render with empty library). */
    /* getLibrary() resolves (empty) — flips loaded=true and runs the seed
       baseline pass. Mirrors the real boot ordering. */
    await act(async () => {
      store.dispatch(librarySlice.actions.hydrate(libResponse([])));
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(runProsodyPassesMock).not.toHaveBeenCalled();

    /* Now a book appears in the library — triggers the effect. */
    await act(async () => {
      store.dispatch(librarySlice.actions.addBook(makeBook('b1', 'cast_pending')));
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(runProsodyPassesMock).toHaveBeenCalledTimes(1);
      const [calledId, calledOpts] = runProsodyPassesMock.mock.calls[0] as [string, Record<string, unknown>];
      expect(calledId).toBe('b1');
      expect(calledOpts.dispatch).toBe(store.dispatch);
      expect(typeof calledOpts.onProgress).toBe('function');
    });
  });

  // ── Test 3: background book (not the active stage) fires ──

  it('fires for a background book even when that bookId is not the active UI stage', async () => {
    const store = makeStore();
    /* Active book is b1 (on the confirm stage). */
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    /* Set up getBookState to distinguish the two books. */
    getBookStateMock.mockImplementation((id: string) => Promise.resolve(defaultStateResponse(id)));

    renderLayout(store);

    /* Wait for the seeded first render. */
    /* getLibrary() resolves (empty) — flips loaded=true and runs the seed
       baseline pass. Mirrors the real boot ordering. */
    await act(async () => {
      store.dispatch(librarySlice.actions.hydrate(libResponse([])));
      await new Promise((r) => setTimeout(r, 20));
    });

    /* A background book (b2) transitions to cast_pending.
       It is NOT the active stage book (b1). */
    await act(async () => {
      store.dispatch(librarySlice.actions.addBook(makeBook('b2', 'cast_pending')));
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(runProsodyPassesMock).toHaveBeenCalledTimes(1);
      const [calledId, calledOpts] = runProsodyPassesMock.mock.calls[0] as [string, Record<string, unknown>];
      expect(calledId).toBe('b2');
      expect(calledOpts.dispatch).toBe(store.dispatch);
    });
  });

  // ── Test 4: getBookState → prosodyEnabled:false → no run ──

  it('skips runProsodyPasses when getBookState returns prosodyEnabled:false (authoritative opt-out)', async () => {
    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    getBookStateMock.mockResolvedValue({
      ...defaultStateResponse('b1'),
      state: { ...defaultStateResponse('b1').state, prosodyEnabled: false },
    });

    renderLayout(store);

    /* getLibrary() resolves (empty) — flips loaded=true and runs the seed
       baseline pass. Mirrors the real boot ordering. */
    await act(async () => {
      store.dispatch(librarySlice.actions.hydrate(libResponse([])));
      await new Promise((r) => setTimeout(r, 20));
    });

    await act(async () => {
      store.dispatch(librarySlice.actions.addBook(makeBook('b1', 'cast_pending')));
      await new Promise((r) => setTimeout(r, 50));
    });

    /* getBookState is called but prosodyEnabled:false → no pass. */
    await waitFor(() => {
      expect(getBookStateMock).toHaveBeenCalledWith('b1');
    });
    expect(runProsodyPassesMock).not.toHaveBeenCalled();
  });

  // ── Test 5: getBookState → prosodyAnnotated:true → no run (watermark) ──

  it('skips runProsodyPasses when getBookState returns prosodyAnnotated:true (watermark)', async () => {
    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    getBookStateMock.mockResolvedValue({
      ...defaultStateResponse('b1'),
      state: { ...defaultStateResponse('b1').state, prosodyAnnotated: true },
    });

    renderLayout(store);

    /* getLibrary() resolves (empty) — flips loaded=true and runs the seed
       baseline pass. Mirrors the real boot ordering. */
    await act(async () => {
      store.dispatch(librarySlice.actions.hydrate(libResponse([])));
      await new Promise((r) => setTimeout(r, 20));
    });

    await act(async () => {
      store.dispatch(librarySlice.actions.addBook(makeBook('b1', 'cast_pending')));
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(getBookStateMock).toHaveBeenCalledWith('b1');
    });
    expect(runProsodyPassesMock).not.toHaveBeenCalled();
  });

  // ── Test 6: two books transitioning → each fires once ──

  it('fires runProsodyPasses once per book when two books transition concurrently', async () => {
    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    getBookStateMock.mockImplementation((id: string) => Promise.resolve(defaultStateResponse(id)));

    renderLayout(store);

    /* getLibrary() resolves (empty) — flips loaded=true and runs the seed
       baseline pass. Mirrors the real boot ordering. */
    await act(async () => {
      store.dispatch(librarySlice.actions.hydrate(libResponse([])));
      await new Promise((r) => setTimeout(r, 20));
    });

    await act(async () => {
      store.dispatch(librarySlice.actions.addBook(makeBook('b1', 'cast_pending')));
      store.dispatch(librarySlice.actions.addBook(makeBook('b2', 'cast_pending')));
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(runProsodyPassesMock).toHaveBeenCalledTimes(2);
    });
    const calledIds = runProsodyPassesMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(calledIds).toContain('b1');
    expect(calledIds).toContain('b2');
  });

  // ── Test 7: failed:1 → no putBookState + book re-eligible ──

  it('marks the book unfinished (never done) when failed > 0, and the book is re-eligible on the next transition', async () => {
    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    runProsodyPassesMock.mockResolvedValueOnce({ totalAnnotations: 5, totalChapters: 2, failed: 1, skipped: 0 });

    renderLayout(store);

    /* getLibrary() resolves (empty) — flips loaded=true and runs the seed
       baseline pass. Mirrors the real boot ordering. */
    await act(async () => {
      store.dispatch(librarySlice.actions.hydrate(libResponse([])));
      await new Promise((r) => setTimeout(r, 20));
    });

    await act(async () => {
      store.dispatch(librarySlice.actions.addBook(makeBook('b1', 'cast_pending')));
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(runProsodyPassesMock).toHaveBeenCalledTimes(1);
    });

    /* failed > 0: marked unfinished (#3435 — so the next open re-runs it),
       never done, and only for its own book. */
    await waitFor(() => expect(putBookStateMock).toHaveBeenCalledTimes(1));
    expect(putBookStateMock).toHaveBeenCalledWith('b1', {
      slice: 'state',
      patch: { prosodyAnnotated: false },
    });

    /* Simulate a second appearance: book transitions through a non-complete
       status and back to complete. This changes completeKey, retriggering
       the effect. Since the partial run removed b1 from considered, it fires again. */
    runProsodyPassesMock.mockResolvedValueOnce({ totalAnnotations: 5, totalChapters: 2, failed: 0, skipped: 0 });

    await act(async () => {
      /* Step through not_analysed → cast_pending to change completeKey twice:
         first removing b1 from completeIds (not_analysed → effect fires, b1 not
         in completeIds), then re-adding it (cast_pending → b1 back in completeIds,
         not in considered → fires the second pass). */
      store.dispatch(librarySlice.actions.addBook(makeBook('b1', 'not_analysed')));
      await new Promise((r) => setTimeout(r, 10));
      store.dispatch(librarySlice.actions.addBook(makeBook('b1', 'cast_pending')));
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(runProsodyPassesMock).toHaveBeenCalledTimes(2);
    });

    /* On the successful second pass (failed:0), the watermark IS written. */
    await waitFor(() => {
      expect(putBookStateMock).toHaveBeenCalledWith('b1', {
        slice: 'state',
        patch: { prosodyAnnotated: true },
      });
    });
  });

  // ── Test 8: failed:0 → putBookState writes watermark ──

  it('calls putBookState with prosodyAnnotated:true when failed === 0', async () => {
    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    runProsodyPassesMock.mockResolvedValue({ totalAnnotations: 10, totalChapters: 3, failed: 0, skipped: 0 });

    renderLayout(store);

    /* getLibrary() resolves (empty) — flips loaded=true and runs the seed
       baseline pass. Mirrors the real boot ordering. */
    await act(async () => {
      store.dispatch(librarySlice.actions.hydrate(libResponse([])));
      await new Promise((r) => setTimeout(r, 20));
    });

    await act(async () => {
      store.dispatch(librarySlice.actions.addBook(makeBook('b1', 'cast_pending')));
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(putBookStateMock).toHaveBeenCalledWith('b1', {
        slice: 'state',
        patch: { prosodyAnnotated: true },
      });
    });
  });

  // ── Test 9: rejected runProsodyPasses removes book from considered ──

  it('removes book from considered when runProsodyPasses rejects (retry-safe)', async () => {
    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    runProsodyPassesMock.mockRejectedValueOnce(new Error('network error'));

    renderLayout(store);

    /* getLibrary() resolves (empty) — flips loaded=true and runs the seed
       baseline pass. Mirrors the real boot ordering. */
    await act(async () => {
      store.dispatch(librarySlice.actions.hydrate(libResponse([])));
      await new Promise((r) => setTimeout(r, 20));
    });

    await act(async () => {
      store.dispatch(librarySlice.actions.addBook(makeBook('b1', 'cast_pending')));
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(runProsodyPassesMock).toHaveBeenCalledTimes(1);
    });

    /* The run had started: marked unfinished, never done (#3435). */
    await waitFor(() => expect(putBookStateMock).toHaveBeenCalledTimes(1));
    expect(putBookStateMock).toHaveBeenCalledWith('b1', {
      slice: 'state',
      patch: { prosodyAnnotated: false },
    });

    /* A subsequent status change should fire again (book was removed from considered).
       Cycle through a non-complete status to retrigger the effect with a new completeKey. */
    runProsodyPassesMock.mockResolvedValueOnce({ totalAnnotations: 0, totalChapters: 0, failed: 0, skipped: 0 });

    await act(async () => {
      store.dispatch(librarySlice.actions.addBook(makeBook('b1', 'not_analysed')));
      await new Promise((r) => setTimeout(r, 10));
      store.dispatch(librarySlice.actions.addBook(makeBook('b1', 'cast_pending')));
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(runProsodyPassesMock).toHaveBeenCalledTimes(2);
    });
  });

  // ── Task 7: double-fire guard — active stream skips runProsodyPasses ──

  it('does NOT fire runProsodyPasses when prosody.activeStreams already has the book (double-fire guard)', async () => {
    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));

    renderLayout(store);

    /* Seed the library first (flips loaded=true). */
    await act(async () => {
      store.dispatch(librarySlice.actions.hydrate(libResponse([])));
      await new Promise((r) => setTimeout(r, 20));
    });

    /* Pre-seed an active prosody stream for b1 BEFORE the transition fires.
       Simulates another tab (or a manual trigger) already running the pass. */
    store.dispatch(prosodyActions.setActive({ bookId: 'b1', progress: 0, label: 'Detecting emotions' }));

    /* Trigger the completion transition. */
    await act(async () => {
      store.dispatch(librarySlice.actions.addBook(makeBook('b1', 'cast_pending')));
      await new Promise((r) => setTimeout(r, 50));
    });

    /* Guard fired: shouldAutoTriggerProsody returned false → no double-fire. */
    expect(runProsodyPassesMock).not.toHaveBeenCalled();
  });

  // ── Test: 'not_analysed' / 'analysing' / 'unreadable' / 'orphaned' are not considered complete ──

  it('does NOT fire for books with non-complete statuses (not_analysed, analysing, unreadable, orphaned)', async () => {
    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));

    renderLayout(store);

    /* getLibrary() resolves (empty) — flips loaded=true and runs the seed
       baseline pass. Mirrors the real boot ordering. */
    await act(async () => {
      store.dispatch(librarySlice.actions.hydrate(libResponse([])));
      await new Promise((r) => setTimeout(r, 20));
    });

    for (const status of ['not_analysed', 'analysing', 'unreadable', 'orphaned'] as const) {
      await act(async () => {
        store.dispatch(librarySlice.actions.addBook(makeBook('b1', status)));
        await new Promise((r) => setTimeout(r, 30));
      });
    }

    expect(runProsodyPassesMock).not.toHaveBeenCalled();
  });

  // ── Test: runProsodyPasses is called with { dispatch } only (no signal) ──

  it('calls runProsodyPasses with { dispatch } only — no signal (detached path)', async () => {
    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));

    renderLayout(store);

    /* getLibrary() resolves (empty) — flips loaded=true and runs the seed
       baseline pass. Mirrors the real boot ordering. */
    await act(async () => {
      store.dispatch(librarySlice.actions.hydrate(libResponse([])));
      await new Promise((r) => setTimeout(r, 20));
    });

    await act(async () => {
      store.dispatch(librarySlice.actions.addBook(makeBook('b1', 'cast_pending')));
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(runProsodyPassesMock).toHaveBeenCalledTimes(1);
    });

    const [_bookId, opts] = runProsodyPassesMock.mock.calls[0] as [string, Record<string, unknown>];
    /* Task 14: onProgress is now passed for the global prosody pill. */
    expect(Object.keys(opts).sort()).toEqual(['canApply', 'dispatch', 'onProgress'].sort());
    expect(opts.signal).toBeUndefined();
    expect(typeof opts.onProgress).toBe('function');
  });

  // ── Final whole-branch review Finding 1: eager trigger forwards `detail` ──
  // The onProgress callback wired at this call site used to dispatch only
  // `progress`, silently dropping label/chapterIndex/totalChapters/
  // estRemainingMs even though runProsodyPasses (and the manual button path)
  // supply them. Since auto-prosody is the default/common path, this was the
  // only path where the Status popover's chapter-count/ETA enrichment never
  // showed up. Assert the forwarded detail lands in the prosody slice.

  it('forwards chapterIndex/totalChapters/estRemainingMs from onProgress detail into the prosody slice (Finding 1)', async () => {
    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));

    /* Hold runProsodyPasses open (don't let it resolve) so the `finally` clear
       doesn't wipe activeStreams before we inspect it — mirrors production
       timing, where onProgress ticks arrive WHILE the pass is still running. */
    let resolvePass!: (v: { totalAnnotations: number; totalChapters: number; failed: number; skipped: number }) => void;
    runProsodyPassesMock.mockImplementationOnce(
      (_id: string, opts: { onProgress?: (fraction: number, detail?: Record<string, unknown>) => void }) =>
        new Promise((resolve) => {
          resolvePass = resolve;
          opts.onProgress?.(0.5, {
            label: 'Detecting emotions',
            chapterIndex: 2,
            totalChapters: 5,
            estRemainingMs: 12_000,
          });
        }),
    );

    renderLayout(store);

    await act(async () => {
      store.dispatch(librarySlice.actions.hydrate(libResponse([])));
      await new Promise((r) => setTimeout(r, 20));
    });

    await act(async () => {
      store.dispatch(librarySlice.actions.addBook(makeBook('b1', 'cast_pending')));
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(runProsodyPassesMock).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      const entry = store.getState().prosody.activeStreams.b1;
      expect(entry).toMatchObject({
        progress: 50,
        label: 'Detecting emotions',
        chapterIndex: 2,
        totalChapters: 5,
        estRemainingMs: 12_000,
      });
    });

    /* Let the pass finish so the effect's finally/cleanup runs cleanly. */
    await act(async () => {
      resolvePass({ totalAnnotations: 0, totalChapters: 5, failed: 0, skipped: 0 });
      await new Promise((r) => setTimeout(r, 20));
    });
  });
});

/* #3435 (PR #3505 review pass 5) — the detected emotions of a background
   book only land in that book. The run outlives the book on screen: it starts
   when a book finishes analysing, wherever the user is, and the server never
   writes these annotations itself — the frontend applies them to the
   manuscript slice and the persistence middleware saves that slice into the
   book the stage names. Runs the REAL thunk and the REAL middleware. */
describe('Layout — prosody auto-trigger writes only into its own book (#3435)', () => {
  const sentence = (chapterId: number, id: number) =>
    ({ chapterId, id, text: 'Hello.', characterId: 'narrator' }) as never;

  function stateFor(bookId: string) {
    const base = defaultStateResponse(bookId);
    return { ...base, manuscriptEdits: { sentences: [sentence(1, 1)], mergedAwayKeys: [] } };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const actual = await vi.importActual<typeof import('./prosody-thunk')>('./prosody-thunk');
    runProsodyPassesMock.mockImplementation((...args: unknown[]) =>
      (actual.runProsodyPasses as (...a: unknown[]) => unknown)(...args),
    );
    getBookStateMock.mockImplementation(async (id: string) => stateFor(id));
    putBookStateMock.mockResolvedValue({});
    detectEmotionsMock.mockImplementation(
      async (_id: string, opts: { onAnnotation?: (e: unknown) => void }) => {
        opts.onAnnotation?.({ chapterId: 1, annotations: [{ sentenceId: 1, emotion: 'angry' }] });
        return { totalAnnotations: 1, annotatedChapters: 1 };
      },
    );
    detectInstructMock.mockImplementation(
      async (_id: string, opts: { onAnnotation?: (e: unknown) => void }) => {
        opts.onAnnotation?.({ chapterId: 1, annotations: [{ sentenceId: 1, instruct: 'whispered' }] });
        return { totalAnnotations: 1, annotatedChapters: 1 };
      },
    );
  });

  /* Opens `openId` (stage + slices, through the layout's own read), then
     lets `finishedId` finish analysing so the auto-trigger runs for it. */
  async function runFor(openId: string, finishedId: string) {
    const store = makeStore(true);
    store.dispatch(uiActions.openBook({ id: openId, status: 'voices_pending' }));
    renderLayout(store);
    await act(async () => {
      store.dispatch(librarySlice.actions.hydrate(libResponse([])));
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(store.getState().manuscript.manuscriptId).toBe(`mns_${openId}`));
    await act(async () => {
      store.dispatch(librarySlice.actions.addBook(makeBook(finishedId, 'cast_pending')));
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(detectInstructMock).toHaveBeenCalledWith(finishedId, expect.anything()));
    /* Past the persistence debounce, so any manuscript PUT has gone out. */
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });
    return store;
  }

  const manuscriptPuts = () =>
    putBookStateMock.mock.calls.filter((c) => (c[1] as { slice: string }).slice === 'manuscript');
  const watermarkPuts = (id: string) =>
    putBookStateMock.mock.calls.filter(
      (c) => c[0] === id && (c[1] as { patch: { prosodyAnnotated?: boolean } }).patch?.prosodyAnnotated,
    );

  it("a background book's emotions never land in the open book, and it is marked unfinished — it alone", async () => {
    const store = await runFor('b2', 'b1');

    const s = store.getState().manuscript.sentences.find((x) => x.chapterId === 1 && x.id === 1);
    expect(s?.emotion).toBeUndefined();
    expect(s?.instruct).toBeUndefined();
    expect(manuscriptPuts()).toEqual([]);
    expect(watermarkPuts('b1')).toEqual([]);
    /* #3435 — the skipped run marks ITS book unfinished (so opening it re-runs
       it), never the open book the slices and the stage hold. */
    const statePuts = putBookStateMock.mock.calls.filter((c) => (c[1] as { slice: string }).slice === 'state');
    expect(statePuts).toEqual([['b1', { slice: 'state', patch: { prosodyAnnotated: false } }]]);
  });

  it("the open book's own emotions land in it and persist to it once, and it is marked annotated", async () => {
    const store = await runFor('b1', 'b1');

    const s = store.getState().manuscript.sentences.find((x) => x.chapterId === 1 && x.id === 1);
    expect(s?.emotion).toBe('angry');
    const puts = manuscriptPuts();
    expect(puts).toHaveLength(1);
    expect(puts[0][0]).toBe('b1');
    expect(JSON.stringify(puts[0][1])).toContain('"emotion":"angry"');
    expect(watermarkPuts('b1')).toHaveLength(1);
  });

  it("the open book's slices are skipped while the stage already names another book (its read not landed)", async () => {
    const store = makeStore(true);
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'voices_pending' }));
    renderLayout(store);
    await act(async () => {
      store.dispatch(librarySlice.actions.hydrate(libResponse([])));
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(store.getState().manuscript.manuscriptId).toBe('mns_b1'));
    /* b2's read never lands: the stage names b2, the slices still hold b1. */
    getBookStateMock.mockImplementation((id: string) =>
      id === 'b2' ? new Promise(() => {}) : Promise.resolve(stateFor(id)),
    );
    await act(async () => {
      store.dispatch(uiActions.openBook({ id: 'b2', status: 'voices_pending' }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(store.getState().manuscript.manuscriptId).toBe('mns_b1');
    await act(async () => {
      store.dispatch(librarySlice.actions.addBook(makeBook('b1', 'cast_pending')));
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(detectInstructMock).toHaveBeenCalledWith('b1', expect.anything()));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });

    expect(manuscriptPuts()).toEqual([]);
    expect(watermarkPuts('b1')).toEqual([]);
  });

  it("the stage naming the book is not enough while its read has not landed (the slices hold another book)", async () => {
    const store = makeStore(true);
    store.dispatch(uiActions.openBook({ id: 'b2', status: 'voices_pending' }));
    renderLayout(store);
    await act(async () => {
      store.dispatch(librarySlice.actions.hydrate(libResponse([])));
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(store.getState().manuscript.manuscriptId).toBe('mns_b2'));
    /* The layout's read of b1 never lands: the stage names b1, the slices
       still hold b2. (The auto-trigger's own later read of b1 does.) */
    let b1Reads = 0;
    getBookStateMock.mockImplementation((id: string) =>
      id === 'b1' && b1Reads++ === 0 ? new Promise(() => {}) : Promise.resolve(stateFor(id)),
    );
    await act(async () => {
      store.dispatch(uiActions.openBook({ id: 'b1', status: 'voices_pending' }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(store.getState().manuscript.manuscriptId).toBe('mns_b2');
    await act(async () => {
      store.dispatch(librarySlice.actions.addBook(makeBook('b1', 'cast_pending')));
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(detectInstructMock).toHaveBeenCalledWith('b1', expect.anything()));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });

    const s = store.getState().manuscript.sentences.find((x) => x.chapterId === 1 && x.id === 1);
    expect(s?.emotion).toBeUndefined();
    expect(manuscriptPuts()).toEqual([]);
    expect(watermarkPuts('b1')).toEqual([]);
  });
});

/* #3435 (PR #3505 review passes 6-7) — an annotation that arrives while its
   book is not open is skipped (a write never lands on a stage that names no
   book). Every run that started and did not finish — skipped work, a failed
   chapter, or a background run that yielded — marks its own book unfinished
   (prosodyAnnotated: false). The layout re-runs detection (fill-only) for an
   open, analysis-complete book so marked, and ONLY so marked: a book whose
   watermark is unset (analysed before fs-65, or never seen finish) is not
   retro-annotated (fs-65 design: no backlog-wide auto-spend). A re-run never
   rewrites the text of a chapter that has rendered audio, and it stops as
   soon as its book is no longer the open one or the user starts work on it.
   Runs the REAL thunk and the REAL persistence middleware; the server mocks
   keep the watermark the way the server does (true / false / unset). */
describe('Layout — an unfinished book is re-run when it is next opened (#3435)', () => {
  const sentence = (chapterId: number, id: number) =>
    ({ chapterId, id, text: 'Hello.', characterId: 'narrator' }) as never;

  let libBooks: LibraryBook[];
  /* The server's watermark per book: absent = unset. */
  let marks: Map<string, boolean>;
  /* Book ids whose chapter 1 has rendered audio. */
  let renderedCh1: Set<string>;

  function stateFor(bookId: string) {
    const base = defaultStateResponse(bookId);
    const rendered = renderedCh1.has(bookId);
    return {
      ...base,
      state: {
        ...base.state,
        prosodyAnnotated: marks.get(bookId),
        chapters: rendered
          ? [
              { id: 1, title: 'One', slug: 'ch-1' },
              { id: 2, title: 'Two', slug: 'ch-2' },
            ]
          : [],
      },
      manuscriptEdits: { sentences: [sentence(1, 1), sentence(2, 1)], mergedAwayKeys: [] },
      ...(rendered
        ? {
            completedSlugs: ['ch-1'],
            renderedSpeakersByChapter: { 1: { 1: 'narrator' } },
            renderedTextByChapter: { 1: { 1: textHashForStale('Hello.') } },
          }
        : {}),
    };
  }

  const ch1 = { chapterId: 1, annotations: [{ sentenceId: 1, emotion: 'angry' }] };
  const ch2 = { chapterId: 2, annotations: [{ sentenceId: 1, emotion: 'sad' }] };
  type Opts = { onAnnotation?: (e: unknown) => void; signal?: AbortSignal };
  const emit = (opts: Opts, chapters: unknown[]) => chapters.forEach((c) => opts.onAnnotation?.(c));

  beforeEach(async () => {
    vi.clearAllMocks();
    libBooks = [];
    marks = new Map();
    renderedCh1 = new Set();
    const actual = await vi.importActual<typeof import('./prosody-thunk')>('./prosody-thunk');
    runProsodyPassesMock.mockImplementation((...args: unknown[]) =>
      (actual.runProsodyPasses as (...a: unknown[]) => unknown)(...args),
    );
    vi.mocked(api.getLibrary).mockImplementation(async () => libResponse(libBooks) as never);
    getBookStateMock.mockImplementation(async (id: string) => stateFor(id));
    putBookStateMock.mockImplementation(
      async (id: string, body: { patch?: { prosodyAnnotated?: boolean } }) => {
        if (typeof body.patch?.prosodyAnnotated === 'boolean') marks.set(id, body.patch.prosodyAnnotated);
        return {};
      },
    );
    /* Default: every run emits both chapters at once. */
    detectEmotionsMock.mockImplementation(async (_id: string, opts: Opts) => {
      emit(opts, [ch1, ch2]);
      return { totalAnnotations: 2, annotatedChapters: 2 };
    });
    detectInstructMock.mockResolvedValue({ totalAnnotations: 0, annotatedChapters: 0 });
  });

  afterEach(() => {
    vi.mocked(api.getLibrary).mockImplementation(async () => ({ authors: [] }) as never);
  });

  /* Any path: leaving for the Library must not unmount the layout. */
  function renderAnyPath(store: ReturnType<typeof makeStore>) {
    return render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books/b1/cast']}>
          <Routes>
            <Route path="*" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );
  }

  const settle = (ms: number) =>
    act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  const manuscriptPuts = () =>
    putBookStateMock.mock.calls.filter((c) => (c[1] as { slice: string }).slice === 'manuscript');
  const watermarkPuts = (id: string) =>
    putBookStateMock.mock.calls.filter(
      (c) => c[0] === id && (c[1] as { patch: { prosodyAnnotated?: boolean } }).patch?.prosodyAnnotated,
    );
  /* Every `prosodyAnnotated: false` write, as the book id it went to. */
  const unfinishedPuts = () =>
    putBookStateMock.mock.calls
      .filter((c) => (c[1] as { patch?: { prosodyAnnotated?: boolean } }).patch?.prosodyAnnotated === false)
      .map((c) => c[0]);
  const sentenceOf = (store: ReturnType<typeof makeStore>, chapterId: number) =>
    store.getState().manuscript.sentences.find((x) => x.chapterId === chapterId && x.id === 1);
  const emotionOf = (store: ReturnType<typeof makeStore>, chapterId: number) =>
    sentenceOf(store, chapterId)?.emotion;

  it('P6a: a run that crossed a Library trip is finished on reopen, saved to its book only, and the book ends annotated', async () => {
    /* First run: chapter 1 arrives while the user is on the Library, chapter 2
       after they reopen the book. */
    let releaseCh2!: () => void;
    detectEmotionsMock.mockImplementationOnce(async (_id: string, opts: Opts) => {
      emit(opts, [ch1]);
      await new Promise<void>((r) => (releaseCh2 = r));
      emit(opts, [ch2]);
      return { totalAnnotations: 2, annotatedChapters: 2 };
    });
    const store = makeStore(true);
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    renderAnyPath(store);
    await waitFor(() => expect(store.getState().manuscript.manuscriptId).toBe('mns_b1'));
    await settle(30);

    /* The book finished analysing in the foreground; the Library refresh is
       where it is first seen complete, so the run starts there. */
    libBooks = [makeBook('b1', 'cast_pending')];
    await act(async () => {
      store.dispatch(uiActions.goHome());
    });
    await waitFor(() => expect(detectEmotionsMock).toHaveBeenCalledTimes(1));
    expect(emotionOf(store, 1)).toBeUndefined(); // skipped: the Library names no book

    /* Reopen b1 while the run is in flight: no second, concurrent run. */
    await act(async () => {
      store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    });
    await settle(50);
    expect(detectEmotionsMock).toHaveBeenCalledTimes(1);

    /* The re-run applies past the first batch's debounce, so each applied
       batch is its own PUT. */
    detectEmotionsMock.mockImplementation(async (_id: string, opts: Opts) => {
      await new Promise((r) => setTimeout(r, 700));
      emit(opts, [ch1, ch2]);
      return { totalAnnotations: 2, annotatedChapters: 2 };
    });
    await act(async () => {
      releaseCh2();
    });
    await waitFor(() => expect(detectEmotionsMock).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await waitFor(() => expect(watermarkPuts('b1')).toHaveLength(1), { timeout: 3000 });
    await settle(700);

    expect(unfinishedPuts()).toEqual(['b1']); // the skipped first run marked it unfinished
    expect(emotionOf(store, 1)).toBe('angry');
    expect(emotionOf(store, 2)).toBe('sad');
    const puts = manuscriptPuts();
    expect(puts.map((c) => c[0])).toEqual(['b1', 'b1']); // one per applied batch, all to b1
    expect(JSON.stringify(puts[1][1])).toContain('"emotion":"angry"');
    expect(detectEmotionsMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('P6b: a run that stays on the Library saves nothing and marks its book unfinished; opening the book re-runs it into that book and marks it', async () => {
    const store = makeStore(true);
    renderAnyPath(store); // boots on the Library
    await settle(30);

    await act(async () => {
      store.dispatch(librarySlice.actions.addBook(makeBook('b1', 'cast_pending')));
    });
    await waitFor(() => expect(detectInstructMock).toHaveBeenCalledTimes(1));
    await settle(700);
    expect(manuscriptPuts()).toEqual([]);
    expect(watermarkPuts('b1')).toEqual([]);
    expect(unfinishedPuts()).toEqual(['b1']);

    await act(async () => {
      store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    });
    await waitFor(() => expect(detectEmotionsMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(watermarkPuts('b1')).toHaveLength(1));
    await settle(700);

    expect(emotionOf(store, 1)).toBe('angry');
    const puts = manuscriptPuts();
    expect(puts).toHaveLength(1);
    expect(puts[0][0]).toBe('b1');
  });

  it('P7c: a book complete at boot with its watermark unset is NOT run on open — its text is never rewritten (fs-65: no retro-annotation)', async () => {
    libBooks = [makeBook('b1', 'cast_pending')];
    detectInstructMock.mockImplementation(async (_id: string, opts: Opts) => {
      emit(opts, [{ chapterId: 1, annotations: [{ sentenceId: 1, text: 'Hhhh… Hello.', vocalization: true }] }]);
      return { totalAnnotations: 1, annotatedChapters: 1 };
    });
    const store = makeStore(true);
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    renderAnyPath(store);
    await waitFor(() => expect(store.getState().manuscript.manuscriptId).toBe('mns_b1'));
    await settle(800);

    expect(detectEmotionsMock).not.toHaveBeenCalled();
    expect(detectInstructMock).not.toHaveBeenCalled();
    expect(sentenceOf(store, 1)?.text).toBe('Hello.');
    expect(manuscriptPuts()).toEqual([]);
    expect(putBookStateMock).not.toHaveBeenCalled();
  });

  it('reopen: a complete book marked unfinished is run on open and marked done (the backlog stays quiet, unfinished or not)', async () => {
    libBooks = [makeBook('b1', 'cast_pending'), makeBook('b2', 'cast_pending')];
    marks.set('b1', false);
    marks.set('b2', false);
    const store = makeStore(true);
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    renderAnyPath(store);

    await waitFor(() => expect(detectEmotionsMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(watermarkPuts('b1')).toHaveLength(1));
    await settle(700);
    expect(detectEmotionsMock).toHaveBeenCalledWith('b1', expect.anything());
    expect(detectEmotionsMock).not.toHaveBeenCalledWith('b2', expect.anything());
    expect(emotionOf(store, 1)).toBe('angry');
    expect(manuscriptPuts().map((c) => c[0])).toEqual(['b1']);
  });

  it('control: opening a book already marked annotated does not re-run it', async () => {
    libBooks = [makeBook('b1', 'cast_pending')];
    marks.set('b1', true);
    const store = makeStore(true);
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    renderAnyPath(store);
    await waitFor(() => expect(store.getState().manuscript.manuscriptId).toBe('mns_b1'));
    await settle(100);

    expect(detectEmotionsMock).not.toHaveBeenCalled();
  });

  it('control: an open book that is not analysis-complete is not run', async () => {
    libBooks = [makeBook('b1', 'analysing')];
    marks.set('b1', false);
    const store = makeStore(true);
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    renderAnyPath(store);
    await waitFor(() => expect(store.getState().manuscript.manuscriptId).toBe('mns_b1'));
    await settle(100);

    expect(detectEmotionsMock).not.toHaveBeenCalled();
  });

  it('cannot apply: an open book whose slices hold another manuscriptId than its read is never run', async () => {
    /* The slices hold the book under another manuscriptId than its book-state
       read reports (the mock app's uploaded book does this), so the gate would
       skip every annotation: the run is not started at all — no pill, no busy
       window, and nothing to loop on. */
    libBooks = [makeBook('b1', 'cast_pending')];
    marks.set('b1', false);
    let reads = 0;
    getBookStateMock.mockImplementation(async (id: string) => {
      const st = stateFor(id);
      return reads++ === 0 ? st : { ...st, state: { ...st.state, manuscriptId: 'mns_other' } };
    });
    const store = makeStore(true);
    const seen: string[] = [];
    store.subscribe(() => {
      if (store.getState().prosody.activeStreams.b1) seen.push('b1');
    });
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    renderAnyPath(store);
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
    await settle(300);

    expect(detectEmotionsMock).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    expect(watermarkPuts('b1')).toEqual([]);
  });

  it('rendered audio: the re-run never rewrites the text of a chapter with rendered audio, and makes no chapter stale', async () => {
    libBooks = [makeBook('b1', 'voices_pending')];
    marks.set('b1', false);
    renderedCh1.add('b1');
    const rewrite = (chapterId: number) => ({
      chapterId,
      annotations: [{ sentenceId: 1, text: 'Hhhh… Hello.', vocalization: true, instruct: 'gasping' }],
    });
    detectInstructMock.mockImplementation(async (_id: string, opts: Opts) => {
      emit(opts, [rewrite(1), rewrite(2)]);
      return { totalAnnotations: 2, annotatedChapters: 2 };
    });
    const store = makeStore(true);
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'voices_pending' }));
    renderAnyPath(store);
    await waitFor(() => expect(detectInstructMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(watermarkPuts('b1')).toHaveLength(1));
    await settle(700);

    expect(store.getState().chapters.chapters.find((c) => c.id === 1)?.state).toBe('done');
    /* Chapter 1 has audio: its line is untouched (its emotion still fills). */
    expect(sentenceOf(store, 1)?.text).toBe('Hello.');
    expect(sentenceOf(store, 1)?.vocalization).toBeFalsy();
    expect(emotionOf(store, 1)).toBe('angry');
    const { renderedTextByChapter } = store.getState().chapters;
    expect(
      isChapterTextEditedSinceRender(
        renderedTextByChapter[1],
        store.getState().manuscript.sentences.filter((s) => s.chapterId === 1),
      ),
    ).toBe(false);
    /* Control: chapter 2 has no audio, so the same annotation lands there. */
    expect(sentenceOf(store, 2)?.text).toBe('Hhhh… Hello.');
  });

  /* #3435 (PR #3505 CI) — the open re-run is background work: it never blocks
     or delays what the user does on the book. */
  const queued = (bookId: string) =>
    queueActions.setSnapshot({
      entries: [
        { id: 'q1', bookId, chapterId: 1, scope: 'this', addedAt: '', status: 'queued', order: 0 } as never,
      ],
      paused: true,
    });

  async function openWithHeldRun() {
    let release!: () => void;
    detectEmotionsMock.mockImplementation(async (_id: string, opts: Opts) => {
      await new Promise<void>((r) => (release = r));
      emit(opts, [ch1, ch2]);
      return { totalAnnotations: 2, annotatedChapters: 2 };
    });
    libBooks = [makeBook('b1', 'cast_pending')];
    marks.set('b1', false);
    const store = makeStore(true);
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    renderAnyPath(store);
    await waitFor(() => expect(detectEmotionsMock).toHaveBeenCalledTimes(1));
    return { store, release: () => release() };
  }

  it('background: the open re-run shows its pill but never makes the book busy', async () => {
    const { store, release } = await openWithHeldRun();
    expect(store.getState().prosody.activeStreams.b1).toMatchObject({ background: true });
    expect(selectAnalysisBusyForBook(store.getState() as never, 'b1')).toBe(false);
    await act(async () => release());
    await waitFor(() => expect(watermarkPuts('b1')).toHaveLength(1));
  });

  it('yields: generation work queued for the book mid-run ends the run at once; nothing more lands, the book stays marked unfinished', async () => {
    const { store, release } = await openWithHeldRun();
    await act(async () => {
      store.dispatch(queued('b1'));
    });
    expect(store.getState().prosody.activeStreams.b1).toBeUndefined();
    await act(async () => release());
    await settle(300);
    expect(emotionOf(store, 1)).toBeUndefined();
    expect(watermarkPuts('b1')).toEqual([]);
    expect(unfinishedPuts()).toEqual(['b1']);
    expect(detectEmotionsMock).toHaveBeenCalledTimes(1); // not restarted this visit
  });

  it('yields: a run that yielded is marked unfinished, never done, even when nothing arrived after it yielded', async () => {
    let release!: () => void;
    detectEmotionsMock.mockImplementation(async () => {
      await new Promise<void>((r) => (release = r));
      return { totalAnnotations: 0, annotatedChapters: 0 };
    });
    libBooks = [makeBook('b1', 'cast_pending')];
    marks.set('b1', false);
    const store = makeStore(true);
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    renderAnyPath(store);
    await waitFor(() => expect(detectEmotionsMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      store.dispatch(queued('b1'));
    });
    await act(async () => release());
    await settle(300);
    expect(watermarkPuts('b1')).toEqual([]);
    expect(unfinishedPuts()).toEqual(['b1']);
  });

  it('yields: a manual run that takes the book mid-run keeps its own pill', async () => {
    const { store, release } = await openWithHeldRun();
    await act(async () => {
      store.dispatch(prosodyActions.setActive({ bookId: 'b1', progress: 0, label: 'Manual' }));
    });
    await act(async () => release());
    await settle(300);
    expect(store.getState().prosody.activeStreams.b1).toMatchObject({ label: 'Manual' });
    expect(emotionOf(store, 1)).toBeUndefined(); // the background run applied nothing
    expect(watermarkPuts('b1')).toEqual([]);
  });

  it('waits: an open book with generation work queued is not run until that work is gone', async () => {
    libBooks = [makeBook('b1', 'cast_pending')];
    marks.set('b1', false);
    const store = makeStore(true);
    store.dispatch(queued('b1'));
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    renderAnyPath(store);
    await waitFor(() => expect(store.getState().manuscript.manuscriptId).toBe('mns_b1'));
    await settle(200);
    expect(detectEmotionsMock).not.toHaveBeenCalled();

    await act(async () => {
      store.dispatch(queueActions.setSnapshot({ entries: [], paused: true }));
    });
    await waitFor(() => expect(watermarkPuts('b1')).toHaveLength(1));
    expect(detectEmotionsMock).toHaveBeenCalledTimes(1);
  });

  it('no double run: a library transition while the open re-run is in flight starts nothing new', async () => {
    const { store, release } = await openWithHeldRun();
    await act(async () => {
      store.dispatch(librarySlice.actions.addBook(makeBook('b1', 'voices_pending')));
    });
    await settle(50);
    expect(detectEmotionsMock).toHaveBeenCalledTimes(1);

    await act(async () => release());
    await waitFor(() => expect(watermarkPuts('b1')).toHaveLength(1));
    await settle(100);
    expect(detectEmotionsMock).toHaveBeenCalledTimes(1);
  });

  /* #3435 (PR #3505 review pass 7) — the background re-run belongs to the
     open book: it stops the moment its book is not the open one, or an
     analysis run starts for it. Each held run here ends the way the real SSE
     request does when its signal aborts. */
  type HeldRun = { id: string; signal?: AbortSignal; release: () => void };
  function holdRuns(): HeldRun[] {
    const runs: HeldRun[] = [];
    detectEmotionsMock.mockImplementation(
      (id: string, opts: Opts) =>
        new Promise((resolve, reject) => {
          runs.push({
            id,
            signal: opts.signal,
            release: () => {
              emit(opts, [ch1, ch2]);
              resolve({ totalAnnotations: 2, annotatedChapters: 2 });
            },
          });
          opts.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    return runs;
  }
  const live = (runs: HeldRun[]) => runs.filter((r) => !r.signal?.aborted).map((r) => r.id);

  async function openAndWait(store: ReturnType<typeof makeStore>, id: string) {
    await act(async () => {
      store.dispatch(uiActions.openBook({ id, status: 'cast_pending' }));
    });
    await waitFor(() => expect(store.getState().manuscript.manuscriptId).toBe(`mns_${id}`));
  }

  it('P7a: opening another book ends the run; back on the book with generation queued, nothing of it lands', async () => {
    const runs = holdRuns();
    libBooks = [makeBook('b1', 'cast_pending'), makeBook('b2', 'cast_pending')];
    marks.set('b1', false);
    const store = makeStore(true);
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    renderAnyPath(store);
    await waitFor(() => expect(runs).toHaveLength(1));

    await openAndWait(store, 'b2');
    expect(runs[0].signal?.aborted).toBe(true);
    expect(store.getState().prosody.activeStreams.b1).toBeUndefined();
    await waitFor(() => expect(unfinishedPuts()).toEqual(['b1'])); // its own book only, never b2

    await openAndWait(store, 'b1');
    await act(async () => {
      store.dispatch(queued('b1'));
    });
    await act(async () => runs.forEach((r) => r.release()));
    await settle(700);
    expect(emotionOf(store, 1)).toBeUndefined();
    expect(manuscriptPuts()).toEqual([]);
    expect(watermarkPuts('b1')).toEqual([]);
  });

  it('P7b: opening three unfinished books in a row leaves one run in flight, never three', async () => {
    const runs = holdRuns();
    libBooks = ['b1', 'b2', 'b3'].map((id) => makeBook(id, 'cast_pending'));
    ['b1', 'b2', 'b3'].forEach((id) => marks.set(id, false));
    const store = makeStore(true);
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    renderAnyPath(store);
    await waitFor(() => expect(runs).toHaveLength(1));
    await openAndWait(store, 'b2');
    await waitFor(() => expect(runs).toHaveLength(2));
    await openAndWait(store, 'b3');
    await waitFor(() => expect(runs).toHaveLength(3));
    await settle(50);

    expect(live(runs)).toEqual(['b3']);
    expect(Object.keys(store.getState().prosody.activeStreams)).toEqual(['b3']);
    await act(async () => runs.forEach((r) => r.release()));
  });

  it('P7e: a Re-analyse from Confirm ends the run; nothing of it lands mid-analysis', async () => {
    const runs = holdRuns();
    libBooks = [makeBook('b1', 'cast_pending')];
    marks.set('b1', false);
    const store = makeStore(true);
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    renderAnyPath(store);
    await waitFor(() => expect(runs).toHaveLength(1));
    expect(store.getState().ui.stage.kind).toBe('confirm');

    await act(async () => {
      store.dispatch(uiActions.reanalyse({ manuscriptId: 'mns_b1' }));
    });
    expect(runs[0].signal?.aborted).toBe(true);
    expect(store.getState().prosody.activeStreams.b1).toBeUndefined();
    await act(async () => runs[0].release());
    await settle(700);
    expect(emotionOf(store, 1)).toBeUndefined();
    expect(manuscriptPuts()).toEqual([]);
    expect(watermarkPuts('b1')).toEqual([]);
  });

  it('P7e: a Re-analyse while the re-run waits on its read starts no run at all', async () => {
    const runs = holdRuns();
    libBooks = [makeBook('b1', 'cast_pending')];
    marks.set('b1', false);
    /* The layout's own read lands; the open trigger's read is held. */
    let reads = 0;
    const held: Array<() => void> = [];
    getBookStateMock.mockImplementation((id: string) =>
      reads++ === 0
        ? Promise.resolve(stateFor(id))
        : new Promise((r) => held.push(() => r(stateFor(id)))),
    );
    const store = makeStore(true);
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    renderAnyPath(store);
    await waitFor(() => expect(reads).toBe(2));

    await act(async () => {
      store.dispatch(uiActions.reanalyse({ manuscriptId: 'mns_b1' }));
    });
    await act(async () => held.forEach((release) => release()));
    await settle(200);
    expect(runs).toEqual([]);
    expect(store.getState().prosody.activeStreams.b1).toBeUndefined();
  });

  it('P7e: a subset analysis run started for the book ends the run', async () => {
    const runs = holdRuns();
    libBooks = [makeBook('b1', 'voices_pending')];
    marks.set('b1', false);
    const store = makeStore(true);
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'voices_pending' }));
    renderAnyPath(store);
    await waitFor(() => expect(runs).toHaveLength(1));

    await act(async () => {
      store.dispatch(
        analysisActions.setActiveStream({
          bookId: 'b1',
          manuscriptId: 'mns_b1',
          phaseId: 0,
          phaseLabel: 'Detecting characters',
          phaseProgress: 0,
          remainingMs: null,
          lastTickAt: Date.now(),
          state: 'running',
          kind: 'subset',
          subsetChapterIds: [1],
        }),
      );
    });
    expect(runs[0].signal?.aborted).toBe(true);
    expect(store.getState().prosody.activeStreams.b1).toBeUndefined();
    await act(async () => runs[0].release());
    await settle(700);
    expect(emotionOf(store, 1)).toBeUndefined();
    expect(watermarkPuts('b1')).toEqual([]);
  });

  /* #3435 (PR #3505 review pass 7) — the open trigger's two wait guards. */
  it('waits: a manual run that takes the book while the re-run waits on its read is not overwritten; the re-run follows it', async () => {
    libBooks = [makeBook('b1', 'cast_pending')];
    marks.set('b1', false);
    /* The layout's own read lands; the open trigger's read is held. */
    let reads = 0;
    const held: Array<() => void> = [];
    getBookStateMock.mockImplementation((id: string) =>
      reads++ === 0
        ? Promise.resolve(stateFor(id))
        : new Promise((r) => held.push(() => r(stateFor(id)))),
    );
    const store = makeStore(true);
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    renderAnyPath(store);
    await waitFor(() => expect(reads).toBe(2));

    await act(async () => {
      store.dispatch(prosodyActions.setActive({ bookId: 'b1', progress: 0, label: 'Manual' }));
    });
    await act(async () => held.forEach((release) => release()));
    await settle(200);
    expect(store.getState().prosody.activeStreams.b1).toMatchObject({ label: 'Manual' });
    expect(store.getState().prosody.activeStreams.b1?.background).toBeFalsy();
    expect(detectEmotionsMock).not.toHaveBeenCalled();

    /* The manual run ends: the open trigger looks again, this visit. */
    getBookStateMock.mockImplementation(async (id: string) => stateFor(id));
    await act(async () => {
      store.dispatch(prosodyActions.clear({ bookId: 'b1' }));
    });
    await waitFor(() => expect(watermarkPuts('b1')).toHaveLength(1));
    expect(detectEmotionsMock).toHaveBeenCalledTimes(1);
  });

  it('waits: the re-run starts only once the slices hold the book, so a fast read cannot miss the visit', async () => {
    libBooks = [makeBook('b1', 'cast_pending'), makeBook('b2', 'cast_pending')];
    marks.set('b1', false);
    const store = makeStore(true);
    store.dispatch(uiActions.openBook({ id: 'b2', status: 'cast_pending' }));
    renderAnyPath(store);
    await waitFor(() => expect(store.getState().manuscript.manuscriptId).toBe('mns_b2'));
    await settle(50);

    /* b1's first read (the layout's) is held; every later one lands at once. */
    let b1Reads = 0;
    let releaseLayoutRead!: () => void;
    getBookStateMock.mockImplementation((id: string) =>
      id === 'b1' && b1Reads++ === 0
        ? new Promise((r) => (releaseLayoutRead = () => r(stateFor(id))))
        : Promise.resolve(stateFor(id)),
    );
    await act(async () => {
      store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    });
    await settle(100);
    expect(store.getState().manuscript.manuscriptId).toBe('mns_b2');

    await act(async () => releaseLayoutRead());
    await waitFor(() => expect(store.getState().manuscript.manuscriptId).toBe('mns_b1'));
    await waitFor(() => expect(watermarkPuts('b1')).toHaveLength(1));
    expect(detectEmotionsMock).toHaveBeenCalledWith('b1', expect.anything());
  });
});
