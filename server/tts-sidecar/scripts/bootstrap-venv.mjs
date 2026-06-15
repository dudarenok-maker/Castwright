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
  overlayFileForProfile,
} from './venv-migration.mjs';
import { resolveInstallProfile } from './accelerator-profile.mjs';
import { planTorchPreinstall } from './install-torch.mjs';
import { planOrtSwap } from './install-ort.mjs';

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

/** Run `pip <args>` in the venv; exits non-zero (with `label`) on failure. */
function pip(venvPy, pipArgs, label) {
  const p = spawnSync(venvPy, ['-m', 'pip', ...pipArgs], { stdio: 'inherit', windowsHide: true });
  if (p.status !== 0) {
    process.stderr.write(`[bootstrap-venv] FAIL: ${label}\n`);
    process.exit(1);
  }
}

/**
 * Install the engine deps for `profile` into the venv: (1) pre-install the ROCm
 * torch wheels for amd (no-op otherwise), (2) pip install the profile's
 * requirements overlay, (3) swap base onnxruntime → onnxruntime-directml on
 * amd-win (no-op otherwise). For nvidia this is exactly today's single overlay
 * install. The torch/ort steps are driven by the same pure planners the
 * standalone install-torch.mjs / install-ort.mjs CLIs use.
 */
function installForProfile(venvPy, profile) {
  const torch = planTorchPreinstall(profile, process.platform);
  if (torch.action === 'install') {
    log(`pre-installing ${torch.wheels.length} ROCm torch wheel(s) for the amd profile`);
    pip(venvPy, ['install', '--no-cache-dir', ...torch.wheels], 'ROCm torch pre-install failed');
  }

  const overlay = join(SIDECAR_DIR, 'requirements', overlayFileForProfile(profile));
  log(`installing requirements (${profile} overlay; this can take several minutes)`);
  pip(venvPy, ['install', '-r', overlay], 'pip install failed');

  const ort = planOrtSwap(profile, process.platform);
  if (ort.action === 'swap') {
    log('swapping onnxruntime → onnxruntime-directml (Kokoro on DirectML)');
    for (const step of ort.steps) pip(venvPy, step, `pip ${step.join(' ')} failed`);
  }
}

function main() {
  const venvDir =
    process.env.SIDECAR_VENV_DIR ?? join(REPO_ROOT, 'server', 'tts-sidecar', '.venv');
  const platform = process.platform;
  const venvExists = venvAlreadyBootstrapped(venvDir, platform);
  const stamp = readStamp(venvDir);
  // Effective profile: ACCELERATOR override → the existing venv's stamped profile
  // (carry-forward, so an existing install is never force-migrated) → detection.
  const profile = resolveInstallProfile({
    envOverride: process.env.ACCELERATOR ?? null,
    stampProfile: stamp?.profile ?? null,
    platform,
  });
  const required = resolveRequired(SIDECAR_DIR, profile);
  const { action } = classifyVenvState({ venvExists, stamp, required });

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
    installForProfile(venvPy, profile);
    writeStamp(venvDir, { ...(stamp ?? {}), reqHash: required.reqHash });
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
  installForProfile(venvPy, profile);

  // Stamp the tag of the REAL interpreter, not the required tag, so a
  // mis-supplied 3.11 python stamps cp311 (a later run then flags it). Stamp the
  // resolved profile (no longer hardcoded nvidia) so an amd/cpu install records
  // what it actually built — the upgrade guard then carries it forward.
  const pythonTag = probePythonTag(venvPy) ?? required.pythonTag;
  writeStamp(venvDir, {
    pythonTag,
    profile,
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
