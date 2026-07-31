/* Single canonical composition of voice-engine status for the setup Models step
   and the readiness badges. NOT a new per-engine model — per-engine state reuses
   deriveEngineHealth (engine-health.ts, "one source of truth for the Model
   Manager badge, the inventory, and the readiness gate"). This layer adds the
   runtime (venv/process) axis and GPU info, and composes over the small
   voice-engine registry. Pure over injected probe results (fs/network I/O lives
   in the route handler, mirroring setup-diagnosis.ts). */
import { VOICE_ENGINES, type VoiceEngineId } from './voice-engine-registry.js';
import { deriveEngineHealth, type EngineHealthState } from './engine-health.js';
import { recommendEngines, type RecommendationSet } from './engine-recommendation.js';

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
  /** fe-51 — precomputed recommendation for both answers to the wizard's guided
      question. Derived from info.vramTotalMb + the engine capability map. */
  recommendation: RecommendationSet;
}

/** Per-engine probe results, gathered by the route handler.

    #1965 — the two live signals are kept APART rather than pre-collapsed into a
    single `importable`, because they are not the same claim:

    - `importOk` — a REAL import statement was executed in the sidecar and
      returned (true) or raised (false). Sticky per sidecar process.
    - `specPresent` — the `find_spec` probe. Says the package is on the venv's
      path; says nothing about whether importing it would actually work (that
      gap is #1944, the speechbrain lazy-proxy collision).

    `undefined` on EITHER means unknown — sidecar down, older sidecar, or (for
    `importOk`, the common case) nothing has tried to import that engine yet in
    this sidecar process. Unknown is never "broken"; see the fail-open rule at
    voice-engine-registry.ts:26-29. */
export interface EngineProbeResult {
  packageOnDisk: boolean;
  weightsOnDisk: boolean;
  loaded: boolean;
  importOk: boolean | undefined;
  specPresent: boolean | undefined;
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
    /* packageBroken: disk says package present, but the live sidecar can't use
       it. A real failed import is the strongest evidence and wins outright;
       with no real attempt to trust we fall back to find_spec. Unknown on both
       axes (sidecar down / older sidecar / engine never loaded) → not
       broken-confirmed → false.

       #1965 — this is exactly equivalent to the pre-split
       `packageOnDisk && (importOk ?? specPresent) === false`, which is what
       makes the split a pure refactor: the `??` collapse used to happen in
       voice-engine-registry's single accessor and now happens here, once. */
    const packageBroken =
      p.packageOnDisk &&
      (p.importOk === false || (p.importOk === undefined && p.specPresent === false));
    engines[entry.id] = { state, packageBroken };
  }
  return {
    runtime: input.runtime,
    engines,
    info: input.info,
    recommendation: recommendEngines(input.info.vramTotalMb),
  };
}

/** Derived: an engine a book could actually render with right now. */
export function engineUsable(s: EngineStatus): boolean {
  return (s.state === 'ready' || s.state === 'loaded') && !s.packageBroken;
}
