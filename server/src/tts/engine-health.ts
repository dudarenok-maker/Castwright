/* Unified per-engine health: one source of truth for the Model Manager badge,
   the inventory, and the readiness gate. `package-missing` (weights present but
   the Python package gone — e.g. after a fresh venv rebuild) is a distinct state
   from `not-installed`, so the UI can offer a fast Repair instead of a full
   reinstall. */

export type EngineId = 'kokoro' | 'qwen' | 'coqui' | 'whisper';
export type EngineHealthState =
  | 'ready'
  | 'package-missing'
  | 'weights-missing'
  | 'not-installed'
  | 'loaded';
export type EngineTier = 'standard' | 'secondary';
export type RepairAction = 'venv-bootstrap' | 'installer';

/* Standard engines ride the requirements bundle (their package reinstalls via a
   venv re-bootstrap); Coqui is the opt-in secondary engine with its own installer. */
const STANDARD: ReadonlySet<EngineId> = new Set<EngineId>(['kokoro', 'qwen', 'whisper']);

export const engineTier = (id: EngineId): EngineTier => (STANDARD.has(id) ? 'standard' : 'secondary');

export interface EngineProbe {
  packageInstalled: boolean;
  weightsPresent: boolean;
  loaded: boolean;
}

/** Derive the 4-state health (+ loaded) from independent package/weights probes.
    `package-missing` must NOT collapse into `not-installed` — weights are present,
    only the package needs reinstalling. */
export function deriveEngineHealth(_id: EngineId, p: EngineProbe): { state: EngineHealthState } {
  if (p.loaded) return { state: 'loaded' };
  if (p.packageInstalled && p.weightsPresent) return { state: 'ready' };
  if (!p.packageInstalled && p.weightsPresent) return { state: 'package-missing' };
  if (p.packageInstalled && !p.weightsPresent) return { state: 'weights-missing' };
  return { state: 'not-installed' };
}

/** Repair routing by tier: standard engines re-bootstrap the venv (reinstall the
    overlay → the missing package); Coqui uses its opt-in installer (pip-installs). */
export function repairActionFor(id: EngineId, _state: EngineHealthState): RepairAction {
  return engineTier(id) === 'secondary' ? 'installer' : 'venv-bootstrap';
}
