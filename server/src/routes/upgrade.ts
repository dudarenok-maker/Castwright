/* fs-1 — /api/upgrade/{stage,apply,abort,state}: the in-app upgrade flow.

   stage  (multipart zip) → validate + record a candidate, refusing while busy
                            (409) or for a downgrade (412).
   apply  → extract the candidate into a NEW releases/ sibling, npm ci,
            conditional venv pip, flip the .current-version pointer, spawn the
            detached restarter, then SIGTERM this server. Returns 202; the UI
            polls /state + /api/info until the new version answers.
   abort  → drop the staged zip.
   state  → current phase (+ live busy) so the UI overlay can render.

   The destructive work (validate, apply) lives in ../upgrade/* so it can be
   unit-tested; this router is the HTTP surface + state-file bookkeeping. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import multer from 'multer';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAppVersion } from '../app-version.js';
import { anyJobInFlight } from '../upgrade/busy-probe.js';
import { validateUpgradeZip } from '../upgrade/zip-validate.js';
import { applyUpgrade, createApplySteps } from '../upgrade/apply.js';
import { resolveUpgradePaths, type UpgradePaths } from '../upgrade/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/* server/{src,dist}/routes → repoRoot is three levels up. */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

export type UpgradePhase = 'idle' | 'staged' | 'applying' | 'restarting' | 'error';

interface UpgradeState {
  phase: UpgradePhase;
  candidateVersion?: string;
  reqHash?: string | null;
  topDir?: string;
  isDowngrade?: boolean;
  error?: string;
}

function paths(): UpgradePaths {
  return resolveUpgradePaths(REPO_ROOT);
}

function readState(p: UpgradePaths): UpgradeState {
  try {
    return JSON.parse(readFileSync(p.stateFile, 'utf8')) as UpgradeState;
  } catch {
    return { phase: 'idle' };
  }
}

function writeState(p: UpgradePaths, state: UpgradeState): void {
  mkdirSync(p.stagingDir, { recursive: true });
  writeFileSync(p.stateFile, JSON.stringify(state), 'utf8');
}

const uploadMw = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const p = paths();
      mkdirSync(p.stagingDir, { recursive: true });
      cb(null, p.stagingDir);
    },
    filename: (_req, _file, cb) => cb(null, 'incoming.zip'),
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // a full bundle is ~30 MB; cap generously.
});

export const upgradeRouter = Router();

upgradeRouter.get('/state', (_req: Request, res: Response) => {
  const p = paths();
  const busy = anyJobInFlight();
  res.json({ ...readState(p), busy: busy.busy, busyReason: busy.busy ? busy : undefined });
});

upgradeRouter.post('/stage', (req: Request, res: Response) => {
  const busy = anyJobInFlight();
  if (busy.busy) {
    return res.status(409).json({ error: 'A generation or analysis job is in flight.', ...busy });
  }
  uploadMw.single('zip')(req as never, res as never, async (err: unknown) => {
    const p = paths();
    if (err) {
      return res.status(400).json({ error: err instanceof multer.MulterError ? err.code : 'upload failed' });
    }
    if (!existsSync(p.stagedZip)) {
      return res.status(400).json({ error: 'No zip uploaded (field name must be "zip").' });
    }
    try {
      const v = await validateUpgradeZip(p.stagedZip, getAppVersion());
      if (!v.ok) {
        rmSync(p.stagedZip, { force: true });
        writeState(p, { phase: 'idle' });
        const status = v.code === 'downgrade' ? 412 : 400;
        return res.status(status).json({ error: v.reason, code: v.code });
      }
      const steps = createApplySteps({ venvDir: p.venvDir });
      const requiresPipInstall = !!v.reqHash && v.reqHash !== steps.readReqHash();
      writeState(p, {
        phase: 'staged',
        candidateVersion: v.candidateVersion,
        reqHash: v.reqHash,
        topDir: v.topDir,
        isDowngrade: v.isDowngrade,
      });
      return res.json({
        candidateVersion: v.candidateVersion,
        runningVersion: getAppVersion(),
        reqHash: v.reqHash,
        requiresPipInstall,
        isDowngrade: v.isDowngrade,
      });
    } catch (e) {
      rmSync(p.stagedZip, { force: true });
      return res.status(400).json({ error: (e as Error).message });
    }
  });
});

upgradeRouter.post('/abort', (_req: Request, res: Response) => {
  const p = paths();
  rmSync(p.stagedZip, { force: true });
  writeState(p, { phase: 'idle' });
  res.json({ ok: true });
});

upgradeRouter.post('/apply', async (_req: Request, res: Response) => {
  const p = paths();
  const busy = anyJobInFlight();
  if (busy.busy) {
    return res.status(409).json({ error: 'A generation or analysis job is in flight.', ...busy });
  }
  const state = readState(p);
  if (state.phase !== 'staged' || !state.candidateVersion || !state.topDir) {
    return res.status(409).json({ error: 'Nothing staged. POST /stage a zip first.' });
  }

  writeState(p, { ...state, phase: 'applying' });
  res.status(202).json({ status: 'applying', toVersion: state.candidateVersion });

  // Background — the response has already been sent. Update the state file as it
  // progresses; on success flip to 'restarting' and SIGTERM ourselves so the
  // detached restarter (spawned inside applyUpgrade) sees us exit and boots the
  // new release.
  void (async () => {
    try {
      const result = await applyUpgrade(
        {
          installRoot: p.installRoot,
          releasesDir: p.releasesDir,
          stagedZipPath: p.stagedZip,
          topDir: state.topDir as string,
          candidateVersion: state.candidateVersion as string,
          reqHash: state.reqHash ?? null,
          oldPid: process.pid,
        },
        createApplySteps({ venvDir: p.venvDir, log: (m) => console.log(m) }),
      );
      if (result.ok) {
        writeState(p, { phase: 'restarting', candidateVersion: result.version });
        console.log(`[upgrade] applied v${result.version}; restarting.`);
        setTimeout(() => process.kill(process.pid, 'SIGTERM'), 250);
      } else {
        writeState(p, { phase: 'error', candidateVersion: state.candidateVersion, error: `${result.phase}: ${result.error}` });
        console.error(`[upgrade] apply failed at ${result.phase}: ${result.error}`);
      }
    } catch (e) {
      writeState(p, { phase: 'error', candidateVersion: state.candidateVersion, error: (e as Error).message });
      console.error('[upgrade] apply threw:', e);
    }
  })();
});
