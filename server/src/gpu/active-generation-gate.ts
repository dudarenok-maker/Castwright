/* Stateless leaf gate for "is any render in flight anywhere" (#1839).

   This module imports NOTHING — that is what makes it incapable of joining an
   import cycle. `routes/generation.ts` owns the actual state
   (`inFlightByBook`) and registers its existing `activeGenerationBooks`
   accessor here at module init; readers elsewhere (e.g.
   `server/src/gpu/evict-idle-tts.ts`) call `isAnyGenerationActive()` instead
   of importing the route module directly, which would recreate the cycle
   `routes/generation.ts -> tts/index.ts -> tts/sidecar.ts ->
   gpu/evict-idle-tts.ts -> routes/generation.ts`.

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
   "simplify" the unregistered default to `false`. */

let provider: (() => string[]) | null = null;

/** Registered by routes/generation.ts at module init with its existing
    `activeGenerationBooks` accessor. */
export function setActiveGenerationBooksProvider(fn: () => string[]): void {
  provider = fn;
}

/** True when a render may be in flight anywhere. Unregistered resolves to
    `true` — fail closed (see file header). */
export function isAnyGenerationActive(): boolean {
  if (!provider) return true;
  return provider().length > 0;
}
