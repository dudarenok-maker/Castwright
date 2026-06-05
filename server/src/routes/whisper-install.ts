/* In-app Whisper ASR installer routes (srv-31, plan 186). Mirrors the Qwen
   install routes so Account → Models can install the ASR content-QA engine
   without a terminal:

     GET  /api/whisper/detect             — install-state probe (no job)
     POST /api/whisper/install            — kick off install-whisper.mjs (202 + job)
     GET  /api/whisper/install/:id        — poll job progress
     POST /api/whisper/install/:id/recheck — re-probe install-state

   No resolver-cache sync (unlike Qwen) — ASR isn't an auto-selected synth
   engine; it's gated explicitly by SEG_ASR_ENABLED. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WhisperInstallBootstrap } from '../tts/whisper-install-bootstrap.js';

export const whisperInstallRouter = Router();

/* server/src/routes/whisper-install.ts → repo root is three levels up. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const defaultBootstrap = new WhisperInstallBootstrap({ repoRoot: REPO_ROOT });
let bootstrap: WhisperInstallBootstrap = defaultBootstrap;

/** Test injection — swap in a stubbed bootstrap (offline, no spawn). */
export function setWhisperInstallBootstrap(b: WhisperInstallBootstrap): void {
  bootstrap = b;
}
export function _resetWhisperInstallBootstrap(): void {
  bootstrap = defaultBootstrap;
}

whisperInstallRouter.get('/detect', async (_req: Request, res: Response) => {
  return res.json(await bootstrap.detect());
});

whisperInstallRouter.post('/install', (_req: Request, res: Response) => {
  const job = bootstrap.start();
  return res.status(202).json(job);
});

whisperInstallRouter.get('/install/:id', (req: Request, res: Response) => {
  const job = bootstrap.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: `No Whisper install job '${req.params.id}'` });
  }
  return res.json(job);
});

whisperInstallRouter.post('/install/:id/recheck', async (req: Request, res: Response) => {
  const job = await bootstrap.recheck(req.params.id);
  if (!job) {
    return res.status(404).json({ error: `No Whisper install job '${req.params.id}'` });
  }
  return res.json(job);
});
