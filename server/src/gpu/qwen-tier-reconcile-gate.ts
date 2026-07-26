/* Stateless leaf gate for "free a resident Qwen base tier this run doesn't
   need" (#1839).

   This module imports NOTHING — that is what makes it incapable of joining an
   import cycle. `tts/ensure-sidecar-loaded.ts` owns the actual
   `reconcileResidentQwenTiers` implementation and registers it here at module
   init; readers elsewhere (e.g. `server/src/gpu/evict-idle-tts.ts`) call
   `reconcileResidentQwenTiersIfRegistered()` instead of importing
   `tts/ensure-sidecar-loaded.ts` directly, which would recreate an import
   cycle: that module's OTHER exports reach `gpu/engine-device.ts` (dynamic
   import) -> `gpu/engine-device-state.ts` -> `routes/sidecar-health.ts` ->
   `tts/coqui-catalog-audit.ts` -> `tts/voice-mapping.ts` -> `tts/index.ts`,
   which is exactly where `gpu/evict-idle-tts.ts` is reached FROM (via
   `tts/sidecar.ts`) — closing the loop even though
   `reconcileResidentQwenTiers` itself never touches any of that.

   There is exactly one source of truth (the registered function) — nothing
   here copies or reimplements the reconcile logic, so it can't drift from
   `tts/ensure-sidecar-loaded.ts`'s own behaviour.

   FAIL CLOSED IS REQUIRED, NOT A PREFERENCE. If `tts/ensure-sidecar-loaded.ts`
   has not registered yet (module load order, a future refactor, a test
   importing this module in isolation), `reconcileResidentQwenTiersIfRegistered`
   resolves to `false` — "nothing can be freed" — so `evictIdleQwenBase`
   declines to evict rather than pretending it succeeded. Do NOT "simplify"
   the unregistered default to `true`.

   TRUTHFUL RETURN (#1839 finding 1). The registered `reconcileResidentQwenTiers`
   itself reports whether it actually issued an `/unload` (its `evictions`
   array was non-empty) — this gate passes that value straight through rather
   than collapsing "registered" and "freed something" into the same `true`.
   Being registered but freeing nothing (the tier to drop was never resident)
   must read as `false` here too, or `evictIdleQwenBase` reports success having
   freed nothing and `capacity-retry.ts` burns a retry attempt on an immediate
   no-op retry instead of polling. */

let provider:
  | ((keep: { keep06: boolean; keep17: boolean }, signal?: AbortSignal) => Promise<boolean>)
  | null = null;

/** Registered by tts/ensure-sidecar-loaded.ts at module init with its own
    `reconcileResidentQwenTiers`. */
export function setReconcileResidentQwenTiersProvider(
  fn: (keep: { keep06: boolean; keep17: boolean }, signal?: AbortSignal) => Promise<boolean>,
): void {
  provider = fn;
}

/** Calls the registered `reconcileResidentQwenTiers` and returns whatever it
    reports (`true` only when it actually issued an `/unload`), or returns
    `false` without doing anything when nothing has registered — fail closed
    (see file header). */
export async function reconcileResidentQwenTiersIfRegistered(
  keep: { keep06: boolean; keep17: boolean },
  signal?: AbortSignal,
): Promise<boolean> {
  if (!provider) return false;
  return provider(keep, signal);
}
