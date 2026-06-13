// Pairs with docs/features/archive/04-analysing-view-progress.md

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { uiSlice } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
import { analysisSlice } from '../store/analysis-slice';
import { accountSlice } from '../store/account-slice';
import { AnalysingView } from './analysing';
import type { AnalyseOpts, AnalysisLiveInfo } from '../lib/api';
import type {
  AnalyseResponse,
  BookStateResponse,
  Character,
  DroppedQuotesResponse,
} from '../lib/types';

/* Captured handlers so tests can drive phase/log events at will. */
let capturedOpts: AnalyseOpts | undefined;
let capturedSubsetCall: { chapterIds: number[]; opts: AnalyseOpts | undefined } | undefined;
let resolveSubset: ((value: AnalyseResponse) => void) | undefined;
let getBookStateImpl: ((bookId: string) => Promise<BookStateResponse | null>) | undefined;
let getDroppedQuotesImpl: ((bookId: string) => Promise<DroppedQuotesResponse>) | undefined;
/* Per-test override — when set, the analyseManuscript mock rejects with
   this error instead of returning a never-resolving promise. Lets tests
   exercise the view's catch branches (cast_incomplete,
   stage1_shrink_refused, etc.) without rewiring the whole mock. */
let analyseManuscriptRejection: unknown | undefined;
const loadAnalyzerSpy = vi.fn();
const unloadSidecarSpy = vi.fn();
const getSidecarHealthSpy = vi.fn();
const getOllamaHealthSpy = vi.fn();

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
        if (analyseManuscriptRejection !== undefined) {
          return Promise.reject(analyseManuscriptRejection);
        }
        return new Promise<AnalyseResponse>(() => {});
      },
      /* Subset retry — captures the chapter ids + opts and exposes a
         manual resolver so tests can simulate a successful retry. */
      runAnalysisForChapters: (_id: string, chapterIds: number[], opts?: AnalyseOpts) => {
        capturedSubsetCall = { chapterIds, opts };
        return new Promise<AnalyseResponse>((resolve) => {
          resolveSubset = resolve;
        });
      },
      getBookState: (bookId: string) =>
        getBookStateImpl ? getBookStateImpl(bookId) : Promise.reject(new Error('no impl')),
      getDroppedQuotes: (bookId: string) =>
        getDroppedQuotesImpl
          ? getDroppedQuotesImpl(bookId)
          : Promise.resolve({ manuscriptId: 'm1', batches: [] }),
      getOllamaHealth: () => getOllamaHealthSpy(),
      getSidecarHealth: () => getSidecarHealthSpy(),
      loadAnalyzer: () => loadAnalyzerSpy(),
      unloadAnalyzer: () => Promise.resolve({ status: 'unloaded' as const }),
      loadSidecar: () => Promise.resolve({ status: 'ready' as const }),
      unloadSidecar: () => {
        unloadSidecarSpy();
        return Promise.resolve({ status: 'idle' as const });
      },
    },
  };
});

beforeEach(() => {
  capturedOpts = undefined;
  capturedSubsetCall = undefined;
  resolveSubset = undefined;
  getBookStateImpl = undefined;
  getDroppedQuotesImpl = undefined;
  analyseManuscriptRejection = undefined;
  loadAnalyzerSpy.mockReset();
  unloadSidecarSpy.mockReset();
  getSidecarHealthSpy.mockReset();
  getOllamaHealthSpy.mockReset();
  getSidecarHealthSpy.mockResolvedValue({ status: 'reachable', url: '(test)', modelLoaded: false });
  loadAnalyzerSpy.mockResolvedValue({ status: 'ready' as const });
  /* Default to "reachable AND model resident" — the analysis effect is
     gated on isAnalyzerReady, so tests that drive phase/log events
     through capturedOpts need the analysis to actually have fired.
     Tests that specifically exercise the not-resident state override
     this in-line. */
  getOllamaHealthSpy.mockResolvedValue({
    status: 'reachable',
    url: '(test)',
    models: ['qwen3.5:4b'],
    expectedModel: 'qwen3.5:4b',
    modelPulled: true,
    resident: ['qwen3.5:4b'],
    modelResident: true,
  });
});

function renderView() {
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      analysis: analysisSlice.reducer,
      account: accountSlice.reducer,
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

/* The analysis effect is gated on (a) the probe useEffect having
   resolved getOllamaHealth at least once with modelResident=true so
   isAnalyzerReady flips on, AND (b) the user clicking the "Start
   analysis" button (analysisStarted state). Tests that drive
   phase/log events through capturedOpts therefore need to wait for
   the button to enable, click it, and then wait for the analysis
   fetch to be captured. This helper bundles the whole dance. */
async function renderViewWaitingForAnalysis() {
  const result = renderView();
  const startBtn = await screen.findByRole('button', { name: /start analysis/i });
  await act(async () => {
    fireEvent.click(startBtn);
  });
  await waitFor(() => expect(capturedOpts).toBeDefined());
  return result;
}

describe('AnalysingView — live ticker (regression for stuck-chapter screenshot bug)', () => {
  it('renders one row per in-flight chapter so a slow chapter does not hide concurrent progress', async () => {
    await renderViewWaitingForAnalysis();

    const live: AnalysisLiveInfo = {
      totalChapters: 7,
      chapters: [
        { chapterIndex: 2, chapterTitle: 'DAY ONE', elapsedMs: 4 * 60_000 + 15_000, estMs: 21_000 },
        { chapterIndex: 7, chapterTitle: 'DAY SIX', elapsedMs: 8_000, estMs: 123_000 },
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

  it('hides the ticker entirely when no chapters are in flight (between completion and next start)', async () => {
    await renderViewWaitingForAnalysis();

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
  it('renders a "Receiving response" line under the active phase when a heartbeat arrives', async () => {
    await renderViewWaitingForAnalysis();

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

  it("clears the previous phase's heartbeat the moment the active phase advances", async () => {
    await renderViewWaitingForAnalysis();

    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 0, progress: 0.4 });
      capturedOpts?.onHeartbeat?.({
        phaseId: 0,
        receivedBytes: 4096,
        charsPerSec: 100,
        elapsedMs: 5_000,
        sinceLastChunkMs: 800,
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

  it('renders a "Throttling …" pill on a throttle SSE event and replaces the heartbeat while active', async () => {
    /* Limiter just blocked an outbound call for 5s. The pill replaces
       the heartbeat row so the user knows the wait is *intentional*,
       not a hang — fixes the "is it stuck?" question the old silent
       wait raised. */
    await renderViewWaitingForAnalysis();

    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 1, progress: 0.4 });
      capturedOpts?.onHeartbeat?.({
        phaseId: 1,
        receivedBytes: 1024,
        charsPerSec: 100,
        elapsedMs: 2_000,
        sinceLastChunkMs: 200,
      });
    });
    expect(screen.getByText(/Receiving response/i)).toBeInTheDocument();

    act(() => {
      capturedOpts?.onThrottle?.({
        phaseId: 1,
        chapterIndex: 3,
        model: 'gemini-3.1-flash-lite',
        waitMs: 5_000,
        reason: 'rpm',
      });
    });

    expect(screen.getByText(/Throttling Gemini 3.1 Flash Lite/i)).toBeInTheDocument();
    expect(screen.getByText(/requests-per-minute cap/i)).toBeInTheDocument();
    /* Heartbeat row hides while the pill is active. */
    expect(screen.queryByText(/Receiving response/i)).not.toBeInTheDocument();
  });

  it('shows "Reading the manuscript…" while the SSE is connecting and no log lines have arrived yet', async () => {
    /* On a cold server the first 2-3s after click are spent in
       getOrHydrateManuscript re-parsing the EPUB. The screen used to
       look frozen during that window — phase 0 active spinner, 0%
       progress, no log lines, nothing else. The bridging status fills
       that silent gap so the click doesn't look like a no-op. */
    await renderViewWaitingForAnalysis();

    /* Right after the fetch fires, the analysis useEffect sets conn
       to 'connecting'. No phase/log events have arrived yet because
       capturedOpts hasn't been called. The bridging line should
       appear under the active phase. */
    expect(screen.getByText(/Reading the manuscript \(parsing chapters\)…/)).toBeInTheDocument();

    /* Once the first phase event lands, conn flips to 'streaming' and
       the bridging line drops out (the live log + heartbeat take over). */
    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 0, progress: 0.05 });
      capturedOpts?.onLog?.({ phaseId: 0, message: 'Manuscript: 103,102 words, …' });
    });
    expect(
      screen.queryByText(/Reading the manuscript \(parsing chapters\)…/),
    ).not.toBeInTheDocument();
  });

  it('flags as Stalled only past the engine-specific threshold (60s for local Ollama, 8s for cloud)', async () => {
    /* Default renderView uses qwen3.5:4b (local) → 60s stall threshold.
       12s is normal for constrained-decoding bursts and should NOT flag
       as stalled (was the false-alarm bug we got from re-using cloud's
       8s threshold). */
    await renderViewWaitingForAnalysis();

    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 0, progress: 0.6 });
      capturedOpts?.onHeartbeat?.({
        phaseId: 0,
        receivedBytes: 12_000,
        charsPerSec: 200,
        elapsedMs: 30_000,
        sinceLastChunkMs: 12_000,
      });
    });
    expect(screen.getByText(/Receiving response/)).toBeInTheDocument();
    expect(screen.queryByText(/Stalled/)).not.toBeInTheDocument();

    /* A real local stall (past 60s) should flag. */
    act(() => {
      capturedOpts?.onHeartbeat?.({
        phaseId: 0,
        receivedBytes: 12_000,
        charsPerSec: 200,
        elapsedMs: 90_000,
        sinceLastChunkMs: 70_000, // 70s — past the local 60s threshold
      });
    });
    expect(screen.getByText(/Stalled/)).toBeInTheDocument();
    expect(screen.queryByText(/Receiving response/)).not.toBeInTheDocument();
  });
});

