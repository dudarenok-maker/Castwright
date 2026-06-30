/* Pin the contract of useTtsLifecycle so a future refactor that consolidates
   it with Generation view's local pills (or hoists state to Redux) can't
   silently regress:

   - One /health probe drives BOTH the Coqui and Kokoro pill states.
   - Coqui load auto-evicts the analyzer first and surfaces the eviction banner
     only when the analyzer was actually resident.
   - Kokoro load does NOT touch the analyzer (1 GB Kokoro + 7 GB Ollama fits an
     8 GB GPU per plan 14a) — important regression net for the VRAM math.
   - load/unload call the right engine on the wire (`api.loadSidecar({engine})`)
     so the proxy can dispatch Coqui vs. Kokoro correctly.
   - Optimistic pending state is per-engine — a Stop click on one engine doesn't
     drag the other pill into 'idle'. */

import { renderHook, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getSidecarHealth: vi.fn(),
    getGpuQueueState: vi.fn(),
    getOllamaHealth: vi.fn(),
    unloadAnalyzer: vi.fn(),
    loadSidecar: vi.fn(),
    unloadSidecar: vi.fn(),
  },
}));

vi.mock('./api', () => ({ api: mocks }));

import { useTtsLifecycle } from './use-tts-lifecycle';

beforeEach(() => {
  mocks.getSidecarHealth.mockResolvedValue({
    status: 'reachable',
    url: '',
    loading: false,
    modelLoaded: false,
    kokoroLoaded: false,
    kokoroLoading: false,
    qwenLoaded: false,
    qwenLoading: false,
  });
  /* GPU semaphore queue probe — runs on the same 30 s tick as /health.
     Default to an empty queue so the "GPU busy · N waiting ·" pill prefix
     stays hidden in tests that don't exercise contention. */
  mocks.getGpuQueueState.mockResolvedValue({ depth: 0, inFlight: 0, max: 1 });
  mocks.getOllamaHealth.mockResolvedValue({
    status: 'reachable',
    modelResident: true,
  });
  mocks.unloadAnalyzer.mockResolvedValue({ status: 'ok' });
  mocks.loadSidecar.mockResolvedValue({ status: 'ok' });
  mocks.unloadSidecar.mockResolvedValue({ status: 'ok' });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useTtsLifecycle', () => {
  it('starts both engines in "idle" before the first probe completes', () => {
    const { result } = renderHook(() => useTtsLifecycle());
    expect(result.current.coqui.state).toBe('idle');
    expect(result.current.kokoro.state).toBe('idle');
  });

  it('flips Coqui pill to "ready" when /health reports modelLoaded=true', async () => {
    mocks.getSidecarHealth.mockResolvedValueOnce({
      status: 'reachable',
      url: '',
      loading: false,
      modelLoaded: true,
      kokoroLoaded: false,
      kokoroLoading: false,
    });
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.coqui.state).toBe('ready'));
    expect(result.current.kokoro.state).toBe('idle');
  });

  it('flips Kokoro pill to "ready" when /health reports kokoroLoaded=true', async () => {
    /* The eager-preload reality: Kokoro is loaded from startup so the
       first /health probe usually reports ready=true. Coqui starts unloaded
       (PRELOAD_COQUI=0). Both states fan out from one response. */
    mocks.getSidecarHealth.mockResolvedValueOnce({
      status: 'reachable',
      url: '',
      loading: false,
      modelLoaded: false,
      kokoroLoaded: true,
      kokoroLoading: false,
    });
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.kokoro.state).toBe('ready'));
    expect(result.current.coqui.state).toBe('idle');
  });

  it('exposes display-only ASR state (enabled/loaded/device) from the same /health probe', async () => {
    mocks.getSidecarHealth.mockResolvedValueOnce({
      status: 'reachable',
      url: '',
      loading: false,
      modelLoaded: false,
      kokoroLoaded: false,
      kokoroLoading: false,
      qwenLoaded: false,
      qwenLoading: false,
      asrEnabled: true,
      asrLoaded: true,
      asrDevice: 'cuda',
    });
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.asr.state).toBe('ready'));
    expect(result.current.asr.enabled).toBe(true);
    expect(result.current.asr.device).toBe('cuda');
  });

  it('reports ASR disabled + idle when the server omits the asr fields (SEG_ASR_ENABLED off)', async () => {
    /* The default beforeEach /health has no asr fields → enabled false, idle. */
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.asr.enabled).toBe(false));
    expect(result.current.asr.state).toBe('idle');
    expect(result.current.asr.device).toBeNull();
  });

  it('drives both pills from a SINGLE /health probe per tick (one-poll invariant)', async () => {
    /* The architectural rule plan 30 G1 enforced and BACKLOG #15 protects:
       per-engine fan-out must not introduce a second poll. After one mount
       cycle + first probe, getSidecarHealth must have been called exactly
       once. */
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.coqui.state).toBe('idle'));
    expect(mocks.getSidecarHealth).toHaveBeenCalledTimes(1);
  });

  it('flips both pills to "unreachable" when /health rejects', async () => {
    mocks.getSidecarHealth.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.coqui.state).toBe('unreachable'));
    expect(result.current.kokoro.state).toBe('unreachable');
  });

  it('Coqui onLoad auto-evicts the analyzer and surfaces the eviction banner when analyzer WAS resident', async () => {
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.coqui.state).toBe('idle'));

    await act(async () => {
      await result.current.coqui.onLoad();
    });

    expect(mocks.unloadAnalyzer).toHaveBeenCalledOnce();
    expect(mocks.loadSidecar).toHaveBeenCalledOnce();
    expect(mocks.loadSidecar).toHaveBeenCalledWith({ engine: 'coqui' });
    expect(result.current.evictionNotice).toBe(
      'Analyzer unloaded to free VRAM for the voice engine.',
    );
  });

  it('Coqui onLoad does NOT surface the eviction banner when analyzer was already unloaded', async () => {
    mocks.getOllamaHealth.mockResolvedValueOnce({
      status: 'reachable',
      modelResident: false,
    });
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.coqui.state).toBe('idle'));

    await act(async () => {
      await result.current.coqui.onLoad();
    });

    /* unloadAnalyzer still fires (idempotent) but the banner stays off
       because we only show it when the unload actually freed something. */
    expect(mocks.unloadAnalyzer).toHaveBeenCalledOnce();
    expect(result.current.evictionNotice).toBeNull();
  });

  it('Kokoro onLoad does NOT touch the analyzer (1 GB Kokoro fits alongside Ollama)', async () => {
    /* Regression net for the plan 14a VRAM invariant: Kokoro's footprint is
       small enough to coexist with the analyzer; auto-evicting on every
       Kokoro Load would needlessly trash the analyzer's residency and
       trigger a re-warm the next time the user runs analysis. */
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.kokoro.state).toBe('idle'));

    await act(async () => {
      await result.current.kokoro.onLoad();
    });

    expect(mocks.unloadAnalyzer).not.toHaveBeenCalled();
    expect(mocks.getOllamaHealth).not.toHaveBeenCalled();
    expect(mocks.loadSidecar).toHaveBeenCalledOnce();
    expect(mocks.loadSidecar).toHaveBeenCalledWith({ engine: 'kokoro' });
    expect(result.current.evictionNotice).toBeNull();
  });

  it('Coqui onLoad surfaces a load-error banner when loadSidecar returns status=error', async () => {
    mocks.loadSidecar.mockResolvedValueOnce({ status: 'error', error: 'weights missing' });
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.coqui.state).toBe('idle'));

    await act(async () => {
      await result.current.coqui.onLoad();
    });

    expect(result.current.loadErrorNotice).toBe('weights missing');
  });

  it('Coqui onLoad surfaces a load-error banner when loadSidecar throws', async () => {
    mocks.loadSidecar.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.coqui.state).toBe('idle'));

    await act(async () => {
      await result.current.coqui.onLoad();
    });

    expect(result.current.loadErrorNotice).toMatch(/connect ECONNREFUSED/);
  });

  it('Coqui onStop calls unloadSidecar with engine=coqui and clears any prior notices', async () => {
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.coqui.state).toBe('idle'));

    /* Plant a notice via onLoad first, then verify onStop clears it. */
    await act(async () => {
      await result.current.coqui.onLoad();
    });
    expect(result.current.evictionNotice).not.toBeNull();

    await act(async () => {
      await result.current.coqui.onStop();
    });
    expect(mocks.unloadSidecar).toHaveBeenCalledOnce();
    expect(mocks.unloadSidecar).toHaveBeenCalledWith({ engine: 'coqui' });
    expect(result.current.evictionNotice).toBeNull();
    expect(result.current.loadErrorNotice).toBeNull();
  });

  it('Kokoro onStop calls unloadSidecar with engine=kokoro', async () => {
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.kokoro.state).toBe('idle'));

    await act(async () => {
      await result.current.kokoro.onStop();
    });
    expect(mocks.unloadSidecar).toHaveBeenCalledOnce();
    expect(mocks.unloadSidecar).toHaveBeenCalledWith({ engine: 'kokoro' });
  });

  it('flips the Qwen pill to "ready" when /health reports qwenLoaded=true', async () => {
    /* Plan 108: the bespoke Qwen engine reports through the same /health
       response (qwenLoaded / qwenLoading) — the third consumer the
       BACKLOG #15 fan-out anticipated. */
    mocks.getSidecarHealth.mockResolvedValueOnce({
      status: 'reachable',
      url: '',
      loading: false,
      modelLoaded: false,
      kokoroLoaded: false,
      kokoroLoading: false,
      qwenLoaded: true,
      qwenLoading: false,
    });
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.qwen.state).toBe('ready'));
    expect(result.current.coqui.state).toBe('idle');
    expect(result.current.kokoro.state).toBe('idle');
  });

  it('flips the Qwen pill to "loading" when /health reports qwenLoading=true', async () => {
    mocks.getSidecarHealth.mockResolvedValueOnce({
      status: 'reachable',
      url: '',
      loading: false,
      modelLoaded: false,
      kokoroLoaded: false,
      kokoroLoading: false,
      qwenLoaded: false,
      qwenLoading: true,
    });
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.qwen.state).toBe('loading'));
  });

  it('Qwen onLoad does NOT touch the analyzer (treated like Kokoro, not Coqui)', async () => {
    /* Qwen must not auto-evict the analyzer — only Coqui does. Regression
       net for the plan 108 residency rule. */
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.qwen.state).toBe('idle'));

    await act(async () => {
      await result.current.qwen.onLoad();
    });

    expect(mocks.unloadAnalyzer).not.toHaveBeenCalled();
    expect(mocks.getOllamaHealth).not.toHaveBeenCalled();
    expect(mocks.loadSidecar).toHaveBeenCalledOnce();
    expect(mocks.loadSidecar).toHaveBeenCalledWith({ engine: 'qwen' });
    expect(result.current.evictionNotice).toBeNull();
  });

  it('Qwen onStop calls unloadSidecar with engine=qwen', async () => {
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.qwen.state).toBe('idle'));

    await act(async () => {
      await result.current.qwen.onStop();
    });
    expect(mocks.unloadSidecar).toHaveBeenCalledOnce();
    expect(mocks.unloadSidecar).toHaveBeenCalledWith({ engine: 'qwen' });
  });

  it('drives all THREE pills from a SINGLE /health probe per tick (one-poll invariant)', async () => {
    /* Adding the Qwen consumer must NOT introduce a second poll — the
       BACKLOG #15 / plan 30 G1 invariant. After one mount cycle the
       sidecar /health probe must have fired exactly once even though three
       engine pills read from it. */
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.qwen.state).toBe('idle'));
    expect(mocks.getSidecarHealth).toHaveBeenCalledTimes(1);
  });

  it('Kokoro pending state does not bleed into Coqui pill', async () => {
    /* Per-engine pending override: when the user clicks Stop on Kokoro,
       only the Kokoro pill flips to 'idle' optimistically — the Coqui
       pill keeps its current state until the next /health resolve. */
    mocks.getSidecarHealth.mockResolvedValueOnce({
      status: 'reachable',
      url: '',
      loading: false,
      modelLoaded: true,
      kokoroLoaded: true,
      kokoroLoading: false,
    });
    /* Make the unload promise hang so the pending override stays in place
       long enough for assertion. */
    let resolveUnload: (v: { status: string }) => void = () => {};
    mocks.unloadSidecar.mockReturnValueOnce(
      new Promise((r) => {
        resolveUnload = r;
      }),
    );

    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.coqui.state).toBe('ready'));
    expect(result.current.kokoro.state).toBe('ready');

    let stopPromise: Promise<void> = Promise.resolve();
    act(() => {
      stopPromise = result.current.kokoro.onStop();
    });
    /* Pending override fires synchronously inside onStop before the await. */
    expect(result.current.kokoro.state).toBe('idle');
    expect(result.current.coqui.state).toBe('ready');

    /* Release the hang so the test cleans up. */
    await act(async () => {
      resolveUnload({ status: 'idle' });
      await stopPromise;
    });
  });

  it('exposes the GPU semaphore queue depth from /api/gpu/queue on the same tick', async () => {
    /* Hook polls /api/gpu/queue alongside /api/sidecar/health so the
       top-bar pill can prefix "GPU busy · N waiting ·". When depth > 0 the
       hook surfaces it on TtsLifecycle.gpuQueueDepth; consumer
       (layout.tsx) decides whether to render the prefix. */
    mocks.getGpuQueueState.mockResolvedValueOnce({ depth: 2, inFlight: 1, max: 1 });
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.gpuQueueDepth).toBe(2));
    expect(result.current.gpuInFlight).toBe(1);
  });

  it('clears gpuQueueDepth to undefined when /api/gpu/queue rejects (older server graceful-degrade)', async () => {
    /* A partial deploy where the Node server is older than the
       frontend (no /api/gpu/queue route) shouldn't surface as a
       user-facing error — the pill just drops back to its default
       label. */
    mocks.getGpuQueueState.mockRejectedValueOnce(new Error('HTTP 404'));
    const { result } = renderHook(() => useTtsLifecycle());
    /* First wait for the sidecar probe to settle so the hook is past
       its initial mount before we assert on the queue field. */
    await waitFor(() => expect(result.current.coqui.state).toBe('idle'));
    expect(result.current.gpuQueueDepth).toBeUndefined();
    expect(result.current.gpuInFlight).toBeUndefined();
  });

  it('dismissNotices clears both banner strings without calling the API', async () => {
    mocks.loadSidecar.mockResolvedValueOnce({ status: 'error', error: 'X' });
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.coqui.state).toBe('idle'));

    await act(async () => {
      await result.current.coqui.onLoad();
    });
    expect(result.current.loadErrorNotice).toBe('X');

    const callsBefore = mocks.loadSidecar.mock.calls.length + mocks.unloadSidecar.mock.calls.length;
    act(() => {
      result.current.dismissNotices();
    });
    expect(result.current.evictionNotice).toBeNull();
    expect(result.current.loadErrorNotice).toBeNull();
    const callsAfter = mocks.loadSidecar.mock.calls.length + mocks.unloadSidecar.mock.calls.length;
    expect(callsAfter).toBe(callsBefore);
  });
});
