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

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Run `pip <args>` in the venv; returns true on success (status 0). Non-fatal —
    the caller decides what a failure means (the amd path falls back to CPU). */
function pipOk(venvPy, pipArgs) {
  return spawnSync(venvPy, ['-m', 'pip', ...pipArgs], { stdio: 'inherit', windowsHide: true }).status === 0;
}

/** Absolute path of the requirements overlay for a profile. */
function overlayPath(profile) {
  return join(SIDECAR_DIR, 'requirements', overlayFileForProfile(profile));
}

/** Record an accelerator fallback (amd→cpu) next to the venv stamp so the runtime
    / UI can explain "AMD GPU detected but acceleration unavailable — on CPU".
    Best-effort; a write failure never blocks the (already-degraded) install. */
function writeFallbackMarker(venvDir, requested, effective, reason) {
  try {
    writeFileSync(
      join(venvDir, '.accelerator-fallback.json'),
      `${JSON.stringify({ requested, effective, reason }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Install the engine deps for `profile`, returning the profile ACTUALLY installed.
 * The amd path (ROCm torch wheels → amd overlay → ORT swap) is BEST-EFFORT: the
 * ROCm wheels are alpha previews, so if any amd step fails it FALLS BACK to a CPU
 * install — the app still works (degraded to CPU, surfaced via the fallback marker
 * + an honest 'cpu' stamp) instead of bricking a fresh AMD install. nvidia/cpu/
 * apple install their overlay directly (a failure there is fatal → throws). The
 * torch/ort steps use the same pure planners as the standalone install scripts.
 * `runPip` is injectable for tests.
 * @returns {string} the effective profile ('amd', or 'cpu' on an amd→cpu fallback)
 */
export function installForProfile(
  venvPy,
  profile,
  runPip = (a) => pipOk(venvPy, a),
  platform = process.platform,
  venvDir = null,
) {
  if (profile === 'amd') {
    const torch = planTorchPreinstall('amd', platform);
    if (torch.action === 'install') {
      log(`pre-installing ${torch.wheels.length} ROCm torch wheel(s) for the amd profile`);
    }
    let ok = torch.action !== 'install' || runPip(['install', '--no-cache-dir', ...torch.wheels]);
    if (ok) {
      log('installing requirements (amd-rocm overlay; this can take several minutes)');
      ok = runPip(['install', '-r', overlayPath('amd')]);
    }
    if (ok) {
      const ort = planOrtSwap('amd', platform);
      if (ort.action === 'swap') {
        for (const step of ort.steps) {
          if (!runPip(step)) {
            ok = false;
            break;
          }
        }
      }
    }
    if (ok) return 'amd';
    // ROCm install failed → degrade to a working CPU install (Auto + CPU fallback).
    log('AMD ROCm install FAILED — falling back to a CPU install so the app still works.');
    log('  GPU acceleration is unavailable; update your AMD driver / confirm ROCm support to retry.');
    if (venvDir) writeFallbackMarker(venvDir, 'amd', 'cpu', 'rocm-install-failed');
    if (!runPip(['install', '-r', overlayPath('cpu')])) {
      throw new Error('CPU fallback install also failed (check network + the sidecar venv)');
    }
    return 'cpu';
  }

  log(`installing requirements (${profile} overlay; this can take several minutes)`);
  if (!runPip(['install', '-r', overlayPath(profile)])) {
    throw new Error(`pip install failed for the ${profile} overlay`);
  }
  return profile;
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
    // installForProfile returns the EFFECTIVE profile — amd may degrade to cpu if
    // the ROCm install fails, so re-stamp the profile + its reqHash accordingly.
    const effective = runInstall(venvPy, profile, venvDir);
    const effReq = resolveRequired(SIDECAR_DIR, effective);
    writeStamp(venvDir, { ...(stamp ?? {}), profile: effective, reqHash: effReq.reqHash });
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
  // Effective profile — amd may degrade to cpu on a ROCm-install failure.
  const effective = runInstall(venvPy, profile, venvDir);

  // Stamp the tag of the REAL interpreter, not the required tag, so a
  // mis-supplied 3.11 python stamps cp311 (a later run then flags it). Stamp the
  // EFFECTIVE profile (resolved, possibly amd→cpu) + its reqHash so the venv
  // records what it actually built — the upgrade guard then carries it forward.
  const pythonTag = probePythonTag(venvPy) ?? required.pythonTag;
  const effReq = resolveRequired(SIDECAR_DIR, effective);
  writeStamp(venvDir, {
    pythonTag,
    profile: effective,
    reqHash: effReq.reqHash,
    builtVersion: readBuiltVersion(),
  });

  log('done');
}

/** Wrap installForProfile so a hard (non-fallback) failure prints a clean message
    and exits non-zero instead of dumping a stack — preserving the prior CLI UX. */
function runInstall(venvPy, profile, venvDir) {
  try {
    return installForProfile(venvPy, profile, undefined, process.platform, venvDir);
  } catch (err) {
    process.stderr.write(`[bootstrap-venv] FAIL: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
}

// Run only when invoked directly (node bootstrap-venv.mjs); stay inert on import
// so unit tests can exercise venvPythonPath / venvAlreadyBootstrapped without
// triggering a real venv creation.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