describe('AnalysingView — Phase 0a live cast preview', () => {
  const makeChar = (id: string, name: string): Character => ({
    id,
    name,
    role: 'role',
    color: id,
    voiceState: 'generated',
  });

  it('does not render the cast preview before any cast-update has arrived', () => {
    renderView();
    /* Phase 0 is active by default; no characters yet → no preview. */
    expect(screen.queryByText(/Cast so far/i)).not.toBeInTheDocument();
  });

  it('renders the running roster as cast-update events arrive, growing chapter-by-chapter', async () => {
    await renderViewWaitingForAnalysis();

    /* Chapter 1 lands — narrator + Wren. */
    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 0, progress: 0.05 });
      capturedOpts?.onCastUpdate?.({
        characters: [makeChar('narrator', 'Narrator'), makeChar('wren', 'Wren')],
      });
    });
    expect(screen.getByText(/Cast so far · 2 characters/)).toBeInTheDocument();
    expect(screen.getByText('Wren')).toBeInTheDocument();

    /* Chapter 5 lands — adds Marlow. */
    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 0, progress: 0.4 });
      capturedOpts?.onCastUpdate?.({
        characters: [
          makeChar('narrator', 'Narrator'),
          makeChar('wren', 'Wren'),
          makeChar('marlow', 'Marlow'),
        ],
      });
    });
    expect(screen.getByText(/Cast so far · 3 characters/)).toBeInTheDocument();
    expect(screen.getByText('Marlow')).toBeInTheDocument();
  });

  it('keeps the cast preview visible under Phase 0 after the active phase advances (regression: model-switch retry on a fully-cached Phase 0 was wiping the chips from the UI even though the cast slice still held them)', async () => {
    await renderViewWaitingForAnalysis();

    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 0, progress: 1 });
      capturedOpts?.onCastUpdate?.({
        characters: [makeChar('narrator', 'Narrator'), makeChar('wren', 'Wren')],
      });
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

  it('swaps the heading to the refined remaining estimate when an eta event arrives', async () => {
    await renderViewWaitingForAnalysis();

    act(() => {
      /* Server's projection after observing a few slow Ollama chapters —
         the heading must reflect this, not the canned 22ms/word figure. */
      capturedOpts?.onEta?.({ remainingMs: 4 * 60_000 });
    });

    expect(screen.getByText(/~4 minutes remaining at the current pace/i)).toBeInTheDocument();
    expect(screen.queryByText(/usually under 90 seconds/i)).not.toBeInTheDocument();
  });

  it('keeps the refined estimate live across subsequent eta updates', async () => {
    await renderViewWaitingForAnalysis();

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
      reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, account: accountSlice.reducer },
    });
    return render(
      <Provider store={store}>
        <AnalysingView manuscriptId={null} title="Demo" wordCount={500} onComplete={() => {}} />
      </Provider>,
    );
  }

  it('unloads the TTS sidecar before warming the analyzer when both compete for VRAM', async () => {
    /* Sidecar has a model loaded → unloading it should fire AND the banner
       should surface so the user knows the swap happened. */
    getSidecarHealthSpy.mockResolvedValue({
      status: 'reachable',
      url: '(test)',
      modelLoaded: true,
    });
    /* Override the default-resident probe so the Load button is visible
       (it only appears when the analyzer is NOT resident). */
    getOllamaHealthSpy.mockResolvedValue({
      status: 'reachable',
      url: '(test)',
      models: ['qwen3.5:4b'],
      expectedModel: 'qwen3.5:4b',
      modelPulled: true,
      resident: [],
      modelResident: false,
    });

    renderNoManuscript();

    /* Wait for the initial health probe to settle so the pill is rendered. */
    const loadBtn = await screen.findByRole('button', { name: /load model \(analyzer\)/i });
    await act(async () => {
      fireEvent.click(loadBtn);
    });

    await waitFor(() => expect(unloadSidecarSpy).toHaveBeenCalledTimes(1));
    expect(loadAnalyzerSpy).toHaveBeenCalledTimes(1);
    /* Auto-evict banner — the user must see that loading the analyzer
       freed VRAM from TTS, otherwise the swap is silent and confusing. */
    expect(await screen.findByText(/TTS unloaded to free VRAM/i)).toBeInTheDocument();
  });

  it('does not surface the eviction banner when TTS had no model loaded to begin with', async () => {
    /* No-op unload should still fire (Ollama hates surprise state), but
       the banner lies if it pretends VRAM was freed when it wasn't. */
    getSidecarHealthSpy.mockResolvedValue({
      status: 'reachable',
      url: '(test)',
      modelLoaded: false,
    });
    getOllamaHealthSpy.mockResolvedValue({
      status: 'reachable',
      url: '(test)',
      models: ['qwen3.5:4b'],
      expectedModel: 'qwen3.5:4b',
      modelPulled: true,
      resident: [],
      modelResident: false,
    });

    renderNoManuscript();
    const loadBtn = await screen.findByRole('button', { name: /load model \(analyzer\)/i });
    await act(async () => {
      fireEvent.click(loadBtn);
    });

    await waitFor(() => expect(loadAnalyzerSpy).toHaveBeenCalled());
    expect(screen.queryByText(/TTS unloaded to free VRAM/i)).not.toBeInTheDocument();
  });

  /* Regression: before the fix, loadAnalyzer returning {status:'error', …}
     was silently discarded. The pill stayed on "Loading…" until the probe
     ticked it back to idle, and the user never learned why. Surface the
     daemon's error string so the failure is visible. */
  it('surfaces the error message when loadAnalyzer resolves with status:error', async () => {
    getOllamaHealthSpy.mockResolvedValue({
      status: 'reachable',
      url: '(test)',
      models: ['qwen3.5:4b'],
      expectedModel: 'qwen3.5:4b',
      modelPulled: true,
      resident: [],
      modelResident: false,
    });
    loadAnalyzerSpy.mockResolvedValue({
      status: 'error' as const,
      error: 'Ollama /api/generate returned 503',
    });

    renderNoManuscript();
    const loadBtn = await screen.findByRole('button', { name: /load model \(analyzer\)/i });
    await act(async () => {
      fireEvent.click(loadBtn);
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Ollama \/api\/generate returned 503/i,
    );
  });

  it('surfaces a fetch failure when loadAnalyzer throws', async () => {
    getOllamaHealthSpy.mockResolvedValue({
      status: 'reachable',
      url: '(test)',
      models: ['qwen3.5:4b'],
      expectedModel: 'qwen3.5:4b',
      modelPulled: true,
      resident: [],
      modelResident: false,
    });
    loadAnalyzerSpy.mockRejectedValue(new Error('Failed to fetch'));

    renderNoManuscript();
    const loadBtn = await screen.findByRole('button', { name: /load model \(analyzer\)/i });
    await act(async () => {
      fireEvent.click(loadBtn);
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn't reach Ollama/i);
  });

  it('hides the analyzer pill when a cloud (Gemini) model is selected — nothing to load locally', () => {
    const store = configureStore({
      reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, account: accountSlice.reducer },
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
    expect(
      screen.queryByRole('button', { name: /load model \(analyzer\)/i }),
    ).not.toBeInTheDocument();
  });
});

/* Regression for the user-reported "Loading analyzer…" pill that sits
   stuck while the model is already 100% resident per `ollama ps`. The
   prior derivation forced 'loading' whenever the analysis SSE was in
   'connecting' (i.e. POST in-flight, no events yet) — which on a long
   book's stage 0a is the bulk of the screen's lifetime. The pill is
   meant to track the *model* lifecycle (Ollama VRAM), not the SSE
   fetch lifecycle. */
describe('AnalysingView — analyzer pill reflects model state, not SSE state', () => {
  it('shows "Analyzer ready" when the model is resident and the SSE is still connecting', async () => {
    getOllamaHealthSpy.mockResolvedValue({
      status: 'reachable',
      url: '(test)',
      models: ['qwen3.5:4b'],
      expectedModel: 'qwen3.5:4b',
      modelPulled: true,
      resident: ['qwen3.5:4b'],
      modelResident: true,
    });

    renderView();

    /* renderView mounts with manuscriptId set → useEffect flips conn into
       'connecting' synchronously. The probe resolves on the next tick;
       once it does, the pill must reflect the resident model rather than
       the in-flight SSE. */
    expect(await screen.findByText(/Analyzer ready/i)).toBeInTheDocument();
    expect(screen.queryByText(/Loading analyzer/i)).not.toBeInTheDocument();
  });

  it('shows "Streaming live" once SSE events start flowing, even if the probe is still stale', async () => {
    /* Default mock from beforeEach already has modelResident: true — that
       satisfies isAnalyzerReady so the analysis useEffect fires and
       capturedOpts is captured. */
    await renderViewWaitingForAnalysis();
    /* First phase event flips conn → 'streaming'. */
    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 0, progress: 0.05 });
    });

    expect(await screen.findByText(/Streaming live/i)).toBeInTheDocument();
  });

  it('auto-fires the Load when the model is not resident on mount', async () => {
    /* The "implicit cold-load" path (analysis fires while the model is
       cold) no longer exists — the gate at analysing.tsx prevents the
       analysis from firing against a non-resident analyzer. Instead an
       auto-load effect kicks off handleLoadAnalyzer the moment the
       probe confirms the model isn't resident, so the user doesn't
       have to click anything to get analysis started. Verify
       loadAnalyzer fires; the pill's loading-text rendering is covered
       in ModelControlPill.test.tsx. */
    getOllamaHealthSpy.mockResolvedValue({
      status: 'reachable',
      url: '(test)',
      models: ['qwen3.5:4b'],
      expectedModel: 'qwen3.5:4b',
      modelPulled: true,
      resident: [],
      modelResident: false,
    });

    renderView();

    await waitFor(() => expect(loadAnalyzerSpy).toHaveBeenCalled());
    /* Analysis must NOT have fired against the cold analyzer. */
    expect(capturedOpts).toBeUndefined();
  });

  it('shows "Ollama not reachable" regardless of SSE state when the daemon is down', async () => {
    getOllamaHealthSpy.mockResolvedValue({
      status: 'unreachable',
      url: '(test)',
      error: 'connect ECONNREFUSED',
    });

    renderView();

    /* Daemon-level outage outranks everything else — the user needs to know
       the analyzer can't run at all, not that the SSE is "connecting". */
    expect(await screen.findByText(/Ollama not reachable/i)).toBeInTheDocument();
    expect(screen.queryByText(/Loading analyzer/i)).not.toBeInTheDocument();
  });
});

