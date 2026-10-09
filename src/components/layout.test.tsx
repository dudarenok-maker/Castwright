/* Pairs with docs/features/archive/27-book-state-persistence.md.

   Pins the per-book hydration effect's revisions branch: when the user
   lands on a book stage and `getBookState` resolves with a `revisions`
   payload, Layout dispatches `revisionsActions.hydrate`
   BEFORE the 30s `pollRevisions` interval starts. This is the cold-load
   path that closes the brief empty-state flash window that used to
   render between mount and the first poll tick.

   This test deliberately drives the layout's mount sequence through to
   the dispatch and then unmounts — it does NOT exercise the 30s poll
   itself, the analysing pill rehydration, or any of the other side-
   effects the layout runs alongside. Those have their own paired tests. */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore, type Middleware } from '@reduxjs/toolkit';
import { MemoryRouter, Routes, Route } from 'react-router';

import { uiSlice } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { revisionsSlice } from '../store/revisions-slice';
import { manuscriptSlice } from '../store/manuscript-slice';
import { librarySlice } from '../store/library-slice';
import { voicesSlice } from '../store/voices-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { accountSlice } from '../store/account-slice';
import { bookMetaSlice } from '../store/book-meta-slice';
import { exportsSlice } from '../store/exports-slice';
import { analysisSlice } from '../store/analysis-slice';
import { castDesignSlice } from '../store/cast-design-slice';
import { queueSlice } from '../store/queue-slice';
import { tourSlice } from '../store/tour-slice';
import { listenProgressSlice } from '../store/listen-progress-slice';
import { settingsSlice } from '../store/settings-slice';
import { continueListeningSlice } from '../store/continue-listening-slice';
import { persistenceMiddleware } from '../store/persistence-middleware';
import { notificationsSlice } from '../store/notifications-slice';
import { prosodySlice } from '../store/prosody-slice';
import { scriptReviewSlice } from '../store/script-review-slice';
import { spliceSlice } from '../store/splice-slice';

const getBookStateMock = vi.fn();
const pollRevisionsMock = vi.fn();
const pollRevisionsBulkMock = vi.fn();
const putBookStateMock = vi.fn();
/* Task 22 — the A/B player's per-op routes. */
const acceptRevisionMock = vi.fn();
const rejectRevisionMock = vi.fn();
const restorePreviousUnrecordedMock = vi.fn();
const getChapterAudioPreviousMock = vi.fn();
const matchVoicesMock = vi.fn();

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return {
    ...mod,
    api: {
      /* Library + voice library + base-voice catalogue hydrate on mount —
         resolve to empty so they no-op without throwing. */
      getLibrary: vi.fn(async () => ({ authors: [] })),
      getVoices: vi.fn(async () => ({ voices: [], dropped: [] })),
      getBaseVoices: vi.fn(async () => ({ voices: [] })),
      /* Account fetch (createAsyncThunk wraps this) — resolve to minimal
         UserSettings so the slice's hydrate doesn't reject. */
      getUserSettings: vi.fn(async () => ({})),
      /* The line this test is actually about. Configured per-test via
         getBookStateMock.mockResolvedValue. */
      getBookState: (...args: unknown[]) => getBookStateMock(...args),
      /* Persistence-middleware's PUT sink — only wired into the store by the
         tests below that use `makeStoreWithScopeAndPersistence()` (#3395
         pass 3, R1/R2); a stub here so it's never `undefined` if the
         middleware is ever wired into a test that doesn't configure it. */
      putBookState: (...args: unknown[]) => putBookStateMock(...args),
      /* Cold-boot analysis state probe — return null so the analysing-pill
         rehydration short-circuits. */
      getAnalysisState: vi.fn(async () => null),
      /* Workspace-wide cold-boot scan. Layout's mount
         effect calls this; return empty so no pill seeds. */
      getActiveAnalyses: vi.fn(async () => ({ snapshots: [] })),
      /* The 30 s pollRevisions interval. Resolve to empty so it doesn't
         overwrite the slice between hydrate and the test's assertions. */
      pollRevisions: (...args: unknown[]) => pollRevisionsMock(...args),
      /* Background bulk-poll fan-out across all known books — the
         #3376 test resolves this per-test; default to empty so the
         per-render fetch doesn't crash the test harness. */
      pollRevisionsBulk: (...args: unknown[]) => pollRevisionsBulkMock(...args),
      /* useTtsLifecycle polls /health on mount; resolve to unreachable so
         no pending pill state lands. */
      getSidecarHealth: vi.fn(async () => ({ status: 'unreachable', url: '(test)' })),
      /* useTtsLifecycle also polls /api/gpu/queue on the same cadence (the
         GPU semaphore depth that drives the "GPU busy · N waiting ·" pill
         prefix). Stub to an empty queue so the pill renders without the
         prefix in these tests. */
      getGpuQueueState: vi.fn(async () => ({ queueDepth: 0, devices: [] })),
      /* useTtsLifecycle also polls the code-43 auto-revert trip status on the
         same cadence (task 16/16.5, #2974) — resolve to null so no trip
         banner state lands, same pattern as getGpuQueueState above. */
      getGpuTripStatus: vi.fn(async () => null),
      /* Task 10 (#1839) — the resident-model Stop control in the global TTS
         notice banner calls ttsLifecycle.kokoro/coqui.onStop(), which hits
         these. Not exercised by most tests in this file, but useTtsLifecycle
         needs both defined on the mocked api module or a real Stop click
         throws "api.unloadSidecar is not a function". */
      loadSidecar: vi.fn(async () => ({ status: 'ready' })),
      unloadSidecar: vi.fn(async () => ({ status: 'idle' })),
      /* Voice matching fires on the confirm stage only; we render at
         'ready' here so it shouldn't trigger, but keep a stub so any
         drift in that guard doesn't crash the test. */
      matchVoices: (...args: unknown[]) => matchVoicesMock(...args),
      /* Plan 90 — Layout fetches the series roster on bookId change so
         the manuscript-view reassign picker has roster entries to surface.
         Return empty so the effect's catch path doesn't fire and these
         tests stay focused on per-book hydration. */
      getSeriesRoster: vi.fn(async () => ({ characters: [] })),
      /* fs-21 — boot-splash readiness gate fetches this once on mount; resolve
         ready so the splash clears and the normal app renders. A vi.fn() (not
         a plain arrow) so individual tests can override the resolved value
         per-test (see the Retry-suppression describe block below), same
         pattern as getSidecarHealth/setShelfStatus elsewhere in this file. */
      getSetupReadiness: vi.fn(async () => ({
        ready: true,
        completedAt: '2026-06-12T00:00:00.000Z',
        blockers: {
          sidecar: { status: 'pass', cause: 'pass', message: '', remediation: '' },
          ffmpeg: { status: 'pass', cause: 'pass', message: '', remediation: '' },
          tts: { status: 'pass', cause: 'pass', message: '', remediation: '' },
          analyzer: { status: 'pass', cause: 'pass', message: '', remediation: '' },
        },
        info: { gpu: 'cuda · 1.2 / 8.0 GB reserved' },
      })),
      /* Guided-tour boot fetch — resolve to not-completed so the tour slice
         stays inactive (overlay renders null) and the test harness is unaffected. */
      getTourStatus: vi.fn(async () => ({ completedAt: null })),
      /* MiniPlayer stubs — needed when Layout renders a MiniPlayer (ready stage
         with a current track). Defaults to no-ops so the player mounts cleanly. */
      getChapterAudio: vi.fn(async () => ({
        url: '/api/books/b1/chapters/1/audio.mp3',
        durationSec: 600,
        peaks: [],
        sampleRate: 44100,
        segments: [],
      })),
      /* Task 22 — the A/B player's per-op routes, configured per-test via
         the matching Mock above. */
      acceptRevision: (...a: unknown[]) => acceptRevisionMock(...a),
      rejectRevision: (...a: unknown[]) => rejectRevisionMock(...a),
      restorePreviousUnrecorded: (...a: unknown[]) => restorePreviousUnrecordedMock(...a),
      getChapterAudioPrevious: (...a: unknown[]) => getChapterAudioPreviousMock(...a),
      getListenProgress: vi.fn(async () => null),
      putListenProgress: vi.fn(async () => ({
        chapterId: 1,
        currentSec: 0,
        updatedAt: new Date().toISOString(),
      })),
      putListenStats: vi.fn(async () => ({})),
      /* fs-15 shelf-status — the auto-finish call. Mocked as a vi.fn so tests
         can assert it was called with {finished:true}. */
      setShelfStatus: vi.fn(async () => ({
        chapterId: 1,
        currentSec: 0,
        updatedAt: new Date().toISOString(),
      })),
      /* fe-47 tier-modal test — the "apply tier to cast" sink. */
      setCastTier: vi.fn(async () => ({ updated: 0 })),
    },
    AnalysisError: class extends Error {},
    ExportIncompleteError: class extends Error {
      missing: string[] = [];
    },
  };
});

/* Stub the route-prefetch thunks. Layout fires importUploadView() /
   importGenerationView() from stage-keyed effects to warm lazy chunks; those
   real dynamic imports resolve AFTER a test finishes, and Vitest 4 now fails
   the run on the resulting post-teardown EnvironmentTeardownError (Vitest 2
   swallowed it). Prefetch is a pure perf optimisation, never under test here,
   so no-op it to keep the imports from outliving the jsdom environment. */
vi.mock('../routes/prefetch', () => ({
  importGenerationView: vi.fn(() => Promise.resolve({})),
  importUploadView: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../store/prosody-thunk', () => ({
  runProsodyPasses: vi.fn(() => Promise.resolve({ totalAnnotations: 0, totalChapters: 0, failed: 0, skipped: 0 })),
}));

import { Layout, _resetRevisionsErrorToastedForTests, _resetRevisionPollWarningsForTests } from './layout';
import { api, ApiError } from '../lib/api';
import { uiActions } from '../store/ui-slice';
import { revisionsActions } from '../store/revisions-slice';
import { revisionPlayerMiddleware } from '../store/revision-player-middleware';
import { castActions } from '../store/cast-slice';
import { RevisionOpFailure } from '../lib/revision-op-failure';
import { bookMetaActions } from '../store/book-meta-slice';
import { exportsActions } from '../store/exports-slice';
import { notificationsActions } from '../store/notifications-slice';
import type { DriftEvent, LibraryBook, LibraryResponse } from '../lib/types';
import type { Chapter, Character, Voice } from '../lib/types';
import {
  selectUndesignedQwenCharacters,
  selectVoiceReadinessGateShouldFire,
} from '../store/voice-readiness-selectors';
import type { RootState } from '../store';

function makeStore(extraMiddleware: Middleware[] = []) {
  return configureStore({
    middleware: (getDefault) => getDefault().concat(...extraMiddleware),
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
      splice: spliceSlice.reducer,
    },
  });
}

/* Plan 286, Task 18 — helpers for the server-owned revisions hydrate tests. */
const F1 = '000000000000001-a';
function bookStateFor(bookId: string, revisions: unknown, extra: Record<string, unknown> = {}) {
  return {
    state: { bookId, manuscriptId: `mns_${bookId}`, title: `Book ${bookId}`, author: 'Della Renwick', series: 'Standalones',
      seriesPosition: null, isStandalone: true, manuscriptFile: 'manuscript.txt', castConfirmed: true, chapters: [],
      coverGradient: ['#3C194F', '#0F0E0D'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    cast: { characters: [{ id: 'eliza', name: 'Eliza', role: '', color: 'narrator' }] },
    manuscript: { wordCount: 0, format: 'plaintext' }, manuscriptEdits: null,
    revisions, completedSlugs: [], chapterCharacters: {}, changeLog: null, ...extra,
  };
}
const revState = (bookId: string, fileId: string | null, rev: number, ids: string[]) =>
  ({ bookId, fileId, rev, pending: ids.map((id) => ({ id, chapterId: 3, characterId: 'eliza', segments: [] })), dismissed: [], acceptedSelections: {}, timeline: {} });
/* A catch-all route, not `/books/:bookId/cast` — several of these tests call
   uiActions.goHome() and reopen. Layout's own stage->URL sync effect
   (skipFirst) navigates for real on the first stage change after mount, and
   a route scoped to just the book path would then fail to match '/' and
   unmount Layout, exactly as the #3395 pass 3 R1/R1b/R2 tests this task
   replaces already found and worked around (see git history). */
function renderLayoutAt(store: ReturnType<typeof makeStore>, bookId: string) {
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[`/books/${bookId}/cast`]}>
        <Routes><Route path="*" element={<Layout />} /></Routes>
      </MemoryRouter>
    </Provider>,
  );
}
const openAt = (store: ReturnType<typeof makeStore>, id: string) =>
  act(() => { store.dispatch({ type: 'ui/openBook', payload: { id, status: 'cast_pending' } }); });

