// Pairs with docs/features/04-analysing-view-progress.md

import { describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { uiSlice } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
import { AnalysingView } from './analysing';
import type { AnalyseOpts, AnalysisLiveInfo } from '../lib/api';
import type { AnalyseResponse, Character } from '../lib/types';

/* Captured handlers so tests can drive phase/log events at will. */
let capturedOpts: AnalyseOpts | undefined;

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      /* Never-resolving so the view stays mounted in its "streaming" state
         for the duration of the test. */
      analyseManuscript: (_id: string, opts?: AnalyseOpts) => {
        capturedOpts = opts;
        return new Promise<AnalyseResponse>(() => {});
      },
    },
  };
});

function renderView() {
  const store = configureStore({
    reducer: {
      ui:   uiSlice.reducer,
      cast: castSlice.reducer,
    },
  });
  return {
    store,
    ...render(
      <Provider store={store}>
        <AnalysingView
          manuscriptId="m1"
          title="Bonus Keefe Story"
          wordCount={2440}
          onComplete={() => {}}
        />
      </Provider>,
    ),
  };
}

describe('AnalysingView — live ticker (regression for stuck-chapter screenshot bug)', () => {
  it('renders one row per in-flight chapter so a slow chapter does not hide concurrent progress', () => {
    renderView();

    const live: AnalysisLiveInfo = {
      totalChapters: 7,
      chapters: [
        { chapterIndex: 2, chapterTitle: 'DAY ONE',   elapsedMs: 4 * 60_000 + 15_000, estMs: 21_000  },
        { chapterIndex: 7, chapterTitle: 'DAY SIX',   elapsedMs: 8_000,               estMs: 123_000 },
      ],
    };

    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 1, progress: 0.56, live });
    });

    /* Both chapters render — the screenshot bug was that only "Chapter 2/7"
       (the oldest in-flight) was visible while chapters 6 & 7 ran behind it. */
    expect(screen.getByText('Chapter 2/7')).toBeInTheDocument();
    expect(screen.getByText('Chapter 7/7')).toBeInTheDocument();
    expect(screen.getByText('DAY ONE')).toBeInTheDocument();
    expect(screen.getByText('DAY SIX')).toBeInTheDocument();

    /* The chapter that's run far past its estimate is flagged "over budget";
       the freshly-started one is not. */
    const overBudget = screen.getAllByText('over budget');
    expect(overBudget).toHaveLength(1);
  });

  it('hides the ticker entirely when no chapters are in flight (between completion and next start)', () => {
    renderView();

    act(() => {
      capturedOpts?.onPhase?.({
        phaseId: 1,
        progress: 0.4,
        live: { totalChapters: 7, chapters: [] },
      });
    });

    expect(screen.queryByText(/Chapter \d+\/7/)).not.toBeInTheDocument();
  });
});

describe('AnalysingView — streaming heartbeat indicator', () => {
  it('renders a "Receiving response" line under the active phase when a heartbeat arrives', () => {
    renderView();

    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 0, progress: 0.4 });
      capturedOpts?.onHeartbeat?.({
        phaseId: 0,
        receivedBytes: 18_432, // ≈ 18 KB
        charsPerSec: 340,
        elapsedMs: 12_500,
        sinceLastChunkMs: 1_200,
      });
    });

    expect(screen.getByText(/Receiving response/i)).toBeInTheDocument();
    expect(screen.getByText(/18 KB/)).toBeInTheDocument();
    expect(screen.getByText(/340 chars\/s/)).toBeInTheDocument();
    expect(screen.getByText(/last chunk 1s ago/)).toBeInTheDocument();
  });

  it('clears the previous phase\'s heartbeat the moment the active phase advances', () => {
    renderView();

    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 0, progress: 0.4 });
      capturedOpts?.onHeartbeat?.({
        phaseId: 0, receivedBytes: 4096, charsPerSec: 100,
        elapsedMs: 5_000, sinceLastChunkMs: 800,
      });
    });
    expect(screen.getByText(/Receiving response/i)).toBeInTheDocument();

    /* Phase advances to 1 — stage 0's heartbeat should disappear, no new
       heartbeat for stage 1 yet so nothing renders. */
    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 1, progress: 0.05 });
    });
    expect(screen.queryByText(/Receiving response/i)).not.toBeInTheDocument();
  });

  it('flags as Stalled when the most recent chunk is older than the freshness threshold', () => {
    renderView();

    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 0, progress: 0.6 });
      capturedOpts?.onHeartbeat?.({
        phaseId: 0,
        receivedBytes: 12_000,
        charsPerSec: 200,
        elapsedMs: 30_000,
        sinceLastChunkMs: 12_000, // 12s — over the 8s threshold
      });
    });

    expect(screen.getByText(/Stalled/)).toBeInTheDocument();
    expect(screen.queryByText(/Receiving response/)).not.toBeInTheDocument();
  });
});

describe('AnalysingView — Phase 0a live cast preview', () => {
  const makeChar = (id: string, name: string): Character => ({
    id, name, role: 'role', color: id, voiceState: 'generated',
  });

  it('does not render the cast preview before any cast-update has arrived', () => {
    renderView();
    /* Phase 0 is active by default; no characters yet → no preview. */
    expect(screen.queryByText(/Cast so far/i)).not.toBeInTheDocument();
  });

  it('renders the running roster as cast-update events arrive, growing chapter-by-chapter', () => {
    renderView();

    /* Chapter 1 lands — narrator + Sophie. */
    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 0, progress: 0.05 });
      capturedOpts?.onCastUpdate?.({ characters: [
        makeChar('narrator', 'Narrator'),
        makeChar('sophie', 'Sophie'),
      ]});
    });
    expect(screen.getByText(/Cast so far · 2 characters/)).toBeInTheDocument();
    expect(screen.getByText('Sophie')).toBeInTheDocument();

    /* Chapter 5 lands — adds Keefe. */
    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 0, progress: 0.4 });
      capturedOpts?.onCastUpdate?.({ characters: [
        makeChar('narrator', 'Narrator'),
        makeChar('sophie', 'Sophie'),
        makeChar('keefe', 'Keefe'),
      ]});
    });
    expect(screen.getByText(/Cast so far · 3 characters/)).toBeInTheDocument();
    expect(screen.getByText('Keefe')).toBeInTheDocument();
  });

  it('does not render the cast preview under Phase 1 (attribution) once that phase becomes active', () => {
    renderView();

    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 0, progress: 1 });
      capturedOpts?.onCastUpdate?.({ characters: [
        makeChar('narrator', 'Narrator'), makeChar('sophie', 'Sophie'),
      ]});
      /* Now Phase 1 (attribution) becomes active. */
      capturedOpts?.onPhase?.({ phaseId: 1, progress: 0.05 });
    });

    /* Cast preview is keyed to Phase 0 specifically (LiveCastPreview is
       only rendered inside the p.id === 0 branch); once Phase 1 is the
       active phase, the preview shouldn't be visible. */
    expect(screen.queryByText(/Cast so far/i)).not.toBeInTheDocument();
  });
});