/* Pause/Resume + per-chapter retry. These cover the user-facing controls
   added to recover from mid-book cast-detection failures (the `qwen3.5:4b`
   invalid-JSON crash on long chapters) without restarting the Node server.
   The button must be a permanent fixture during the analysing stage, and
   per-chapter Retry rows must survive page reload via book-state
   hydration. */
describe('AnalysingView — Start/Pause/Resume button cycle', () => {
  it('Start → Pause → Resume: clicking Pause aborts the SSE; clicking Resume re-fires the analysis with a fresh AbortController', async () => {
    /* Phase 1: Start. Default mock state has the analyzer resident; the
       button reads "Start analysis", the click captures the first
       AbortController via capturedOpts.signal. */
    await renderViewWaitingForAnalysis();
    const firstSignal = capturedOpts!.signal!;
    expect(firstSignal.aborted).toBe(false);

    /* Emit a phase event so conn flips to 'streaming' — the button label
       hinges on conn. */
    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 0, progress: 0.05 });
    });
    expect(await screen.findByRole('button', { name: /pause analysis/i })).toBeInTheDocument();

    /* Phase 2: Pause. Click aborts the captured controller. The next
       render swaps the label to Resume. */
    const pauseBtn = screen.getByRole('button', { name: /pause analysis/i });
    await act(async () => {
      fireEvent.click(pauseBtn);
    });
    expect(firstSignal.aborted).toBe(true);
    expect(await screen.findByRole('button', { name: /resume analysis/i })).toBeInTheDocument();

    /* Phase 3: Resume. New analyseManuscript call lands with a fresh
       AbortController — the old one stays aborted. */
    capturedOpts = undefined;
    const resumeBtn = screen.getByRole('button', { name: /resume analysis/i });
    await act(async () => {
      fireEvent.click(resumeBtn);
    });
    await waitFor(() => expect(capturedOpts).toBeDefined());
    expect(capturedOpts!.signal!.aborted).toBe(false);
    expect(capturedOpts!.signal).not.toBe(firstSignal);
  });
});

