/* In-app Kokoro install routes (fs-21). Mirrors the Coqui/Whisper install
   routes so Account → Models can install the Kokoro ONNX weights without a
   terminal:

     GET  /api/kokoro/detect              — install-state probe (no job)
     POST /api/kokoro/install             — kick off install-kokoro.mjs (202 + job)
     GET  /api/kokoro/install/:id         — poll job progress
     POST /api/kokoro/install/:id/recheck — re-probe install-state

   No resolver-cache sync (unlike Qwen) — Kokoro's presence is detected at
   sidecar startup, not via a lazy resolver; install-state never feeds
   getResolvedTtsModelKey on the server side. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KokoroInstallBootstrap } from '../tts/kokoro-install-bootstrap.js';

export const kokoroInstallRouter = Router();

/* server/src/routes/kokoro-install.ts → repo root is three levels up. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const defaultBootstrap = new KokoroInstallBootstrap({ repoRoot: REPO_ROOT });
let bootstrap: KokoroInstallBootstrap = defaultBootstrap;

/** Test injection — swap in a stubbed bootstrap (offline, no spawn). */
export function setKokoroInstallBootstrap(b: KokoroInstallBootstrap): void {
  bootstrap = b;
}
export function _resetKokoroInstallBootstrap(): void {
  bootstrap = defaultBootstrap;
}

kokoroInstallRouter.get('/detect', async (_req: Request, res: Response) => {
  return res.json(await bootstrap.detect());
});

kokoroInstallRouter.post('/install', (_req: Request, res: Response) => {
  const job = bootstrap.start();
  return res.status(202).json(job);
});

kokoroInstallRouter.get('/install/:id', (req: Request, res: Response) => {
  const job = bootstrap.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: `No Kokoro install job '${req.params.id}'` });
  }
  return res.json(job);
});

kokoroInstallRouter.post('/install/:id/recheck', async (req: Request, res: Response) => {
  const job = await bootstrap.recheck(req.params.id);
  if (!job) {
    return res.status(404).json({ error: `No Kokoro install job '${req.params.id}'` });
  }
  return res.json(job);
});
