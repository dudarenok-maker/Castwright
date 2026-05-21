/* Pairs with docs/features/27-book-state-persistence.md.

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
import { render, waitFor } from '@testing-library/react';
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
    /* Workspace-wide cold-boot scan (Backlog Should #1). Layout's mount
       effect calls this; return empty so no pill seeds. */
    getActiveAnalyses: vi.fn(async () => ({ snapshots: [] })),
    /* The 30 s pollRevisions interval. Resolve to empty so it doesn't
       overwrite the slice between hydrate and the test's assertions. */
    pollRevisions: (...args: unknown[]) => pollRevisionsMock(...args),
    /* useTtsLifecycle polls /health on mount; resolve to unreachable so
       no pending pill state lands. */
    getSidecarHealth: vi.fn(async () => ({ status: 'unreachable', url: '(test)' })),
    /* Voice matching fires on the confirm stage only; we render at
       'ready' here so it shouldn't trigger, but keep a stub so any
       drift in that guard doesn't crash the test. */
    matchVoices: vi.fn(async () => ({ matches: [] })),
    /* Plan 90 — Layout fetches the series roster on bookId change so
       the manuscript-view reassign picker has roster entries to surface.
       Return empty so the effect's catch path doesn't fire and these
       tests stay focused on per-book hydration. */
    getSeriesRoster: vi.fn(async () => ({ characters: [] })),
  },
  AnalysisError: class extends Error {},
  ExportIncompleteError: class extends Error {
    missing: string[] = [];
  },
}));

import { Layout } from './layout';
import { uiActions } from '../store/ui-slice';

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
        title: 'Bonus Keefe Story',
        author: 'Shannon Messenger',
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
        author: 'Shannon Messenger',
        series: 'Keeper of the Lost Cities',
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
        title: 'Bonus Keefe Story',
        author: 'Shannon Messenger',
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
