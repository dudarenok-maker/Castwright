/* Stateless leaf gate for "is any render in flight anywhere" (#1839).

   This module imports NOTHING — that is what makes it incapable of joining an
   import cycle. `routes/generation.ts` owns the actual state
   (`inFlightByBook`) and registers its existing `activeGenerationBooks`
   accessor here at module init; readers elsewhere (e.g.
   `server/src/gpu/evict-idle-tts.ts`) call `isAnyGenerationActive()` instead
   of importing the route module directly, which would recreate the cycle
   `routes/generation.ts -> tts/index.ts -> tts/sidecar.ts ->
   gpu/evict-idle-tts.ts -> routes/generation.ts`.

   A fs-26 splice and a QA repair are GPU work too but never enter
   `inFlightByBook`; `routes/chapter-job-coordination.ts` registers its
   in-flight splice count (`setInFlightSpliceCounter`, #4066) and both
   predicates below fold it in.

   There is exactly one source of truth (the registered accessor) — nothing
   here copies or caches the state, so it can't drift from
   `routes/generation.ts`'s own view.

   FAIL CLOSED IS REQUIRED, NOT A PREFERENCE. If `routes/generation.ts` has not
   registered yet (module load order, a future refactor, a test importing this
   module without the route module), `isAnyGenerationActive()` resolves to
   `true` — "a render may be running" — so any consumer declines to act rather
   than assuming it's safe. For the eviction lever this guards, the worst case
   of fail-closed is today's behaviour (a capacity error); the worst case of
   fail-open would be evicting a model out from under a live render. Do NOT
   "simplify" the unregistered default to `false`.

   KNOWN RESIDUAL WINDOW (#1839 finding 2, left open on purpose — see
   gpu/evict-idle-tts.ts's file header for the full writeup). This accessor
   only reflects `routes/generation.ts`'s `registerJob` — a render that has
   started but not yet reached `registerJob` (it calls its own run-start
   `reconcileResidentQwenTiers` well before that point) is invisible here, so
   `isAnyGenerationActive()` can report `false` for a render that is, in
   fact, mid-startup. A blocked op's `evictIdleQwenBase` racing that window
   is a narrow gap. Its worst case is no longer just a lazy cold-reload on the
   starting render's first chapter (tts/ensure-sidecar-loaded.ts:31-36): since
   #4066 the op that evicts there can be a voice design, which then holds
   ~6 GB, so a Quality render's next chapter cannot reload its 1.7B base next
   to it and waits on the capacity budget, and can fail. No corruption or data
   loss either way. Closing
   it would need a "starting" marker set before that render's own reconcile
   and cleared once `registerJob` (or any earlier exit) hands off — not added
   here because `routes/generation.ts` declares `job`/`key`/`controller` in
   that same stretch and reads them from closures deep inside the per-chapter
   render loop hundreds of lines later, so the marker's lifetime can't be
   scoped to a clean try/finally without hoisting those declarations across a
   much larger span than this fix should touch. */

/** #4075 — per-ADMISSION state for `evictIdleQwenBase`'s quiet-poll rule.
    `withCapacityRetry` creates one per call and hands it to every ask, so two
    concurrent admissions never share a streak. `minGapMs` is its poll
    interval; `sawRepair` latches once the lever declined because a repair or
    splice was active; `idleSince` is the time of the first idle poll in the
    current quiet streak (null = no streak). The streak restarts on any
    activity seen at a poll AND on any splice that registered since
    `idleSince` was set, even one that already released (the splice epoch, see
    `readSpliceEpoch`); `epoch` is the epoch read when `idleSince` was set. */
export interface QuietPollState {
  minGapMs: number;
  sawRepair: boolean;
  idleSince: number | null;
  epoch: number | null;
}

let provider: (() => string[]) | null = null;
let spliceCounter: (() => number) | null = null;
let spliceEpochReader: (() => number) | null = null;

/** Registered by routes/generation.ts at module init with its existing
    `activeGenerationBooks` accessor. */
export function setActiveGenerationBooksProvider(fn: () => string[]): void {
  provider = fn;
}

/** #4066 — registered by routes/chapter-job-coordination.ts at module init
    with its in-flight splice count. A fs-26 splice and a QA repair (which
    registers through the same `registerSplice`) re-synthesise on the GPU but
    never enter generation's `inFlightByBook`, so the accessor above cannot see
    them. Unregistered counts as zero: the generation provider is the fail-closed
    one, and a splice can only exist once its registry (the registrant) has loaded. */
export function setInFlightSpliceCounter(fn: () => number): void {
  spliceCounter = fn;
}

/** #4075 — registered by routes/chapter-job-coordination.ts with a monotonic
    count of every `registerSplice` ever made. The quiet-poll rule needs it
    because the gate is only SAMPLED at each poll: a chapter that registers and
    releases wholly between two polls is invisible to the count above, but
    moves this epoch. A render's registration bumps nothing: a render is never
    'declined' (it spends the caller's latch), so it never reaches the quiet
    rule. */
export function setSpliceEpochReader(fn: () => number): void {
  spliceEpochReader = fn;
}

/** Current splice epoch, or `null` when no reader is registered. Callers must
    treat `null` as "moved" (fail closed): an unregistered reader can never
    complete the quiet rule, so the lever declines rather than evicting on a
    streak it cannot verify. */
export function readSpliceEpoch(): number | null {
  return spliceEpochReader ? spliceEpochReader() : null;
}

function spliceActive(): boolean {
  return (spliceCounter?.() ?? 0) > 0;
}

/** True when a render, splice or QA repair may be in flight anywhere.
    Unregistered resolves to `true` — fail closed (see file header). */
export function isAnyGenerationActive(): boolean {
  if (!provider) return true;
  return provider().length > 0 || spliceActive();
}

/** #4075 — true only when a splice or QA repair is KNOWN to be in flight and
    NO chapter render is. Unregistered resolves to `false`, so it never turns a
    fail-closed "active" into anything but the old answer. It does two jobs:
    wording (a repair is not a chapter render and cannot be paused, so its
    remedy is "wait"), and `evictIdleQwenBase`'s choice between `'declined'`
    (re-arm the caller's latch, repair only) and `false` (spend it, anything
    that may be a render: a multi-chapter render has a gap between one chapter
    job deregistering and the next registering, which a re-asked lever must not
    land in). Only the `isAnyGenerationActive` read decides whether to evict.
    A Fix-audio splice BATCH has the same gap (one POST per chapter), so a
    lever that has seen a repair additionally waits for a quiet streak
    (`QuietPollState`) before it evicts. One residue remains: a Listen-row QA
    repair can run during a render, and in the render's chapter gap it reads as
    repair-only. That is no wider than #1839's residual window above (the gate
    already reads idle between a render's POSTs), and the quiet-poll rule
    narrows it further. */
export function isRepairOnlyKnownActive(): boolean {
  if (!provider) return false;
  return provider().length === 0 && spliceActive();
}

/** True only when a render is KNOWN to be in flight. Unregistered resolves to
    `false`. For wording a message only (#4066, `describeVramBlockers`): there
    the worst case of a wrong `false` is a less specific error, while a wrong
    `true` would tell the user a render is running when none is. Never use it
    to decide whether an eviction is safe — that is `isAnyGenerationActive`. */
export function isGenerationKnownActive(): boolean {
  if (!provider) return false;
  return provider().length > 0 || spliceActive();
}