/** Same shape as `makeStore()`, plus `persistenceMiddleware` — the
    production store's real debounced PUT-on-mutation behaviour. Needed by
    the #3395 pass 3 R1/R2 tests below, which assert on the actual patch
    `api.putBookState` receives after a book reopens or a write races a
    hydrate. Kept separate from the plain `makeStore()` so the many tests that
    don't care about persistence aren't dragged through the debounce timers. */
function makeStoreWithScopeAndPersistence() {
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
      prosody: prosodySlice.reducer,
      scriptReview: scriptReviewSlice.reducer,
    },
    middleware: (getDefault) => getDefault().concat(persistenceMiddleware),
  });
}

beforeEach(() => {
  getBookStateMock.mockReset();
  pollRevisionsMock.mockReset();
  pollRevisionsMock.mockResolvedValue({ pending: [], drift: [] });
  pollRevisionsBulkMock.mockReset();
  pollRevisionsBulkMock.mockResolvedValue({ byBookId: {} });
  putBookStateMock.mockReset();
  putBookStateMock.mockResolvedValue(undefined);
  acceptRevisionMock.mockReset();
  rejectRevisionMock.mockReset();
  restorePreviousUnrecordedMock.mockReset();
  getChapterAudioPreviousMock.mockReset();
  matchVoicesMock.mockReset();
  matchVoicesMock.mockResolvedValue({ matches: [] });
});

describe('Layout — per-book hydration: revisions branch (plan 27)', () => {
  it('re-fetches getBookState when entering /confirm with manuscript hydrated but cast empty', async () => {
    /* Regression for the confirm-cast-empty race (fix branch
       fix/frontend-confirm-cast-empty-race). When analyseManuscript's
       'result' SSE event lands with characters absent (or a Phase 0 cache
       resume skipped the streamed mergeCharacters path), manuscriptActions
       .hydrateFromAnalysis still populates manuscript.{bookId,manuscriptId,
       title} while castActions.hydrateFromAnalysis no-ops (its guard:
       `if (characters?.length)`). The user lands on /confirm with cast=[]
       and the view renders "0 speaking characters detected." Layout's
       per-book hydration effect now requires cast.characters.length > 0
       on the confirm/ready stages before short-circuiting; the previous
       check (manuscript-only) skipped the disk refetch and left cast
       empty. This test pins that contract by pre-populating the manuscript
       slice (simulating hydrateFromAnalysis having run) and verifying
       Layout still calls getBookState. */
    getBookStateMock.mockResolvedValue({
      state: {
        bookId: 'b1',
        manuscriptId: 'mns_test',
        title: 'The Floodmark',
        author: 'Della Renwick',
        series: 'The Hollow Tide',
        seriesPosition: 8.5,
        isStandalone: false,
        manuscriptFile: 'manuscript.epub',
        castConfirmed: false,
        chapters: [],
        coverGradient: ['#3C194F', '#0F0E0D'],
        createdAt: '2026-05-17T00:00:00Z',
        updatedAt: '2026-05-17T00:00:00Z',
      },
      cast: {
        characters: [
          { id: 'narrator', name: 'Narrator', role: 'Third-person observer', color: 'narrator' },
        ],
      },
      manuscript: { wordCount: 0, format: 'epub' },
      manuscriptEdits: null,
      revisions: null,
      completedSlugs: [],
      chapterCharacters: {},
      changeLog: null,
    });

    const store = makeStore();
    /* Pre-populate the manuscript slice as it would be after Upload →
       Analyse: uploadComplete set manuscriptId+title, then the (buggy)
       analyse completion set bookId via hydrateFromAnalysis. Cast stays
       empty — the no-op branch of cast-slice.ts:43 when payload.characters
       is absent / empty. Without the cast-non-empty leg in the layout
       short-circuit, the effect would skip the disk hydrate and the user
       would see "0 speaking characters detected" on confirm. */
    store.dispatch({
      type: 'manuscript/uploadComplete',
      payload: {
        manuscriptId: 'mns_test',
        title: 'The Floodmark',
        format: 'epub',
        wordCount: 100,
        sourceText: null,
      },
    });
    store.dispatch({
      type: 'manuscript/hydrateFromAnalysis',
      payload: {
        bookId: 'b1',
        manuscriptId: 'mns_test',
        title: 'The Floodmark',
        characters: [],
        chapters: [],
        sentences: [],
        phaseTimings: [],
      },
    });
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books/b1/confirm']}>
          <Routes>
            <Route path="/books/:bookId/confirm" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    await waitFor(() => {
      expect(getBookStateMock).toHaveBeenCalledWith('b1');
    });

    /* Disk roster landed in the cast slice — the user would now see
       1 speaking character (narrator) instead of "0 speaking
       characters detected". */
    await waitFor(() => {
      expect(store.getState().cast.characters.map((c) => c.id)).toEqual(['narrator']);
    });
  });

  it('hydrates with an empty patch (but a real bookId) when revisions field is absent on the response', async () => {
    /* A freshly-imported book whose revisions.json doesn't exist yet
       returns `revisions: null` from getBookState. Layout still carries
       `bookId` through to hydrateFromBookState (bare `null` would lose the
       belt-and-braces bookId-mismatch guard's anchor — #3395 pass 2, N1),
       so the slice's fields land empty and `loaded` flips true, same as
       before, but `revisions.bookId` is now correctly 'b1' rather than
       untouched. */
    getBookStateMock.mockResolvedValue({
      state: {
        bookId: 'b1',
        manuscriptId: 'mns_test',
        title: 'the Coalfall Commission',
        author: 'Della Renwick',
        series: 'Standalones',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: false,
        chapters: [],
        coverGradient: ['#3C194F', '#0F0E0D'],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      cast: null,
      manuscript: null,
      manuscriptEdits: null,
      revisions: null,
      completedSlugs: [],
      chapterCharacters: {},
      changeLog: null,
    });

    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books/b1/cast']}>
          <Routes>
            <Route path="/books/:bookId/cast" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    await waitFor(() => {
      const s = store.getState();
      expect(s.revisions.loaded).toBe(true);
      expect(s.revisions.pending).toEqual([]);
      expect(s.revisions.drift).toEqual([]);
      expect(s.revisions.bookId).toBe('b1');
    });
  });

  /* #3435 (PR #3505 review pass 4, P4c) — a result for book A skipped
     because the slices held book B leaves them B's, ids and all
     (routes/index.tsx AnalysingRoute). Confirm for A must then read A from
     disk rather than take B's slices as A's. */
  it("Confirm for a book whose result was skipped reads it from disk while the slices still hold another book", async () => {
    getBookStateMock.mockImplementation(async (bookId: string) => ({
      state: {
        bookId,
        manuscriptId: bookId === 'b1' ? 'm1' : 'm2',
        title: bookId === 'b1' ? 'Book A' : 'Book B',
        castConfirmed: false,
        chapters: [],
      },
      cast: { characters: [{ id: 'a-villain', name: 'Villain', role: 'Antagonist', color: 'magenta' }] },
      manuscript: null,
      manuscriptEdits: null,
      revisions: null,
      completedSlugs: [],
      chapterCharacters: {},
      changeLog: null,
    }));
    const store = makeStore();
    store.dispatch(
      manuscriptSlice.actions.hydrateFromBookState({
        state: { bookId: 'b2', manuscriptId: 'm2', title: 'Book B' } as never,
        sentences: null,
      }),
    );
    store.dispatch(castSlice.actions.hydrateCharacters([{ id: 'b-hero', name: 'Hero', role: 'Protagonist', color: 'peach' }]));
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'analysing', manuscriptId: 'm1' }));
    store.dispatch(uiActions.analysisComplete({ bookId: 'b1' }));
    expect(store.getState().ui.stage).toMatchObject({ kind: 'confirm', bookId: 'b1' });

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books/b1/confirm']}>
          <Routes>
            <Route path="/books/:bookId/confirm" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledWith('b1'));
    await waitFor(() => {
      const s = store.getState();
      expect([s.manuscript.bookId, s.manuscript.manuscriptId, s.manuscript.title]).toEqual(['b1', 'm1', 'Book A']);
      expect(s.cast.characters.map((c) => c.id)).toEqual(['a-villain']);
    });
  });
});

describe("Layout — an upload never leaves the old book's id on its manuscript (#3435)", () => {
  it('reopening the previous book after uploadComplete reads it from disk instead of treating it as loaded', async () => {
    getBookStateMock.mockImplementation(async (bookId: string) => ({
      state: { bookId, manuscriptId: 'm1', title: 'Book A', castConfirmed: false, chapters: [] },
      cast: { characters: [{ id: 'a-villain', name: 'Villain', role: 'Antagonist', color: 'magenta' }] },
      manuscript: null,
      manuscriptEdits: null,
      revisions: null,
      completedSlugs: [],
      chapterCharacters: {},
      changeLog: null,
    }));
    const store = makeStore();
    store.dispatch(
      manuscriptSlice.actions.hydrateFromBookState({
        state: { bookId: 'b1', manuscriptId: 'm1', title: 'Book A' } as never,
        sentences: null,
      }),
    );
    store.dispatch(castSlice.actions.hydrateCharacters([{ id: 'a-villain', name: 'Villain', role: 'Antagonist', color: 'magenta' }]));
    store.dispatch(
      manuscriptSlice.actions.uploadComplete({
        bookId: 'b2',
        manuscriptId: 'm2',
        title: 'Book B',
        format: 'plaintext',
        wordCount: 10,
        sourceText: '',
      } as never),
    );
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'analysing', manuscriptId: 'm1' }));
    store.dispatch(uiActions.analysisComplete({ bookId: 'b1' }));

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books/b1/confirm']}>
          <Routes>
            <Route path="/books/:bookId/confirm" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledWith('b1'));
    await waitFor(() => {
      const s = store.getState();
      expect([s.manuscript.bookId, s.manuscript.manuscriptId]).toEqual(['b1', 'm1']);
    });
  });
});

