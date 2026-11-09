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
   is a narrow gap whose worst case is a sidecar lazy cold-reload on the
   starting render's first chapter (documented as a correct fallback at
   tts/ensure-sidecar-loaded.ts:31-36), not corruption or data loss. Closing
   it would need a "starting" marker set before that render's own reconcile
   and cleared once `registerJob` (or any earlier exit) hands off — not added
   here because `routes/generation.ts` declares `job`/`key`/`controller` in
   that same stretch and reads them from closures deep inside the per-chapter
   render loop hundreds of lines later, so the marker's lifetime can't be
   scoped to a clean try/finally without hoisting those declarations across a
   much larger span than this fix should touch. */

let provider: (() => string[]) | null = null;
let spliceCounter: (() => number) | null = null;

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

function spliceActive(): boolean {
  return (spliceCounter?.() ?? 0) > 0;
}

/** True when a render, splice or QA repair may be in flight anywhere.
    Unregistered resolves to `true` — fail closed (see file header). */
export function isAnyGenerationActive(): boolean {
  if (!provider) return true;
  return provider().length > 0 || spliceActive();
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
