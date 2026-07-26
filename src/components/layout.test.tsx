/* Pairs with docs/features/archive/27-book-state-persistence.md.

   Pins the per-book hydration effect's revisions branch: when the user
   lands on a book stage and `getBookState` resolves with a `revisions`
   payload, Layout dispatches `revisionsActions.hydrateFromBookState`
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
import { configureStore } from '@reduxjs/toolkit';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

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
import { notificationsSlice } from '../store/notifications-slice';
import { prosodySlice } from '../store/prosody-slice';
import { scriptReviewSlice } from '../store/script-review-slice';

const getBookStateMock = vi.fn();
const pollRevisionsMock = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    /* Library + voice library + base-voice catalogue hydrate on mount —
       resolve to empty so they no-op without throwing. */
    getLibrary: vi.fn(async () => ({ books: [] })),
    getVoices: vi.fn(async () => ({ voices: [], dropped: [] })),
    getBaseVoices: vi.fn(async () => ({ voices: [] })),
    /* Account fetch (createAsyncThunk wraps this) — resolve to minimal
       UserSettings so the slice's hydrate doesn't reject. */
    getUserSettings: vi.fn(async () => ({})),
    /* The line this test is actually about. Configured per-test via
       getBookStateMock.mockResolvedValue. */
    getBookState: (...args: unknown[]) => getBookStateMock(...args),
    /* Cold-boot analysis state probe — return null so the analysing-pill
       rehydration short-circuits. */
    getAnalysisState: vi.fn(async () => null),
    /* Workspace-wide cold-boot scan. Layout's mount
       effect calls this; return empty so no pill seeds. */
    getActiveAnalyses: vi.fn(async () => ({ snapshots: [] })),
    /* The 30 s pollRevisions interval. Resolve to empty so it doesn't
       overwrite the slice between hydrate and the test's assertions. */
    pollRevisions: (...args: unknown[]) => pollRevisionsMock(...args),
    /* Background bulk-poll fan-out across all known books — stub to
       empty so the per-render fetch doesn't crash the test harness. */
    pollRevisionsBulk: vi.fn(async () => ({ byBookId: {} })),
    /* useTtsLifecycle polls /health on mount; resolve to unreachable so
       no pending pill state lands. */
    getSidecarHealth: vi.fn(async () => ({ status: 'unreachable', url: '(test)' })),
    /* useTtsLifecycle also polls /api/gpu/queue on the same cadence (the
       GPU semaphore depth that drives the "GPU busy · N waiting ·" pill
       prefix). Stub to an empty queue so the pill renders without the
       prefix in these tests. */
    getGpuQueueState: vi.fn(async () => ({ queueDepth: 0, devices: [] })),
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
    matchVoices: vi.fn(async () => ({ matches: [] })),
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
}));

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
  runProsodyPasses: vi.fn(() => Promise.resolve({ totalAnnotations: 0, totalChapters: 0, failed: 0 })),
}));

import { Layout } from './layout';
import { api } from '../lib/api';
import { uiActions } from '../store/ui-slice';
import { revisionsActions } from '../store/revisions-slice';
import { bookMetaActions } from '../store/book-meta-slice';
import { exportsActions } from '../store/exports-slice';
import type { DriftEvent, LibraryBook, LibraryResponse } from '../lib/types';
import type { Chapter, Character, Voice } from '../lib/types';
import {
  selectUndesignedQwenCharacters,
  selectVoiceReadinessGateShouldFire,
} from '../store/voice-readiness-selectors';
import type { RootState } from '../store';

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
      prosody: prosodySlice.reducer,
      scriptReview: scriptReviewSlice.reducer,
    },
  });
}

beforeEach(() => {
  getBookStateMock.mockReset();
  pollRevisionsMock.mockReset();
  pollRevisionsMock.mockResolvedValue({ pending: [], drift: [] });
});

describe('Layout — per-book hydration: revisions branch (plan 27)', () => {
  it('dispatches revisionsActions.hydrateFromBookState with pending/drift/dismissed/acceptedSelections from getBookState', async () => {
    /* Minimal BookStateResponse-shaped payload. The `state` field is the
       only one Layout's hydrate reads strictly — everything else is
       fed through `?? null` / `?? []` defaults. The `revisions` field
       is what we're asserting on. */
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
      revisions: {
        pending: [{ id: 'r1', characterId: 'cap_halloran', chapterId: 3 }],
        drift: [{ id: 'd1', characterId: 'cap_halloran', severity: 'moderate' }],
        dismissed: ['old-id'],
        acceptedSelections: { 'r-prev': { 4: 'B' } },
      },
      completedSlugs: [],
      chapterCharacters: {},
      changeLog: null,
    });

    const store = makeStore();
    /* Drive stage onto a book route so the per-book hydration effect
       fires. Use the cast-confirm stage for stability — 'ready' would
       also work but pulls in more views via the Outlet. */
    store.dispatch({
      type: 'ui/openBook',
      payload: { id: 'b1', status: 'cast_pending' },
    });

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books/b1/cast']}>
          <Routes>
            <Route path="/books/:bookId/cast" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    /* getBookState was called for the active book. */
    await waitFor(() => {
      expect(getBookStateMock).toHaveBeenCalledWith('b1');
    });

    /* Revisions hydrated synchronously off the response — before the
       30s poll has a chance to overwrite. */
    await waitFor(() => {
      const s = store.getState();
      expect(s.revisions.loaded).toBe(true);
      expect(s.revisions.pending.map((r) => r.id)).toEqual(['r1']);
      expect(s.revisions.drift.map((d) => d.id)).toEqual(['d1']);
      expect(s.revisions.dismissed).toEqual(['old-id']);
      expect(s.revisions.acceptedSelections).toEqual({ 'r-prev': { 4: 'B' } });
    });
  });

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

  it('passes null to hydrateFromBookState when revisions field is absent on the response', async () => {
    /* A freshly-imported book whose revisions.json doesn't exist yet
       returns `revisions: null` from getBookState. The slice's null
       handler still flips `loaded` to true so the UI can distinguish
       "nothing pending" from "still hydrating". */
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
      revisionsActions.hydrateFromBookState({
        drift: [
          makeDriftEvent({ id: 'drift:book-A-slug:1:eliza:voice', bookId: 'book-A-slug' }),
          makeDriftEvent({ id: 'drift:book-B-slug:1:eliza:voice', bookId: 'book-B-slug' }),
        ],
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

describe('Layout — resident-model Stop control in the global TTS notice banner (Task 10 / #1839)', () => {
  /* Kokoro is eagerly resident (PRELOAD_KOKORO). Before this task, its only
     Stop control lived in the generation view behind enginesInUse — so on a
     book-less view (or the cast/voices view of a book whose cast doesn't use
     Kokoro) it held ~1GB with no control in reach. That's exactly the moment
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
