// Pairs with docs/features/04-analysing-view-progress.md

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { uiSlice } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
import { AnalysingView } from './analysing';
import type { AnalyseOpts, AnalysisLiveInfo } from '../lib/api';
import type { AnalyseResponse, Character } from '../lib/types';

/* Captured handlers so tests can drive phase/log events at will. */
let capturedOpts: AnalyseOpts | undefined;
const loadAnalyzerSpy = vi.fn();
const unloadSidecarSpy = vi.fn();
const getSidecarHealthSpy = vi.fn();

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
      getOllamaHealth: () => Promise.resolve({
        status: 'reachable' as const,
        url: '(test)',
        models: [],
        expectedModel: 'qwen3.5:4b',
        modelPulled: true,
      }),
      getSidecarHealth: () => getSidecarHealthSpy(),
      loadAnalyzer:    () => { loadAnalyzerSpy(); return Promise.resolve({ status: 'ready' as const }); },
      unloadAnalyzer:  () => Promise.resolve({ status: 'unloaded' as const }),
      loadSidecar:     () => Promise.resolve({ status: 'ready' as const }),
      unloadSidecar:   () => { unloadSidecarSpy(); return Promise.resolve({ status: 'idle' as const }); },
    },
  };
});

beforeEach(() => {
  loadAnalyzerSpy.mockReset();
  unloadSidecarSpy.mockReset();
  getSidecarHealthSpy.mockReset();
  getSidecarHealthSpy.mockResolvedValue({ status: 'reachable', url: '(test)', modelLoaded: false });
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
          title="the Coalfall Commission"
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

    /* Chapter 1 lands — narrator + Wren. */
    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 0, progress: 0.05 });
      capturedOpts?.onCastUpdate?.({ characters: [
        makeChar('narrator', 'Narrator'),
        makeChar('Wren', 'Wren'),
      ]});
    });
    expect(screen.getByText(/Cast so far · 2 characters/)).toBeInTheDocument();
    expect(screen.getByText('Wren')).toBeInTheDocument();

    /* Chapter 5 lands — adds Marlow. */
    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 0, progress: 0.4 });
      capturedOpts?.onCastUpdate?.({ characters: [
        makeChar('narrator', 'Narrator'),
        makeChar('Wren', 'Wren'),
        makeChar('Marlow', 'Marlow'),
      ]});
    });
    expect(screen.getByText(/Cast so far · 3 characters/)).toBeInTheDocument();
    expect(screen.getByText('Marlow')).toBeInTheDocument();
  });

  it('keeps the cast preview visible under Phase 0 after the active phase advances (regression: model-switch retry on a fully-cached Phase 0 was wiping the chips from the UI even though the cast slice still held them)', () => {
    renderView();

    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 0, progress: 1 });
      capturedOpts?.onCastUpdate?.({ characters: [
        makeChar('narrator', 'Narrator'), makeChar('Wren', 'Wren'),
      ]});
      /* Now Phase 1 (attribution) becomes active. */
      capturedOpts?.onPhase?.({ phaseId: 1, progress: 0.05 });
    });

    /* Cast roster is Phase 0's outcome — must remain visible after Phase 0
       completes. The chips render under Phase 0's row regardless of which
       phase is currently active. */
    expect(screen.getByText(/Cast so far · 2 characters/)).toBeInTheDocument();
    expect(screen.getByText('Narrator')).toBeInTheDocument();
    expect(screen.getByText('Wren')).toBeInTheDocument();
  });
});

/* Regression for "neither the total estimate at the top get refreshed" —
   the static describeSize() string is Gemini-calibrated (22ms/word) and
   overshoots local Ollama by 3-5×, so the heading must swap to the
   server-supplied wall-clock projection the moment the first chapter
   completes. */
