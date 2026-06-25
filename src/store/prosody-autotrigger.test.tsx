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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

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
import { analysisSlice } from './analysis-slice';
import { castDesignSlice } from './cast-design-slice';
import { queueSlice } from './queue-slice';
import { tourSlice } from './tour-slice';
import { listenProgressSlice } from './listen-progress-slice';
import { settingsSlice } from './settings-slice';
import { continueListeningSlice } from './continue-listening-slice';
import { notificationsSlice } from './notifications-slice';
import type { LibraryBook } from '../lib/types';

/* ── Module mocks ──────────────────────────────────────────────────────── */

const runProsodyPassesMock = vi.fn();
vi.mock('./prosody-thunk', () => ({
  runProsodyPasses: (...args: unknown[]) => runProsodyPassesMock(...args),
}));

const getBookStateMock = vi.fn();
const putBookStateMock = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    /* Library + base infra */
    getLibrary: vi.fn(async () => ({ books: [] })),
    getVoices: vi.fn(async () => ({ voices: [], dropped: [] })),
    getBaseVoices: vi.fn(async () => ({ voices: [] })),
    getUserSettings: vi.fn(async () => ({})),
    getBookState: (...args: unknown[]) => getBookStateMock(...args),
    putBookState: (...args: unknown[]) => putBookStateMock(...args),
    getAnalysisState: vi.fn(async () => null),
    getActiveAnalyses: vi.fn(async () => ({ snapshots: [] })),
    pollRevisions: vi.fn(async () => ({ pending: [], drift: [] })),
    pollRevisionsBulk: vi.fn(async () => ({ byBookId: {} })),
    getSidecarHealth: vi.fn(async () => ({ status: 'unreachable', url: '(test)' })),
    getGpuQueueState: vi.fn(async () => ({ depth: 0, inFlight: 0, max: 1 })),
    matchVoices: vi.fn(async () => ({ matches: [] })),
    getSeriesRoster: vi.fn(async () => ({ characters: [] })),
    getSetupReadiness: () =>
      Promise.resolve({
        ready: true,
        completedAt: '2026-06-12T00:00:00.000Z',
        blockers: { sidecar: 'pass', ffmpeg: 'pass', tts: 'pass', analyzer: 'pass' },
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
}));

/* Route-prefetch stubs — avoid post-teardown EnvironmentTeardownError. */
vi.mock('../routes/prefetch', () => ({
  importGenerationView: vi.fn(() => Promise.resolve({})),
  importUploadView: vi.fn(() => Promise.resolve({})),
}));

import { Layout } from '../components/layout';
import { uiActions } from './ui-slice';

/* ── Store factory ─────────────────────────────────────────────────────── */

function makeStore() {
  return configureStore({
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
    runProsodyPassesMock.mockResolvedValue({ totalAnnotations: 0, totalChapters: 0, failed: 0 });
    putBookStateMock.mockResolvedValue({});
  });

  // ── Test 2: seed-on-mount — book complete on first render is NOT triggered ──

  it('does NOT fire runProsodyPasses for a book that is already analysis-complete on first render (seed-on-mount)', async () => {
    const store = makeStore();
    /* A book that already exists in the library as cast_pending BEFORE Layout
       mounts should be seeded into `considered` without firing. */
    store.dispatch(librarySlice.actions.addBook(makeBook('b1', 'cast_pending')));
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));

    renderLayout(store);

    /* Wait enough time for any async effects to settle. */
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(runProsodyPassesMock).not.toHaveBeenCalled();
  });

  // ── Test 1: book appearing AFTER the seeded first render fires once ──

  it('fires runProsodyPasses once when a book transitions to cast_pending AFTER the seeded first render', async () => {
    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));

    renderLayout(store);

    /* Wait for the seed pass (first render with empty library). */
    await act(async () => {
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
      expect(runProsodyPassesMock).toHaveBeenCalledWith('b1', { dispatch: store.dispatch });
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
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    /* A background book (b2) transitions to cast_pending.
       It is NOT the active stage book (b1). */
    await act(async () => {
      store.dispatch(librarySlice.actions.addBook(makeBook('b2', 'cast_pending')));
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(runProsodyPassesMock).toHaveBeenCalledWith('b2', { dispatch: store.dispatch });
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

    await act(async () => {
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

    await act(async () => {
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

    await act(async () => {
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

  it('does NOT write putBookState when failed > 0 and the book is re-eligible on the next transition', async () => {
    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    runProsodyPassesMock.mockResolvedValueOnce({ totalAnnotations: 5, totalChapters: 2, failed: 1 });

    renderLayout(store);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    await act(async () => {
      store.dispatch(librarySlice.actions.addBook(makeBook('b1', 'cast_pending')));
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(runProsodyPassesMock).toHaveBeenCalledTimes(1);
    });

    /* No watermark written because failed > 0. */
    expect(putBookStateMock).not.toHaveBeenCalled();

    /* Simulate a second appearance: book transitions through a non-complete
       status and back to complete. This changes completeKey, retriggering
       the effect. Since the partial run removed b1 from considered, it fires again. */
    runProsodyPassesMock.mockResolvedValueOnce({ totalAnnotations: 5, totalChapters: 2, failed: 0 });

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
    runProsodyPassesMock.mockResolvedValue({ totalAnnotations: 10, totalChapters: 3, failed: 0 });

    renderLayout(store);

    await act(async () => {
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

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    await act(async () => {
      store.dispatch(librarySlice.actions.addBook(makeBook('b1', 'cast_pending')));
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(runProsodyPassesMock).toHaveBeenCalledTimes(1);
    });

    /* No watermark written. */
    expect(putBookStateMock).not.toHaveBeenCalled();

    /* A subsequent status change should fire again (book was removed from considered).
       Cycle through a non-complete status to retrigger the effect with a new completeKey. */
    runProsodyPassesMock.mockResolvedValueOnce({ totalAnnotations: 0, totalChapters: 0, failed: 0 });

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

  // ── Test: 'not_analysed' / 'analysing' / 'unreadable' / 'orphaned' are not considered complete ──

  it('does NOT fire for books with non-complete statuses (not_analysed, analysing, unreadable, orphaned)', async () => {
    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));

    renderLayout(store);

    await act(async () => {
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

    await act(async () => {
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
    expect(Object.keys(opts)).toEqual(['dispatch']);
    expect(opts.signal).toBeUndefined();
  });
});