describe('AnalysingView — failed-chapter retry', () => {
  function makeBookState(failedIds: number[]): BookStateResponse {
    /* Minimal shape — only the fields the analysing view reads, padded
       with required BookStateJson fields so the type-check stays happy. */
    return {
      state: {
        bookId: 'b1',
        manuscriptId: 'm1',
        title: 'the Coalfall Commission',
        author: '',
        series: '',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'bonus-marlow.txt',
        castConfirmed: false,
        chapters: [
          { id: 44, title: 'Chapter Forty-Two', slug: '44-chapter-forty-two', duration: '0:00' },
          {
            id: 49,
            title: 'Chapter Forty-Seven',
            slug: '49-chapter-forty-seven',
            duration: '0:00',
          },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: '2026-05-15T00:00:00.000Z',
        updatedAt: '2026-05-15T00:00:00.000Z',
      },
      cast: null,
      manuscript: null,
      manuscriptEdits: null,
      revisions: null,
      completedSlugs: [],
      changeLog: null,
      analysis: { failedChapterIds: failedIds },
    };
  }

  it('hydrates the Failed-chapters panel from book-state on mount when failedChapterIds is non-empty', async () => {
    getBookStateImpl = () => Promise.resolve(makeBookState([44, 49]));

    const store = configureStore({
      reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, account: accountSlice.reducer },
    });
    render(
      <Provider store={store}>
        <AnalysingView
          manuscriptId="m1"
          bookId="b1"
          title="the Coalfall Commission"
          wordCount={2440}
          onComplete={() => {}}
        />
      </Provider>,
    );

    expect(await screen.findByText(/2 chapters failed cast detection/i)).toBeInTheDocument();
    expect(screen.getByText('Chapter Forty-Two')).toBeInTheDocument();
    expect(screen.getByText('Chapter Forty-Seven')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /retry chapter/i })).toHaveLength(2);
  });

  it('clicking Retry while the main run is streaming aborts the main run, runs the subset alone, then resumes the main run on settle', async () => {
    /* Regression for the "stage two does not pause" + "retry has no
       persistence on reload" pair. Pre-fix the panel kept Retry
       clickable while the main run was in flight; both SSEs raced
       cache writes and one finisher's stale snapshot clobbered the
       other's progress. New contract: Retry serialises against the
       main run by pausing it for the duration of the subset call and
       auto-resuming once the row settles. */
    getBookStateImpl = () => Promise.resolve(makeBookState([44]));

    const store = configureStore({
      reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, account: accountSlice.reducer },
    });
    render(
      <Provider store={store}>
        <AnalysingView
          manuscriptId="m1"
          bookId="b1"
          title="the Coalfall Commission"
          wordCount={2440}
          onComplete={() => {}}
        />
      </Provider>,
    );

    /* Start the analysis so the effect captures opts, then drive a
       phase event so the view transitions to conn === 'streaming'. */
    const startBtn = await screen.findByRole('button', { name: /start analysis/i });
    await act(async () => {
      fireEvent.click(startBtn);
    });
    await waitFor(() => expect(capturedOpts).toBeDefined());
    const mainSignal = capturedOpts!.signal!;
    expect(mainSignal.aborted).toBe(false);
    await act(async () => {
      capturedOpts!.onPhase!({ phaseId: 0, progress: 0.4 });
    });

    /* Panel hydrated from book-state. Button is not disabled — the
       new contract is that the click pauses the main run rather than
       being blocked at the UI. */
    const retryBtn = await screen.findByRole('button', { name: /retry chapter/i });
    expect(retryBtn).not.toBeDisabled();

    /* Clicking Retry aborts the main run's signal before firing the
       subset call. Without this the two SSEs race the disk-backed
       analysis cache and the second finisher overwrites the first. */
    capturedOpts = undefined;
    await act(async () => {
      fireEvent.click(retryBtn);
    });
    expect(mainSignal.aborted).toBe(true);
    expect(capturedSubsetCall).toBeDefined();
    expect(capturedSubsetCall!.chapterIds).toEqual([44]);

    /* Resolve the subset call as if the server succeeded. */
    await act(async () => {
      resolveSubset?.({
        bookId: 'b1',
        manuscriptId: 'm1',
        title: '',
        phaseTimings: [],
        characters: [],
        chapters: [],
        sentences: [],
        libraryMatches: [],
      } as AnalyseResponse);
    });

    /* Main run resumes automatically — a fresh analyseManuscript fetch
       lands with a NEW (non-aborted) AbortController. The user never
       has to click Resume. */
    await waitFor(() => expect(capturedOpts).toBeDefined());
    expect(capturedOpts!.signal).not.toBe(mainSignal);
    expect(capturedOpts!.signal!.aborted).toBe(false);
  });

  it('a chapter-resolved SSE event drops the matching panel row mid-stream', async () => {
    /* Pre-fix the panel was hydrated once on mount from book-state and
       never updated, so a chapter that the main run's Phase 0a re-
       attempted successfully (cleared from cache.failedChapterIds
       server-side) kept showing as failed until the user reloaded.
       The user then clicked Retry on a row the server had already
       resolved, kicking a duplicate subset run. The server now
       broadcasts chapter-resolved on the SSE stream and this view
       drops the row in response. */
    getBookStateImpl = () => Promise.resolve(makeBookState([44, 49]));

    const store = configureStore({
      reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, account: accountSlice.reducer },
    });
    render(
      <Provider store={store}>
        <AnalysingView
          manuscriptId="m1"
          bookId="b1"
          title="the Coalfall Commission"
          wordCount={2440}
          onComplete={() => {}}
        />
      </Provider>,
    );

    /* Hydrate the panel from book-state, then start the analysis so
       the SSE callbacks bind to the running main run. */
    await screen.findByText(/2 chapters failed cast detection/i);
    const startBtn = screen.getByRole('button', { name: /start analysis/i });
    await act(async () => {
      fireEvent.click(startBtn);
    });
    await waitFor(() => expect(capturedOpts).toBeDefined());

    /* Server resolves chapter 44 during Phase 0a re-queue. */
    await act(async () => {
      capturedOpts!.onChapterResolved!({ chapterId: 44 });
    });

    await waitFor(() => {
      expect(screen.queryByText('Chapter Forty-Two')).not.toBeInTheDocument();
    });
    /* The unresolved row stays. */
    expect(screen.getByText('Chapter Forty-Seven')).toBeInTheDocument();
    expect(screen.getByText(/1 chapter failed cast detection/i)).toBeInTheDocument();

    /* Resolving the last row collapses the panel entirely. */
    await act(async () => {
      capturedOpts!.onChapterResolved!({ chapterId: 49 });
    });
    await waitFor(() => {
      expect(screen.queryByText(/chapter failed cast detection/i)).not.toBeInTheDocument();
    });
  });

  it('clicking Retry calls runAnalysisForChapters with exactly [chapterId]; the row disappears when the subset call resolves', async () => {
    getBookStateImpl = () => Promise.resolve(makeBookState([44]));

    const store = configureStore({
      reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, account: accountSlice.reducer },
    });
    render(
      <Provider store={store}>
        <AnalysingView
          manuscriptId="m1"
          bookId="b1"
          title="the Coalfall Commission"
          wordCount={2440}
          onComplete={() => {}}
        />
      </Provider>,
    );

    const retryBtn = await screen.findByRole('button', { name: /retry chapter/i });
    await act(async () => {
      fireEvent.click(retryBtn);
    });

    expect(capturedSubsetCall).toBeDefined();
    expect(capturedSubsetCall!.chapterIds).toEqual([44]);
    /* Button reads Retrying… while the subset promise is pending. */
    expect(screen.getByRole('button', { name: /retrying/i })).toBeInTheDocument();

    /* Resolve the subset call as if the server succeeded — the row drops
       out of the panel, and because that was the only failed chapter the
       whole panel disappears. */
    await act(async () => {
      resolveSubset?.({
        bookId: 'b1',
        manuscriptId: 'm1',
        title: '',
        phaseTimings: [],
        characters: [],
        chapters: [],
        sentences: [],
        libraryMatches: [],
      } as AnalyseResponse);
    });

    await waitFor(() => {
      expect(screen.queryByText(/chapter failed cast detection/i)).not.toBeInTheDocument();
    });
    expect(screen.queryByText('Chapter Forty-Two')).not.toBeInTheDocument();
  });
});

