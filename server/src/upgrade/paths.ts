/* fs-1 — resolve the install/release/staging paths the upgrade flow needs,
   given the running server's repoRoot. In a versioned-dir install repoRoot is
   <install>/releases/vX.Y.Z, so installRoot is two levels up and releasesDir is
   its parent. In a plain checkout (no releases/ ancestor) installRoot == repoRoot
   and releasesDir is a notional <repoRoot>/releases (apply is a dev-only path
   there). Pure — repoRoot injected so it's unit-testable. */

import { basename, dirname, join } from 'node:path';
import { resolveRunDir } from '../app-dirs.js';

export interface UpgradePaths {
  repoRoot: string;
  installRoot: string;
  releasesDir: string;
  isVersioned: boolean;
  stagingDir: string;
  stagedZip: string;
  stateFile: string;
  venvDir: string;
  serverPidFile: string;
}

export function resolveUpgradePaths(repoRoot: string, env: NodeJS.ProcessEnv = process.env): UpgradePaths {
  const releasesParent = dirname(repoRoot);
  const isVersioned = basename(releasesParent) === 'releases';
  const installRoot = isVersioned ? dirname(releasesParent) : repoRoot;
  const releasesDir = isVersioned ? releasesParent : join(repoRoot, 'releases');
  const stagingDir = join(installRoot, '.upgrade-staging');
  const venvDir = env.SIDECAR_VENV_DIR
    ? env.SIDECAR_VENV_DIR
    : join(repoRoot, 'server', 'tts-sidecar', '.venv');
  return {
    repoRoot,
    installRoot,
    releasesDir,
    isVersioned,
    stagingDir,
    stagedZip: join(stagingDir, 'incoming.zip'),
    stateFile: join(stagingDir, 'state.json'),
    venvDir,
    serverPidFile: join(resolveRunDir(repoRoot), 'server.pid'),
  };
}