describe('Layout — revisions hydrate (plan 286)', () => {
  beforeEach(() => {
    pollRevisionsMock.mockResolvedValue({ drift: [] });
    pollRevisionsBulkMock.mockResolvedValue({ byBookId: {} });
    _resetRevisionsErrorToastedForTests(); // module-level: without this, a retry or test order leaks the OD2 set
  });

  it('book open dispatches hydrate with the normalised revisions (fileId/rev adopted)', async () => {
    getBookStateMock.mockResolvedValue(bookStateFor('b1', revState('b1', F1, 3, ['r1'])));
    const store = makeStore();
    openAt(store, 'b1');
    renderLayoutAt(store, 'b1');
    await waitFor(() => expect(store.getState().revisions).toMatchObject({ bookId: 'b1', fileId: F1, rev: 3 }));
    expect(store.getState().revisions.pending.map((p) => p.id)).toEqual(['r1']);
  });

  it('reopening a book always re-hydrates revisions, even with manuscript and cast already loaded', async () => {
    getBookStateMock.mockResolvedValue(bookStateFor('b1', revState('b1', null, 0, [])));
    const store = makeStore();
    openAt(store, 'b1');
    renderLayoutAt(store, 'b1');
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(store.getState().manuscript.bookId).toBe('b1'));
    getBookStateMock.mockResolvedValue(bookStateFor('b1', revState('b1', F1, 1, ['fresh'])));
    act(() => { store.dispatch(uiActions.goHome()); });
    openAt(store, 'b1');
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(store.getState().revisions.pending.map((p) => p.id)).toEqual(['fresh']));
  });

  it('a stage change within the same book (confirm → ready) does not re-read revisions', async () => {
    getBookStateMock.mockResolvedValue(bookStateFor('b1', revState('b1', null, 0, [])));
    const store = makeStore();
    openAt(store, 'b1');
    renderLayoutAt(store, 'b1');
    await waitFor(() => expect(store.getState().manuscript.bookId).toBe('b1'));
    act(() => { store.dispatch({ type: 'ui/openBook', payload: { id: 'b1', status: 'complete' } }); }); // → ready
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(getBookStateMock).toHaveBeenCalledTimes(1);
  });

  it('a failed reopen read is dropped silently (no toast); the poll repairs it', async () => {
    getBookStateMock.mockResolvedValue(bookStateFor('b1', revState('b1', null, 0, [])));
    const store = makeStore();
    openAt(store, 'b1');
    renderLayoutAt(store, 'b1');
    await waitFor(() => expect(store.getState().manuscript.bookId).toBe('b1'));
    getBookStateMock.mockRejectedValueOnce(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    act(() => { store.dispatch(uiActions.goHome()); });
    openAt(store, 'b1');
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    warn.mockRestore();
    expect(store.getState().notifications.toasts).toEqual([]);
  });

  it('a reopen read cancelled by a stage change before it lands is re-issued, not skipped', async () => {
    getBookStateMock.mockResolvedValue(bookStateFor('b1', revState('b1', null, 0, [])));
    const store = makeStore();
    openAt(store, 'b1');
    renderLayoutAt(store, 'b1');
    await waitFor(() => expect(store.getState().manuscript.bookId).toBe('b1'));
    let resolveCancelled!: (v: unknown) => void;
    getBookStateMock
      .mockReturnValueOnce(new Promise((r) => (resolveCancelled = r)))
      .mockResolvedValueOnce(bookStateFor('b1', revState('b1', F1, 2, ['fresh'])));
    act(() => { store.dispatch(uiActions.goHome()); });
    openAt(store, 'b1'); // read #2 starts and stays in flight
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(2));
    act(() => { store.dispatch({ type: 'ui/openBook', payload: { id: 'b1', status: 'complete' } }); }); // stage change: cleanup cancels read #2
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(3)); // re-issued, because read #2 never landed
    await act(async () => { resolveCancelled(bookStateFor('b1', revState('b1', null, 0, []))); }); // the cancelled read lands late and is ignored
    await waitFor(() => expect(store.getState().revisions.pending.map((p) => p.id)).toEqual(['fresh']));
  });

  it('A7 — a read for another book cancelled before it lands does not let a return skip the first book\'s re-read', async () => {
    getBookStateMock.mockImplementation(async (id: string) => bookStateFor(id, revState(id, null, 0, [])));
    const store = makeStore();
    openAt(store, 'bA');
    renderLayoutAt(store, 'bA');
    await waitFor(() => expect(store.getState().manuscript.bookId).toBe('bA')); // bA's read landed
    getBookStateMock.mockImplementationOnce(() => new Promise(() => {})); // bB's read never lands
    openAt(store, 'bB');
    await waitFor(() => expect(getBookStateMock).toHaveBeenLastCalledWith('bB'));
    const callsBefore = getBookStateMock.mock.calls.length;
    getBookStateMock.mockImplementation(async (id: string) => bookStateFor(id, revState(id, F1, 1, ['back'])));
    openAt(store, 'bA'); // cancels bB's read; bA is still manuscript-ready, so this is the revisions-only path
    await waitFor(() => expect(getBookStateMock.mock.calls.length).toBe(callsBefore + 1));
    expect(getBookStateMock).toHaveBeenLastCalledWith('bA');
    await waitFor(() => expect(store.getState().revisions.pending.map((p) => p.id)).toEqual(['back']));
  });

  it('sequence guard — a slow reopen read on a legacy book does not erase the entry the user just recorded', async () => {
    getBookStateMock.mockResolvedValue(bookStateFor('b1', revState('b1', null, 0, [])));
    const store = makeStore();
    openAt(store, 'b1');
    renderLayoutAt(store, 'b1');
    await waitFor(() => expect(store.getState().manuscript.bookId).toBe('b1'));
    let resolveRead!: (v: unknown) => void;
    getBookStateMock.mockReturnValueOnce(new Promise((r) => (resolveRead = r)));
    act(() => { store.dispatch(uiActions.goHome()); });
    openAt(store, 'b1');
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(2)); // read in flight, carrying the pre-op seq
    act(() => { store.dispatch(revisionsActions.applyServerState(revState('b1', F1, 1, ['recorded']))); }); // the op lands first
    await act(async () => { resolveRead(bookStateFor('b1', revState('b1', null, 0, []))); }); // the stale snapshot lands after
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(store.getState().revisions.fileId).toBe(F1);
    expect(store.getState().revisions.pending.map((p) => p.id)).toEqual(['recorded']);
  });

  it('OD2 — an unreadable revisions.json toasts the server sentence once per book per session', async () => {
    const msg = "This book's A/B review history couldn't be read, so its pending reviews aren't shown.";
    getBookStateMock.mockResolvedValue(bookStateFor('b9', null, { revisionsError: msg }));
    const store = makeStore();
    openAt(store, 'b9');
    renderLayoutAt(store, 'b9');
    await waitFor(() => expect(store.getState().notifications.toasts.map((t) => t.message)).toEqual([msg]));
    act(() => { store.dispatch(notificationsActions.dismissByKey('revisions-unreadable-b9')); });
    act(() => { store.dispatch(uiActions.goHome()); });
    openAt(store, 'b9');
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(store.getState().notifications.toasts).toEqual([]);
  });

  it('OD2 — a newer-schema file toasts its own upgrade sentence', async () => {
    const upgrade = 'revisions.json declares schema=99 but this server only understands up to schema=1. Refusing to read it — upgrade the server before editing this book.';
    getBookStateMock.mockResolvedValue(bookStateFor('b8', null, { revisionsError: upgrade }));
    const store = makeStore();
    openAt(store, 'b8');
    renderLayoutAt(store, 'b8');
    await waitFor(() => expect(store.getState().notifications.toasts.map((t) => t.message)).toEqual([upgrade]));
  });

  it("book B never shows book A's pending in the rendered UI (selector scoping)", async () => {
    getBookStateMock.mockImplementation(async (id: string) => bookStateFor(id, revState(id, F1, 1, id === 'bA' ? ['a-take'] : [])));
    const store = makeStore();
    openAt(store, 'bA');
    renderLayoutAt(store, 'bA');
    fireEvent.click(await screen.findByTestId('status-pill'));
    await waitFor(() => expect(within(screen.getByTestId('status-popover-revisions')).getByText(/1 revision pending/)).toBeInTheDocument());
    openAt(store, 'bB'); // the cache still holds bA's entry until bB's hydrate lands
    /* Open the popover if it is not already open (clicking an open one would close it).
       With the scoped selector bB has no pending, so the pill may not render at all. */
    const pill = screen.queryByTestId('status-pill');
    if (pill && !screen.queryByTestId('status-popover-revisions')) fireEvent.click(pill);
    expect(screen.queryByText(/revisions? pending/)).toBeNull();
  });
});

/* #3395 pass 5, minor c (kept — full-load path) — the failed-read notice
   belongs to the book whose read failed; leaving that book must take the
   notice with it. Adapted to `bookStateFor`: the rest of the describe block
   this test came from (#3395 pass 3, R1/R1b/R2 — the revisions persistence
   races) pinned the pre-cutover per-book hydrate machinery this task
   deletes from the layout effect; those cases are
   replaced by the revisions-slice cache tests (Task 12) and the thunk tests
   (Task 14). This one test exercises the FULL-LOAD retry/notice path, which
   Task 18 keeps unchanged (OD3). */
describe('Layout — full-load hydrate failure notice (#3395 pass 5, minor c)', () => {
  it('the failed-read notice is dismissed when the user moves on to another book', async () => {
    getBookStateMock.mockImplementation(async (id: string) => {
      if (id === 'book-A') throw new Error('disk error');
      return bookStateFor(id, revState(id, null, 0, []));
    });
    const store = makeStore();
    openAt(store, 'book-A');
    renderLayoutAt(store, 'book-A');
    const failedToast = () =>
      store.getState().notifications.toasts.find((t) => t.dedupeKey === 'revisions-hydrate-failed');
    await waitFor(() => expect(failedToast()).toBeDefined());

    openAt(store, 'book-B');
    await waitFor(() => expect(store.getState().manuscript.bookId).toBe('book-B'));
    expect(failedToast()).toBeUndefined();
  });
});

/* Task 6 (fix round 1, finding 2) — the first-load library-hydrate dispatcher
   (the .catch() on api.getLibrary() in Layout's own mount effect) had zero
   coverage. Typecheck can't substitute: `status` is optional on the
   hydrateError payload, so `{ message }` alone compiles fine even if the
   `status: e instanceof ApiError ? e.status : undefined` line were deleted
   outright. Only a runtime assertion on the dispatched payload closes that
   gap. */
describe('Layout — first-load library hydrate carries the ApiError status (task-6)', () => {
  it('dispatches hydrateError with status: 401 when getLibrary rejects with an ApiError', async () => {
    vi.mocked(api.getLibrary).mockRejectedValueOnce(new ApiError('nope', 401));

    const store = makeStore();
    /* The 'books' stage, no :bookId — sidesteps the separate per-book
       getBookState hydration path (unrelated to this test, and
       getBookStateMock is .mockReset() in the top-level beforeEach so it has
       no implementation here) and keeps this test scoped to Layout's own
       first-load library-hydrate effect. */
    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books']}>
          <Routes>
            <Route path="/books" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    await waitFor(() => {
      // fromServer: false — #2278 review round 3, Finding 3 threaded a third
      // field through this same dispatch; `new ApiError('nope', 401)` above
      // never went through apiErrorFromResponse, so it defaults false.
      expect(store.getState().library.error).toEqual({ message: 'nope', status: 401, fromServer: false });
    });
  });
});

/* Pairs with #2023 (docs/testing/fs38-wave3-onbox-acceptance.md §5 Section C,
   C-05) — the orphaned-characterId fallback banner's whole hydrate seam had
   ZERO coverage: deleting `dispatch(castActions.setOrphanedCharacterFallbacks(…))`
   from layout.tsx's getBookState handler left all 4492 frontend tests AND the
   new e2e spec green, because the e2e spec dispatches the reducer directly
   (bypassing layout — see its own corrected comment) and no unit test ever
   drove layout's own hydrate path for this field. This is that missing case. */
