#!/usr/bin/env node
// bootstrap-venv.mjs -- create a Python venv and pip-install requirements.txt
// into it. Spawned by the VenvBootstrap job class (fs-21 wave 1b) as:
//   node bootstrap-venv.mjs <pythonCmd> [pythonArgs...]
//
// Cross-platform Node ESM (Windows + macOS + Linux).
//
// What it does (Phase 1 — detect-and-reinstall, NO in-place rebuild):
//   1. Resolve the venv directory (SIDECAR_VENV_DIR env or the canonical
//      <repoRoot>/server/tts-sidecar/.venv).
//   2. classifyVenvState (venv-migration.mjs) against the venv stamp + what this
//      release requires (python-tag.txt + the requirements/ overlay hash):
//        - fresh-bootstrap (no venv): python -m venv, pip install, write the stamp
//          (stamping the REAL interpreter's cpXY tag).
//        - needs-reinstall (python/profile mismatch, or an un-stamped existing
//          venv): print reinstall guidance + exit non-zero WITHOUT touching the
//          venv. Never pip into a mismatched interpreter.
//        - pip-in-place (only requirements drifted): pip install, refresh the
//          stamp's reqHash.
//        - noop (everything matches): nothing to do.
//
// Usage (the caller resolves <pythonCmd> to a 3.12 interpreter):
//   node server/tts-sidecar/scripts/bootstrap-venv.mjs python3
//   node server/tts-sidecar/scripts/bootstrap-venv.mjs py -3.12

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  classifyVenvState,
  readStamp,
  writeStamp,
  resolveRequired,
} from './venv-migration.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/ -> tts-sidecar/ -> server/ -> repo root  (3 levels up)
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
// scripts/ -> tts-sidecar/
const SIDECAR_DIR = resolve(__dirname, '..');

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

/**
 * Ask an interpreter for its own cpXY tag (e.g. 'cp312'). We stamp the tag of the
 * REAL interpreter that built the venv, not the release's required tag — so a
 * mis-supplied 3.11 python stamps cp311 and a later run flags it for reinstall.
 * @param {string} pythonExe path to the python binary
 * @returns {string|null} the cpXY tag, or null if the probe failed
 */
function probePythonTag(pythonExe) {
  const r = spawnSync(
    pythonExe,
    ['-c', "import sys;print(f'cp{sys.version_info.major}{sys.version_info.minor}')"],
    { encoding: 'utf8', windowsHide: true },
  );
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  const tag = r.stdout.trim();
  return /^cp\d+$/.test(tag) ? tag : null;
}

/** Read the app version from the root package.json, or null if unavailable. */
function readBuiltVersion() {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** pip install -r requirements.txt into a venv python; exits non-zero on failure. */
function pipInstall(venvPy) {
  const reqs = join(SIDECAR_DIR, 'requirements.txt');
  log('installing requirements (this can take several minutes)');
  const p = spawnSync(venvPy, ['-m', 'pip', 'install', '-r', reqs], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (p.status !== 0) {
    process.stderr.write('[bootstrap-venv] FAIL: pip install failed\n');
    process.exit(1);
  }
}

function main() {
  const venvDir =
    process.env.SIDECAR_VENV_DIR ?? join(REPO_ROOT, 'server', 'tts-sidecar', '.venv');
  const platform = process.platform;
  const venvExists = venvAlreadyBootstrapped(venvDir, platform);
  const required = resolveRequired(SIDECAR_DIR);
  const { action } = classifyVenvState({
    venvExists,
    stamp: readStamp(venvDir),
    required,
  });

  if (action === 'noop') {
    log('venv up to date — nothing to do');
    return;
  }

  if (action === 'needs-reinstall') {
    process.stderr.write(
      '[bootstrap-venv] FAIL: this venv was built for a different Python or profile ' +
        'and cannot be upgraded in place.\n' +
        '[bootstrap-venv] This release needs a fresh reinstall: delete the venv at ' +
        `${venvDir} and re-run the installer (your books and voices are preserved — ` +
        'they live in the external workspace, not the venv).\n',
    );
    process.exit(1);
  }

  if (action === 'pip-in-place') {
    const venvPy = venvPythonPath(venvDir, platform);
    pipInstall(venvPy);
    const stamp = readStamp(venvDir) ?? {};
    writeStamp(venvDir, { ...stamp, reqHash: required.reqHash });
    log('done');
    return;
  }

  // action === 'fresh-bootstrap'
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
  pipInstall(venvPy);

  // Stamp the tag of the REAL interpreter, not the required tag, so a
  // mis-supplied 3.11 python stamps cp311 (a later run then flags it).
  const pythonTag = probePythonTag(venvPy) ?? required.pythonTag;
  writeStamp(venvDir, {
    pythonTag,
    profile: 'nvidia',
    reqHash: required.reqHash,
    builtVersion: readBuiltVersion(),
  });

  log('done');
}

// Run only when invoked directly (node bootstrap-venv.mjs); stay inert on import
// so unit tests can exercise venvPythonPath / venvAlreadyBootstrapped without
// triggering a real venv creation.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
