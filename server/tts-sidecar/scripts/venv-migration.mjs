// venv-migration.mjs — pure decision core for the venv stamp + detect-and-reinstall
// logic. Consumed live in Phase 1 by BOTH bootstrap-venv.mjs (fresh-install path)
// and apply.ts (self-upgrade guard) via `resolveRequired` + `classifyVenvState` +
// `readStamp` — they share this one module so the two paths can't classify the same
// venv differently. Tested from server/src/tts/venv-migration.test.ts which imports
// it directly. Plain synchronous ESM library (no CLI guard, no top-level await) so a
// server .ts can statically import from it inertly (a sibling .d.mts supplies types).

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Hash the *text* of the resolved requirements files (overlay then base), in the
 * given order. NOT a pip-resolved dependency tree — same fidelity as today's
 * single-file hash, just multi-file (H2/A9).
 * @param {string[]} fileContents  file texts in a defined order
 * @returns {string} hex sha256
 */
export function computeReqHash(fileContents) {
  const h = createHash('sha256');
  for (const c of fileContents) {
    h.update(String(c));
    h.update('\0'); // separator so ['ab',''] != ['a','b']
  }
  return h.digest('hex');
}

/**
 * Three-way venv decision. A missing/null stamp is treated as a mismatch →
 * rebuild (M2: v1.7.0 venvs have no stamp). Interpreter/profile changes force a
 * rebuild (a venv is bound to its Python); a requirements-only change is an
 * in-place pip install; otherwise no-op.
 * @param {{stamp: {pythonTag:string,profile:string,reqHash:string}|null,
 *          required: {pythonTag:string,profile:string,reqHash:string}}} a
 * @returns {'rebuild'|'pip-in-place'|'noop'}
 */
export function decideVenvAction({ stamp, required }) {
  if (!stamp) return 'rebuild';
  if (stamp.pythonTag !== required.pythonTag) return 'rebuild';
  if (stamp.profile !== required.profile) return 'rebuild';
  if (stamp.reqHash !== required.reqHash) return 'pip-in-place';
  return 'noop';
}

/** Path of the stamp file inside a venv dir. */
export function stampPath(venvDir) {
  return join(venvDir, '.venv-stamp.json');
}

/**
 * Read the venv stamp. Returns null on a missing OR corrupt file (M2: both mean
 * "rebuild" downstream) — never throws.
 * @returns {{pythonTag:string,profile:string,reqHash:string,builtVersion?:string}|null}
 */
export function readStamp(venvDir) {
  try {
    return JSON.parse(readFileSync(stampPath(venvDir), 'utf8'));
  } catch {
    return null;
  }
}

/** Write the venv stamp (pretty JSON). */
export function writeStamp(venvDir, stamp) {
  writeFileSync(stampPath(venvDir), `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');
}

/**
 * Phase-1 venv classifier. Composes readStamp/decideVenvAction into the
 * detect-and-reinstall actions: Phase 1 never does an in-place teardown, so a
 * Python/profile mismatch (decideVenvAction's 'rebuild') maps to
 * 'needs-reinstall' (guide a fresh reinstall — the v1.6.0 precedent). A missing
 * venv is a fresh bootstrap; requirements-only drift is pip-in-place; an exact
 * match is a no-op.
 * @param {{venvExists: boolean,
 *          stamp: {pythonTag:string,profile:string,reqHash:string}|null,
 *          required: {pythonTag:string,profile:string,reqHash:string}}} a
 * @returns {{action: 'fresh-bootstrap'|'needs-reinstall'|'pip-in-place'|'noop'}}
 */
export function classifyVenvState({ venvExists, stamp, required }) {
  if (!venvExists) return { action: 'fresh-bootstrap' };
  const decision = decideVenvAction({ stamp, required });
  if (decision === 'rebuild') return { action: 'needs-reinstall' };
  return { action: decision };
}

/**
 * The requirements overlay file for an install profile. amd/cpu get their own
 * overlay; nvidia, apple, and anything unrecognised fall back to the nvidia-cuda
 * overlay — which is also the mac-safe set (plain kokoro-onnx gives the CPU/CoreML
 * onnxruntime, the GPU swap is nvidia-only, torch from PyPI gives the mps build),
 * preserving today's NVIDIA + macOS behaviour. Pure.
 * @param {string} profile
 * @returns {string} a filename under requirements/
 */
export function overlayFileForProfile(profile) {
  if (profile === 'amd') return 'amd-rocm.txt';
  if (profile === 'cpu') return 'cpu.txt';
  return 'nvidia-cuda.txt';
}

/**
 * Resolve what this release REQUIRES from disk: the canonical Python tag, the
 * effective install profile, and the requirements hash. Shared by both
 * bootstrap-venv.mjs (source/dev install) and apply.ts (self-upgrade) so the two
 * paths can never disagree about what "current" means (S3). The overlay is
 * selected by `profile` (Phase 2 — the caller resolves the effective profile via
 * resolveInstallProfile); `reqHash` hashes the overlay text THEN the base text
 * (the fixed order computeReqHash documents). Defaults to 'nvidia' so a caller
 * that passes nothing reproduces today's behaviour exactly.
 * @param {string} sidecarDir  Absolute path to server/tts-sidecar.
 * @param {string} [profile='nvidia']  Effective install profile.
 * @returns {{pythonTag: string, profile: string, reqHash: string}}
 */
export function resolveRequired(sidecarDir, profile = 'nvidia') {
  const pythonTag = readFileSync(join(sidecarDir, 'python-tag.txt'), 'utf8').trim();
  const overlay = readFileSync(
    join(sidecarDir, 'requirements', overlayFileForProfile(profile)),
    'utf8',
  );
  const base = readFileSync(join(sidecarDir, 'requirements', 'base.txt'), 'utf8');
  return { pythonTag, profile, reqHash: computeReqHash([overlay, base]) };
}
