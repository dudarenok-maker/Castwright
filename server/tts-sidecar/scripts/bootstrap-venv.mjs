#!/usr/bin/env node
// bootstrap-venv.mjs -- create a Python venv and pip-install requirements.txt
// into it. Spawned by the VenvBootstrap job class (fs-21 wave 1b) as:
//   node bootstrap-venv.mjs <pythonCmd> [pythonArgs...]
//
// Cross-platform Node ESM (Windows + macOS + Linux).
//
// What it does:
//   1. Resolve the venv directory (SIDECAR_VENV_DIR env or the canonical
//      <repoRoot>/server/tts-sidecar/.venv).
//   2. If the venv python binary already exists -> no-op (idempotent).
//   3. Otherwise: python -m venv <venvDir>, then <venvPython> -m pip install
//      -r requirements.txt.
//
// Usage:
//   node server/tts-sidecar/scripts/bootstrap-venv.mjs python3
//   node server/tts-sidecar/scripts/bootstrap-venv.mjs py -3.11
//
// Idempotent: if the venv python binary already exists, exits 0 immediately.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/ -> tts-sidecar/ -> server/ -> repo root  (3 levels up)
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/**
 * Return the path of the python binary inside a venv directory.
 * @param {string} venvDir  Absolute path to the venv root.
 * @param {string} platform process.platform value ('win32' | 'linux' | 'darwin' | …)
 * @returns {string}
 */
export function venvPythonPath(venvDir, platform) {
  return platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python');
}

/**
 * Return true iff the venv python binary already exists (venv was already
 * created and should have pip-installed deps).
 * @param {string} venvDir
 * @param {string} platform
 * @returns {boolean}
 */
export function venvAlreadyBootstrapped(venvDir, platform) {
  return existsSync(venvPythonPath(venvDir, platform));
}

function log(m) {
  process.stdout.write(`[bootstrap-venv] ${m}\n`);
}

function main() {
  const venvDir =
    process.env.SIDECAR_VENV_DIR ?? join(REPO_ROOT, 'server', 'tts-sidecar', '.venv');
  const platform = process.platform;

  if (venvAlreadyBootstrapped(venvDir, platform)) {
    log('venv already present — nothing to do');
    return;
  }

  const pyCmd = process.argv[2];
  const pyArgs = process.argv.slice(3);

  if (!pyCmd) {
    process.stderr.write('[bootstrap-venv] FAIL: no python command given\n');
    process.exit(1);
  }

  log(`creating venv at ${venvDir}`);
  const v = spawnSync(pyCmd, [...pyArgs, '-m', 'venv', venvDir], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (v.status !== 0) {
    process.stderr.write('[bootstrap-venv] FAIL: venv creation failed\n');
    process.exit(1);
  }

  const venvPy = venvPythonPath(venvDir, platform);
  const reqs = join(REPO_ROOT, 'server', 'tts-sidecar', 'requirements.txt');

  log('installing requirements (this can take several minutes)');
  const p = spawnSync(venvPy, ['-m', 'pip', 'install', '-r', reqs], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (p.status !== 0) {
    process.stderr.write('[bootstrap-venv] FAIL: pip install failed\n');
    process.exit(1);
  }

  log('done');
}

// Run only when invoked directly (node bootstrap-venv.mjs); stay inert on import
// so unit tests can exercise venvPythonPath / venvAlreadyBootstrapped without
// triggering a real venv creation.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
