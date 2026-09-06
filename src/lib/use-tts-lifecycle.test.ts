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
    getGpuTripStatus: vi.fn(),
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
  /* GPU capacity-wait queue probe — runs on the same 30 s tick as /health.
     Default to an empty queue so the "GPU busy · N waiting ·" pill prefix
     stays hidden in tests that don't exercise contention. */
  mocks.getGpuQueueState.mockResolvedValue({ queueDepth: 0, devices: [] });
  /* Task 16/16.5 trip-status probe — same 30 s tick. Default to "nothing has
     tripped" so tests that don't exercise it never see a stray tripNotice. */
  mocks.getGpuTripStatus.mockResolvedValue(null);
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

  it('Coqui onStop sets pending state to "unloading" (not "idle") while unloadSidecar is in flight (#1921)', async () => {
    /* #1921: `doStop` used to set the optimistic pending state straight to
       'idle', so the pill read "Voice engine idle · Load model" — inviting a
       Load against a model that had not actually gone yet — while the unload
       (which, per #1894, waits out any in-flight forward and can take up to
       90s) was still running.

       Fails against the wrong implementation: with `setPending(engine, 'idle')`
       still in doStop, `result.current.coqui.state` reads 'idle' here instead
       of 'unloading'. Assert DURING the pending window (deferred promise still
       unresolved), not after — an after-the-fact assertion passes against
       either implementation once /health has re-settled things. */
    mocks.getSidecarHealth.mockResolvedValueOnce({
      status: 'reachable',
      url: '',
      loading: false,
      modelLoaded: true,
      kokoroLoaded: false,
      kokoroLoading: false,
    });
    let resolveUnload: (v: { status: string }) => void = () => {};
    mocks.unloadSidecar.mockReturnValueOnce(
      new Promise((r) => {
        resolveUnload = r;
      }),
    );

    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.coqui.state).toBe('ready'));

    let stopPromise: Promise<void> = Promise.resolve();
    act(() => {
      stopPromise = result.current.coqui.onStop();
    });
    expect(result.current.coqui.state).toBe('unloading');

    await act(async () => {
      resolveUnload({ status: 'ok' });
      await stopPromise;
    });
  });

  it('keeps the "unloading" state across a /health poll tick while the unload is still in flight (#1921)', async () => {
    /* The poll runs on setInterval(probe, 30_000) and EVERY resolution
       unconditionally used to clear all four pending overrides. `doStop` now
       awaits a call with up to a 90s budget (#1894) — precisely the
       mid-render case — so at the 30s tick the probe would land, clear
       pendingCoqui, /health would still report modelLoaded: true, and the
       pill would flip back to "Voice engine ready · Stop", ENABLED, while the
       unload is still blocked on the forward. Same lie as #1921, delayed by
       30 seconds.

       Fails against the wrong implementation: without the in-flight guard,
       after advancing past the 30s tick (with unloadSidecar still pending),
       result.current.coqui.state reads 'ready' instead of 'unloading'. */
    vi.useFakeTimers();
    try {
      mocks.getSidecarHealth.mockResolvedValue({
        status: 'reachable',
        url: '',
        loading: false,
        modelLoaded: true,
        kokoroLoaded: false,
        kokoroLoading: false,
      });
      let resolveUnload: (v: { status: string }) => void = () => {};
      mocks.unloadSidecar.mockReturnValueOnce(
        new Promise((r) => {
          resolveUnload = r;
        }),
      );

      const { result } = renderHook(() => useTtsLifecycle());
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.coqui.state).toBe('ready');

      let stopPromise: Promise<void> = Promise.resolve();
      await act(async () => {
        stopPromise = result.current.coqui.onStop();
        await Promise.resolve();
      });
      expect(result.current.coqui.state).toBe('unloading');

      /* Advance past the 30s poll tick while the unload is STILL pending —
         the probe resolves (mocked as always reachable/modelLoaded: true)
         but must not clear the 'unloading' override. */
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(result.current.coqui.state).toBe('unloading');

      /* Release the hang so the test cleans up. */
      await act(async () => {
        resolveUnload({ status: 'ok' });
        await stopPromise;
      });
    } finally {
      vi.useRealTimers();
    }
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
       only the Kokoro pill flips to 'unloading' optimistically (#1921 — the
       unload is in flight and may take up to 90s per #1894) — the Coqui
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
    expect(result.current.kokoro.state).toBe('unloading');
    expect(result.current.coqui.state).toBe('ready');

    /* Release the hang so the test cleans up. */
    await act(async () => {
      resolveUnload({ status: 'idle' });
      await stopPromise;
    });
  });

  it("clears Kokoro's pending override on ITS OWN probe even while Coqui's Stop is still outstanding (F3)", async () => {
    /* F3: inFlightOps used to be a SINGLE counter shared by all four engines.
       Stop Coqui (can hang up to 90s per #1894/#1921), then Load Kokoro:
       Kokoro's own /health probe (fired by its own onLoad, via
       setHealthProbeKey) confirms kokoroLoaded=true, but a shared counter
       still reads nonzero (Coqui's Stop hasn't resolved) — so the poll's
       guard skips clearing ANY pending override, and Kokoro's pill stays
       stuck on the optimistic 'loading' state until the UNRELATED Coqui
       unload finally resolves.

       Fails against a single shared `inFlightOps` counter: the waitFor below
       times out because kokoro.state never reaches 'ready' while Coqui's
       Stop is still in flight. */
    mocks.getSidecarHealth.mockResolvedValueOnce({
      status: 'reachable',
      url: '',
      loading: false,
      modelLoaded: true,
      kokoroLoaded: false,
      kokoroLoading: false,
    });

    let resolveUnload: (v: { status: string }) => void = () => {};
    mocks.unloadSidecar.mockReturnValueOnce(
      new Promise((r) => {
        resolveUnload = r;
      }),
    );

    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.coqui.state).toBe('ready'));
    expect(result.current.kokoro.state).toBe('idle');

    /* Start the long-running Coqui Stop — it hangs, matching the up-to-90s
       #1894 wait for the in-flight forward to drain. */
    let stopPromise: Promise<void> = Promise.resolve();
    await act(async () => {
      stopPromise = result.current.coqui.onStop();
      await Promise.resolve();
    });
    expect(result.current.coqui.state).toBe('unloading');

    /* The NEXT /health probe — fired by Kokoro's own Load via
       setHealthProbeKey — confirms Kokoro is now resident. */
    mocks.getSidecarHealth.mockResolvedValueOnce({
      status: 'reachable',
      url: '',
      loading: false,
      modelLoaded: true,
      kokoroLoaded: true,
      kokoroLoading: false,
    });

    await act(async () => {
      await result.current.kokoro.onLoad();
    });

    /* Kokoro's own probe confirmed residency — its pending override must
       clear even though Coqui's Stop is still outstanding. */
    await waitFor(() => expect(result.current.kokoro.state).toBe('ready'));
    /* Coqui's pending override is untouched by Kokoro's unrelated probe. */
    expect(result.current.coqui.state).toBe('unloading');

    /* Release the hang so the test cleans up. */
    await act(async () => {
      resolveUnload({ status: 'ok' });
      await stopPromise;
    });
  });

  it('exposes the GPU capacity-wait queue depth from /api/gpu/queue on the same tick', async () => {
    /* Hook polls /api/gpu/queue alongside /api/sidecar/health so the
       top-bar pill can prefix "GPU busy · N waiting ·". When queueDepth > 0
       the hook surfaces it on TtsLifecycle.gpuQueueDepth; consumer
       (layout.tsx) decides whether to render the prefix. */
    mocks.getGpuQueueState.mockResolvedValueOnce({ queueDepth: 2, devices: [] });
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.gpuQueueDepth).toBe(2));
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
  });

  it('Task 16/16.5: surfaces the reverted trip toast from /api/gpu/trip-status on the same tick', async () => {
    mocks.getGpuTripStatus.mockResolvedValueOnce({
      status: 'reverted',
      card: 1,
      engines: ['qwen'],
      toast: 'Auto-reverted: GPU pin for qwen looked structurally too small and was reset to auto.',
    });
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() =>
      expect(result.current.tripNotice).toBe(
        'Auto-reverted: GPU pin for qwen looked structurally too small and was reset to auto.',
      ),
    );
  });

  it('Task 16/16.5: surfaces the unrevertable trip toast, and dismissNotices clears it', async () => {
    mocks.getGpuTripStatus.mockResolvedValue({
      status: 'unrevertable',
      toast: 'Voice engine kept crash-looping, but not tied to a specific GPU card — manual investigation needed.',
    });
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.tripNotice).not.toBeNull());

    act(() => {
      result.current.dismissNotices();
    });
    expect(result.current.tripNotice).toBeNull();
  });

  it('reports qwen1_7bInstalled=true when /health (reachable) affirms the 1.7B weights are present', async () => {
    mocks.getSidecarHealth.mockResolvedValueOnce({
      status: 'reachable',
      url: '',
      loading: false,
      modelLoaded: false,
      kokoroLoaded: false,
      kokoroLoading: false,
      qwenLoaded: false,
      qwenLoading: false,
      qwenBase17WeightsPresent: true,
    });
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.qwen1_7bInstalled).toBe(true));
  });

  it('reports qwen1_7bInstalled=false when /health (reachable) affirms the 1.7B weights are absent', async () => {
    mocks.getSidecarHealth.mockResolvedValueOnce({
      status: 'reachable',
      url: '',
      loading: false,
      modelLoaded: false,
      kokoroLoaded: false,
      kokoroLoading: false,
      qwenLoaded: false,
      qwenLoading: false,
      qwenBase17WeightsPresent: false,
    });
    const { result } = renderHook(() => useTtsLifecycle());
    /* Gate on the actual field under test, not `coqui.state === 'idle'` —
       that's true BOTH before sidecarHealth is set (the hook's synchronous
       initial-render default) AND after the mocked health probe resolves,
       so it doesn't distinguish pre- from post-probe and the very next
       assertion below used to race the mock's promise (#1841 CI triage). */
    await waitFor(() => expect(result.current.qwen1_7bInstalled).toBe(false));
  });

  it('#1841 finding 2: reports qwen1_7bInstalled=undefined (unknown), NOT false, when the sidecar is unreachable', async () => {
    /* This is the actual bug: an unreachable/down/recycling sidecar carries
       no qwenBase17WeightsPresent field at all, and reading that as "not
       installed" (false) disables 1.7B in the Start-generation modal and,
       on confirm, silently clears every 1.7B pin across the whole cast. */
    mocks.getSidecarHealth.mockResolvedValueOnce({
      status: 'unreachable',
      url: '',
      error: 'Sidecar returned 503',
    });
    const { result } = renderHook(() => useTtsLifecycle());
    await waitFor(() => expect(result.current.coqui.state).toBe('unreachable'));
    expect(result.current.qwen1_7bInstalled).toBeUndefined();
  });

  it('#1841 finding 2: reports qwen1_7bInstalled=undefined before the first probe resolves', () => {
    const { result } = renderHook(() => useTtsLifecycle());
    expect(result.current.qwen1_7bInstalled).toBeUndefined();
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
