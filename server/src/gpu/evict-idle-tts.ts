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

     KNOWN RESIDUAL WINDOW (#1839 finding 2, investigated and left open on
     purpose): "the render path already reconciles at run start, so the lever
     is inert on the hot path by construction" is not quite true for the
     first ~190 lines of a render's startup. `routes/generation.ts` calls its
     run-start `reconcileResidentQwenTiers` well BEFORE it calls `registerJob`
     — the point at which `activeGenerationBooks()` (and so
     `isAnyGenerationActive()` above) actually sees the book. In that window a
     DIFFERENT blocked op's `evictIdleQwenBase` can see "no render in flight"
     and race the starting render's own run-start reconcile: if this lever's
     `/unload` lands after the render decided to keep a tier, the render's
     first chapter synth hits a tier that was just evicted out from under it.
     Closing this properly means making the starting render visible to the
     gate before its own reconcile call — investigated for this fix, but
     `job`/`key`/`controller` and friends are declared inside that same
     stretch of `routes/generation.ts` and read by closures hundreds of lines
     further down (through `registerJob` and well into the per-chapter render
     loop), so marking-then-clearing around just the run-start reconcile would
     either leak scope-breaking `let` hoists across a huge function or clear
     too early to actually close the window — not a change to make with
     confidence under this fix. The outcome if the race is hit is a sidecar
     lazy cold-reload on that chapter, NOT corruption or data loss — cold-
     reload is already documented as a correct fallback
     (tts/ensure-sidecar-loaded.ts:31-36) — so this is a narrow, benign-outcome
     gap, not a safety hole. See also active-generation-gate.ts's file header.

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
    file header). Returns whether it actually issued an `/unload` (see that
    function's doc comment) — threaded straight through by `evictIdleQwenBase`
    below so this lever's own return value stays truthful (#1839 finding 1). */
type ReconcileResidentQwenTiersFn = (
  keep: { keep06: boolean; keep17: boolean },
  signal?: AbortSignal,
) => Promise<boolean>;

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

/** Returns true when it actually freed something — i.e. the underlying
    `reconcileResidentQwenTiers` issued a real `/unload` (see that function's
    doc comment). `false` covers every other outcome, including "called
    successfully but the tier to drop was never resident" — that used to
    collapse into `true` here (#1839 finding 1), which made
    `capacity-retry.ts` `continue` into an immediate, wasted retry attempt
    instead of falling through to its bounded poll. */
export async function evictIdleQwenBase(opts: EvictIdleQwenBaseOpts): Promise<boolean> {
  const anyGenerationActive = opts._isAnyGenerationActive ?? isAnyGenerationActive;
  const { modelKey } = opts;

  if (!modelKey || engineForModelKey(modelKey) !== 'qwen') return false;
  if (anyGenerationActive()) return false;

  const wants17 = modelKey === 'qwen3-tts-1.7b';
  const keep = { keep06: !wants17, keep17: wants17 };

  if (opts._reconcile) {
    return opts._reconcile(keep, opts.signal);
  }
  return reconcileResidentQwenTiersIfRegistered(keep, opts.signal);
}
