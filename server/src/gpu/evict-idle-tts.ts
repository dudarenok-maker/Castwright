/* Second eviction lever for capacity admission (#1839). Admission already
   evicts the analyzer Ollama once; this frees a resident Qwen BASE TIER the
   current op does not need, so an interactive preview can make room for itself
   instead of polling for ~60 s and failing while an idle base holds the VRAM.
   A non-Qwen op (Coqui/Kokoro) needs NEITHER Qwen tier, so for it BOTH are
   "does not need" and reclaimable — the likeliest real blocker on an 8 GB
   card is an idle Qwen 1.7B base sitting under a Coqui/Kokoro preview
   (#1839 finding 5).

   Deliberately narrow:
   - Qwen bases only, for every op EXCEPT the two heavy ones below. Coqui and
     Kokoro are button-driven — the user loaded them on purpose and silently
     unloading them would be surprising.
   - #4066 (owner decision, "auto-free, then design"): a voice design
     (`purpose: 'design'`) or a Quality op (`qwen3-tts-1.7b`) needs ~6 GB, so
     on an 8 GB card it can never fit next to a resident standard Qwen base or
     an on-GPU Kokoro. For those two op shapes the lever frees BOTH Qwen base
     tiers it doesn't need (a design needs neither — the sidecar reloads the
     0.6B audition base inside its own admitted budget) and a Kokoro that sits
     on the GPU (a CPU Kokoro holds no VRAM, so it is left alone). What it
     freed is recorded in ./tts-auto-free-notice.ts so the browser can show
     the "unloaded to free VRAM" notice. The no-render-in-flight gate below
     applies unchanged.
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
import {
  reconcileResidentQwenTiersIfRegistered,
  type ResidentTtsKeep,
} from './qwen-tier-reconcile-gate.js';
import { probeSidecarHealthIfRegistered, type SidecarHealthSnapshot } from './sidecar-health-gate.js';
import { recordTtsAutoFree } from './tts-auto-free-notice.js';
import { engineForModelKey, type TtsModelKey } from '../tts/model-keys.js';

/** Same shape as tts/ensure-sidecar-loaded.ts's `reconcileResidentQwenTiers` —
    spelled out locally so this module doesn't need to import that one (see
    file header). Returns whether it actually issued an `/unload` (see that
    function's doc comment) — threaded straight through by `evictIdleQwenBase`
    below so this lever's own return value stays truthful (#1839 finding 1). */
type ReconcileResidentQwenTiersFn = (keep: ResidentTtsKeep, signal?: AbortSignal) => Promise<boolean>;

/** A device family that holds VRAM. 'cpu' and an unknown/absent reading do
    not, so a Kokoro reported there is never unloaded by this lever. */
function isGpuFamily(device: string | null | undefined): boolean {
  return device === 'cuda' || device === 'rocm' || device === 'directml';
}

export interface EvictIdleQwenBaseOpts {
  /** The model key the blocked op is asking for. When it's a Qwen key, its
      own tier is the one KEPT (the elevate-only rule: an op only reclaims
      the Qwen tier it doesn't need). When it's a NON-Qwen key (Coqui,
      Kokoro), neither Qwen tier is anything that op could ever need, so
      BOTH are reclaimable (#1839 finding 5) — a Coqui/Kokoro preview no
      longer goes politely unmet just because the blocker is Qwen and not
      itself. */
  modelKey?: TtsModelKey;
  /** #4066 — 'design' when the blocked op is a voice design. The design route
      passes the BOOK's model key, which says nothing about what the design
      itself loads (the 1.7B VoiceDesign model), so this is what tells the
      lever a design needs neither Qwen base tier resident. */
  purpose?: 'design';
  signal?: AbortSignal;
  /** Injected for tests. Defaults to the registered-accessor leaf gate
      (./qwen-tier-reconcile-gate.ts), which fails closed to "did not evict"
      when tts/ensure-sidecar-loaded.ts hasn't registered. */
  _reconcile?: ReconcileResidentQwenTiersFn;
  /** Injected for tests. Returns true when a render may be in flight
      anywhere — defaults to the leaf gate's `isAnyGenerationActive`. */
  _isAnyGenerationActive?: typeof isAnyGenerationActive;
  /** Injected for tests. Reads what the sidecar has resident — defaults to
      the leaf gate's `probeSidecarHealthIfRegistered`. Only consulted for a
      design or Quality op (#4066). */
  _probeHealth?: () => Promise<SidecarHealthSnapshot | null>;
}

/** Returns true when the underlying `reconcileResidentQwenTiers` actually
    freed the tier(s) to drop (see that function's doc comment) — it now checks
    `res.ok` on every `/unload` it issues and reports a network/sidecar failure
    as `false` too (PR #2790 / #2752), not just "a request was issued". `false`
    covers every other outcome, including "called successfully but the tier to
    drop was never resident" — that used to collapse into `true` here (#1839
    finding 1), which made `capacity-retry.ts` `continue` into an immediate,
    wasted retry attempt instead of falling through to its bounded poll; the
    same is now true of a failed eviction, not just a no-op one. */
export async function evictIdleQwenBase(opts: EvictIdleQwenBaseOpts): Promise<boolean> {
  const anyGenerationActive = opts._isAnyGenerationActive ?? isAnyGenerationActive;
  const { modelKey } = opts;

  if (!modelKey) return false;
  if (anyGenerationActive()) return false;

  /* #1839 finding 5 — a non-Qwen op (Coqui/Kokoro) can never need either
     Qwen base resident, so it may reclaim BOTH idle tiers rather than
     bailing out here just because the blocker isn't its own engine. A Qwen
     op keeps the same elevate-only behaviour as before: it only reclaims
     the ONE tier it doesn't itself want. */
  const isQwenOp = engineForModelKey(modelKey) === 'qwen';
  const isDesign = opts.purpose === 'design';
  const wants17 = !isDesign && modelKey === 'qwen3-tts-1.7b';
  const keep: ResidentTtsKeep =
    isQwenOp && !isDesign ? { keep06: !wants17, keep17: wants17 } : { keep06: false, keep17: false };

  /* #4066 — the two heavy op shapes also reclaim an on-GPU Kokoro, and
     report what they freed. Residency is read up front so the notice can
     name only what was really resident. */
  const heavy = isDesign || wants17;
  const freedNames: string[] = [];
  if (heavy) {
    const health = await (opts._probeHealth ?? probeSidecarHealthIfRegistered)().catch(() => null);
    if (health?.kokoroLoaded === true && isGpuFamily(health.devices?.kokoro)) keep.keepKokoro = false;
    if (health?.qwenLoaded === true && !keep.keep06) freedNames.push('Qwen 0.6B');
    if (health?.qwenBase17Loaded === true && !keep.keep17) freedNames.push('Qwen 1.7B');
    if (keep.keepKokoro === false) freedNames.push('Kokoro');
  }

  const freed = opts._reconcile
    ? await opts._reconcile(keep, opts.signal)
    : await reconcileResidentQwenTiersIfRegistered(keep, opts.signal);
  if (freed && heavy) recordTtsAutoFree(freedNames, isDesign ? 'voice design' : 'Quality render');
  return freed;
}