describe('Layout — per-book hydration: orphaned-characterId fallback banner (#2023)', () => {
  it('dispatches castActions.setOrphanedCharacterFallbacks from a getBookState response', async () => {
    getBookStateMock.mockResolvedValue({
      state: {
        bookId: 'b1',
        manuscriptId: 'mns_test',
        title: 'the Coalfall Commission',
        author: 'Della Renwick',
        series: 'Standalones',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters: [],
        coverGradient: ['#3C194F', '#0F0E0D'],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      cast: {
        characters: [
          { id: 'narrator', name: 'Narrator', role: 'Third-person observer', color: 'narrator' },
        ],
      },
      manuscript: { wordCount: 0, format: 'plaintext' },
      manuscriptEdits: null,
      revisions: null,
      completedSlugs: [],
      chapterCharacters: {},
      changeLog: null,
      orphanedCharacterFallbacks: {
        mayrin: {
          characterId: 'narrator',
          voiceName: 'qwen-lib-narrator-clone',
          resolution: 'unresolved',
          segments: 1,
        },
      },
    });

    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books/b1/cast']}>
          <Routes>
            <Route path="/books/:bookId/cast" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    await waitFor(() => {
      expect(getBookStateMock).toHaveBeenCalledWith('b1');
    });

    /* The field this whole feature exists to surface — asserted against the
       real reducer's state shape, not a spy on the dispatch call, so this
       fails exactly the way the deleted-line mutation should: red when the
       dispatch is missing, green when it's there. */
    await waitFor(() => {
      expect(store.getState().cast.orphanedCharacterFallbacks).toEqual({
        mayrin: {
          characterId: 'narrator',
          voiceName: 'qwen-lib-narrator-clone',
          resolution: 'unresolved',
          segments: 1,
        },
      });
    });
  });
});

/* Pairs with docs/features/archive/91-cast-drift-consolidation.md — the multi-book
   drift modal's BOOK header must resolve titles through a saved → library
   → bookId chain so cross-book groups (book never opened this session, so
   bookMeta.saved is empty) don't fall back to the raw workspace slug. */
describe('Layout — drift modal book-title fallback (plan 91)', () => {
  function makeLibraryBook(over: Partial<LibraryBook> & Pick<LibraryBook, 'bookId' | 'title'>): LibraryBook {
    return {
      author: 'Della Renwick',
      series: 'The Hollow Tide',
      seriesPosition: 1,
      isStandalone: false,
      status: 'complete',
      chapterCount: 1,
      completedChapters: 1,
      characterCount: 1,
      voiceCount: 1,
      lastWorkedOn: 'today',
      coverGradient: ['#000', '#fff'],
      tags: [],
      ...over,
    } as LibraryBook;
  }

  function makeDriftEvent(over: Partial<DriftEvent> & Pick<DriftEvent, 'id' | 'bookId'>): DriftEvent {
    return {
      characterId: 'eliza',
      chapterId: 1,
      chapterTitle: 'Chapter 1',
      severity: 'severe',
      factor: 'voice',
      factorLabel: 'Voice',
      description: 'Voice changed.',
      autoQueueable: true,
      detected: '2026-01-01T00:00:00Z',
      suggestedAction: 'regenerate_chapter',
      snapshot: { voiceId: 'old', tone: { warmth: 40, pace: 50 }, attributes: [] },
      current: { voiceId: 'new', tone: { warmth: 40, pace: 50 }, attributes: [] },
      ...over,
    } as DriftEvent;
  }

  it('falls through bookMeta.saved → library.books → bookId for the BOOK header, scoped to the active book by default', async () => {
    const store = makeStore();
    /* Landing on a book (via openBook) fires the per-book disk hydrate
       effect for book-A-slug; this test doesn't care about
       manuscript/cast state, so resolve to "nothing persisted" rather
       than wiring up a matching manuscript hydrate like the other
       openBook-driven tests in this file do. */
    getBookStateMock.mockResolvedValue(null);

    /* Two-book seed, same series: book-A has BOTH bookMeta.saved AND
       library.books; book-B has ONLY library.books. The fallback is what
       surfaces the clean "The Ebb" title for book-B once the Series
       toggle brings it into view; before the fallback fix, book-B's
       header rendered the raw "book-B-slug" string. */
    const library: LibraryResponse = {
      authors: [
        {
          name: 'Della Renwick',
          series: [
            {
              name: 'The Hollow Tide',
              books: [
                makeLibraryBook({ bookId: 'book-A-slug', title: 'Library title — The Hollow Tide' }),
                makeLibraryBook({ bookId: 'book-B-slug', title: 'The Ebb' }),
              ],
            },
          ],
        },
      ],
    };
    store.dispatch(librarySlice.actions.hydrate(library));

    /* book-A has a saved-meta entry with a distinct title so we can
       assert saved beats library (the priority chain's first step). */
    store.dispatch(
      bookMetaActions.hydrateFromBookState({
        bookId: 'book-A-slug',
        state: { title: 'Saved title — The Hollow Tide', author: 'Della Renwick', series: 'the Hollow Tide' },
      }),
    );

    /* One drift event per book, each carrying its own bookId so the
       selector buckets them into two book entries. Each book section
       in drift-report.tsx always renders a BOOK header (PR #165), so
       both `view.bookTitle` values must resolve correctly via the
       saved → library → bookId priority chain — but only once the user
       expands scope to the series; book-A is the only book on screen by
       default (fixes the "375 chapters across 10 books" hang). */
    store.dispatch(
      revisionsActions.applyBackgroundPoll({
        bookId: 'book-A-slug',
        drift: [makeDriftEvent({ id: 'drift:book-A-slug:1:eliza:voice', bookId: 'book-A-slug' })],
      }),
    );
    store.dispatch(
      revisionsActions.applyBackgroundPoll({
        bookId: 'book-B-slug',
        drift: [makeDriftEvent({ id: 'drift:book-B-slug:1:eliza:voice', bookId: 'book-B-slug' })],
      }),
    );

    /* Land on book-A as the active book so the default "book" scope has
       something concrete to scope to. Deliberately 'confirm' (cast_pending)
       rather than 'ready' — the 'ready'-only 30s active-book poll effect
       would otherwise immediately fire pollRevisions({bookId: 'book-A-slug'})
       against the file's default empty mock and wipe the drift event this
       test just seeded via its own per-book replace semantics. */
    store.dispatch(uiActions.openBook({ id: 'book-A-slug', status: 'cast_pending' }));
    store.dispatch(uiActions.setShowDriftReport(true));

    const { findByText, queryByText, findByTestId } = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    /* Default scope: only the active book (book-A) renders. Saved meta
       wins over the library entry for its title. */
    expect(await findByText('Saved title — The Hollow Tide')).toBeTruthy();
    expect(queryByText('The Ebb')).toBeNull();
    /* The library entry's "Library title — The Hollow Tide" must NOT win for
       book-A as the drift modal's BOOK section heading; the saved-meta
       short-circuit guards against a regression that flipped the priority
       order. Scoped to the heading role (not plain queryByText) because
       the top-bar breadcrumb for the now-active book-A-slug legitimately
       renders that same library title elsewhere on the page. */
    expect(
      screen.queryByRole('heading', { level: 4, name: 'Library title — The Hollow Tide' }),
    ).toBeNull();

    /* Expanding to the series brings book-B into view — its title
       resolves through library.books since it has no saved meta. */
    fireEvent.click(await findByTestId('drift-report-scope-series'));
    expect(await findByText('The Ebb')).toBeTruthy();
    /* Neither raw bookId leaks into the modal as a title. */
    expect(queryByText('book-A-slug')).toBeNull();
    expect(queryByText('book-B-slug')).toBeNull();
  });
});

describe('Layout — global TTS pills: per-character Qwen (plan 108)', () => {
  /* Renders Layout at the confirm stage (where showGlobalTtsPill is true)
     with a cast that contains a Qwen-pinned character. The TTS model-control
     pills live in the Status popover, so the test opens it (clicking the
     Status pill pins it open) and asserts a Qwen ModelControlPill (aria-label
     "Qwen <state>") renders inside it alongside the default Kokoro pill —
     proving selectEnginesInUse's per-character signal drives the pill render.
     /health is mocked unreachable so the pill resolves to "Qwen unreachable". */
  it('renders the Qwen pill when a cast character is pinned to ttsEngine="qwen"', async () => {
    getBookStateMock.mockResolvedValue({
      state: {
        bookId: 'b1',
        manuscriptId: 'mns_test',
        title: 'the Coalfall Commission',
        author: 'Della Renwick',
        series: 'Standalones',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: false,
        chapters: [],
        coverGradient: ['#3C194F', '#0F0E0D'],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      cast: {
        characters: [
          { id: 'narrator', name: 'Narrator', role: 'Observer', color: 'narrator' },
          { id: 'halloran', name: 'Captain Halloran', role: 'Captain', color: 'halloran', ttsEngine: 'qwen' },
        ],
      },
      manuscript: { wordCount: 0, format: 'plaintext' },
      manuscriptEdits: null,
      revisions: null,
      completedSlugs: [],
      chapterCharacters: {},
      changeLog: null,
    });

    const store = makeStore();
    /* The Qwen pill rides the per-character override; the account default
       (whatever it hydrates to) drives a separate engine pill we don't
       assert on here. */
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));

    const { findByRole, findByTestId } = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books/b1/cast']}>
          <Routes>
            <Route path="/books/:bookId/cast" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    /* Open the Status popover — the TTS controls live inside it.
       The Qwen pill then renders once the cast hydrates from getBookState.
       Note: a sibling "Qwen 1.7B" pill also renders (fs-55); use a strict
       name match to select only the 0.6B-Base pill here. */
    fireEvent.click(await findByTestId('status-pill'));
    const qwenPill = await findByRole('group', { name: /^Qwen\s+(ready|idle|loading|unreachable)$/i });
    expect(qwenPill).toBeTruthy();
  });
});

describe('Layout — Export status pill (fs-54)', () => {
  it('shows the Export pill with a running count when a non-terminal job exists for any book', async () => {
    const store = makeStore();
    store.dispatch(
      exportsActions.exportStarted({
        id: 'exp_1',
        bookId: 'b1',
        format: 'mp3-zip',
        destination: 'download',
        status: 'in_progress',
        filename: 'Test.zip',
        sizeBytes: null,
        progress: 0.5,
        downloadUrl: null,
        syncPath: null,
        errorReason: null,
        createdAt: '2026-01-01T00:00:00Z',
        completedAt: null,
      }),
    );

    const { findByTestId } = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books']}>
          <Routes>
            <Route path="/books" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    fireEvent.click(await findByTestId('status-pill'));
    const pill = await findByTestId('export-pill');
    expect(pill).toHaveTextContent('Exporting');
    expect(pill).toHaveTextContent('1 running');
    expect(pill).toHaveTextContent('50%');
  });

  it('keeps the Export pill visible via the linger union after the job goes done', async () => {
    const store = makeStore();
    store.dispatch(
      exportsActions.exportLingerSet({ bookId: 'b1', state: 'done' }),
    );

    const { findByTestId } = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books']}>
          <Routes>
            <Route path="/books" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    fireEvent.click(await findByTestId('status-pill'));
    const pill = await findByTestId('export-pill');
    expect(pill).toHaveTextContent('Export done');
  });

  it('shows no Export pill in the popover when there are no jobs and no linger entry', async () => {
    /* Pin the default engine deterministically (same precedent as "Layout —
       default-engine TTS pill reachable without an open book") so the
       Status pill is guaranteed present regardless of account-hydration
       timing — this test asserts on the Export section specifically, not
       on whether the Status pill itself renders (that's a pre-existing,
       unrelated concern). */
    const store = makeStore();
    store.dispatch(accountSlice.actions.setDefaultTtsModelKey('kokoro-v1'));

    const { findByTestId } = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books']}>
          <Routes>
            <Route path="/books" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    fireEvent.click(await findByTestId('status-pill'));
    expect(screen.queryByTestId('export-pill')).toBeNull();
    expect(await findByTestId('status-popover-export')).toHaveTextContent('Nothing exporting.');
  });
});

describe('Layout — Design status pill percent excludes failures (issue: "0/16 · 94%")', () => {
  it('does not inflate percent when every processed character has failed', async () => {
    const store = makeStore();
    store.dispatch(
      castDesignSlice.actions.begin({
        bookId: 'b1',
        total: 16,
        currentName: 'Narrator',
        lastTickAt: Date.parse('2026-01-01T00:00:00Z'),
      }),
    );
    for (let i = 0; i < 15; i += 1) {
      store.dispatch(
        castDesignSlice.actions.charFailed({
          bookId: 'b1',
          characterId: `char_${i}`,
          name: `Char ${i}`,
          error: 'GPU is out of memory — likely another job is using it.',
          lastTickAt: Date.parse('2026-01-01T00:00:00Z'),
        }),
      );
    }

    const { findByTestId } = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books']}>
          <Routes>
            <Route path="/books" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    fireEvent.click(await findByTestId('status-pill'));
    const pill = await findByTestId('design-pill');
    expect(pill).toHaveTextContent('0/16');
    expect(pill).toHaveTextContent('15 failed');
    /* The bug: this used to read "94%" (15 failures / 16 counted as
       "progress"). Failures no longer count toward percent. */
    expect(pill).not.toHaveTextContent('94%');
    expect(pill).toHaveTextContent('0%');
  });
});

describe('Layout — default-engine TTS pill reachable without an open book', () => {
  /* The default/primary engine's Load/Stop pill must be reachable on book-less
     views (Books home) so the model can be pre-loaded right after launch. The
     per-character Qwen pill, by contrast, stays gated behind an open book. */
  it('shows the default Kokoro pill in the Status popover on the Books view (no book open)', async () => {
    const store = makeStore();
    /* Pin the default engine deterministically (the account slice seeds this,
       but make the test independent of hydration). Stay on the initial
       'books' stage — no openBook dispatch. */
    store.dispatch(accountSlice.actions.setDefaultTtsModelKey('kokoro-v1'));

    const { findByTestId, findByRole, queryByText } = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    /* The Status pill renders even with no book in scope because a default
       TTS control is now available; open it to reach the TTS section. */
    fireEvent.click(await findByTestId('status-pill'));
    expect(await findByRole('group', { name: /^Kokoro / })).toBeTruthy();
    /* The dead-end fallback must NOT render — the control is reachable. */
    expect(queryByText(/TTS controls appear once a manuscript is open/i)).toBeNull();
  });

  it('keeps the per-character Qwen pill gated behind an open book', async () => {
    const store = makeStore();
    store.dispatch(accountSlice.actions.setDefaultTtsModelKey('kokoro-v1'));
    /* A Qwen-pinned character exists in the cast slice, but we're on the
       book-less 'books' stage — the Qwen pill (a per-character signal) must
       stay hidden while the default Kokoro pill still shows. */
    store.dispatch(
      castSlice.actions.setCharacters([
        { id: 'narrator', name: 'Narrator', role: 'Observer', color: 'narrator' },
        { id: 'halloran', name: 'Halloran', role: 'Captain', color: 'halloran', ttsEngine: 'qwen' },
      ] as never),
    );

    const { findByTestId, findByRole, queryByRole } = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    fireEvent.click(await findByTestId('status-pill'));
    expect(await findByRole('group', { name: /^Kokoro / })).toBeTruthy();
    expect(queryByRole('group', { name: /^Qwen / })).toBeNull();
  });
});