/* Mid-run recovery surface. With incremental cast.json writes landing on
   every Phase 0a chapter (see server/src/routes/analysis.ts buildInterimCast
   call site), the layout's getBookState hydration now pre-populates the
   cast slice on book open — so a re-opened book mid-run shows the cast
   that was found so far without waiting for the SSE to replay. The
   analysing view's contract is "render whatever is in the cast slice on
   mount", which this test pins down. */
describe('AnalysingView — pre-hydrated cast preview on mount', () => {
  const makeChar = (id: string, name: string): Character => ({
    id,
    name,
    role: 'role',
    color: id,
    voiceState: 'generated',
  });

  it('renders the cast preview from a pre-hydrated cast slice before any SSE event fires', () => {
    const store = configureStore({
      reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, account: accountSlice.reducer },
    });
    /* Simulate the layout's getBookState → setCharacters hydration that
       runs ahead of the analysing route mounting. With cast.json now
       written incrementally on the server, this slice can land
       non-empty even when the user just re-opened a mid-run book. */
    store.dispatch(
      castSlice.actions.setCharacters([
        makeChar('narrator', 'Narrator'),
        makeChar('wren', 'Wren'),
        makeChar('marlow', 'Marlow'),
      ]),
    );

    render(
      <Provider store={store}>
        <AnalysingView
          manuscriptId="m1"
          title="the Coalfall Commission"
          wordCount={2440}
          onComplete={() => {}}
        />
      </Provider>,
    );

    /* Chips render immediately — no Start click, no cast-update SSE event. */
    expect(screen.getByText(/Cast so far · 3 characters/)).toBeInTheDocument();
    expect(screen.getByText('Narrator')).toBeInTheDocument();
    expect(screen.getByText('Wren')).toBeInTheDocument();
    expect(screen.getByText('Marlow')).toBeInTheDocument();
  });
});

describe('AnalysingView — dropped-quotes panel', () => {
  function renderWithBookId() {
    const store = configureStore({
      reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, account: accountSlice.reducer },
    });
    return render(
      <Provider store={store}>
        <AnalysingView
          manuscriptId="m1"
          bookId="b1"
          title="the Coalfall Commission"
          wordCount={2440}
          onComplete={() => {}}
        />
      </Provider>,
    );
  }

  /* getBookState needs SOME impl so the failed-chapter hydration effect
     doesn't reject loudly — return an empty BookStateResponse. The
     book-state hydration isn't what these tests exercise. */
  function setEmptyBookState() {
    getBookStateImpl = () =>
      Promise.resolve({
        state: {
          bookId: 'b1',
          manuscriptId: 'm1',
          title: '',
          author: '',
          series: '',
          seriesPosition: null,
          isStandalone: true,
          manuscriptFile: '',
          castConfirmed: false,
          chapters: [],
          coverGradient: ['#000', '#fff'],
          createdAt: '2026-05-15T00:00:00.000Z',
          updatedAt: '2026-05-15T00:00:00.000Z',
        },
        cast: null,
        manuscript: null,
        manuscriptEdits: null,
        revisions: null,
        completedSlugs: [],
        changeLog: null,
        analysis: { failedChapterIds: [] },
      } as BookStateResponse);
  }

  it('renders nothing when the endpoint returns an empty envelope', async () => {
    setEmptyBookState();
    getDroppedQuotesImpl = () => Promise.resolve({ manuscriptId: 'm1', batches: [] });
    renderWithBookId();

    /* Wait for any rendering settled — the panel must not appear. */
    await waitFor(() => expect(screen.queryByText(/verifier dropped/i)).not.toBeInTheDocument());
  });

  it('renders the latest batch grouped by character with the drop reason rendered', async () => {
    setEmptyBookState();
    getDroppedQuotesImpl = () =>
      Promise.resolve({
        manuscriptId: 'm1',
        batches: [
          {
            recordedAt: '2026-05-15T10:00:00.000Z',
            route: 'analysis-stream',
            totalDropped: 3,
            affectedCharacters: 2,
            entries: [
              {
                characterId: 'wren',
                characterName: 'Wren',
                quote: 'fabricated 1',
                truncated: false,
                reason: 'not_in_source',
              },
              {
                characterId: 'wren',
                characterName: 'Wren',
                quote: 'fabricated 2',
                truncated: false,
                reason: 'not_in_source',
              },
              {
                characterId: 'marlow',
                characterName: 'Marlow',
                quote: '   ',
                truncated: false,
                reason: 'empty_after_normalisation',
              },
            ],
          },
        ],
      });
    renderWithBookId();

    /* Header reports the totals. */
    expect(
      await screen.findByText(/Verifier dropped 3 quotes across 2 characters/),
    ).toBeInTheDocument();
    /* Both character groups render. */
    expect(screen.getByText('Wren')).toBeInTheDocument();
    expect(screen.getByText('Marlow')).toBeInTheDocument();
    /* Quotes themselves appear (with quote marks rendered around them). */
    expect(screen.getByText(/fabricated 1/)).toBeInTheDocument();
    expect(screen.getByText(/fabricated 2/)).toBeInTheDocument();
    /* Reason rendered for the empty-after-normalisation branch. */
    expect(screen.getByText('empty after normalisation')).toBeInTheDocument();
  });

  it('shows the [truncated] marker for entries truncated server-side', async () => {
    setEmptyBookState();
    getDroppedQuotesImpl = () =>
      Promise.resolve({
        manuscriptId: 'm1',
        batches: [
          {
            recordedAt: '2026-05-15T10:00:00.000Z',
            route: 'analysis-stream',
            totalDropped: 1,
            affectedCharacters: 1,
            entries: [
              {
                characterId: 'verbose',
                characterName: 'Verbose',
                quote: 'this was originally much longer',
                truncated: true,
                reason: 'not_in_source',
              },
            ],
          },
        ],
      });
    renderWithBookId();
    expect(await screen.findByText(/\[truncated\]/)).toBeInTheDocument();
  });

  it('renders only the latest batch when multiple batches exist', async () => {
    setEmptyBookState();
    getDroppedQuotesImpl = () =>
      Promise.resolve({
        manuscriptId: 'm1',
        batches: [
          {
            recordedAt: '2026-05-15T09:00:00.000Z',
            route: 'analysis-stream',
            totalDropped: 1,
            affectedCharacters: 1,
            entries: [
              {
                characterId: 'a',
                characterName: 'OldOne',
                quote: 'old fabrication',
                truncated: false,
                reason: 'not_in_source',
              },
            ],
          },
          {
            recordedAt: '2026-05-15T10:00:00.000Z',
            route: 'analysis-chapters',
            totalDropped: 1,
            affectedCharacters: 1,
            entries: [
              {
                characterId: 'b',
                characterName: 'NewOne',
                quote: 'recent fabrication',
                truncated: false,
                reason: 'not_in_source',
              },
            ],
          },
        ],
      });
    renderWithBookId();
    expect(await screen.findByText('NewOne')).toBeInTheDocument();
    expect(screen.queryByText('OldOne')).not.toBeInTheDocument();
    expect(screen.queryByText(/old fabrication/)).not.toBeInTheDocument();
  });
});

