/* useTtsLifecycle — single source of truth for both TTS engine pills'
   state and the Load / Stop side-effects (analyzer auto-evict + sidecar
   load/unload per engine).

   Lifted out of `views/generation.tsx` so the same state powers both the
   Generation view's pills AND the global pills in `layout.tsx`'s top bar.
   The hook owns its own /health poll and pending-override state; call it
   ONCE per app instance — Layout calls it and exposes the result via
   LayoutContext so descendant views (Generation today, others as they
   arrive) read the same state without spinning up a parallel poll.

   ─── Hard invariant: one hook, one poll, one /health response ──────────
   Coqui, Kokoro AND Qwen engine states all fan out from the SAME 30 s
   setInterval below. Do NOT split into per-engine hooks — that was the
   duplicated-poll situation plan 30 G1 consolidated away, and the
   per-engine fan-out here is what BACKLOG #15 documents as the seam a
   third consumer would extend (without adding a second poll). The /health
   response carries every engine's load state in one shot (see
   server/src/routes/sidecar-health.ts forwarding `kokoroLoaded` /
   `kokoroLoading` and `qwenLoaded` / `qwenLoading` alongside Coqui's
   `modelLoaded` / `loading`).

   The hook deliberately keeps `playSampleWithAutoLoad` out of scope:
   sample-Play surfaces (drawer, cast row) still trigger their own JIT
   warm independently. Plan 30 explicitly preserves that path. */

import { useEffect, useRef, useState } from 'react';
import { api, type SidecarHealth, type GpuQueueState, type GpuTripStatus } from './api';
import type { ModelControlState } from '../components/ModelControlPill';

export interface EngineLifecycle {
  state: ModelControlState;
  onLoad: () => Promise<void>;
  onStop: () => Promise<void>;
}

/** ASR (Whisper) is display-only in the model-watch — it loads lazily on
    /transcribe and idle-evicts, so there is no Load/Stop affordance, just a
    resident indicator + the device it runs on. */
export interface AsrLifecycle {
  /** Whether the server has ASR content-QA enabled (SEG_ASR_ENABLED). The
      model-watch only shows an ASR pill when this is true. */
  enabled: boolean;
  state: ModelControlState;
  device: string | null;
}

export interface TtsLifecycle {
  /** Coqui XTTS — button-driven, ~3 GB VRAM, auto-evicts the analyzer on Load. */
  coqui: EngineLifecycle;
  /** Kokoro v1 — eager-loaded at sidecar startup, ~1 GB VRAM, does NOT auto-
      evict the analyzer (fits alongside Ollama on an 8 GB GPU per plan 14a). */
  kokoro: EngineLifecycle;
  /** Qwen 0.6B-Base — bespoke per-character engine (plan 108), button-driven.
      Treated like Kokoro for residency: does NOT auto-evict the analyzer. */
  qwen: EngineLifecycle;
  /** Qwen 1.7B-Base — larger synth model for the anchored emotion-variant
      workflow (fs-55). Button-driven via POST /load {engine:"qwen",model:"1.7b"}.
      Does NOT auto-evict the analyzer. */
  qwen1_7b: EngineLifecycle;
  /** Whisper ASR content-QA engine (srv-31). Display-only — no Load/Stop. */
  asr: AsrLifecycle;
  /** Whether the Qwen 1.7B base weights are on disk. INSTALLED, not loaded —
      `qwen1_7b.state === 'ready'` is residency and is a different question.

      Tri-state, and the third state matters: `sidecarHealth.qwenBase17WeightsPresent`
      only exists on a REACHABLE /health response (server/src/routes/sidecar-health.ts
      only maps it in the reachable branch). While the sidecar is down, recycling, or
      hasn't answered the first probe yet, there is no signal either way — that is
      UNKNOWN, not "not installed".
        - `true`      — probe reachable, weights affirmatively present.
        - `false`     — probe reachable, weights affirmatively absent.
        - `undefined` — no reachable answer yet (down / recycling / unprobed).
      Consumers (the Start-generation modal) MUST treat `undefined` as available,
      not disabled — see that modal's own comment for why (recoverable failed
      run vs. unrecoverable silent loss of every 1.7B cast pin). */
  qwen1_7bInstalled: boolean | undefined;
  /** Inline banner copy: "Analyzer unloaded to free VRAM for TTS." Shared
      slot — only one engine load is in flight at a time so a single notice
      surface is correct. */
  evictionNotice: string | null;
  /** Rose banner copy when Load/Stop returns {status:'error',...} or the
      request itself throws. Shared slot for the same reason. */
  loadErrorNotice: string | null;
  /** Surface-local "dismiss this notice" affordance. The hook owns the
      notice state because both pills share it; either surface clearing it
      should clear it everywhere. */
  dismissNotices: () => void;
  /** GPU capacity-wait queue depth — number of synth ops currently parked
      behind a no-capacity 503, waiting for VRAM to free up (vram-aware
      placement, Task 10 — server/src/tts/sidecar.ts getCapacityWaiterCount()).
      Drives the "GPU busy · N waiting ·" prefix on the top-bar pill so a
      session waiting on another's sidecar call can see why it's not
      starting. `undefined` when the server doesn't expose `/api/gpu/queue`
      (older builds / partial deploys) — UI degrades to no prefix in that
      case. */
  gpuQueueDepth?: number;
  /** Task 16/16.5 (#1230 item 2, #2974) — "Auto-reverted: GPU pin for ... was
      reset to auto." (a card-specific code-43 streak was reverted and TTS
      brought back) or "...not tied to a specific GPU card... manual
      investigation needed." (a non-card-specific streak — nothing was
      reverted, TTS is still held down). `null` when nothing has tripped
      since the server booted, or the server predates GET /api/gpu/trip-status.
      Surface-local dismiss via `dismissNotices()`, same as the other two. */
  tripNotice: string | null;
}