describe('Layout — suppresses the TTS pill Retry only for an actionable sidecar diagnosis', () => {
  /* Task 15 code-review finding: the `suppressUnreachableSidecarAction`
     branch in layout.tsx (`cause !== 'unreachable-transient'`) had zero
     test coverage anywhere — ModelControlPill.test.tsx only pins the
     generic prop mechanically, and status-popover.test.tsx's own
     "suppression" test explicitly punts verification here. These two
     cases exercise the real caller-side decision: a specific, actionable
     sidecar cause (e.g. venv-missing) hides the Kokoro pill's Retry
     button (its own Status-popover diagnosis block is the affordance
     instead); a merely-transient "still booting" cause leaves Retry as
     the only affordance, so it must stay visible. getSidecarHealth
     (mocked at the top of this file) always resolves 'unreachable', which
     is the precondition for Retry to even be a question — see
     ModelControlPill's `hideButton = state === 'unreachable' &&
     suppressUnreachableAction`. */
  const DIAGNOSIS_MESSAGE = 'sidecar test diagnosis message';

  function readinessWithSidecarCause(cause: 'venv-missing' | 'unreachable-transient') {
    /* `ready: true` here is a deliberate test-fixture simplification: the
       real server computes `ready` as AND-of-all-blockers (a genuine sidecar
       fail would also flip this false and redirect to /setup — a separate,
       already-covered concern). Forcing it true keeps this test isolated to
       the Retry-suppression branch under test, without the redirect
       side-effect unmounting Layout (this test's <Routes> only declares
       "/"). */
    return {
      ready: true,
      completedAt: '2026-06-12T00:00:00.000Z',
      blockers: {
        sidecar: { status: 'fail' as const, cause, message: DIAGNOSIS_MESSAGE, remediation: 'x' },
        ffmpeg: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        tts: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        analyzer: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
      },
      info: { gpu: 'cuda · 1.2 / 8.0 GB reserved' },
    };
  }

  async function renderWithSidecarCause(cause: 'venv-missing' | 'unreachable-transient') {
    /* Two api.getSetupReadiness() call sites fire on a Layout mount —
       Layout's own boot-splash probe (layout.tsx) and useSetupDiagnosis's
       fetchNow (use-setup-diagnosis.ts) — so queue the override for both;
       any later test's calls fall back to the mock factory's default
       (all-pass) resolution once this queue drains. */
    vi.mocked(api.getSetupReadiness).mockResolvedValueOnce(readinessWithSidecarCause(cause) as never);
    vi.mocked(api.getSetupReadiness).mockResolvedValueOnce(readinessWithSidecarCause(cause) as never);

    const store = makeStore();
    store.dispatch(accountSlice.actions.setDefaultTtsModelKey('kokoro-v1'));

    const { findByTestId, findByRole, findByText } = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    fireEvent.click(await findByTestId('status-pill'));
    const kokoroPill = await findByRole('group', { name: /^Kokoro / });
    /* Pin the precondition: the pill must actually be in the 'unreachable'
       state (driven by the top-of-file getSidecarHealth mock) before the
       Retry-button assertion below means anything. */
    await waitFor(() => {
      expect(kokoroPill.getAttribute('aria-label')).toMatch(/unreachable/i);
    });
    /* Also wait for the sidecar DiagnosisBlock's own message to have
       rendered — proof that `setupReadiness` (the async getSetupReadiness
       resolution, a separate race from the sidecar-health poll above) has
       landed before asserting on the Retry button either way. Without this,
       the "keeps Retry visible" case could pass for the wrong reason (the
       assertion running before readiness resolves, when suppression is
       still false by default regardless of cause). */
    await findByText(DIAGNOSIS_MESSAGE);
    return kokoroPill;
  }

  it('hides the Kokoro pill Retry button when the sidecar diagnosis has an actionable cause', async () => {
    const kokoroPill = await renderWithSidecarCause('venv-missing');
    await waitFor(() => {
      expect(within(kokoroPill).queryByRole('button', { name: /retry/i })).toBeNull();
    });
  });

  it('keeps the Kokoro pill Retry button visible when the sidecar diagnosis is merely transient', async () => {
    const kokoroPill = await renderWithSidecarCause('unreachable-transient');
    expect(within(kokoroPill).queryByRole('button', { name: /retry/i })).not.toBeNull();
  });
});

describe('Layout — voices re-hydrate as generation renders chapters', () => {
  /* Regression: a bespoke Qwen voice's `generated` flag (cast Status column:
     "Designed" vs "Generated") is derived server-side from rendered segments.
     The voice library only re-hydrated on book/engine/stage change, so a voice
     generated while the user sat on the cast view stayed "Designed" until they
     navigated away and back. The hydrate effect now also keys off the
     completed-chapter count across active streams, so each rendered chapter
     re-fetches the library. */
  it('re-fetches getVoices when an active stream advances its done count', async () => {
    getBookStateMock.mockResolvedValue({
      state: {
        bookId: 'b1',
        manuscriptId: 'mns_test',
        title: 'the Coalfall Commission',
        author: 'Della Renwick',
        series: 'Standalones',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters: [],
        coverGradient: ['#3C194F', '#0F0E0D'],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      cast: { characters: [] },
      manuscript: { wordCount: 0, format: 'plaintext' },
      manuscriptEdits: null,
      revisions: null,
    });

    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books/b1/cast']}>
          <Routes>
            <Route path="/books/:bookId/cast" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    const getVoices = vi.mocked(api.getVoices);
    await waitFor(() => expect(getVoices).toHaveBeenCalled());
    const callsAfterMount = getVoices.mock.calls.length;

    /* A chapter finished rendering for this book — the stream's done count
       climbs from 0 to 1. */
    act(() => {
      store.dispatch(
        chaptersSlice.actions.setActiveStream({
          streamKey: 'b1::1',
          bookId: 'b1',
          chapterId: 1,
          modelKey: 'qwen3-tts-0.6b',
          done: 1,
          total: 5,
          inProgress: 1,
          lastTickAt: null,
          halted: false,
        }),
      );
    });

    await waitFor(() => {
      expect(getVoices.mock.calls.length).toBeGreaterThan(callsAfterMount);
    });

    /* A second chapter completes — done climbs to 2, refetching again so the
       table keeps pace with generation. */
    const callsAfterFirstChapter = getVoices.mock.calls.length;
    act(() => {
      store.dispatch(
        chaptersSlice.actions.updateActiveStreamProgress({ streamKey: 'b1::1', done: 2 }),
      );
    });
    await waitFor(() => {
      expect(getVoices.mock.calls.length).toBeGreaterThan(callsAfterFirstChapter);
    });
  });
});

/* Task 4 (fs-15 / #952) — auto-finish dispatch+POST on reaching the final
   listenable chapter.
   "Final listenable" = last chapter with !excluded && state==='done' && parsedDuration>0.
   When Layout passes onCrossedFinish to MiniPlayer and the currently-loaded
   chapter IS that final chapter, it must:
     1. dispatch(continueListeningSlice.dismiss(bookId))   → dismissedIds grows
     2. call api.setShelfStatus(bookId, {finished:true})   → POST fires once
   When the chapter is NOT the final listenable chapter, NEITHER should happen. */
describe('Layout — auto-finish on reaching the final listenable chapter (Task 4 / fs-15)', () => {
  /* A chapter shape satisfying the "done + duration > 0 + !excluded" predicate. */
  function doneChapter(id: number, durationStr: string, over?: Partial<Chapter>): Chapter {
    return {
      id,
      title: `Chapter ${id}`,
      duration: durationStr,
      state: 'done',
      progress: 1,
      characters: {},
      ...over,
    } as Chapter;
  }

  /* A minimal BookStateResponse so Layout's per-book hydration resolves cleanly. */
  function bookStatePayload(chapters: Chapter[]) {
    return {
      state: {
        bookId: 'b1',
        manuscriptId: 'mns1',
        title: 'Test Book',
        author: 'Author',
        series: null,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters,
        coverGradient: ['#000', '#fff'],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      cast: { characters: [] },
      manuscript: { wordCount: 0, format: 'plaintext' },
      manuscriptEdits: null,
      revisions: null,
      completedSlugs: [],
      chapterCharacters: {},
      changeLog: null,
    };
  }

  async function fireAudioEvents(audioEl: HTMLAudioElement, currentTimeSec: number, durationSec: number) {
    /* Seed the native duration so onLoadedMetadata and onTimeUpdate both see it. */
    Object.defineProperty(audioEl, 'duration', { configurable: true, value: durationSec });
    /* Fire loadedmetadata first so MiniPlayer's handler sets audio.durationSec. */
    await act(async () => {
      audioEl.dispatchEvent(new Event('loadedmetadata'));
    });
    /* Now seed currentTime and fire timeupdate — the finish-tail check
       reads e.currentTarget.duration (= durationSec) and e.currentTarget.currentTime (= currentTimeSec). */
    Object.defineProperty(audioEl, 'currentTime', { configurable: true, writable: true, value: currentTimeSec });
    await act(async () => {
      audioEl.dispatchEvent(new Event('timeupdate'));
    });
  }

  beforeEach(() => {
    HTMLMediaElement.prototype.load = vi.fn();
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    vi.mocked(api.setShelfStatus).mockReset();
    vi.mocked(api.setShelfStatus).mockResolvedValue({
      chapterId: 1,
      currentSec: 0,
      updatedAt: new Date().toISOString(),
    } as never);
    vi.mocked(api.getChapterAudio).mockResolvedValue({
      url: '/api/books/b1/chapters/1/audio.mp3',
      durationSec: 600,
      peaks: [],
      sampleRate: 44100,
      segments: [],
    } as never);
  });

  it('dispatches dismiss and calls setShelfStatus({finished:true}) when the FINAL listenable chapter enters its tail', async () => {
    /* Two done chapters; chapter 2 is the final listenable. */
    const chapters = [doneChapter(1, '10:00'), doneChapter(2, '10:00')];

    /* Stub getBookState to return a payload whose completedSlugs marks both
       chapters done. The slug format mirrors what the server generates:
       `${id-padded}-${slugified-title}`. hydrateFromBookState checks
       completedSlugs against c.slug on the raw chapter object. */
    getBookStateMock.mockResolvedValue({
      ...bookStatePayload(chapters),
      completedSlugs: ['01-chapter-1', '02-chapter-2'],
      state: {
        ...bookStatePayload(chapters).state,
        chapters: chapters.map((c) => ({
          id: c.id,
          title: c.title,
          slug: c.id === 1 ? '01-chapter-1' : '02-chapter-2',
          duration: c.duration,
          generationState: 'done',
        })),
      },
    });

    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_confirmed' }));

    const { container } = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books/b1/listen']}>
          <Routes>
            <Route path="/books/:bookId/listen" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    /* Wait for chapters to hydrate from getBookState and both become 'done'. */
    await waitFor(() => {
      const chs = store.getState().chapters.chapters;
      expect(chs.length).toBe(2);
      expect(chs.every((c) => c.state === 'done')).toBe(true);
    });

    /* Set the current track to the FINAL chapter (id=2) AFTER hydration. */
    act(() => {
      store.dispatch(uiActions.setCurrentTrack(2));
    });

    /* MiniPlayer should now render and its <audio> element should be in the DOM. */
    let audioElOrNull: HTMLAudioElement | null = null;
    await waitFor(() => {
      audioElOrNull = container.querySelector('audio');
      expect(audioElOrNull).not.toBeNull();
    });
    const audioEl = audioElOrNull!;

    /* Fire a timeUpdate with remaining <= 10 s (591 out of 600). */
    await fireAudioEvents(audioEl, 591, 600);

    await waitFor(() => {
      expect(vi.mocked(api.setShelfStatus)).toHaveBeenCalledWith('b1', { finished: true });
    });

    /* dismiss also landed in the slice. */
    expect(store.getState().continueListening.dismissedIds).toContain('b1');
  });

  it('does NOT dispatch dismiss or call setShelfStatus on a NON-final chapter', async () => {
    const chapters = [doneChapter(1, '10:00'), doneChapter(2, '10:00')];

    getBookStateMock.mockResolvedValue({
      ...bookStatePayload(chapters),
      completedSlugs: ['01-chapter-1', '02-chapter-2'],
      state: {
        ...bookStatePayload(chapters).state,
        chapters: chapters.map((c) => ({
          id: c.id,
          title: c.title,
          slug: c.id === 1 ? '01-chapter-1' : '02-chapter-2',
          duration: c.duration,
          generationState: 'done',
        })),
      },
    });

    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_confirmed' }));

    const { container } = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books/b1/listen']}>
          <Routes>
            <Route path="/books/:bookId/listen" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    await waitFor(() => {
      const chs = store.getState().chapters.chapters;
      expect(chs.length).toBe(2);
      expect(chs.every((c) => c.state === 'done')).toBe(true);
    });

    /* Set current track to chapter 1 — NOT the final listenable (chapter 2 is). */
    act(() => {
      store.dispatch(uiActions.setCurrentTrack(1));
    });

    let audioElOrNull2: HTMLAudioElement | null = null;
    await waitFor(() => {
      audioElOrNull2 = container.querySelector('audio');
      expect(audioElOrNull2).not.toBeNull();
    });
    const audioEl2 = audioElOrNull2!;

    await fireAudioEvents(audioEl2, 591, 600);

    /* Nothing should fire for a non-final chapter. */
    await new Promise((r) => setTimeout(r, 50));
    expect(vi.mocked(api.setShelfStatus)).not.toHaveBeenCalled();
    expect(store.getState().continueListening.dismissedIds).not.toContain('b1');
  });
});

/* fe-47 — the tier modal's 1.7B guard used to carry its OWN inline
   "has a designed voice" check (`hasDesignedVoice`/`eligibleQwenMembers` in
   layout.tsx), a third parallel definition alongside the cast view's
   `needsVoiceIds` and fe-46's `selectUndesignedQwenCharacters`. This pins that
   the modal's eligibility now derives from that same shared selector: for a
   mixed cast (some designed, some not), the characters the modal actually
   applies the 1.7B pin to are exactly the complement of what
   `selectUndesignedQwenCharacters` reports as undesigned, and
   `selectVoiceReadinessGateShouldFire` agrees the cast isn't fully designed. */
describe('Layout — tier-modal 1.7B eligibility converges on the shared voice-readiness selector (fe-47)', () => {
  const mixedCast: Character[] = [
    { id: 'narrator', name: 'Narrator', role: 'Observer', color: 'narrator', lines: 0 } as Character,
    {
      id: 'overrideDesigned',
      name: 'Odessa',
      role: 'Lead',
      color: 'lead',
      lines: 10,
      ttsEngine: 'qwen',
      overrideTtsVoices: { qwen: { name: 'odessa-v1' } },
    } as Character,
    {
      id: 'linkedDesigned',
      name: 'Linh',
      role: 'Support',
      color: 'support',
      lines: 8,
      ttsEngine: 'qwen',
      voiceId: 'vid-linh',
    } as Character,
    {
      id: 'undesigned',
      name: 'Uma',
      role: 'Rival',
      color: 'rival',
      lines: 5,
      ttsEngine: 'qwen',
    } as Character,
  ];

  const libraryVoices: Voice[] = [
    {
      id: 'vid-linh',
      name: 'Linh',
      gradient: ['#111111', '#222222'],
      ttsVoice: { provider: 'qwen', name: 'linh-v1' },
    } as unknown as Voice,
  ];

  afterEach(() => {
    /* This describe block overrides three mocks shared with the rest of the
       file — restore their defaults so later tests aren't affected. */
    vi.mocked(api.getVoices).mockResolvedValue({ voices: [], dropped: [] } as never);
    vi.mocked(api.setCastTier).mockReset();
    vi.mocked(api.setCastTier).mockResolvedValue({ updated: 0 });
    vi.mocked(api.getSidecarHealth).mockResolvedValue({ status: 'unreachable', url: '(test)' });
  });

  it('pins the tier onto exactly the characters the shared selector marks as designed', async () => {
    /* This test clicks the 1.7B tier row (#1841 gates it on installed
       weights) — report the base as installed so the click isn't a no-op. */
    vi.mocked(api.getSidecarHealth).mockResolvedValue({
      status: 'reachable',
      url: '(test)',
      qwenBase17WeightsPresent: true,
    });

    getBookStateMock.mockResolvedValue({
      state: {
        bookId: 'b1',
        manuscriptId: 'mns_test',
        title: 'the Coalfall Commission',
        author: 'Della Renwick',
        series: 'Standalones',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: false,
        chapters: [],
        coverGradient: ['#3C194F', '#0F0E0D'],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      cast: { characters: mixedCast },
      manuscript: { wordCount: 0, format: 'plaintext' },
      manuscriptEdits: null,
      revisions: null,
      completedSlugs: [],
      chapterCharacters: {},
      changeLog: null,
    });
    vi.mocked(api.getVoices).mockResolvedValue({ voices: libraryVoices, dropped: [] } as never);
    vi.mocked(api.setCastTier).mockResolvedValue({ updated: 1 });

    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'complete' }));

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books']}>
          <Routes>
            <Route path="/books" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    await waitFor(() => {
      expect(store.getState().cast.characters.map((c) => c.id)).toContain('undesigned');
      expect(store.getState().voices.voices.map((v) => v.id)).toContain('vid-linh');
    });

    /* The shared selector's verdict: only 'undesigned' lacks a designed
       Qwen voice, and the readiness gate agrees the cast isn't fully ready. */
    const state = store.getState() as unknown as RootState;
    const undesigned = selectUndesignedQwenCharacters(state, 'b1');
    expect(undesigned.map((c) => c.id)).toEqual(['undesigned']);
    expect(selectVoiceReadinessGateShouldFire(state, 'b1')).toBe(true);

    act(() => {
      store.dispatch(uiActions.openStartGenPrompt());
    });

    fireEvent.click(await screen.findByTestId('start-gen-tier-qwen3-tts-1.7b'));
    fireEvent.click(screen.getByRole('button', { name: /Start generating/i }));

    /* No refusal toast — at least one Qwen member is eligible. */
    expect(screen.queryByText(/No Qwen voice has been designed yet/i)).toBeNull();

    /* Exactly the two DESIGNED members get the 1.7B pin — via their own id
       (no voiceId) or their linked voiceId — matching the selector's verdict
       above 1:1. The undesigned member is excluded. */
    await waitFor(() => expect(vi.mocked(api.setCastTier)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.setCastTier)).toHaveBeenCalledWith(
      'b1',
      'overrideDesigned',
      'qwen3-tts-1.7b',
    );
    expect(vi.mocked(api.setCastTier)).toHaveBeenCalledWith('b1', 'vid-linh', 'qwen3-tts-1.7b');
    expect(vi.mocked(api.setCastTier)).not.toHaveBeenCalledWith(
      'b1',
      'undesigned',
      'qwen3-tts-1.7b',
    );
  });
});