describe('AnalysingView — stage1 shrink-refused banner', () => {
  it('renders the banner with prev/next counts when the server emits stage1_shrink_refused', async () => {
    /* Pre-arm the analyse mock to reject with the exact AnalysisError
       shape the route emits on a refused shrink. The view's catch block
       handles this code specifically — not a red error banner, but the
       yellow shrink-refused card with the prev/next counts and the
       "Accept smaller roster" button. */
    const { AnalysisError } = await vi.importActual<typeof import('../lib/api')>('../lib/api');
    analyseManuscriptRejection = new AnalysisError(
      'Cast finalisation would drop from 6 to 1 characters.',
      'stage1_shrink_refused',
      undefined,
      6,
      1,
    );
    await renderViewWaitingForAnalysis();

    /* The banner surfaces both counts and offers the override button. */
    const banner = await screen.findByTestId('stage1-shrink-refused-banner');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/6 characters/);
    expect(banner.textContent).toMatch(/replace it with .*1/);
    const acceptBtn = screen.getByRole('button', {
      name: /Accept smaller roster \(1 characters\)/i,
    });
    expect(acceptBtn).toBeInTheDocument();
  });

  it('clicking Accept smaller roster re-fires the analysis with allowStage1Shrink:true', async () => {
    const { AnalysisError } = await vi.importActual<typeof import('../lib/api')>('../lib/api');
    analyseManuscriptRejection = new AnalysisError(
      'Cast finalisation would drop from 5 to 1 characters.',
      'stage1_shrink_refused',
      undefined,
      5,
      1,
    );
    await renderViewWaitingForAnalysis();

    /* First call: no override — captured opts must not include the flag. */
    expect((capturedOpts as AnalyseOpts | undefined)?.allowStage1Shrink).toBeUndefined();

    /* Clear the rejection so the second attempt enters the never-resolving
       branch instead of looping forever in the banner. */
    analyseManuscriptRejection = undefined;

    const acceptBtn = await screen.findByRole('button', { name: /Accept smaller roster/i });
    await act(async () => {
      fireEvent.click(acceptBtn);
    });

    /* Wait for the override to land on capturedOpts. The mock overwrites
       on every call, so the most recent capture is the post-click one. */
    await waitFor(() => {
      expect((capturedOpts as AnalyseOpts | undefined)?.allowStage1Shrink).toBe(true);
    });
  });

  it('Dismiss clears the banner without re-firing with the override', async () => {
    const { AnalysisError } = await vi.importActual<typeof import('../lib/api')>('../lib/api');
    analyseManuscriptRejection = new AnalysisError(
      'Cast finalisation would drop from 4 to 1 characters.',
      'stage1_shrink_refused',
      undefined,
      4,
      1,
    );
    await renderViewWaitingForAnalysis();
    const banner = await screen.findByTestId('stage1-shrink-refused-banner');
    expect(banner).toBeInTheDocument();

    const dismissBtn = screen.getByRole('button', { name: /Dismiss/i });
    await act(async () => {
      fireEvent.click(dismissBtn);
    });
    await waitFor(() =>
      expect(screen.queryByTestId('stage1-shrink-refused-banner')).not.toBeInTheDocument(),
    );

    /* Dismiss must not trigger a re-fire with the override flag.
       The most recent captured opts are still the original (no override)
       call — the dismiss is purely a UI state change. */
    expect((capturedOpts as AnalyseOpts | undefined)?.allowStage1Shrink).toBeUndefined();
  });
});

describe('AnalysingView — cross-navigation analysis snapshot (B2)', () => {
  it('sets analysis.activeStream when the SSE fires so the AnalysisPill can read from Redux', async () => {
    const { store } = await renderViewWaitingForAnalysis();
    /* The view seeds the snapshot when api.analyseManuscript is called.
       Capturing it via the store proves the cross-navigation surface is
       wired — the pill (B3) reads this same snapshot. */
    await waitFor(() => {
      const snap = store.getState().analysis.activeStream;
      expect(snap).not.toBeNull();
    });
    const snap = store.getState().analysis.activeStream!;
    expect(snap.manuscriptId).toBe('m1');
    expect(snap.bookTitle).toBe('the Coalfall Commission');
    expect(snap.state).toBe('running');
    /* D2 — snapshot captures the engine at start time so the reverse
       local-analyzer guard can decide whether to prompt before a
       user-driven TTS start. Default test setup runs qwen3.5:4b
       (local). Mis-classifying this as remote would silently disable
       the reverse guard. */
    expect(snap.engine).toBe('local');
  });

  it('clicking Pause flips analysis.activeStream.state to paused (middleware will fire api.pauseAnalysis)', async () => {
    const { store } = await renderViewWaitingForAnalysis();
    await waitFor(() => expect(store.getState().analysis.activeStream).not.toBeNull());

    /* Drive the SSE handler to streaming state so the button reads
       "Pause analysis" rather than "Start analysis". A single phase
       tick is enough to flip conn → streaming. */
    await act(async () => {
      capturedOpts?.onPhase?.({ phaseId: 0, progress: 0.1 });
    });

    const pauseBtn = await screen.findByRole('button', { name: /pause analysis/i });
    await act(async () => {
      fireEvent.click(pauseBtn);
    });

    await waitFor(() => {
      expect(store.getState().analysis.activeStream?.state).toBe('paused');
    });
  });
});

describe('AnalysingView — series-cast carry-over pill (C3)', () => {
  it('renders the pill when the server emits a series-prior event', async () => {
    /* Server emits series-prior once at Phase 0 entry when the
       analyzer has been pre-seeded with characters from prior books
       in the same series. The view dispatches setSeriesPrior into the
       analysis slice; the pill reads from there so it survives
       reload + cross-navigation. */
    await renderViewWaitingForAnalysis();
    /* Drive the captured callback as if the server emitted the event. */
    await act(async () => {
      (capturedOpts as AnalyseOpts | undefined)?.onSeriesPrior?.({
        count: 41,
        names: ['Wren', 'Marlow', 'Oduvan'],
      });
    });
    const pill = await screen.findByTestId('series-prior-pill');
    expect(pill).toBeInTheDocument();
    expect(pill.textContent).toContain('41');
    expect(pill.textContent).toContain('Wren');
    expect(pill.textContent).toContain('Marlow');
    expect(pill.textContent).toContain('Oduvan');
    /* +N appears when the total exceeds the sample. 41 - 3 = 38. */
    expect(pill.textContent).toMatch(/\+38/);
  });

  it('does NOT render the pill when no series-prior event was emitted (standalone / first-in-series)', async () => {
    await renderViewWaitingForAnalysis();
    /* Drive a phase tick to confirm the analysis effect is alive,
       but never emit series-prior. */
    await act(async () => {
      capturedOpts?.onPhase?.({ phaseId: 0, progress: 0.2 });
    });
    expect(screen.queryByTestId('series-prior-pill')).not.toBeInTheDocument();
  });
});

/* Regression: a browser reload during an in-flight analysis must NOT
   strand the view on "Start analysis" — layout.tsx populates
   s.analysis.activeStream from api.getAnalysisState on mount, and the
   view's local analysisStarted state must rehydrate from that snapshot
   so the SSE subscribe path opens without a button click. Previously
   the user had to click "Start analysis" before the running run became
   visible in the view (the top-bar pill was correct; the view itself
   wasn't), because the new POST took the server's subscribe path. */