type EngineId = 'coqui' | 'kokoro' | 'qwen' | 'qwen1_7b';

export function useTtsLifecycle(): TtsLifecycle {
  const [sidecarHealth, setSidecarHealth] = useState<SidecarHealth | null>(null);
  const [gpuQueue, setGpuQueue] = useState<GpuQueueState | null>(null);
  const [healthProbeKey, setHealthProbeKey] = useState(0);
  /* Pending UI override — per-engine, set immediately on Load/Stop click so
     the right pill reports the intended next state while /health catches up.
     Cleared on the next probe that confirms the transition. Per-engine so a
     Stop on Kokoro doesn't clobber Coqui's optimistic state. */
  const [pendingCoqui, setPendingCoqui] = useState<ModelControlState | null>(null);
  const [pendingKokoro, setPendingKokoro] = useState<ModelControlState | null>(null);
  const [pendingQwen, setPendingQwen] = useState<ModelControlState | null>(null);
  const [pendingQwen17b, setPendingQwen17b] = useState<ModelControlState | null>(null);
  const [evictionNotice, setEvictionNotice] = useState<string | null>(null);
  const [loadErrorNotice, setLoadErrorNotice] = useState<string | null>(null);
  /* Task 16/16.5 — last-seen trip-status toast, or null once dismissed or
     never tripped. Tracks the toast STRING, not the raw GpuTripStatus, so a
     dismiss doesn't need to remember which trip it dismissed — the poll
     below only re-sets it when the toast text actually changes (see the
     lastTripToast ref), so a dismissed notice doesn't reappear on the very
     next 30s tick for the same still-current trip. */
  const [tripNotice, setTripNotice] = useState<string | null>(null);
  const lastTripToast = useRef<string | null>(null);
  /* In-flight op counter — guards the /health poll's unconditional pending-
     clear below against a Load/Stop that is still awaiting its response.
     Since #1894 a Stop can await a 90 s budget (the sidecar waits out an
     in-flight forward before dropping the model), so the 30 s poll tick can
     land WHILE a Stop is still pending. Without this guard the poll would
     clear the optimistic 'unloading' override and the pill would flip back
     to the stale (still-resident) 'ready' reading — the same lie #1921 is
     about, delayed by 30 seconds. Incremented at the top of doLoad/doStop,
     decremented in a finally; the poll only clears a given engine's pending
     override when THAT engine reads zero.

     Per-engine (F3): a single shared counter would make e.g. a 90 s Coqui
     Stop hold the Kokoro pill's pending 'loading' override hostage — Kokoro's
     own Load finishes and its probe would confirm the transition, but the
     guard above saw a nonzero total and skipped clearing ANY engine's
     pending, so Kokoro's pill stays stuck reading 'loading' until the
     unrelated Coqui unload resolves. */
  const inFlightOps = useRef<Record<EngineId, number>>({ coqui: 0, kokoro: 0, qwen: 0, qwen1_7b: 0 });

  /* Clears each engine's pending override independently — only the engines
     with no in-flight Load/Stop of their own. See the inFlightOps comment
     above for why this must be per-engine rather than a single guard. */
  const clearSettledPendings = () => {
    if (inFlightOps.current.coqui === 0) setPendingCoqui(null);
    if (inFlightOps.current.kokoro === 0) setPendingKokoro(null);
    if (inFlightOps.current.qwen === 0) setPendingQwen(null);
    if (inFlightOps.current.qwen1_7b === 0) setPendingQwen17b(null);
  };

  useEffect(() => {
    let cancelled = false;
    const probe = () => {
      api
        .getSidecarHealth()
        .then((h) => {
          if (cancelled) return;
          setSidecarHealth(h);
          clearSettledPendings();
        })
        .catch(() => {
          if (cancelled) return;
          setSidecarHealth({ status: 'unreachable', url: '', error: 'Probe failed.' });
          clearSettledPendings();
        });

      /* GPU queue state — same cadence, separate endpoint. Permissive
         error handling: an older server (or a transient 404 / 5xx) just
         clears the depth so the pill drops back to its default label;
         it does NOT surface as a user-facing error. This is opportunistic
         UX, not a hard contract. */
      api
        .getGpuQueueState()
        .then((q) => {
          if (cancelled) return;
          setGpuQueue(q);
        })
        .catch(() => {
          if (cancelled) return;
          setGpuQueue(null);
        });

      /* Task 16/16.5 — same permissive-error posture as the queue probe above:
         an older server or a transient failure just means no trip toast, not
         a user-visible error. Only pushes a NEW toast into state (via the
         lastTripToast ref) — a dismissed notice must not resurrect itself on
         the very next tick for the same still-current trip. */
      api
        .getGpuTripStatus()
        .then((t: GpuTripStatus) => {
          if (cancelled) return;
          const toast = t?.toast ?? null;
          if (toast !== lastTripToast.current) {
            lastTripToast.current = toast;
            setTripNotice(toast);
          }
        })
        .catch(() => {
          /* leave whatever notice/dismiss state is already showing */
        });
    };
    probe();
    const id = setInterval(probe, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [healthProbeKey]);

  const coquiState: ModelControlState = (() => {
    if (pendingCoqui) return pendingCoqui;
    if (!sidecarHealth) return 'idle';
    if (sidecarHealth.status === 'unreachable') return 'unreachable';
    if (sidecarHealth.loading) return 'loading';
    if (sidecarHealth.modelLoaded) return 'ready';
    return 'idle';
  })();

  const kokoroState: ModelControlState = (() => {
    if (pendingKokoro) return pendingKokoro;
    if (!sidecarHealth) return 'idle';
    if (sidecarHealth.status === 'unreachable') return 'unreachable';
    if (sidecarHealth.kokoroLoading) return 'loading';
    if (sidecarHealth.kokoroLoaded) return 'ready';
    return 'idle';
  })();

  const qwenState: ModelControlState = (() => {
    if (pendingQwen) return pendingQwen;
    if (!sidecarHealth) return 'idle';
    if (sidecarHealth.status === 'unreachable') return 'unreachable';
    if (sidecarHealth.qwenLoading) return 'loading';
    if (sidecarHealth.qwenLoaded) return 'ready';
    return 'idle';
  })();

  const qwen1_7bState: ModelControlState = (() => {
    if (pendingQwen17b) return pendingQwen17b;
    if (!sidecarHealth) return 'idle';
    if (sidecarHealth.status === 'unreachable') return 'unreachable';
    if (sidecarHealth.qwenBase17Loaded) return 'ready';
    return 'idle';
  })();

  /* ASR is display-only: 'ready' when the Whisper model is resident, 'idle'
     otherwise (it loads lazily on /transcribe + idle-evicts, so there's no
     'loading' state to surface and no Load/Stop). */
  const asrState: ModelControlState = (() => {
    if (!sidecarHealth) return 'idle';
    if (sidecarHealth.status === 'unreachable') return 'unreachable';
    if (sidecarHealth.asrLoaded) return 'ready';
    return 'idle';
  })();

  const setPending = (engine: EngineId, next: ModelControlState | null) => {
    if (engine === 'kokoro') setPendingKokoro(next);
    else if (engine === 'qwen') setPendingQwen(next);
    else if (engine === 'qwen1_7b') setPendingQwen17b(next);
    else setPendingCoqui(next);
  };

  const doLoad = async (engine: EngineId) => {
    inFlightOps.current[engine] += 1;
    try {
      setPending(engine, 'loading');
      setEvictionNotice(null);
      setLoadErrorNotice(null);
      /* Auto-evict the analyzer ONLY when loading Coqui — Coqui's ~3 GB
         fights the analyzer for VRAM on an 8 GB GPU; Kokoro's ~1 GB fits
         alongside the analyzer (plan 14a) so its Load is a no-op for the
         analyzer's residency. */
      if (engine === 'coqui') {
        let analyzerWasLoaded = false;
        try {
          const ollama = await api.getOllamaHealth();
          analyzerWasLoaded = ollama.status === 'reachable' && ollama.modelResident === true;
        } catch {
          /* If the analyzer probe fails we still try to unload — Ollama might
             be reachable for /api/generate even if /api/ps is flaky. */
        }
        try {
          await api.unloadAnalyzer();
          if (analyzerWasLoaded) {
            setEvictionNotice('Analyzer unloaded to free VRAM for the voice engine.');
          }
        } catch {
          /* Ollama down or no model loaded — proceed with TTS load anyway. */
        }
      }
      /* The /api/sidecar/load proxy returns {status:'error', error:'…'} with
         a 5xx body on timeout or sidecar-side failure; realLoadSidecar parses
         the body either way and only throws if fetch itself fails. So we
         inspect AND catch — both paths can be the failure. */
      try {
        const loadOpts =
          engine === 'qwen1_7b'
            ? ({ engine: 'qwen' as const, model: '1.7b' } as const)
            : { engine: engine as 'coqui' | 'kokoro' | 'qwen' };
        const result = await api.loadSidecar(loadOpts);
        if (result.status === 'error') {
          setLoadErrorNotice(result.error || 'Voice engine failed to load. Check the voice engine logs.');
          setPending(engine, null);
        }
      } catch (e) {
        setLoadErrorNotice(`Couldn't reach the sidecar: ${(e as Error).message ?? 'fetch failed'}`);
        setPending(engine, null);
      }
      setHealthProbeKey((k) => k + 1);
    } finally {
      inFlightOps.current[engine] -= 1;
    }
  };

  const doStop = async (engine: EngineId) => {
    inFlightOps.current[engine] += 1;
    try {
      setPending(engine, 'unloading');
      setEvictionNotice(null);
      setLoadErrorNotice(null);
      try {
        const stopOpts =
          engine === 'qwen1_7b'
            ? ({ engine: 'qwen' as const, model: '1.7b' } as const)
            : { engine: engine as 'coqui' | 'kokoro' | 'qwen' };
        const result = await api.unloadSidecar(stopOpts);
        if (result.status === 'error') {
          setLoadErrorNotice(result.error || 'Voice engine failed to unload.');
          setPending(engine, null);
        }
      } catch (e) {
        setLoadErrorNotice(`Couldn't reach the sidecar: ${(e as Error).message ?? 'fetch failed'}`);
        setPending(engine, null);
      }
      setHealthProbeKey((k) => k + 1);
    } finally {
      inFlightOps.current[engine] -= 1;
    }
  };

  const dismissNotices = () => {
    setEvictionNotice(null);
    setLoadErrorNotice(null);
    setTripNotice(null);
  };

  return {
    coqui: {
      state: coquiState,
      onLoad: () => doLoad('coqui'),
      onStop: () => doStop('coqui'),
    },
    kokoro: {
      state: kokoroState,
      onLoad: () => doLoad('kokoro'),
      onStop: () => doStop('kokoro'),
    },
    qwen: {
      state: qwenState,
      onLoad: () => doLoad('qwen'),
      onStop: () => doStop('qwen'),
    },
    qwen1_7b: {
      state: qwen1_7bState,
      onLoad: () => doLoad('qwen1_7b'),
      onStop: () => doStop('qwen1_7b'),
    },
    asr: {
      enabled: sidecarHealth?.asrEnabled === true,
      state: asrState,
      device: sidecarHealth?.asrDevice ?? null,
    },
    /* Only a reachable probe carries an affirmative answer either way (see the
       tri-state doc comment above) — anything else (unprobed / unreachable)
       stays undefined = unknown, never coerced down to false. */
    qwen1_7bInstalled:
      sidecarHealth?.status === 'reachable' ? sidecarHealth.qwenBase17WeightsPresent === true : undefined,
    evictionNotice,
    loadErrorNotice,
    dismissNotices,
    gpuQueueDepth: gpuQueue?.queueDepth,
    tripNotice,
  };
}
