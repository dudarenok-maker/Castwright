/* Unified per-engine health: one source of truth for the Model Manager badge,
   the inventory, and the readiness gate. `package-missing` (weights present but
   the Python package gone — e.g. after a fresh venv rebuild) is a distinct state
   from `not-installed`, so the UI can offer a fast Repair instead of a full
   reinstall. `package-broken` (#2533) is a further distinct state on the same
   "weights present, package unusable" branch: the package is genuinely on disk
   but fails to import, vs. `package-missing`'s "genuinely absent" — see the
   optional `packageFault` probe input below. */

export type EngineId = 'kokoro' | 'qwen' | 'coqui' | 'whisper';
export type EngineHealthState =
  | 'ready'
  | 'package-missing'
  | 'package-broken'
  | 'weights-missing'
  | 'not-installed'
  | 'loaded';
export type EngineTier = 'standard' | 'secondary';

/* Standard engines ride the requirements bundle (their package reinstalls via a
   venv re-bootstrap); Coqui is the opt-in secondary engine with its own installer. */
const STANDARD: ReadonlySet<EngineId> = new Set<EngineId>(['kokoro', 'qwen', 'whisper']);

export const engineTier = (id: EngineId): EngineTier => (STANDARD.has(id) ? 'standard' : 'secondary');

export interface EngineProbe {
  packageInstalled: boolean;
  weightsPresent: boolean;
  loaded: boolean;
  /** #2533 — optional; when provided, picks 'package-broken' vs 'package-missing'
      on the `!packageInstalled && weightsPresent` branch below ('broken' →
      'package-broken', anything else → today's 'package-missing'). Omitted →
      behavior is EXACTLY as before this field existed, which is what lets
      models-status.ts's own call site (deliberately kept disk-only/coarse, see
      that module's `EngineStatus.state` doc) stay untouched. Inline literal
      type, not models-status.ts's `PackageFault`, to avoid a circular import —
      that module already imports `deriveEngineHealth`/`EngineHealthState` FROM
      this file. */
  packageFault?: 'ok' | 'missing' | 'broken';
}

/** Derive the 5-state health (+ loaded) from independent package/weights probes.
    `package-missing` must NOT collapse into `not-installed` — weights are present,
    only the package needs reinstalling. `package-broken` is the same branch's
    finer distinction: the package IS present but fails to import (see
    `packageFault` above) rather than being genuinely absent.

    Overloaded so a caller that never passes `packageFault` (models-status.ts's
    own call site — see that module's `EngineStatus.state` doc for why it stays
    disk-only/coarse) gets a return type that PROVABLY excludes 'package-broken',
    with no cast: the first overload's parameter type intersects `Omit<EngineProbe,
    'packageFault'>` with `{ packageFault?: never }`, so a variable or a spread
    whose *declared type* still carries a `packageFault` key is rejected by that
    overload — but a value whose declared type has been narrowed to omit the key
    (e.g. an explicit `Omit<EngineProbe, 'packageFault'>` annotation, or a generic
    constrained to that shape) can still slip through even if the underlying value
    carries `packageFault` at runtime; that residual gap is inherent to
    TypeScript's structural typing and not further closeable here. No such
    narrowing occurs anywhere in this tree today (models-status.ts:116 passes a
    fresh literal with no `packageFault` key at all). (An Omit alone only trips
    TypeScript's excess-property check against an inline literal; a probe built
    as a `const` first and passed by reference compiles clean against a bare Omit
    while still carrying `packageFault` at runtime — see the regression test
    titled "a probe extracted into a variable must still resolve to the WIDE
    overload" in engine-health.test.ts, which pins this at the type level via a
    conditional-type assignment that fails `tsc` if the overload regresses, not
    via `@ts-expect-error`.) This is what lets `EngineStatus.state` keep its
    narrower, openapi-documented 4-value type (models-status.ts's
    `EngineStatusState`) without duplicating this function. */
export function deriveEngineHealth(
  _id: EngineId,
  p: Omit<EngineProbe, 'packageFault'> & { packageFault?: never },
): { state: Exclude<EngineHealthState, 'package-broken'> };
export function deriveEngineHealth(_id: EngineId, p: EngineProbe): { state: EngineHealthState };
export function deriveEngineHealth(_id: EngineId, p: EngineProbe): { state: EngineHealthState } {
  if (p.loaded) return { state: 'loaded' };
  if (p.packageInstalled && p.weightsPresent) return { state: 'ready' };
  if (!p.packageInstalled && p.weightsPresent) {
    return { state: p.packageFault === 'broken' ? 'package-broken' : 'package-missing' };
  }
  if (p.packageInstalled && !p.weightsPresent) return { state: 'weights-missing' };
  return { state: 'not-installed' };
}

