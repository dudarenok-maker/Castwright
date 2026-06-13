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

import { useEffect, useState } from 'react';
import { api, type SidecarHealth, type GpuQueueState } from './api';
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
  /** Qwen — bespoke per-character engine (plan 108), button-driven. Treated
      like Kokoro for residency: does NOT auto-evict the analyzer. */
  qwen: EngineLifecycle;
  /** Whisper ASR content-QA engine (srv-31). Display-only — no Load/Stop. */
  asr: AsrLifecycle;
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
  /** GPU semaphore queue depth — number of GPU ops queued behind the
      in-flight ones. Drives the "GPU busy · N waiting ·" prefix on the
      top-bar pill so a session waiting on another's analyzer / sidecar
      call can see why it's not starting. `undefined` when the server
      doesn't expose `/api/gpu/queue` (older builds / partial deploys)
      — UI degrades to no prefix in that case. */
  gpuQueueDepth?: number;
  /** Companion to `gpuQueueDepth` — number of GPU ops currently
      holding a slot. Exposed for diagnostics; not currently rendered
      anywhere but cheap to keep on the shape so future surfaces (a
      developer-tools view, a metric overlay) can read it without a
      second poll. */
  gpuInFlight?: number;
}

type EngineId = 'coqui' | 'kokoro' | 'qwen';

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
  const [evictionNotice, setEvictionNotice] = useState<string | null>(null);
  const [loadErrorNotice, setLoadErrorNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const probe = () => {
      api
        .getSidecarHealth()
        .then((h) => {
          if (cancelled) return;
          setSidecarHealth(h);
          setPendingCoqui(null);
          setPendingKokoro(null);
          setPendingQwen(null);
        })
        .catch(() => {
          if (cancelled) return;
          setSidecarHealth({ status: 'unreachable', url: '', error: 'Probe failed.' });
          setPendingCoqui(null);
          setPendingKokoro(null);
          setPendingQwen(null);
        });

      /* GPU queue state — same cadence, separate endpoint. Permissive
         error handling: an older server (or a transient 404 / 5xx) just
         clears the depth so the pill drops back to its default label;
         it does NOT surface as a user-facing error. The semaphore is
         opportunistic UX, not a hard contract. */
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
    else setPendingCoqui(next);
  };

  const doLoad = async (engine: EngineId) => {
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
          setEvictionNotice('Analyzer unloaded to free VRAM for TTS.');
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
      const result = await api.loadSidecar({ engine });
      if (result.status === 'error') {
        setLoadErrorNotice(result.error || 'Voice engine failed to load. Check the voice engine logs.');
        setPending(engine, null);
      }
    } catch (e) {
      setLoadErrorNotice(`Couldn't reach the sidecar: ${(e as Error).message ?? 'fetch failed'}`);
      setPending(engine, null);
    }
    setHealthProbeKey((k) => k + 1);
  };

  const doStop = async (engine: EngineId) => {
    setPending(engine, 'idle');
    setEvictionNotice(null);
    setLoadErrorNotice(null);
    try {
      const result = await api.unloadSidecar({ engine });
      if (result.status === 'error') {
        setLoadErrorNotice(result.error || 'TTS model failed to unload.');
        setPending(engine, null);
      }
    } catch (e) {
      setLoadErrorNotice(`Couldn't reach the sidecar: ${(e as Error).message ?? 'fetch failed'}`);
      setPending(engine, null);
    }
    setHealthProbeKey((k) => k + 1);
  };

  const dismissNotices = () => {
    setEvictionNotice(null);
    setLoadErrorNotice(null);
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
    asr: {
      enabled: sidecarHealth?.asrEnabled === true,
      state: asrState,
      device: sidecarHealth?.asrDevice ?? null,
    },
    evictionNotice,
    loadErrorNotice,
    dismissNotices,
    gpuQueueDepth: gpuQueue?.depth,
    gpuInFlight: gpuQueue?.inFlight,
  };
}
