/* Stateless leaf gate for "what does the sidecar currently report resident"
   (#1839).

   This module imports NOTHING — that is what makes it incapable of joining an
   import cycle. `routes/sidecar-health.ts` owns the actual `probeSidecarHealth`
   implementation and registers it here at module init; readers elsewhere
   (e.g. `gpu/capacity-retry.ts`, wiring `describeVramBlockers` into
   `NoCapacityError`) call `probeSidecarHealthIfRegistered()` instead of
   importing `routes/sidecar-health.ts` directly, which would close an import
   cycle: that route module is reachable from `gpu/capacity-retry.ts` via
   `tts/sidecar.ts` -> `tts/index.ts` -> `tts/voice-mapping.ts` (already a
   cycle) and separately via `routes/sidecar-health.ts` ->
   `tts/coqui-catalog-audit.ts` -> `tts/voice-mapping.ts` -> `tts/index.ts` ->
   `tts/sidecar.ts` -> `gpu/capacity-retry.ts` — closing the loop even though
   `probeSidecarHealth` itself never touches `gpu/capacity-retry.ts`. A dynamic
   `await import(...)` does NOT dodge this — madge (and Node's own module
   graph) still treats it as an edge, so it still shows up as a cycle.

   There is exactly one source of truth (the registered accessor) — nothing
   here copies or reimplements the probe, so it can't drift from
   `routes/sidecar-health.ts`'s own behaviour. Mirrors
   `./qwen-tier-reconcile-gate.ts` and `./active-generation-gate.ts`; see
   those files' headers for the fuller version of this argument.

   FAIL CLOSED IS REQUIRED, NOT A PREFERENCE. If `routes/sidecar-health.ts` has
   not registered yet (module load order, a future refactor, a test importing
   this module in isolation), `probeSidecarHealthIfRegistered` resolves to
   `null` — "nothing known" — so a caller treats it as "no blockers to name"
   rather than pretending a probe ran. That degrades `NoCapacityError`'s
   message back to today's generic "free VRAM" line, never to a false or stale
   blocker list. */

/** Narrow, locally-spelled-out shape — deliberately NOT `import type` from
    `routes/sidecar-health.ts`'s `SidecarHealthResult`. A type-only import
    still counts as an edge for cycle detection (see `evict-idle-tts.ts`'s file
    header for the same call). `SidecarHealthResult` is a structural superset
    of this, so the registered `probeSidecarHealth` satisfies it as-is. */
export interface SidecarHealthSnapshot {
  modelLoaded?: boolean;
  kokoroLoaded?: boolean;
  qwenLoaded?: boolean;
  qwenBase17Loaded?: boolean;
}

let provider: (() => Promise<SidecarHealthSnapshot>) | null = null;

/** Registered by routes/sidecar-health.ts at module init with its own
    `probeSidecarHealth`. */
export function setProbeSidecarHealthProvider(fn: () => Promise<SidecarHealthSnapshot>): void {
  provider = fn;
}

/** Calls the registered `probeSidecarHealth` and returns its result, or
    `null` when nothing has registered — fail closed (see file header). */
export async function probeSidecarHealthIfRegistered(): Promise<SidecarHealthSnapshot | null> {
  if (!provider) return null;
  return provider();
}
