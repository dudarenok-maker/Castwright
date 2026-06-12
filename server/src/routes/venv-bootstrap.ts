/* In-app venv bootstrap routes (fs-21 decision Z). Mirrors kokoro-install.ts
   so Account → Models can bootstrap the Python venv without a terminal:

     GET  /api/setup/venv/detect              — venv + python probe (no job)
     POST /api/setup/venv/bootstrap           — kick off bootstrap-venv.mjs (202 + job)
     GET  /api/setup/venv/bootstrap/:id       — poll job progress
     POST /api/setup/venv/bootstrap/:id/recheck — re-probe venv state

   Verb is `/bootstrap`, NOT `/install` — the venv is not a model; we're
   setting up the runtime environment, not downloading weights. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VenvBootstrap } from '../tts/venv-bootstrap.js';

export const venvBootstrapRouter = Router();

/* server/src/routes/venv-bootstrap.ts → repo root is three levels up. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const defaultBootstrap = new VenvBootstrap({ repoRoot: REPO_ROOT });
let bootstrap: VenvBootstrap = defaultBootstrap;

/** Test injection — swap in a stubbed bootstrap (offline, no spawn). */
export function setVenvBootstrap(b: VenvBootstrap): void {
  bootstrap = b;
}
export function _resetVenvBootstrap(): void {
  bootstrap = defaultBootstrap;
}

venvBootstrapRouter.get('/detect', (_req: Request, res: Response) => {
  return res.json(bootstrap.detect());
});

venvBootstrapRouter.post('/bootstrap', (_req: Request, res: Response) => {
  const job = bootstrap.start();
  return res.status(202).json(job);
});

venvBootstrapRouter.get('/bootstrap/:id', (req: Request, res: Response) => {
  const job = bootstrap.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: `No venv bootstrap job '${req.params.id}'` });
  }
  return res.json(job);
});

venvBootstrapRouter.post('/bootstrap/:id/recheck', (req: Request, res: Response) => {
  const job = bootstrap.recheck(req.params.id);
  if (!job) {
    return res.status(404).json({ error: `No venv bootstrap job '${req.params.id}'` });
  }
  return res.json(job);
});
