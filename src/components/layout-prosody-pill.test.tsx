/* Task 14 (fs-65 Phase 3) — prosody progress pill rendering tests.
   Migrated to per-book activeStreams map shape (Task 1 of analysis-pill-gate).
   Task 3 will delete this file when the pill is retired and replaced by the
   Status-pill rung.

   TDD contracts:
   1. The pill renders with label + percent when prosody.activeStreams has an entry.
   2. The pill is absent when prosody.activeStreams is empty. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
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
import { prosodySlice, prosodyActions } from '../store/prosody-slice';

import { Layout } from './layout';

/* ── Module mocks ──────────────────────────────────────────────────────── */

vi.mock('../store/prosody-thunk', () => ({
  runProsodyPasses: vi.fn(() => Promise.resolve({ totalAnnotations: 0, totalChapters: 0, failed: 0 })),
}));

vi.mock('../lib/api', () => ({
  api: {
    getLibrary: vi.fn(async () => ({ books: [] })),
    getVoices: vi.fn(async () => ({ voices: [], dropped: [] })),
    getBaseVoices: vi.fn(async () => ({ voices: [] })),
    getUserSettings: vi.fn(async () => ({})),
    getBookState: vi.fn(async () => null),
    putBookState: vi.fn(async () => ({})),
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
    getChapterAudio: vi.fn(async () => null),
    getListenProgress: vi.fn(async () => null),
    putListenProgress: vi.fn(async () => null),
    putListenStats: vi.fn(async () => ({})),
    setShelfStatus: vi.fn(async () => null),
  },
  AnalysisError: class extends Error {},
  ExportIncompleteError: class extends Error {
    missing: string[] = [];
  },
}));

vi.mock('../routes/prefetch', () => ({
  importGenerationView: vi.fn(() => Promise.resolve({})),
  importUploadView: vi.fn(() => Promise.resolve({})),
}));

/* ── Store factory ─────────────────────────────────────────────────────── */

function makeStore(prosodyState?: Partial<ReturnType<typeof prosodySlice.getInitialState>>) {
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
    },
    preloadedState: prosodyState ? { prosody: prosodyState as ReturnType<typeof prosodySlice.getInitialState> } : undefined,
  });
}

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

describe('Layout — prosody progress pill (Task 14 / fs-65 Phase 3)', () => {
  it('renders the prosody pill with label and percent when activeStreams has an entry', async () => {
    const store = makeStore({
      activeStreams: { b1: { progress: 42, label: 'Detecting emotions' } },
    });

    renderLayout(store);

    const pill = await screen.findByTestId('prosody-pill');
    expect(pill).toBeTruthy();
    expect(pill.textContent).toContain('Detecting emotions');
    expect(pill.textContent).toContain('42%');
  });

  it('does NOT render the prosody pill when activeStreams is empty', async () => {
    const store = makeStore({ activeStreams: {} });

    renderLayout(store);

    /* Wait for the boot-splash to resolve and Layout to settle. */
    await screen.findByRole('navigation');

    expect(screen.queryByTestId('prosody-pill')).toBeNull();
  });

  it('prosody pill updates when store state changes', async () => {
    const store = makeStore({ activeStreams: {} });

    renderLayout(store);

    /* No pill initially. */
    await screen.findByRole('navigation');
    expect(screen.queryByTestId('prosody-pill')).toBeNull();

    /* Dispatch setActive → pill should appear. */
    await act(async () => {
      store.dispatch(prosodyActions.setActive({ bookId: 'b1', progress: 0, label: 'Detecting emotions' }));
    });
    const pill = await screen.findByTestId('prosody-pill');
    expect(pill.textContent).toContain('0%');

    /* Dispatch updateProgress → percent updates. */
    await act(async () => {
      store.dispatch(prosodyActions.updateProgress({ bookId: 'b1', progress: 0.77 }));
    });
    expect(pill.textContent).toContain('77%');

    /* Dispatch clear → pill disappears. */
    await act(async () => {
      store.dispatch(prosodyActions.clear({ bookId: 'b1' }));
    });
    expect(screen.queryByTestId('prosody-pill')).toBeNull();
  });
});
