/* Second eviction lever for capacity admission (#1839). Admission already
   evicts the analyzer Ollama once; this frees a resident Qwen BASE TIER the
   current op does not need, so an interactive preview can make room for itself
   instead of polling for ~60 s and failing while an idle base holds the VRAM.

   Deliberately narrow:
   - Qwen bases only. Coqui and Kokoro are button-driven — the user loaded them
     on purpose and silently unloading them would be surprising.
   - Only when NO render is in flight anywhere. A resident base during a render
     may be in active use, and a mixed-tier book can have both tiers live at
     once (a character pinned above its book's tier). This also makes the lever
     inert during generation by construction, which is correct: the render path
     already reconciles tiers at run start (ensure-sidecar-loaded.ts:182).

   Reads both outside dependencies from stateless leaf gates rather than
   importing their owning modules directly:
   - "is any render in flight" from ./active-generation-gate.ts, instead of
     `activeGenerationBooks` from routes/generation.ts — that route module is
     reachable from here via tts/index.ts -> tts/sidecar.ts, so a static
     import of it back from this module closes an import cycle.
   - the actual eviction call from ./qwen-tier-reconcile-gate.ts, instead of
     `reconcileResidentQwenTiers` from tts/ensure-sidecar-loaded.ts directly —
     that module's OTHER exports reach gpu/engine-device.ts (dynamic import)
     -> gpu/engine-device-state.ts -> routes/sidecar-health.ts ->
     tts/coqui-catalog-audit.ts -> tts/voice-mapping.ts -> tts/index.ts,
     which closes a different cycle back to where this module is reached
     from (tts/sidecar.ts).
   Both gates fail closed (unregistered => "a render may be running" /
   "nothing can be freed"), so a wiring break declines to evict rather than
   evicting mid-render or pretending success.

   Deliberately does NOT import tts/ensure-sidecar-loaded.ts, not even for
   its `reconcileResidentQwenTiers` type — a type-only import still counts as
   an edge for cycle detection (see qwen-tier-reconcile-gate.ts), so the
   injection type below is spelled out locally instead. */
import { isAnyGenerationActive } from './active-generation-gate.js';
import { reconcileResidentQwenTiersIfRegistered } from './qwen-tier-reconcile-gate.js';
import { engineForModelKey, type TtsModelKey } from '../tts/model-keys.js';

/** Same shape as tts/ensure-sidecar-loaded.ts's `reconcileResidentQwenTiers` —
    spelled out locally so this module doesn't need to import that one (see
    file header). */
type ReconcileResidentQwenTiersFn = (
  keep: { keep06: boolean; keep17: boolean },
  signal?: AbortSignal,
) => Promise<void>;

export interface EvictIdleQwenBaseOpts {
  /** The model key the blocked op is asking for. Its tier is the one KEPT. */
  modelKey?: TtsModelKey;
  signal?: AbortSignal;
  /** Injected for tests. Defaults to the registered-accessor leaf gate
      (./qwen-tier-reconcile-gate.ts), which fails closed to "did not evict"
      when tts/ensure-sidecar-loaded.ts hasn't registered. */
  _reconcile?: ReconcileResidentQwenTiersFn;
  /** Injected for tests. Returns true when a render may be in flight
      anywhere — defaults to the leaf gate's `isAnyGenerationActive`. */
  _isAnyGenerationActive?: typeof isAnyGenerationActive;
}

/** Returns true when it actually asked the sidecar to unload something. */
export async function evictIdleQwenBase(opts: EvictIdleQwenBaseOpts): Promise<boolean> {
  const anyGenerationActive = opts._isAnyGenerationActive ?? isAnyGenerationActive;
  const { modelKey } = opts;

  if (!modelKey || engineForModelKey(modelKey) !== 'qwen') return false;
  if (anyGenerationActive()) return false;

  const wants17 = modelKey === 'qwen3-tts-1.7b';
  const keep = { keep06: !wants17, keep17: wants17 };

  if (opts._reconcile) {
    await opts._reconcile(keep, opts.signal);
    return true;
  }
  return reconcileResidentQwenTiersIfRegistered(keep, opts.signal);
}
