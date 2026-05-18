/* useTtsLifecycle — single source of truth for the TTS pill's state and the
   Load / Stop side-effects (analyzer auto-evict + sidecar load/unload).

   Lifted out of `views/generation.tsx` so the same state powers both the
   Generation view's local pill AND the new global pill in `layout.tsx`'s
   top bar. The hook owns its own /health poll and pending-override state;
   call it ONCE per app instance — Layout calls it and exposes the result
   via LayoutContext so descendant views (Generation today, others as they
   arrive) read the same state without spinning up a parallel poll.

   The hook deliberately keeps `playSampleWithAutoLoad` out of scope:
   sample-Play surfaces (drawer, cast row) still trigger their own JIT
   warm independently. Plan 30 explicitly preserves that path. */

import { useEffect, useState } from 'react';
import { api, type SidecarHealth } from './api';
import type { ModelControlState } from '../components/ModelControlPill';

export interface TtsLifecycle {
  state: ModelControlState;
  /** Inline banner copy: "Analyzer unloaded to free VRAM for TTS." */
  evictionNotice: string | null;
  /** Rose banner copy when Load/Stop returns {status:'error',...} or the
      request itself throws. */
  loadErrorNotice: string | null;
  onLoad: () => Promise<void>;
  onStop: () => Promise<void>;
  /** Surface-local "dismiss this notice" affordance. The hook owns the
      notice state because both pills share it; either surface clearing it
      should clear it everywhere. */
  dismissNotices: () => void;
}

export function useTtsLifecycle(): TtsLifecycle {
  const [sidecarHealth, setSidecarHealth] = useState<SidecarHealth | null>(null);
  const [healthProbeKey, setHealthProbeKey] = useState(0);
  /* Pending UI override — set immediately on a Load/Stop click so the pill
     reports the intended next state while /health catches up. Cleared on the
     next probe that confirms the transition. */
  const [pendingPillState, setPendingPillState] = useState<ModelControlState | null>(null);
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
          setPendingPillState(null);
        })
        .catch(() => {
          if (cancelled) return;
          setSidecarHealth({ status: 'unreachable', url: '', error: 'Probe failed.' });
          setPendingPillState(null);
        });
    };
    probe();
    const id = setInterval(probe, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [healthProbeKey]);

  const state: ModelControlState = (() => {
    if (pendingPillState) return pendingPillState;
    if (!sidecarHealth) return 'idle';
    if (sidecarHealth.status === 'unreachable') return 'unreachable';
    if (sidecarHealth.loading) return 'loading';
    if (sidecarHealth.modelLoaded) return 'ready';
    return 'idle';
  })();

  const onLoad = async () => {
    setPendingPillState('loading');
    setEvictionNotice(null);
    setLoadErrorNotice(null);
    /* Auto-evict the analyzer before warming TTS — both models compete for
       the same VRAM on a single-GPU box. If the analyzer wasn't resident
       the call is a cheap no-op on Ollama's side; either way we surface a
       banner only when the unload actually freed something. */
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
    /* The /api/sidecar/load proxy returns {status:'error', error:'…'} with
       a 5xx body on timeout or sidecar-side failure; realLoadSidecar parses
       the body either way and only throws if fetch itself fails. So we
       inspect AND catch — both paths can be the failure. */
    try {
      const result = await api.loadSidecar();
      if (result.status === 'error') {
        setLoadErrorNotice(result.error || 'TTS model failed to load. Check the sidecar logs.');
        setPendingPillState(null);
      }
    } catch (e) {
      setLoadErrorNotice(`Couldn't reach the sidecar: ${(e as Error).message ?? 'fetch failed'}`);
      setPendingPillState(null);
    }
    setHealthProbeKey((k) => k + 1);
  };

  const onStop = async () => {
    setPendingPillState('idle');
    setEvictionNotice(null);
    setLoadErrorNotice(null);
    try {
      const result = await api.unloadSidecar();
      if (result.status === 'error') {
        setLoadErrorNotice(result.error || 'TTS model failed to unload.');
        setPendingPillState(null);
      }
    } catch (e) {
      setLoadErrorNotice(`Couldn't reach the sidecar: ${(e as Error).message ?? 'fetch failed'}`);
      setPendingPillState(null);
    }
    setHealthProbeKey((k) => k + 1);
  };

  const dismissNotices = () => {
    setEvictionNotice(null);
    setLoadErrorNotice(null);
  };

  return { state, evictionNotice, loadErrorNotice, onLoad, onStop, dismissNotices };
}