describe('Layout — analysis sub-stage runtime fields forward to the Status pill/popover (Task 11)', () => {
  /* Task 2 taught selectAnalysisSubstage to return model/engine/
     activityState/activitySince/fallbackActive; Task 10 taught the popover's
     SubstageRow to render them. This test pins the missing link: Layout must
     actually forward those five fields from the selector into both the
     summarizeStatus() input (compact-pill tone) and the StatusPopover prop
     (popover detail) — otherwise they're silently undefined at runtime even
     though every type along the chain compiles. */
  it('carries model/engine/activityState/fallbackActive from the prosody stream through to the compact pill tone and popover detail', async () => {
    const store = makeStore();
    store.dispatch(
      prosodySlice.actions.setActive({ bookId: 'b1', progress: 0.3, label: 'Detecting emotions' }),
    );
    store.dispatch(
      prosodySlice.actions.updateProgress({
        bookId: 'b1',
        progress: 0.3,
        model: 'gemma-4-31b-it',
        engine: 'gemini',
        activityState: 'streaming',
        fallbackActive: true,
        now: Date.now(),
      }),
    );

    const { findByTestId } = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books']}>
          <Routes>
            <Route path="/books" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    /* Compact pill: fallbackActive alone (independent of activityState)
       must flip the tone amber — proves summarizeStatus() received
       fallbackActive via layout.tsx's StatusInput.analysisSubstage object. */
    const pill = await findByTestId('status-pill');
    expect(pill).toHaveAttribute('data-status-tone', 'amber');

    /* Popover: model/engine/fallbackActive must reach StatusPopoverProps —
       proves layout.tsx's StatusDetail.analysisSubstage object carries them
       (not just percent/label/chapterIndex/totalChapters/estRemainingMs). */
    fireEvent.click(pill);
    expect(await findByTestId('substage-engine-model')).toHaveTextContent(/^Gemini ·/);
    expect(await findByTestId('substage-fallback-note')).toHaveTextContent(
      'Switched to Gemini — Ollama unreachable',
    );
  });
});

describe('Layout — analysis pill state derivation for needs-action (#3203)', () => {
  /* When an analysis halts with a non-failure code (cast_incomplete /
     stage1_shrink_refused), the analysis pill's state should be
     'needs-action', not 'halted'. This test drives a real analysisStream
     snapshot through Layout's pill-state derivation logic and asserts the
     correct state by checking the compact Status pill that reflects that state. */
  it('derives pillState as needs-action when runState is halted with cast_incomplete', async () => {
    const store = makeStore();
    store.dispatch(
      analysisSlice.actions.setActiveStream({
        bookId: 'b1',
        manuscriptId: 'mns_b1',
        state: 'halted',
        haltCode: 'cast_incomplete',
        haltReason: 'cast is incomplete',
        phaseId: 0,
        phaseLabel: 'Detecting characters',
        phaseProgress: 0.5,
        lastTickAt: Date.now(),
        remainingMs: null,
      }),
    );

    const { findByTestId } = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    /* The Status pill should have aria-label containing 'Needs action',
       proving the pill's state was derived as 'needs-action' by the
       layout logic (not 'halted'). */
    const pill = await findByTestId('status-pill');
    expect(pill.getAttribute('aria-label')).toMatch(/needs action/i);
  });

  it('derives pillState as needs-action when runState is halted with stage1_shrink_refused', async () => {
    const store = makeStore();
    store.dispatch(
      analysisSlice.actions.setActiveStream({
        bookId: 'b1',
        manuscriptId: 'mns_b1',
        state: 'halted',
        haltCode: 'stage1_shrink_refused',
        haltReason: 'cast shrunk from 10 → 2',
        phaseId: 1,
        phaseLabel: 'Attributing lines',
        phaseProgress: 0.3,
        lastTickAt: Date.now(),
        remainingMs: null,
      }),
    );

    const { findByTestId } = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    const pill = await findByTestId('status-pill');
    expect(pill.getAttribute('aria-label')).toMatch(/needs action/i);
  });
});

describe('Layout — resident-model Stop control in the global TTS notice banner (Task 10 / #1839)', () => {
  /* Kokoro is eagerly resident (PRELOAD_KOKORO). Before this task, its Stop
     control was reachable only via the Status popover (residency-gated, but
     hidden behind a click). That's exactly the moment
     a voice preview fails for capacity (Task 9's NoCapacityError names the
     model but has nothing to point the user at without this). The banner now
     renders a Stop control per resident engine, gated on
     ttsLifecycle.<engine>.state === 'ready' rather than enginesInUse — and
     unlike the pre-existing Status-popover pill (also residency-gated, but
     hidden until the user clicks the Status pill), this one is visible
     without any extra click. */
  it('offers a Stop control for a resident voice model outside the generation view', async () => {
    vi.mocked(api.getSidecarHealth).mockResolvedValue({
      status: 'reachable',
      url: '(test)',
      kokoroLoaded: true,
    });
    vi.mocked(api.unloadSidecar).mockClear();

    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    /* Found WITHOUT opening the Status popover (no click on status-pill) —
       that's the point: reachable directly, not behind a popover click. */
    const kokoroGroup = await screen.findByRole('group', { name: /^Kokoro ready$/i });
    fireEvent.click(within(kokoroGroup).getByRole('button', { name: /stop/i }));

    await waitFor(() => {
      expect(vi.mocked(api.unloadSidecar)).toHaveBeenCalledWith({ engine: 'kokoro' });
    });
  });

  it('shows no Stop control when nothing is resident', async () => {
    vi.mocked(api.getSidecarHealth).mockResolvedValue({
      status: 'reachable',
      url: '(test)',
      kokoroLoaded: false,
    });

    const { findByTestId } = render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    /* Settle the async health probe by opening the Status popover and
       confirming Kokoro resolved to 'idle' (its own pill's action there is
       "Load", not "Stop") — proves the negative assertion below isn't just
       a pre-hydration race. The default engine (kokoro-v1) keeps that pill
       reachable on this book-less view regardless of residency — a
       pre-existing, separate affordance from the banner control under test. */
    fireEvent.click(await findByTestId('status-pill'));
    await screen.findByRole('group', { name: /^Kokoro idle$/i });

    /* No Stop control anywhere on the page — neither the popover's own idle
       pill nor the new banner control, which only renders a Stop affordance
       when a resident engine's state is 'ready'. */
    expect(screen.queryByRole('button', { name: /^stop/i })).toBeNull();
  });
});

describe('Layout — settings-corruption banner (#3175 layer 3)', () => {
  it('renders the settings-corrupt alert when account.corruptSettingsFile is true', async () => {
    const store = makeStore();
    store.dispatch({ type: 'account/fetch/fulfilled', payload: { corruptSettingsFile: true } });

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    expect(await screen.findByText(/unreadable and has been reset to defaults/i)).toBeInTheDocument();
  });

  it('renders no alert when account.corruptSettingsFile is false', async () => {
    const store = makeStore();

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    await waitFor(() => {
      expect(screen.queryByText(/unreadable and has been reset to defaults/i)).toBeNull();
    });
  });
});

