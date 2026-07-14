/* Single canonical composition of voice-engine status for the setup Models step
   and the readiness badges. NOT a new per-engine model — per-engine state reuses
   deriveEngineHealth (engine-health.ts, "one source of truth for the Model
   Manager badge, the inventory, and the readiness gate"). This layer adds the
   runtime (venv/process) axis and GPU info, and composes over the small
   voice-engine registry. Pure over injected probe results (fs/network I/O lives
   in the route handler, mirroring setup-diagnosis.ts). */
import { VOICE_ENGINES, type VoiceEngineId } from './voice-engine-registry.js';
import { deriveEngineHealth, type EngineHealthState } from './engine-health.js';

export type RuntimeProcessState = 'ready' | 'starting' | 'down' | 'crashed';

export interface RuntimeStatus {
  installedOnDisk: boolean;
  pythonFound: boolean;
  process: RuntimeProcessState;
}

export interface EngineStatus {
  /** Reused engine-health state: not-installed | package-missing | weights-missing | ready | loaded. */
  state: EngineHealthState;
  /** Live: package present on disk but fails to IMPORT in the sidecar. Sidecar-up-only;
      false when the sidecar is down (never a first-run "fine" guarantee). */
  packageBroken: boolean;
}

export interface ModelsStatus {
  runtime: RuntimeStatus;
  engines: Record<VoiceEngineId, EngineStatus>;
  info: { gpu: string; vramTotalMb: number | null };
}

/** Per-engine probe results, gathered by the route handler. `importable` is the
    live /health find_spec flag: true (importable), false (present-but-broken), or
    undefined (unknown — sidecar down / older sidecar). */
export interface EngineProbeResult {
  packageOnDisk: boolean;
  weightsOnDisk: boolean;
  loaded: boolean;
  importable: boolean | undefined;
}

export interface BuildModelsStatusInput {
  runtime: RuntimeStatus;
  engines: Record<VoiceEngineId, EngineProbeResult>;
  info: { gpu: string; vramTotalMb: number | null };
}

export function buildModelsStatus(input: BuildModelsStatusInput): ModelsStatus {
  const engines = {} as Record<VoiceEngineId, EngineStatus>;
  for (const entry of VOICE_ENGINES) {
    const p = input.engines[entry.id];
    const { state } = deriveEngineHealth(entry.id, {
      packageInstalled: p.packageOnDisk,
      weightsPresent: p.weightsOnDisk,
      loaded: p.loaded,
    });
    // packageBroken: disk says package present, but the live sidecar can't import it.
    // undefined importable (sidecar down) → not broken-confirmed → false.
    const packageBroken = p.packageOnDisk && p.importable === false;
    engines[entry.id] = { state, packageBroken };
  }
  return { runtime: input.runtime, engines, info: input.info };
}

/** Derived: an engine a book could actually render with right now. */
export function engineUsable(s: EngineStatus): boolean {
  return (s.state === 'ready' || s.state === 'loaded') && !s.packageBroken;
}
