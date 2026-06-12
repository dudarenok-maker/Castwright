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

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent, act } from '@testing-library/react';
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
    getGpuQueueState: vi.fn(async () => ({ depth: 0, inFlight: 0, max: 1 })),
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
       ready so the splash clears and the normal app renders. */
    getSetupReadiness: () =>
      Promise.resolve({
        ready: true,
        completedAt: '2026-06-12T00:00:00.000Z',
        blockers: { sidecar: 'pass', ffmpeg: 'pass', tts: 'pass', analyzer: 'pass' },
        info: { gpu: 'cuda · 1.2 / 8.0 GB reserved' },
      }),
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

import { Layout } from './layout';
import { api } from '../lib/api';
import { uiActions } from '../store/ui-slice';
import { revisionsActions } from '../store/revisions-slice';
import { bookMetaActions } from '../store/book-meta-slice';
import type { DriftEvent, LibraryBook, LibraryResponse } from '../lib/types';

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
        title: 'Unlocked',
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
        title: 'Unlocked',
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
        title: 'Unlocked',
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

  it('falls through bookMeta.saved → library.books → bookId for the BOOK header', async () => {
    const store = makeStore();

    /* Two-book seed: book-A has BOTH bookMeta.saved AND library.books;
       book-B has ONLY library.books. The new fallback is what surfaces
       the clean "Exile" title for book-B; before the fix, book-B's
       header rendered the raw "book-B-slug" string. */
    const library: LibraryResponse = {
      authors: [
        {
          name: 'Della Renwick',
          series: [
            {
              name: 'The Hollow Tide',
              books: [
                makeLibraryBook({ bookId: 'book-A-slug', title: 'Library title — Keeper' }),
                makeLibraryBook({ bookId: 'book-B-slug', title: 'Exile' }),
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
        state: { title: 'Saved title — Keeper', author: 'Della Renwick', series: 'the Hollow Tide' },
      }),
    );

    /* One drift event per book, each carrying its own bookId so the
       selector buckets them into two book entries. Each book section
       in drift-report.tsx always renders a BOOK header (PR #165), so
       both `view.bookTitle` values must resolve correctly via the
       saved → library → bookId priority chain. */
    store.dispatch(
      revisionsActions.hydrateFromBookState({
        drift: [
          makeDriftEvent({ id: 'drift:book-A-slug:1:eliza:voice', bookId: 'book-A-slug' }),
          makeDriftEvent({ id: 'drift:book-B-slug:1:eliza:voice', bookId: 'book-B-slug' }),
        ],
      }),
    );

    store.dispatch(uiActions.setShowDriftReport(true));

    const { findByText, queryByText } = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    /* book-A: saved meta wins over library entry. */
    expect(await findByText('Saved title — Keeper')).toBeTruthy();
    /* book-B: library title surfaces (the fix). Without it the header
       would render the raw "book-B-slug". */
    expect(await findByText('Exile')).toBeTruthy();
    /* Neither raw bookId leaks into the modal as a title. */
    expect(queryByText('book-A-slug')).toBeNull();
    expect(queryByText('book-B-slug')).toBeNull();
    /* The library entry's "Library title — Keeper" must NOT win for
       book-A; the saved-meta short-circuit guards against a regression
       that flipped the priority order. */
    expect(queryByText('Library title — Keeper')).toBeNull();
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
       The Qwen pill then renders once the cast hydrates from getBookState. */
    fireEvent.click(await findByTestId('status-pill'));
    const qwenPill = await findByRole('group', { name: /^Qwen / });
    expect(qwenPill).toBeTruthy();
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