describe('AnalysingView — cold-boot rehydration from analysis slice', () => {
  function renderViewWithActiveStream(state: 'running' | 'paused' | 'halted') {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        analysis: analysisSlice.reducer,
        account: accountSlice.reducer,
      },
      preloadedState: {
        analysis: {
          activeStream: {
            bookId: 'book-1',
            manuscriptId: 'm1',
            bookTitle: 'the Coalfall Commission',
            engine: 'gemini' as const,
            phaseId: 1,
            phaseLabel: 'Parsing & attribution',
            phaseProgress: 0.32,
            remainingMs: 45_000,
            lastTickAt: Date.now() - 2_000,
            state,
          },
        },
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

  it('auto-subscribes the SSE when the slice snapshot says state=running (no click needed)', async () => {
    renderViewWithActiveStream('running');
    /* The fetch fires without anyone clicking Start — proving the view
       reconnected from the cross-navigation snapshot on its own. */
    await waitFor(() => expect(capturedOpts).toBeDefined());
    /* And the button now reads Pause (running), not Start. */
    expect(await screen.findByRole('button', { name: /pause analysis/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start analysis/i })).not.toBeInTheDocument();
  });

  it('does NOT auto-subscribe when state=paused but labels the button "Resume analysis"', async () => {
    renderViewWithActiveStream('paused');
    /* Button reads Resume — proving hasStartedOnceRef was set from the
       snapshot even though analysisStarted stayed false. The
       findByRole flushes the cold-boot effect's microtasks, so by the
       time the assertion lands the analysis effect has had its chance
       to (incorrectly) fire and demonstrably hasn't — capturedOpts is
       still undefined. */
    expect(await screen.findByRole('button', { name: /resume analysis/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start analysis/i })).not.toBeInTheDocument();
    expect(capturedOpts).toBeUndefined();
  });
});

/* Bug D regression — the "Overall" progress bar inside the analysing
   view used a naive (phase + phaseProgress) / 3 average while the
   header pill used the work-weighted 0.45/0.5/0.05 formula. At 20%
   through phase 1, naive said 40% but the pill said 55%. Both now use
   the shared `computeOverallProgress` helper, so the % the view renders
   must match the helper. */
describe('AnalysingView — overall progress matches shared helper', () => {
  it('renders 55% at 20% through phase 1 (the screenshot mismatch case)', async () => {
    await renderViewWaitingForAnalysis();
    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 1, progress: 0.2 });
    });
    /* The "Overall" line is a single ranged region with the percent
       rendered next to the label. Probe for the literal "55%". */
    expect(screen.getByText('55%')).toBeInTheDocument();
    /* Anti-regression: the old naive-average buggy value must NOT be on
       screen for this state. */
    expect(screen.queryByText('40%')).not.toBeInTheDocument();
  });
});

/* Plan 118 — the request `model` is gated so the per-phase split can take
   effect. Uses a Gemini model prop so isAnalyzerReady is true without the
   Ollama probe (cloud analyzers have no local lifecycle to wait on). */
describe('AnalysingView — request-model gating (plan 118)', () => {
  async function renderAndStart(opts: {
    modelProp: string;
    splitActive?: boolean;
    explicit?: boolean;
  }) {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        analysis: analysisSlice.reducer,
        account: accountSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          selectedModel: opts.modelProp,
          selectedModelExplicit: opts.explicit ?? false,
        } as ReturnType<typeof uiSlice.getInitialState>,
        account: {
          ...accountSlice.getInitialState(),
          analyzerPhase0Model: opts.splitActive ? 'gemma-4-31b-it' : null,
          analyzerPhase1Model: opts.splitActive ? 'gemini-3.1-flash-lite' : null,
        } as ReturnType<typeof accountSlice.getInitialState>,
      },
    });
    render(
      <Provider store={store}>
        <AnalysingView manuscriptId="m1" title="the Coalfall Commission" model={opts.modelProp} onComplete={() => {}} />
      </Provider>,
    );
    const startBtn = await screen.findByRole('button', { name: /start analysis/i });
    await act(async () => {
      fireEvent.click(startBtn);
    });
    await waitFor(() => expect(capturedOpts).toBeDefined());
  }

  it('sends the selected model when the split is OFF (single-model path preserved)', async () => {
    await renderAndStart({ modelProp: 'gemini-3.1-flash-lite', splitActive: false });
    expect(capturedOpts?.model).toBe('gemini-3.1-flash-lite');
  });

  it('omits the model when the split is ON and no explicit per-run pick (lets per-phase settings apply)', async () => {
    await renderAndStart({ modelProp: 'gemini-3.1-flash-lite', splitActive: true, explicit: false });
    expect(capturedOpts?.model).toBeUndefined();
  });

  it('sends the model when the split is ON but the user made an explicit per-run pick', async () => {
    await renderAndStart({ modelProp: 'gemini-2.5-flash', splitActive: true, explicit: true });
    expect(capturedOpts?.model).toBe('gemini-2.5-flash');
  });
});

/* Regression: the readiness gate must follow the model the run ACTUALLY uses
   (the per-phase split), NOT ui.selectedModel. Field report: the account
   default seeds ui.selectedModel to a local Ollama model on every boot, but the
   per-phase dropdowns route the run to Gemini — and the view stayed "stuck on
   Ollama" (Ollama-not-reachable pill, "Waiting for analyzer…", needs-VRAM hint)
   even though the cloud run never touches Ollama. */
describe('AnalysingView — readiness gate follows the effective per-phase model', () => {
  function makeStore(opts: {
    selectedModel: string;
    phase0?: string | null;
    phase1?: string | null;
  }) {
    return configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        analysis: analysisSlice.reducer,
        account: accountSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          selectedModel: opts.selectedModel,
          selectedModelExplicit: false,
        } as ReturnType<typeof uiSlice.getInitialState>,
        account: {
          ...accountSlice.getInitialState(),
          analyzerPhase0Model: opts.phase0 ?? null,
          analyzerPhase1Model: opts.phase1 ?? null,
        } as ReturnType<typeof accountSlice.getInitialState>,
      },
    });
  }

  it('does not gate on (or even probe) Ollama when the split routes both phases to cloud, despite a local ui.selectedModel', async () => {
    /* Even with Ollama down, a cloud run must not be blocked by it. */
    getOllamaHealthSpy.mockResolvedValue({
      status: 'unreachable',
      url: '(test)',
      error: 'connect ECONNREFUSED',
    });
    const store = makeStore({
      selectedModel: 'qwen3.5:4b', // stale local default seeded from account
      phase0: 'gemma-4-31b-it', // per-phase split → both cloud
      phase1: 'gemini-3.1-flash-lite',
    });
    render(
      <Provider store={store}>
        <AnalysingView manuscriptId="m1" title="Bonus Keefe Story" model="qwen3.5:4b" onComplete={() => {}} />
      </Provider>,
    );
    const startBtn = await screen.findByRole('button', { name: /start analysis/i });
    expect(startBtn).toBeEnabled();
    expect(screen.queryByText(/Ollama not reachable/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Waiting for analyzer/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/resident in VRAM/i)).not.toBeInTheDocument();
    /* The probe effect is gated on isLocalAnalyzer — a cloud-effective run must
       never reach out to Ollama at all. */
    expect(getOllamaHealthSpy).not.toHaveBeenCalled();
  });

  it('still gates on Ollama when the effective run IS local (split off, local default)', async () => {
    getOllamaHealthSpy.mockResolvedValue({
      status: 'unreachable',
      url: '(test)',
      error: 'connect ECONNREFUSED',
    });
    const store = makeStore({ selectedModel: 'qwen3.5:4b' }); // no per-phase split
    render(
      <Provider store={store}>
        <AnalysingView manuscriptId="m1" title="Bonus Keefe Story" model="qwen3.5:4b" onComplete={() => {}} />
      </Provider>,
    );
    expect(await screen.findByText(/Ollama not reachable/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /waiting for analyzer/i })).toBeDisabled();
  });
});

