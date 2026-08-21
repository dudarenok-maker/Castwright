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
    with no cast: TypeScript's object-literal excess-property check rejects a
    literal carrying a `packageFault` key against the first (Omit) overload, so
    only a caller with no such key can match it. This is what lets
    `EngineStatus.state` keep its narrower, openapi-documented 4-value type
    (models-status.ts's `EngineStatusState`) without duplicating this function. */
export function deriveEngineHealth(
  _id: EngineId,
  p: Omit<EngineProbe, 'packageFault'>,
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

