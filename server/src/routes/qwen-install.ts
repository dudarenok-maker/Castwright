/* In-app Qwen3-TTS installer routes (qwen-default phase 3). Mirrors the Ollama
   install routes (server/src/routes/ollama-health.ts) so Account → Models can
   install Qwen without a terminal:

     GET  /api/qwen/detect          — install-state probe (no job)
     POST /api/qwen/install         — kick off install-qwen3.mjs (202 + job)
     GET  /api/qwen/install/:id     — poll job progress
     POST /api/qwen/install/:id/recheck — re-probe install-state

   On a successful recheck/install the last-known Qwen install-state cache is
   refreshed so getResolvedTtsModelKey flips the default to Qwen immediately
   (no waiting for the next /health poll). */

import { Router, type Request, type Response } from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QwenInstallBootstrap,
  type QwenInstallJob,
} from '../tts/qwen-install-bootstrap.js';
import { setLastKnownQwenInstallState } from '../workspace/user-settings.js';

export const qwenInstallRouter = Router();

/* server/src/routes/qwen-install.ts → repo root is three levels up. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const defaultBootstrap = new QwenInstallBootstrap({ repoRoot: REPO_ROOT });
let bootstrap: QwenInstallBootstrap = defaultBootstrap;

/** Test injection — swap in a stubbed bootstrap (offline, no spawn). */
export function setQwenInstallBootstrap(b: QwenInstallBootstrap): void {
  bootstrap = b;
}
export function _resetQwenInstallBootstrap(): void {
  bootstrap = defaultBootstrap;
}

/* Sync the resolver's cache from a job/detect snapshot so a freshly-installed
   Qwen becomes the default without a poll round-trip. */
function syncResolverCache(job: QwenInstallJob | { status: string }): void {
  if (job.status === 'installed') setLastKnownQwenInstallState('ready');
}

qwenInstallRouter.get('/detect', async (_req: Request, res: Response) => {
  const result = await bootstrap.detect();
  setLastKnownQwenInstallState(result.state);
  return res.json(result);
});

qwenInstallRouter.post('/install', (_req: Request, res: Response) => {
  const job = bootstrap.start();
  return res.status(202).json(job);
});

qwenInstallRouter.get('/install/:id', (req: Request, res: Response) => {
  const job = bootstrap.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: `No Qwen install job '${req.params.id}'` });
  }
  syncResolverCache(job);
  return res.json(job);
});

qwenInstallRouter.post('/install/:id/recheck', async (req: Request, res: Response) => {
  const job = await bootstrap.recheck(req.params.id);
  if (!job) {
    return res.status(404).json({ error: `No Qwen install job '${req.params.id}'` });
  }
  syncResolverCache(job);
  return res.json(job);
});