describe('AnalysingView — Wave 2 brand manifesto', () => {
  it('renders "Many voices, one machine." on the analysing screen', () => {
    renderView();
    expect(screen.getByText('Many voices, one machine.')).toBeInTheDocument();
  });
});

describe('AnalysingView — fs-19 classified failure remediation', () => {
  function makeBookStateWithErrors(
    failedIds: number[],
    failedChapterErrors: Record<string, { code: string; message: string; remediation: string }>,
  ): BookStateResponse {
    return {
      state: {
        bookId: 'b1',
        manuscriptId: 'm1',
        title: 'the Coalfall Commission',
        author: '',
        series: '',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'bonus-marlow.txt',
        castConfirmed: false,
        chapters: [
          { id: 2, title: 'Chapter Two', slug: '2-chapter-two', duration: '0:00' },
          { id: 3, title: 'Chapter Three', slug: '3-chapter-three', duration: '0:00' },
          { id: 4, title: 'Chapter Four', slug: '4-chapter-four', duration: '0:00' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: '2026-05-15T00:00:00.000Z',
        updatedAt: '2026-05-15T00:00:00.000Z',
      },
      cast: null,
      manuscript: null,
      manuscriptEdits: null,
      revisions: null,
      completedSlugs: [],
      changeLog: null,
      analysis: { failedChapterIds: failedIds, failedChapterErrors },
    };
  }

  it('renders remediation from a live chapter-failed event (fs-19 analysis half)', async () => {
    getBookStateImpl = () =>
      Promise.resolve(makeBookStateWithErrors([], {}));

    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        analysis: analysisSlice.reducer,
        account: accountSlice.reducer,
      },
    });
    render(
      <Provider store={store}>
        <AnalysingView
          manuscriptId="m1"
          bookId="b1"
          title="the Coalfall Commission"
          wordCount={2440}
          onComplete={() => {}}
        />
      </Provider>,
    );

    const startBtn = await screen.findByRole('button', { name: /start analysis/i });
    await act(async () => {
      fireEvent.click(startBtn);
    });
    await waitFor(() => expect(capturedOpts).toBeDefined());

    await act(async () => {
      capturedOpts!.onChapterFailed!({
        chapterId: 2,
        message: 'The analyzer could not be reached…',
        code: 'analyzer-unreachable',
        remediation: 'Check that Ollama is running…',
      });
    });

    expect(await screen.findByText(/What to do:/)).toBeInTheDocument();
    expect(screen.getByText(/Check that Ollama is running…/)).toBeInTheDocument();
  });

  it('hydrates remediation from book-state failedChapterErrors after reload', async () => {
    getBookStateImpl = () =>
      Promise.resolve(
        makeBookStateWithErrors([3], {
          '3': {
            code: 'attribution-incomplete',
            message: 'Some lines may be unattributed…',
            remediation: 'Click Retry…',
          },
        }),
      );

    const store = configureStore({
      reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, account: accountSlice.reducer },
    });
    render(
      <Provider store={store}>
        <AnalysingView
          manuscriptId="m1"
          bookId="b1"
          title="the Coalfall Commission"
          wordCount={2440}
          onComplete={() => {}}
        />
      </Provider>,
    );

    expect(await screen.findByText(/Some lines may be unattributed…/)).toBeInTheDocument();
    expect(screen.getByText(/What to do:/)).toBeInTheDocument();
    expect(screen.getByText(/Click Retry…/)).toBeInTheDocument();
  });

  it('keeps the legacy generic line when no record exists', async () => {
    getBookStateImpl = () =>
      Promise.resolve(makeBookStateWithErrors([4], {}));

    const store = configureStore({
      reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, account: accountSlice.reducer },
    });
    render(
      <Provider store={store}>
        <AnalysingView
          manuscriptId="m1"
          bookId="b1"
          title="the Coalfall Commission"
          wordCount={2440}
          onComplete={() => {}}
        />
      </Provider>,
    );

    expect(
      await screen.findByText(/failed on a previous attempt/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/What to do:/)).not.toBeInTheDocument();
  });

  it('failed-row with known code renders More-help link (fe-29)', async () => {
    getBookStateImpl = () =>
      Promise.resolve(makeBookStateWithErrors([2], {}));

    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        analysis: analysisSlice.reducer,
        account: accountSlice.reducer,
      },
    });
    render(
      <Provider store={store}>
        <AnalysingView
          manuscriptId="m1"
          bookId="b1"
          title="the Coalfall Commission"
          wordCount={2440}
          onComplete={() => {}}
        />
      </Provider>,
    );

    const startBtn = await screen.findByRole('button', { name: /start analysis/i });
    await act(async () => {
      fireEvent.click(startBtn);
    });
    await waitFor(() => expect(capturedOpts).toBeDefined());

    await act(async () => {
      capturedOpts!.onChapterFailed!({
        chapterId: 2,
        message: 'Ollama not reachable.',
        code: 'analyzer-unreachable',
        remediation: 'Check that Ollama is running.',
      });
    });

    const link = await screen.findByRole('link', { name: /more help/i });
    expect(link).toHaveAttribute('href', '#/help?code=analyzer-unreachable');
  });

  it('failed-row with remediation but no code suppresses More-help link (fe-29)', async () => {
    getBookStateImpl = () =>
      Promise.resolve(makeBookStateWithErrors([2], {}));

    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        analysis: analysisSlice.reducer,
        account: accountSlice.reducer,
      },
    });
    render(
      <Provider store={store}>
        <AnalysingView
          manuscriptId="m1"
          bookId="b1"
          title="the Coalfall Commission"
          wordCount={2440}
          onComplete={() => {}}
        />
      </Provider>,
    );

    const startBtn = await screen.findByRole('button', { name: /start analysis/i });
    await act(async () => {
      fireEvent.click(startBtn);
    });
    await waitFor(() => expect(capturedOpts).toBeDefined());

    await act(async () => {
      capturedOpts!.onChapterFailed!({
        chapterId: 2,
        message: 'Something went wrong.',
        remediation: 'Try again later.',
        /* no code */
      });
    });

    await screen.findByText(/Try again later\./);
    expect(screen.queryByRole('link', { name: /more help/i })).toBeNull();
  });

  it('keeps failure classification (code + remediation) when a retried chapter re-fails', async () => {
    /* Regression: handleRetryChapter's onChapterFailed only forwarded
       `message`, dropping `code` and `remediation`, so the "What to do:"
       line vanished after a retry that re-failed. */
    getBookStateImpl = () =>
      Promise.resolve(makeBookStateWithErrors([2], {}));

    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        analysis: analysisSlice.reducer,
        account: accountSlice.reducer,
      },
    });
    render(
      <Provider store={store}>
        <AnalysingView
          manuscriptId="m1"
          bookId="b1"
          title="the Coalfall Commission"
          wordCount={2440}
          onComplete={() => {}}
        />
      </Provider>,
    );

    /* Click Retry on the hydrated row — this fires runAnalysisForChapters
       and captures its opts in capturedSubsetCall. */
    const retryBtn = await screen.findByRole('button', { name: /retry chapter/i });
    await act(async () => {
      fireEvent.click(retryBtn);
    });
    expect(capturedSubsetCall).toBeDefined();

    /* The server re-emits chapter-failed with classification fields. */
    await act(async () => {
      capturedSubsetCall!.opts!.onChapterFailed!({
        chapterId: 2,
        message: 'The analyzer could not be reached…',
        code: 'analyzer-unreachable',
        remediation: 'Check that Ollama is running…',
      });
    });

    /* The "What to do:" label and remediation text must still be visible. */
    expect(await screen.findByText(/What to do:/)).toBeInTheDocument();
    expect(screen.getByText(/Check that Ollama is running…/)).toBeInTheDocument();
  });
});
