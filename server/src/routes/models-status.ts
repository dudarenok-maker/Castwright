/* GET /api/setup/models-status — the single client-facing voice-engine status
   payload. Does the I/O (disk probes, one /health probe, VRAM, runtime axes)
   then delegates the pure composition to buildModelsStatus. `computeModelsStatus`
   is exported so setup-readiness.ts derives its sidecar/tts badges from the SAME
   computation (no second source). */
import { Router } from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from '../http.js';
import { buildModelsStatus, type ModelsStatus, type RuntimeProcessState } from '../tts/models-status.js';
import { VOICE_ENGINES, type VoiceEngineId } from '../tts/voice-engine-registry.js';
import { sidecarVenvPresent } from '../diagnostics/venv.js';
import { probePython312Cached } from './setup-diagnosis.js';
import { probeSidecarHealth, type SidecarHealthResult } from './sidecar-health.js';
import { getActiveSupervisor } from '../tts/sidecar-supervisor.js';
import { getDeviceTotalVramMb } from '../gpu/device-total.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Map the sidecar/supervisor liveness to the runtime.process axis. */
function deriveProcess(input: {
  reachable: boolean;
  supervisorActive: boolean;
  supervisorTripped: boolean;
  supervisorExhausted: boolean;
}): RuntimeProcessState {
  if (input.reachable) return 'ready';
  if (input.supervisorTripped || input.supervisorExhausted) return 'crashed';
  if (input.supervisorActive) return 'starting';
  return 'down';
}

/* Build the human GPU string from the SINGLE /health probe result (+ the
   boot-time nvidia-smi total for the sidecar-down case). This deliberately does
   NOT call buildDiagnostics — computeModelsStatus must make exactly ONE
   probeSidecarHealth() call (setup-readiness.ts:119-127 documents a "no second
   probe" invariant; a second one here would re-fire the setLastKnown* side
   effects and double the Models-step probe count). */
function gpuDetail(health: Partial<SidecarHealthResult>, bootTotalMb: number | null): string {
  const gb = (mb: number | null | undefined) => (mb != null ? (mb / 1024).toFixed(1) : '?');
  if (health.status === 'reachable') {
    const total = health.vramTotalMb ?? bootTotalMb;
    const reserved = health.vramReservedMb ?? null;
    const cuda = health.device === 'cuda' || total != null;
    if (!cuda) return health.device ? `device: ${health.device}` : 'CPU — no GPU detected';
    if (reserved != null && total != null) return `cuda · ${gb(reserved)} / ${gb(total)} GB reserved`;
    return total != null ? `cuda · ${gb(total)} GB` : `device: ${health.device}`;
  }
  // Sidecar down — fall back to the boot nvidia-smi total (sidecar-independent).
  return bootTotalMb != null ? `GPU · ~${gb(bootTotalMb)} GB (voice engine offline)` : 'CPU — no GPU detected';
}

export async function computeModelsStatus(repoRoot: string): Promise<ModelsStatus> {
  const installedOnDisk = sidecarVenvPresent(repoRoot);
  const pythonFound = installedOnDisk ? true : probePython312Cached();
  const supervisor = getActiveSupervisor();
  const health: Partial<SidecarHealthResult> = installedOnDisk
    ? await probeSidecarHealth()
    : { status: 'unreachable' };
  const reachable = health.status === 'reachable';

  const engines = {} as Record<VoiceEngineId, {
    packageOnDisk: boolean; weightsOnDisk: boolean; loaded: boolean; importable: boolean | undefined;
  }>;
  for (const e of VOICE_ENGINES) {
    engines[e.id] = {
      packageOnDisk: e.packageInstalledOnDisk(repoRoot),
      weightsOnDisk: e.weightsPresentOnDisk(repoRoot),
      loaded: reachable ? e.liveLoaded(health) : false,
      importable: reachable ? e.livePackageImportable(health) : undefined,
    };
  }

  // GPU string + total from the SINGLE probe (no second buildDiagnostics probe).
  const bootTotalMb = getDeviceTotalVramMb();

  return buildModelsStatus({
    runtime: {
      installedOnDisk,
      pythonFound,
      process: deriveProcess({
        reachable,
        supervisorActive: supervisor !== null,
        supervisorTripped: supervisor?.tripEvent() != null,
        supervisorExhausted: supervisor?.exhaustedEvent() ?? false,
      }),
    },
    engines,
    info: { gpu: gpuDetail(health, bootTotalMb), vramTotalMb: bootTotalMb },
  });
}

export const modelsStatusRouter = Router();

modelsStatusRouter.get('/models-status', async (_req: Request, res: Response) => {
  res.json(await computeModelsStatus(REPO_ROOT));
});