/* #3376 — the 120 s background bulk fan-out (Plan 83) polls every analysed
   NON-active book. Before the fix it dispatched `applyPoll` per book, so the
   polled book's `pending` (empty, or that other book's own list) replaced the
   ACTIVE book's disk-hydrated pending. It must now dispatch
   `applyBackgroundPoll`: drift merges per bookId, pending is never written. */
describe('Layout — background revisions poll keeps the active book pending (#3376)', () => {
  function makeBgLibraryBook(bookId: string): LibraryBook {
    return {
      bookId,
      title: `Book ${bookId}`,
      author: 'Della Renwick',
      series: 'The Hollow Tide',
      seriesPosition: 1,
      isStandalone: false,
      status: 'complete',
      chapterCount: 1,
      completedChapters: 1,
      characterCount: 1,
      voiceCount: 1,
      lastWorkedOn: 'today',
      coverGradient: ['#000', '#fff'],
      tags: [],
    } as LibraryBook;
  }

  it('active book pending survives a non-active book bulk poll tick', async () => {
    /* null = nothing persisted on disk, so the per-book hydrate effect
       early-returns and cannot touch the seeded pending. The route lands
       on the cast (confirm) stage, not 'ready', so the active 30 s poll
       effect stays silent too — same guards the other openBook-driven
       tests in this file rely on. */
    getBookStateMock.mockResolvedValue(null);
    /* book-B answers the bulk tick with an EMPTY pending (the exact shape
       that used to clobber) plus one drift event of its own. */
    pollRevisionsBulkMock.mockResolvedValue({
      byBookId: {
        'book-B-slug': {
          pending: [],
          drift: [
            {
              id: 'd-b2',
              bookId: 'book-B-slug',
              characterId: 'eliza',
              chapterId: 1,
              chapterTitle: 'Chapter 1',
              severity: 'severe',
              factor: 'voice',
            } as DriftEvent,
          ],
        },
      },
    });

    const store = makeStore();
    store.dispatch(
      librarySlice.actions.hydrate({
        authors: [
          {
            name: 'Della Renwick',
            series: [
              {
                name: 'The Hollow Tide',
                books: [makeBgLibraryBook('book-A-slug'), makeBgLibraryBook('book-B-slug')],
              },
            ],
          },
        ],
      } as LibraryResponse),
    );
    store.dispatch(uiActions.openBook({ id: 'book-A-slug', status: 'cast_pending' }));
    /* The active book's disk-hydrated pending — this is what must survive. */
    store.dispatch(
      revisionsActions.applyServerState(revState('book-A-slug', F1, 1, ['r-active'])),
    );

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books/book-A-slug/cast']}>
          <Routes>
            <Route path="/books/:bookId/cast" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    /* The background effect fetches immediately on mount, and book-A (the
       active book) must be excluded from the fan-out. */
    await waitFor(() => {
      expect(pollRevisionsBulkMock).toHaveBeenCalledWith({ bookIds: ['book-B-slug'] });
    });
    /* After the tick: book-B's drift merged in, and the active book's
       pending untouched. Under the old applyPoll dispatch the empty
       byBookId pending would have replaced ['r-active'] here. */
    await waitFor(() => {
      const s = store.getState();
      expect(s.revisions.drift.map((d) => d.id)).toContain('d-b2');
      expect(s.revisions.pending.map((r) => r.id)).toEqual(['r-active']);
    });
  });
});

