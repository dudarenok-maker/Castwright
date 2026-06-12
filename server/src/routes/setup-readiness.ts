/* fs-21 — GET /api/setup/readiness. A THIN MAPPER over diagnostics.ts (it
   must not re-implement the aggregator), adding the two probes diagnostics
   lacks: venv-on-disk and per-engine TTS weights. Drives the adaptive gate. */
import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { buildDiagnostics, type CheckId, type DiagnosticsResponse } from './diagnostics.js';
import { getResolvedAnalysisEngine, getResolvedSetupCompletedAt } from '../workspace/user-settings.js';
import { sidecarVenvPresent } from '../diagnostics/venv.js';
import { anyTtsEnginePresent } from '../tts/engine-presence.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/* Repo root computed locally, exactly as models-inventory.ts does (this file
   is also under server/src/routes/, so '..','..','..' lands on the repo root).
   workspace/paths.ts exports WORKSPACE_ROOT, NOT a repo root — don't import. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export type BlockerStatus = 'pass' | 'fail';

export interface SetupReadiness {
  ready: boolean;
  completedAt: string | null;
  blockers: { sidecar: BlockerStatus; ffmpeg: BlockerStatus; tts: BlockerStatus; analyzer: BlockerStatus };
  info: { gpu: string };
}

function checkOk(d: DiagnosticsResponse, id: CheckId): boolean {
  return d.checks.find((c) => c.id === id)?.status === 'ok';
}
function detail(d: DiagnosticsResponse, id: CheckId): string {
  return d.checks.find((c) => c.id === id)?.detail ?? '';
}

export function buildSetupReadiness(input: {
  diagnostics: DiagnosticsResponse;
  engine: 'local' | 'gemini';
  venvPresent: boolean;
  ttsEnginePresent: boolean;
  completedAt?: string | null;
}): SetupReadiness {
  const { diagnostics: d, engine, venvPresent, ttsEnginePresent } = input;
  const blockers = {
    sidecar: (checkOk(d, 'sidecar') && venvPresent ? 'pass' : 'fail') as BlockerStatus,
    ffmpeg: (checkOk(d, 'ffmpeg') ? 'pass' : 'fail') as BlockerStatus,
    tts: (ttsEnginePresent ? 'pass' : 'fail') as BlockerStatus,
    analyzer: (checkOk(d, engine === 'gemini' ? 'gemini' : 'analyzer') ? 'pass' : 'fail') as BlockerStatus,
  };
  return {
    ready: Object.values(blockers).every((b) => b === 'pass'),
    completedAt: input.completedAt ?? null,
    blockers,
    info: { gpu: detail(d, 'gpu') },
  };
}

export const setupReadinessRouter = Router();

setupReadinessRouter.get('/readiness', async (_req: Request, res: Response) => {
  const diagnostics = await buildDiagnostics();
  res.json(
    buildSetupReadiness({
      diagnostics,
      engine: getResolvedAnalysisEngine(),
      venvPresent: sidecarVenvPresent(REPO_ROOT),
      ttsEnginePresent: anyTtsEnginePresent(REPO_ROOT),
      completedAt: getResolvedSetupCompletedAt(),
    }),
  );
});
