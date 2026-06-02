/* In-app Coqui XTTS v2 installer routes. Mirrors the Qwen install routes
   (server/src/routes/qwen-install.ts) so Account → Models can pre-fetch the
   XTTS v2 weights without a terminal:

     GET  /api/coqui/detect          — install-state probe (no job)
     POST /api/coqui/install         — kick off install-coqui.mjs (202 + job)
     GET  /api/coqui/install/:id     — poll job progress
     POST /api/coqui/install/:id/recheck — re-probe install-state

   Unlike Qwen there's no last-known-install-state cache to sync: Coqui is the
   ALTERNATE engine, never auto-selected as the default, so install-state never
   feeds getResolvedTtsModelKey. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoquiInstallBootstrap } from '../tts/coqui-install-bootstrap.js';

export const coquiInstallRouter = Router();

/* server/src/routes/coqui-install.ts → repo root is three levels up. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const defaultBootstrap = new CoquiInstallBootstrap({ repoRoot: REPO_ROOT });
let bootstrap: CoquiInstallBootstrap = defaultBootstrap;

/** Test injection — swap in a stubbed bootstrap (offline, no spawn). */
export function setCoquiInstallBootstrap(b: CoquiInstallBootstrap): void {
  bootstrap = b;
}
export function _resetCoquiInstallBootstrap(): void {
  bootstrap = defaultBootstrap;
}

coquiInstallRouter.get('/detect', async (_req: Request, res: Response) => {
  const result = await bootstrap.detect();
  return res.json(result);
});

coquiInstallRouter.post('/install', (_req: Request, res: Response) => {
  const job = bootstrap.start();
  return res.status(202).json(job);
});

coquiInstallRouter.get('/install/:id', (req: Request, res: Response) => {
  const job = bootstrap.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: `No Coqui install job '${req.params.id}'` });
  }
  return res.json(job);
});

coquiInstallRouter.post('/install/:id/recheck', async (req: Request, res: Response) => {
  const job = await bootstrap.recheck(req.params.id);
  if (!job) {
    return res.status(404).json({ error: `No Coqui install job '${req.params.id}'` });
  }
  return res.json(job);
});