describe('AnalysingView — total ETA refresh', () => {
  it('shows the static describeSize until the server emits its first eta', () => {
    renderView();
    /* 2440 words × 22ms/word ≈ 54s → "under 90 seconds". */
    expect(screen.getByText(/usually under 90 seconds/i)).toBeInTheDocument();
    expect(screen.queryByText(/remaining at the current pace/i)).not.toBeInTheDocument();
  });

  it('swaps the heading to the refined remaining estimate when an eta event arrives', () => {
    renderView();

    act(() => {
      /* Server's projection after observing a few slow Ollama chapters —
         the heading must reflect this, not the canned 22ms/word figure. */
      capturedOpts?.onEta?.({ remainingMs: 4 * 60_000 });
    });

    expect(screen.getByText(/~4 minutes remaining at the current pace/i)).toBeInTheDocument();
    expect(screen.queryByText(/usually under 90 seconds/i)).not.toBeInTheDocument();
  });

  it('keeps the refined estimate live across subsequent eta updates', () => {
    renderView();

    act(() => {
      capturedOpts?.onEta?.({ remainingMs: 8 * 60_000 });
    });
    expect(screen.getByText(/~8 minutes remaining/i)).toBeInTheDocument();

    /* A later chapter completes — fresher rate brings the estimate down. */
    act(() => {
      capturedOpts?.onEta?.({ remainingMs: 5 * 60_000 });
    });
    expect(screen.getByText(/~5 minutes remaining/i)).toBeInTheDocument();
    expect(screen.queryByText(/~8 minutes remaining/i)).not.toBeInTheDocument();
  });
});

/* Analyzer Load/Stop pill is the only way users have to free GPU memory
   without killing processes. If the Load click stops auto-evicting TTS,
   loading the analyzer on a tight-VRAM box would OOM the new model — the
   whole point of the auto-evict-with-banner flow. */
describe('AnalysingView — analyzer Load button auto-evicts TTS', () => {
  /* Render WITHOUT a manuscriptId so the auto-start analyseManuscript
     effect doesn't flip conn into 'connecting' (which would push the pill
     into 'loading' state with Stop disabled). The pill is meant to render
     even pre-analysis so the user can pre-warm Ollama from this screen. */
  function renderNoManuscript() {
    const store = configureStore({
      reducer: { ui: uiSlice.reducer, cast: castSlice.reducer },
    });
    return render(
      <Provider store={store}>
        <AnalysingView
          manuscriptId={null}
          title="Demo"
          wordCount={500}
          onComplete={() => {}}
        />
      </Provider>,
    );
  }

  it('unloads the TTS sidecar before warming the analyzer when both compete for VRAM', async () => {
    /* Sidecar has a model loaded → unloading it should fire AND the banner
       should surface so the user knows the swap happened. */
    getSidecarHealthSpy.mockResolvedValue({ status: 'reachable', url: '(test)', modelLoaded: true });

    renderNoManuscript();

    /* Wait for the initial health probe to settle so the pill is rendered. */
    const loadBtn = await screen.findByRole('button', { name: /load model \(analyzer\)/i });
    await act(async () => { fireEvent.click(loadBtn); });

    await waitFor(() => expect(unloadSidecarSpy).toHaveBeenCalledTimes(1));
    expect(loadAnalyzerSpy).toHaveBeenCalledTimes(1);
    /* Auto-evict banner — the user must see that loading the analyzer
       freed VRAM from TTS, otherwise the swap is silent and confusing. */
    expect(await screen.findByText(/TTS unloaded to free VRAM/i)).toBeInTheDocument();
  });

  it('does not surface the eviction banner when TTS had no model loaded to begin with', async () => {
    /* No-op unload should still fire (Ollama hates surprise state), but
       the banner lies if it pretends VRAM was freed when it wasn't. */
    getSidecarHealthSpy.mockResolvedValue({ status: 'reachable', url: '(test)', modelLoaded: false });

    renderNoManuscript();
    const loadBtn = await screen.findByRole('button', { name: /load model \(analyzer\)/i });
    await act(async () => { fireEvent.click(loadBtn); });

    await waitFor(() => expect(loadAnalyzerSpy).toHaveBeenCalled());
    expect(screen.queryByText(/TTS unloaded to free VRAM/i)).not.toBeInTheDocument();
  });

  it('hides the analyzer pill when a cloud (Gemini) model is selected — nothing to load locally', () => {
    const store = configureStore({
      reducer: { ui: uiSlice.reducer, cast: castSlice.reducer },
    });
    render(
      <Provider store={store}>
        <AnalysingView
          manuscriptId="m1"
          title="Demo"
          wordCount={500}
          model="gemini-2.5-flash"
          onComplete={() => {}}
        />
      </Provider>,
    );
    /* Gemini has no local lifecycle to manage; the analyzer pill should be
       absent (the original ConnPill renders instead). */
    expect(screen.queryByRole('button', { name: /load model \(analyzer\)/i })).not.toBeInTheDocument();
  });
});