describe('Layout — revisions polls (plan 286)', () => {
  function libraryOf(ids: string[]) {
    return {
      authors: [
        {
          name: 'Della Renwick',
          series: [
            {
              name: 'The Hollow Tide',
              books: ids.map((id) => ({
                bookId: id,
                title: `Book ${id}`,
                author: 'Della Renwick',
                series: 'The Hollow Tide',
                seriesPosition: 1,
                isStandalone: false,
                status: 'complete',
                chapterCount: 1,
                completedChapters: 1,
                characterCount: 1,
                voiceCount: 1,
                lastWorkedOn: 'today',
                coverGradient: ['#000', '#fff'],
                tags: [],
              })),
            },
          ],
        },
      ],
    } as unknown as LibraryResponse;
  }
  beforeEach(() => {
    _resetRevisionPollWarningsForTests();
  });
  async function noUnhandled(run: () => Promise<void>) {
    const seen: unknown[] = [];
    const on = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', on);
    try {
      await run();
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off('unhandledRejection', on);
    }
    expect(seen).toEqual([]);
  }

  it('a stale active poll (lower rev) does not clobber pending', async () => {
    getBookStateMock.mockResolvedValue(bookStateFor('b1', revState('b1', F1, 5, ['keep'])));
    pollRevisionsMock.mockResolvedValue({ ...revState('b1', F1, 4, []), drift: [] });
    pollRevisionsBulkMock.mockResolvedValue({ byBookId: {} });
    const store = makeStore();
    act(() => {
      store.dispatch({ type: 'ui/openBook', payload: { id: 'b1', status: 'complete' } });
    });
    renderLayoutAt(store, 'b1');
    await waitFor(() => expect(pollRevisionsMock).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(store.getState().revisions.pending.map((p) => p.id)).toEqual(['keep']);
  });
  it('a failing active poll is caught', async () => {
    getBookStateMock.mockResolvedValue(null);
    pollRevisionsMock.mockRejectedValue(new Error('500'));
    pollRevisionsBulkMock.mockResolvedValue({ byBookId: {} });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await noUnhandled(async () => {
      const store = makeStore();
      act(() => {
        store.dispatch({ type: 'ui/openBook', payload: { id: 'b1', status: 'complete' } });
      });
      renderLayoutAt(store, 'b1');
      await waitFor(() => expect(pollRevisionsMock).toHaveBeenCalled());
    });
    warn.mockRestore();
  });
  it('D9 — a failing bulk poll is caught', async () => {
    getBookStateMock.mockResolvedValue(null);
    pollRevisionsBulkMock.mockRejectedValue(new Error('500'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await noUnhandled(async () => {
      const store = makeStore();
      store.dispatch(librarySlice.actions.hydrate(libraryOf(['active', 'bg1'])));
      act(() => {
        store.dispatch({ type: 'ui/openBook', payload: { id: 'active', status: 'cast_pending' } });
      });
      renderLayoutAt(store, 'active');
      await waitFor(() => expect(pollRevisionsBulkMock).toHaveBeenCalled());
    });
    warn.mockRestore();
  });
  it('D9 — a partial byBookId with errors still applies the healthy books', async () => {
    getBookStateMock.mockResolvedValue(null);
    pollRevisionsBulkMock.mockResolvedValue({
      byBookId: {
        good: {
          pending: [],
          drift: [
            {
              id: 'g',
              bookId: 'good',
              characterId: 'eliza',
              chapterId: 1,
              chapterTitle: 'C1',
              severity: 'severe',
              factor: 'voice',
            },
          ],
        },
      },
      errors: { bad: "Couldn't read this book's review state." },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore();
    store.dispatch(librarySlice.actions.hydrate(libraryOf(['active', 'good', 'bad'])));
    act(() => {
      store.dispatch({ type: 'ui/openBook', payload: { id: 'active', status: 'cast_pending' } });
    });
    renderLayoutAt(store, 'active');
    await waitFor(() =>
      expect(store.getState().revisions.drift.map((d) => d.id)).toContain('g'),
    );
    expect(warn.mock.calls.some((c) => String(c[0]).includes('bad'))).toBe(true);
    warn.mockRestore();
  });
  it('more than 50 background books are polled in chunks of at most 50', async () => {
    getBookStateMock.mockResolvedValue(null);
    pollRevisionsBulkMock.mockResolvedValue({ byBookId: {} });
    const ids = Array.from({ length: 121 }, (_, i) => `bk${i}`);
    const store = makeStore();
    store.dispatch(librarySlice.actions.hydrate(libraryOf(ids)));
    act(() => {
      store.dispatch({ type: 'ui/openBook', payload: { id: 'bk0', status: 'cast_pending' } });
    });
    renderLayoutAt(store, 'bk0');
    await waitFor(() => expect(pollRevisionsBulkMock).toHaveBeenCalledTimes(3));
    const sizes = pollRevisionsBulkMock.mock.calls.map(
      (c) => (c[0] as { bookIds: string[] }).bookIds.length,
    );
    expect(sizes).toEqual([50, 50, 20]);
  });
});

describe('Layout — A/B player routing (plan 286)', () => {
  const entry = (id: string, ch: number, triggeredBy: string, extra = {}) => ({ id, chapterId: ch, characterId: 'eliza', triggeredBy, segments: [], playable: true, hasPreviousAudio: true, ...extra });
  const S = (ids: ReturnType<typeof entry>[], rev = 1) => ({ bookId: 'b1', fileId: F1, rev, pending: ids, dismissed: [], acceptedSelections: {}, timeline: {} });
  /* RevisionDiffPlayer requires a resolved `chapter` to render (its own
     tests always pass one); getBookState resolves null below so Layout
     never hydrates chapters from the server, so seed them directly. */
  const testChapter = (id: number): Chapter =>
    ({ id, title: `Chapter ${id}`, duration: '00:05:00', state: 'done', progress: 1, characters: {} } as Chapter);
  async function mounted(pending: ReturnType<typeof entry>[], middleware: Middleware[] = [revisionPlayerMiddleware]) {
    getBookStateMock.mockResolvedValue(null);
    pollRevisionsBulkMock.mockResolvedValue({ byBookId: {} });
    getChapterAudioPreviousMock.mockResolvedValue(null);
    const store = makeStore(middleware); // the production watcher by default, so toast assertions can fail
    openAt(store, 'b1');
    store.dispatch(chaptersSlice.actions.setChapters([testChapter(3), testChapter(5)]));
    renderLayoutAt(store, 'b1');
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalled());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); // let the null hydrate land first
    act(() => { store.dispatch(revisionsActions.applyServerState(S(pending))); });
    return store;
  }

  it('D6 — the player opens the requested entry, not pending[0]', async () => {
    const store = await mounted([entry('r-a', 3, 'Ay change'), entry('r-b', 5, 'Bee change')]);
    act(() => { store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r-b', chapterId: 5 })); });
    const player = await screen.findByTestId('revision-diff-player');
    expect(within(player).getByText('Bee change')).toBeInTheDocument();
    expect(within(player).queryByText('Ay change')).toBeNull();
  });
  it('Commit selection accepts through the route and closes on success', async () => {
    acceptRevisionMock.mockResolvedValueOnce(S([], 2));
    const store = await mounted([entry('r-a', 3, 'Ay change')]);
    act(() => { store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r-a', chapterId: 3 })); });
    fireEvent.click(await screen.findByRole('button', { name: /Commit selection/i }));
    await waitFor(() => expect(screen.queryByTestId('revision-diff-player')).toBeNull());
    expect(acceptRevisionMock).toHaveBeenCalledTimes(1);
    expect(acceptRevisionMock.mock.calls[0][0]).toEqual({ bookId: 'b1', revisionId: 'r-a', selection: {} });
    expect(store.getState().ui.openRevision).toBeNull();
  });
  it('a double-click on Commit selection sends one request', async () => {
    let release!: (v: unknown) => void;
    acceptRevisionMock.mockReturnValueOnce(new Promise((r) => (release = r)));
    const store = await mounted([entry('r-a', 3, 'Ay change')]);
    act(() => { store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r-a', chapterId: 3 })); });
    const btn = await screen.findByRole('button', { name: /Commit selection/i });
    fireEvent.click(btn); fireEvent.click(btn);
    expect(acceptRevisionMock).toHaveBeenCalledTimes(1);
    await act(async () => { release(S([], 2)); });
  });
  it('a preview Approve fans out only after the accept succeeded', async () => {
    const store = await mounted([entry('r-a', 3, 'Ay change')]);
    act(() => {
      store.dispatch(castActions.hydrateCharacters([{ id: 'eliza', name: 'Eliza', role: '', color: 'narrator' } as never]));
      store.dispatch(uiActions.setPreviewRegen({ bookId: 'b1', characterId: 'eliza', previewChapterId: 3, remainingChapterIds: [], reason: 'voice', note: '' }));
      store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r-a', chapterId: 3 }));
    });
    acceptRevisionMock.mockRejectedValueOnce(new RevisionOpFailure('gone', 409, 'revision_gone', S([], 2)));
    fireEvent.click(await screen.findByRole('button', { name: /Approve.*regenerate the rest/i }));
    await waitFor(() => expect(acceptRevisionMock).toHaveBeenCalled());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(store.getState().changeLog.events.some((e) => e.type === 'regenerate')).toBe(false);
  });
  it('a successful preview Approve logs the regenerate, and the watcher fires no "resolved elsewhere" toast', async () => {
    acceptRevisionMock.mockResolvedValueOnce(S([], 2));
    const store = await mounted([entry('r-a', 3, 'Ay change')]);
    act(() => {
      store.dispatch(castActions.hydrateCharacters([{ id: 'eliza', name: 'Eliza', role: '', color: 'narrator' } as never]));
      store.dispatch(uiActions.setPreviewRegen({ bookId: 'b1', characterId: 'eliza', previewChapterId: 3, remainingChapterIds: [], reason: 'voice', note: '' }));
      store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r-a', chapterId: 3 }));
    });
    fireEvent.click(await screen.findByRole('button', { name: /Approve.*regenerate the rest/i }));
    await waitFor(() => expect(store.getState().changeLog.events.some((e) => e.type === 'regenerate')).toBe(true));
    expect(store.getState().ui.previewRegen).toBeNull();
    /* Non-vacuous only because `mounted` installs revisionPlayerMiddleware and a
       preview IS tied to chapter 3: the entry leaves the cache on this accept, and
       only revisionOpInFlight keeps the watcher from treating it as resolved
       elsewhere (mutation 5). */
    expect(store.getState().notifications.toasts.map((t) => t.message)).not.toContain('This preview was resolved elsewhere');
  });
  it('a legacy entry (no origin) opens as a server entry and is accepted through the route', async () => {
    acceptRevisionMock.mockResolvedValueOnce(S([], 2));
    const store = await mounted([entry('revision:3:eliza', 3, 'Legacy take')]);
    act(() => { store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'revision:3:eliza', chapterId: 3 })); });
    fireEvent.click(await screen.findByRole('button', { name: /Commit selection/i }));
    await waitFor(() => expect(acceptRevisionMock).toHaveBeenCalledWith({ bookId: 'b1', revisionId: 'revision:3:eliza', selection: {} }));
  });
  it('a reject answering no_previous_audio switches the footer to Keep new take', async () => {
    rejectRevisionMock.mockRejectedValueOnce(new RevisionOpFailure('x', 409, 'no_previous_audio', S([entry('r-a', 3, 'Ay change')])));
    const store = await mounted([entry('r-a', 3, 'Ay change')]);
    act(() => { store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r-a', chapterId: 3 })); });
    fireEvent.click(await screen.findByRole('button', { name: /Reject draft/i }));
    expect(await screen.findByRole('button', { name: /Keep new take/i })).toBeInTheDocument();
  });
  it('stub Approve fans out and makes no revisions call', async () => {
    const store = await mounted([]);
    act(() => {
      store.dispatch(castActions.hydrateCharacters([{ id: 'eliza', name: 'Eliza', role: '', color: 'narrator' } as never]));
      store.dispatch(uiActions.setPreviewRegen({ bookId: 'b1', characterId: 'eliza', previewChapterId: 3, remainingChapterIds: [], reason: 'voice', note: '',
        stub: entry('revision:3:eliza', 3, 'Eliza voice change', { hasPreviousAudio: false }) }));
      store.dispatch(uiActions.setOpenRevision({ kind: 'preview-stub' }));
    });
    fireEvent.click(await screen.findByRole('button', { name: /Approve.*regenerate the rest/i }));
    await waitFor(() => expect(store.getState().changeLog.events.some((e) => e.type === 'regenerate')).toBe(true));
    expect(acceptRevisionMock).not.toHaveBeenCalled();
    expect(restorePreviousUnrecordedMock).not.toHaveBeenCalled();
  });
  it('stub Reject with preserved audio calls restore-unrecorded', async () => {
    restorePreviousUnrecordedMock.mockResolvedValueOnce('restored');
    const store = await mounted([]);
    act(() => {
      store.dispatch(uiActions.setPreviewRegen({ bookId: 'b1', characterId: 'eliza', previewChapterId: 3, remainingChapterIds: [], reason: 'voice', note: '',
        stub: entry('revision:3:eliza', 3, 'Eliza voice change', { hasPreviousAudio: true }) }));
      store.dispatch(uiActions.setOpenRevision({ kind: 'preview-stub' }));
    });
    fireEvent.click(await screen.findByRole('button', { name: /Reject.*re-adjust/i }));
    await waitFor(() => expect(restorePreviousUnrecordedMock).toHaveBeenCalledWith({ bookId: 'b1', chapterId: 3 }));
    await waitFor(() => expect(store.getState().ui.previewRegen).toBeNull());
  });
  it('#1 — a preview stub for another book never renders, even with openRevision set', async () => {
    /* No watcher here: this pins the layout's own gate, not the watcher's hide rule (Task 21). */
    const store = await mounted([], []);
    act(() => {
      store.dispatch(uiActions.setPreviewRegen({ bookId: 'b2', characterId: 'eliza', previewChapterId: 3, remainingChapterIds: [], reason: 'voice', note: '',
        stub: entry('revision:3:eliza', 3, 'Eliza voice change', { hasPreviousAudio: true }) }));
      store.dispatch(uiActions.setOpenRevision({ kind: 'preview-stub' }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.queryByTestId('revision-diff-player')).toBeNull();
    expect(store.getState().ui.previewRegen?.stub?.id).toBe('revision:3:eliza'); // hidden, not cleared
  });
  it('OD28 — closing a stub player only hides it; with nothing else pending and no engine pinned, the Status pill still counts and re-opens it', async () => {
    const store = await mounted([]);
    /* Pass 4 #6 — a STUB-ONLY state: no cache entry, and no TTS control to keep
       the pill up. The FRONTEND_ACCOUNT_DEFAULTS key is 'kokoro-v1', and any key
       (Gemini included) puts its engine into enginesToShow on a ready stage, so
       only an unset key leaves showTtsControls false (selectDefaultTtsEngine:
       "null when no default key has hydrated yet"). */
    act(() => { store.dispatch(accountSlice.actions.setDefaultTtsModelKey(null as never)); });
    /* Precondition: nothing else shows the pill, so only the stub can bring it
       back. If this fails, neutralise whatever else shows it in THIS test;
       never drop the precondition — without it the test cannot fail. */
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.queryByTestId('status-pill')).toBeNull();
    act(() => {
      store.dispatch(uiActions.setPreviewRegen({ bookId: 'b1', characterId: 'eliza', previewChapterId: 3, remainingChapterIds: [], reason: 'voice', note: '',
        stub: entry('revision:3:eliza', 3, 'Eliza voice change', { hasPreviousAudio: true }), completed: { reviewOutcome: 'none', stubFallback: true } }));
      store.dispatch(uiActions.setOpenRevision({ kind: 'preview-stub' }));
    });
    await screen.findByTestId('revision-diff-player');
    act(() => { store.dispatch(uiActions.setOpenRevision(null)); }); // exactly what the player's back-arrow onClose dispatches
    await waitFor(() => expect(screen.queryByTestId('revision-diff-player')).toBeNull());
    expect(store.getState().ui.previewRegen?.stub?.id).toBe('revision:3:eliza');
    const pill = await screen.findByTestId('status-pill');
    expect(pill).toHaveAttribute('aria-label', 'Status — Revisions 1'); // top-bar.tsx summarizeStatus: label 'Revisions', detail '1'
    fireEvent.click(pill);
    const section = await screen.findByTestId('status-popover-revisions');
    fireEvent.click(within(section).getByRole('button', { name: /1 revision pending · Open/ }));
    expect(await screen.findByTestId('revision-diff-player')).toBeInTheDocument();
    expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' });
  });
});


describe('Layout — analysis gaps reach the chapters slice (#3435 decision F / O2)', () => {
  it("the layout's book-state hydrate carries unattributedChapterIds and failedChapterErrors into analysisGapById", async () => {
    getBookStateMock.mockResolvedValue({
      state: {
        bookId: 'b1',
        manuscriptId: 'mns1',
        title: 'Test Book',
        author: 'Author',
        series: null,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters: [
          { id: 1, title: 'Chapter 1', slug: '01-chapter-1' },
          { id: 2, title: 'Chapter 2', slug: '02-chapter-2' },
          { id: 3, title: 'Chapter 3', slug: '03-chapter-3' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      cast: { characters: [] },
      manuscript: { wordCount: 0, format: 'plaintext' },
      manuscriptEdits: null,
      revisions: null,
      completedSlugs: [],
      chapterCharacters: {},
      changeLog: null,
      analysis: {
        failedChapterIds: [1],
        failedChapterErrors: {
          '1': { code: 'analyzer-timeout', message: 'Attribution broke.', remediation: '', phase: 'attribution' },
        },
        stage1Ready: true,
        resumeRequired: false,
        unattributedChapterIds: [2],
      },
    });
    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_confirmed' }));
    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books/b1/listen']}>
          <Routes>
            <Route path="/books/:bookId/listen" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );
    await waitFor(() => {
      expect(store.getState().chapters.analysisGapById).toEqual({
        1: { message: 'Attribution broke.' },
        2: { message: "Analysis didn't finish for this chapter." },
      });
    });
  });
});

describe("Layout — Confirm's voice-match waits for its own book's cast (#3435, PR #3505 pass 5)", () => {
  /* The voice-match effect fires on stage=confirm using whatever cast the
     slice holds, and its result is a persisted action (applyVoiceMatches), so
     while the slices still hold book B it would PUT B's cast to A's
     cast.json. A's read is held open to pin that window; the persistence
     middleware is real because an in-memory-only check cannot see the PUT. */
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
  });

  const bookOf = (bookId: string) => ({
    state: { bookId, manuscriptId: 'm1', title: 'Book A', castConfirmed: false, chapters: [] },
    cast: { characters: [{ id: 'a-villain', name: 'Villain', role: 'Antagonist', color: 'magenta' }] },
    manuscript: null,
    manuscriptEdits: null,
    revisions: null,
    completedSlugs: [],
    chapterCharacters: {},
    changeLog: null,
  });

  function seedBookBInSlices(store: ReturnType<typeof makeStoreWithScopeAndPersistence>) {
    store.dispatch(
      manuscriptSlice.actions.hydrateFromBookState({
        state: { bookId: 'b2', manuscriptId: 'm2', title: 'Book B' } as never,
        sentences: null,
      }),
    );
    store.dispatch(
      castSlice.actions.hydrateCharacters([{ id: 'b-hero', name: 'Hero', role: 'Protagonist', color: 'peach' }]),
    );
  }

  async function assertMatchWaitsForBookA(store: ReturnType<typeof makeStoreWithScopeAndPersistence>) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    getBookStateMock.mockImplementation(async (bookId: string) => {
      await gate;
      return bookOf(bookId);
    });

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books/b1/confirm']}>
          <Routes>
            <Route path="/books/:bookId/confirm" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalledWith('b1'));
    expect(store.getState().ui.stage).toMatchObject({ kind: 'confirm', bookId: 'b1' });
    // Past the 500 ms persistence debounce: a wrongly-fired match would have PUT by now.
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(matchVoicesMock).not.toHaveBeenCalled();
    expect(putBookStateMock.mock.calls.filter(([, req]) => (req as { slice: string }).slice === 'cast')).toEqual([]);

    release();
    await waitFor(() => expect(matchVoicesMock).toHaveBeenCalledTimes(1));
    expect(matchVoicesMock).toHaveBeenCalledWith({
      bookId: 'b1',
      characters: [expect.objectContaining({ id: 'a-villain' })],
    });
    await waitFor(() => {
      const castPuts = putBookStateMock.mock.calls.filter(([, req]) => (req as { slice: string }).slice === 'cast');
      expect(castPuts).toHaveLength(1);
      expect(castPuts[0][0]).toBe('b1');
      const patch = (castPuts[0][1] as { patch: { characters: Array<{ id: string }> } }).patch;
      expect(patch.characters.map((c) => c.id)).toEqual(['a-villain']);
    });
  }

  it("P5a: a skipped analysis result for A (slices still hold B) does not voice-match B's cast into A", async () => {
    const store = makeStoreWithScopeAndPersistence();
    seedBookBInSlices(store);
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'analysing', manuscriptId: 'm1' }));
    store.dispatch(uiActions.analysisComplete({ bookId: 'b1' }));
    await assertMatchWaitsForBookA(store);
  });

  it("P5b: opening cast-pending A from the library after viewing B does not voice-match B's cast into A", async () => {
    const store = makeStoreWithScopeAndPersistence();
    seedBookBInSlices(store);
    store.dispatch(uiActions.openBook({ id: 'b1', status: 'cast_pending' }));
    await assertMatchWaitsForBookA(store);
  });
});
