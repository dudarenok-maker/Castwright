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
     A render in flight answers `false` (the caller's one-shot latch is spent,
     so it is never re-asked); only a splice / QA repair with NO render answers
     `'declined'` (#4075), because a repair is short and the caller should ask
     again once it ends. Re-asking during a render would land in the gap
     between one chapter POST's `deregisterJob` and the next one's
     `registerJob` and unload the render's base. A Fix-audio splice BATCH has
     the same gap (one splice POST per chapter), so once an admission has seen
     a repair the lever evicts only after a quiet streak: the gate idle at two
     consecutive polls at least one poll interval apart AND no splice
     registered between them (a splice epoch, so a chapter that starts and
     ends between two polls still restarts the streak), the idle and epoch
     checks repeated immediately before the unload. The
     streak is per admission (`QuietPollState`), never module-global.

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
     confidence under this fix. The outcome if the race is hit is NOT
     corruption or data loss, but it is no longer just a lazy cold-reload
     (tts/ensure-sidecar-loaded.ts:31-36): since #4066 the op that evicts in
     this window can be a voice design, which then holds ~6 GB, so a Quality
     render's next chapter cannot reload its 1.7B base next to it and waits on
     the capacity budget, and can fail. A narrow gap, not a safety hole. See
     also active-generation-gate.ts's file header.

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
import {
  isAnyGenerationActive,
  isRepairOnlyKnownActive,
  readSpliceEpoch,
  type QuietPollState,
} from './active-generation-gate.js';
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
type ReconcileResidentQwenTiersFn = (
  keep: ResidentTtsKeep,
  signal?: AbortSignal,
  freedOut?: string[],
) => Promise<boolean>;

/** A device family that holds VRAM. 'cpu' and an unknown/absent reading do
    not, so a Kokoro reported there is never unloaded by this lever. */
function isGpuFamily(device: string | null | undefined): boolean {
  return device === 'cuda' || device === 'rocm' || device === 'directml';
}

/** #4066 (owner decision) — the run-start reconcile target for a chapter
    render. A run that loads the Quality (1.7B) base needs ~6 GB, which cannot
    sit next to an on-GPU Kokoro on an 8 GB card, so Kokoro is dropped at run
    start; a run with no 1.7B in it keeps today's behaviour (Kokoro untouched).
    Keyed on `keep.keep17` — the computed per-character target, so a Standard
    book with characters toggled to Quality (and a mixed-tier run) counts —
    not on the run's default model key. Kokoro fallback lines inside the run
    may load it again — accepted. Best-effort: an unreadable probe leaves
    `keep` as it was.
    The queue dispatcher sends one POST per chapter, so this runs on EVERY
    chapter's POST, and a sibling chapter's job may already be live (and its
    Kokoro fallback line mid-synth — `KokoroEngine.unload()` takes no lock). So
    it only applies while nothing else is live: with another generation, splice
    or QA repair in flight (`anotherGenerationActive`) the drop is skipped, and
    the caller must pass `true` whenever that is unknown (fail closed). Two
    first POSTs arriving together can both see nothing and both drop. Bounded
    cost, not a no-op: the second drop can unload a Kokoro the first job just
    reloaded for a fallback line; that line then fails and goes through the
    transient retry. */
export async function keepForRunStart(
  keep: ResidentTtsKeep,
  anotherGenerationActive: boolean,
  probeHealth: () => Promise<SidecarHealthSnapshot | null> = probeSidecarHealthIfRegistered,
): Promise<ResidentTtsKeep> {
  if (anotherGenerationActive || !keep.keep17) return keep;
  const health = await probeHealth().catch(() => null);
  if (health?.kokoroLoaded === true && isGpuFamily(health.devices?.kokoro)) return { ...keep, keepKokoro: false };
  return keep;
}

export interface FreeKokoroForRenderOpts {
  modelKey?: TtsModelKey;
  /** Must be true: the blocked op is a chapter render's own synth call. */
  isRenderSynth?: boolean;
  signal?: AbortSignal;
  /** Injected for tests. Defaults to the sidecar-health leaf gate. */
  _probeHealth?: () => Promise<SidecarHealthSnapshot | null>;
  /** Injected for tests. Defaults to the reconcile leaf gate. */
  _reconcile?: ReconcileResidentQwenTiersFn;
}

/** #4079 (owner decision, 2026-11-11) — the ONE exception to "a render in
    flight frees nothing" (#4066 / `evictIdleQwenBase` above): when a render's
    OWN Quality (1.7B) synth is refused for capacity and Kokoro sits on the
    GPU, unload Kokoro — never a Qwen tier — and let the caller retry. Kokoro
    reloads on the next fallback line, which is accepted (same as the run-start
    drop in `keepForRunStart`). Any other op (a design, a preview, a standard
    synth, anything not a render's own call) gets `false` and frees nothing, so
    #4066's rule holds for them. Returns true only when Kokoro was really
    unloaded. */
export async function freeKokoroForRenderSynth(opts: FreeKokoroForRenderOpts): Promise<boolean> {
  if (opts.isRenderSynth !== true || opts.modelKey !== 'qwen3-tts-1.7b') return false;
  const health = await (opts._probeHealth ?? probeSidecarHealthIfRegistered)().catch(() => null);
  if (!health || health.status === 'unreachable') return false;
  if (!(health.kokoroLoaded === true && isGpuFamily(health.devices?.kokoro))) return false;
  const freedNames: string[] = [];
  /* keep06 + keep17 true: reconcile touches no Qwen tier; keepKokoro:false drops Kokoro only. */
  const keep: ResidentTtsKeep = { keep06: true, keep17: true, keepKokoro: false };
  const ok = opts._reconcile
    ? await opts._reconcile(keep, opts.signal, freedNames)
    : await reconcileResidentQwenTiersIfRegistered(keep, opts.signal, freedNames);
  if (freedNames.length > 0) recordTtsAutoFree(freedNames, 'Quality render');
  return ok && freedNames.includes('Kokoro');
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
  /** #4066 — the device the blocked admission was denied on. A VoiceDesign
      resident on it makes a design/Quality op decline (`'declined'`). Absent
      means unknown, which declines on any resident VoiceDesign. */
  deviceKey?: string;
  signal?: AbortSignal;
  /** #4075 — the admission's own quiet-poll state, created per
      `withCapacityRetry` call and passed to every ask. Absent = no quiet-poll
      rule (a one-off ask). */
  quiet?: QuietPollState;
  /** Injected for tests. Monotonic clock for the quiet-poll gap. */
  _now?: () => number;
  /** Injected for tests. The splice epoch (defaults to the leaf gate's
      `readSpliceEpoch`; `null` = unregistered, which counts as moved). */
  _spliceEpoch?: () => number | null;
  /** Injected for tests. Defaults to the registered-accessor leaf gate
      (./qwen-tier-reconcile-gate.ts), which fails closed to "did not evict"
      when tts/ensure-sidecar-loaded.ts hasn't registered. */
  _reconcile?: ReconcileResidentQwenTiersFn;
  /** Injected for tests. Returns true when a render may be in flight
      anywhere — defaults to the leaf gate's `isAnyGenerationActive`. */
  _isAnyGenerationActive?: typeof isAnyGenerationActive;
  /** Injected for tests. True only when a splice / QA repair is KNOWN in flight
      and no render is — defaults to the leaf gate's `isRepairOnlyKnownActive`
      (unregistered => false, so an unregistered gate answers `false`, like
      main, and never `'declined'`). */
  _isRepairOnlyKnownActive?: typeof isRepairOnlyKnownActive;
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
    same is now true of a failed eviction, not just a no-op one.
    `'declined'` is a hold-off that can clear — a splice or QA repair in flight
    with NO render (#4075, before and after the health probe), another design
    resident, or an unreadable probe (#4066) — and leaves the caller's one-shot
    latch armed so a later poll asks again. A render in flight answers `false`
    and spends the latch, as before #4075: a book render is one POST per chapter,
    so there is a gap between one chapter's job deregistering and the next one
    registering, and a lever re-asked on every poll would land in it and unload
    the render's base. */
export async function evictIdleQwenBase(opts: EvictIdleQwenBaseOpts): Promise<boolean | 'declined'> {
  const anyGenerationActive = opts._isAnyGenerationActive ?? isAnyGenerationActive;
  const repairOnly = opts._isRepairOnlyKnownActive ?? isRepairOnlyKnownActive;
  const { modelKey } = opts;

  const quiet = opts.quiet;
  const now = opts._now ?? (() => performance.now());
  const readEpoch = opts._spliceEpoch ?? readSpliceEpoch;
  /* A splice registered since `idleSince` was set (even one that already
     released: the gate is only sampled at a poll). `null` = unregistered
     reader = moved, so the rule can never complete unverified. */
  const epochMoved = (): boolean => {
    const cur = readEpoch();
    return cur === null || cur !== quiet?.epoch;
  };
  const restartStreak = (t: number): 'declined' => {
    if (quiet) {
      quiet.idleSince = t;
      quiet.epoch = readEpoch();
    }
    return 'declined';
  };

  /* #4075 — a splice / QA repair (and nothing else) is a short "not yet":
     'declined' keeps the caller's latch armed so it asks again once the repair
     ends. A render (or an unregistered gate, which reads as active) answers
     `false` and spends the latch — never 'declined', so a waiting op is not
     re-asked every poll across a multi-chapter render's inter-chapter gap.
     One residue: a Listen-row QA repair can run during a render
     (listen-player-region.tsx), and in the render's chapter gap it reads as
     repair-only. That is no wider than main's #1839 residual window (the gate
     already reads idle between a render's POSTs); the quiet-poll rule below
     narrows it further. Any activity also ends the admission's quiet streak. */
  const activeAnswer = (): false | 'declined' => {
    if (quiet) quiet.idleSince = null;
    if (!repairOnly()) return false;
    if (quiet) quiet.sawRepair = true;
    return 'declined';
  };

  if (!modelKey) return false;
  if (anyGenerationActive()) return activeAnswer();

  /* #4075 quiet-poll rule — a Fix-audio batch is one splice POST per chapter,
     so the gate reads idle between chapters. Once THIS admission has seen a
     repair, evict only after the gate has read idle at two consecutive polls
     at least one poll interval apart with no splice REGISTERED since the first
     (the splice epoch: a chapter that starts and ends between two polls is
     never seen by the gate itself, but still restarts the streak). The state is the admission's own (`quiet`), not module-global.
     No repair seen: nothing changes, the first idle ask evicts. */
  if (quiet?.sawRepair) {
    const t = now();
    if (quiet.idleSince === null || epochMoved()) return restartStreak(t);
    if (t - quiet.idleSince < quiet.minGapMs) return 'declined';
  }

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

  /* #4066 — the two heavy op shapes also reclaim an on-GPU Kokoro. Residency
     is read up front only to decide that (and whether another design is
     resident); what the notice names comes from what reconcile really
     unloaded, so a failed probe or a failed Kokoro unload never loses or
     misstates the event. */
  const heavy = isDesign || wants17;
  if (heavy) {
    const health = await (opts._probeHealth ?? probeSidecarHealthIfRegistered)().catch(() => null);
    /* Fail CLOSED on an unreadable probe (throw, unregistered, or the
       sidecar's own 2 s timeout reporting `unreachable`): a slow-but-alive
       sidecar is exactly when another design sits between its ensure and its
       forward, and reconcile's own `/health` read has no such bound. Declining
       re-arms the caller's latch, so the next poll asks again. */
    if (!health || health.status === 'unreachable') return 'declined';
    /* Designs are not globally serialised and `QwenEngine.unload()` clears
       the VoiceDesign model along with the base, so unloading under another
       design resident on the denied device would kill it mid-forward. Hold
       off; the caller keeps its latch armed and asks again on a later poll. */
    if (health.qwenDesignResident === true && (!opts.deviceKey || health.qwenDeviceKey === opts.deviceKey)) {
      return 'declined';
    }
    if (health.kokoroLoaded === true && isGpuFamily(health.devices?.kokoro)) keep.keepKokoro = false;
    /* The probe above can take up to ~2 s; a render may have started in it. */
    if (anyGenerationActive()) return activeAnswer();
    if (quiet?.sawRepair && epochMoved()) return restartStreak(now());
  }

  /* Only the heavy shapes report what they freed (the light ops record no
     notice), so only they hand reconcile an out-param. */
  const freedNames: string[] | undefined = heavy ? [] : undefined;
  const freed = opts._reconcile
    ? await (freedNames ? opts._reconcile(keep, opts.signal, freedNames) : opts._reconcile(keep, opts.signal))
    : await reconcileResidentQwenTiersIfRegistered(keep, opts.signal, freedNames);
  if (freedNames) recordTtsAutoFree(freedNames, isDesign ? 'voice design' : 'Quality render');
  return freed;
}
