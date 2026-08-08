#!/usr/bin/env node
// install-whisper.mjs -- bootstrap the Whisper ASR engine (faster-whisper) into
// the sidecar venv and pre-fetch its model so the first /transcribe call doesn't
// pay the download tax (srv-31, plan 186).
//
// Cross-platform Node ESM (Windows + macOS + Linux) per the deployer-spread
// convention -- mirrors install-qwen3.mjs.
//
// What it does:
//   1. Locate the sidecar venv's python (.venv/Scripts/python.exe on Windows,
//      .venv/bin/python elsewhere). Fail with a clear bootstrap hint if absent.
//   2. `python -m pip install faster-whisper` (no -U: base.txt pins faster-whisper
//      >=1.0,<2.0 and -U can walk it past that pin). On a bootstrapped box this
//      step is idempotent/no-op.
//   3. Pre-fetch the model via `WhisperModel(<model>, device='cpu',
//      compute_type='int8')` into the default Hugging Face cache, so the first
//      real transcription doesn't stall on the download. The runtime device
//      (cpu/cuda) is chosen separately via ASR_DEVICE.
//
// Usage:
//   node server/tts-sidecar/scripts/install-whisper.mjs [--model base]
//
// PR #2008: if the model is configured only via Advanced Configuration's
// registry override (user-settings.json) rather than an ASR_MODEL env var,
// pass --model explicitly when invoking this script directly from the CLI —
// this script has no access to user-settings.json and falls back to
// ASR_MODEL/'base' otherwise, so a CLI-run install can silently fetch the
// wrong model even though the sidecar itself loads the configured one. The
// in-app installer (Account -> Models) always passes --model and is unaffected.
//
// Idempotent: pip is a no-op when satisfied; the model download is a no-op when
// the HF cache already has the snapshot.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeSanitizedConstraintsFile } from './pip-constraints.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIDECAR_DIR = resolve(__dirname, '..');

/** Pip args for the faster-whisper install. No -U: base.txt pins
 *  faster-whisper>=1.0,<2.0 and -U can walk it past that pin. */
export function whisperPipInstallArgs(constraintsPath) {
  return ['-m', 'pip', 'install', 'faster-whisper', '-c', constraintsPath];
}

/** Write the sanitized constraints file and pip-install faster-whisper against
 *  it. `deps` is injectable so a test can assert the EXACT args `run` receives
 *  without spawning a real interpreter — `run`/`writeConstraints` default to
 *  the real implementations. Returns the exit status `run` returns (0 = ok);
 *  the caller (main) decides what a non-zero status means, unchanged from
 *  before this extraction (still process.exit(1) on failure). */
export function installFasterWhisper(python, env, deps = { run, writeConstraints: writeSanitizedConstraintsFile }) {
  const constraints = deps.writeConstraints(join(SIDECAR_DIR, 'requirements', 'base.txt'));
  return deps.run(python, whisperPipInstallArgs(constraints), env);
}

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}
// Default to the same model the sidecar runs (ASR_MODEL, default `base`) so the
// installer pre-fetches exactly what will be loaded.
const MODEL = flag('--model') || process.env.ASR_MODEL || 'base';

function step(msg) {
  process.stdout.write(`[install-whisper] ${msg}\n`);
}

function findVenvPython() {
  const candidates =
    process.platform === 'win32'
      ? ['.venv/Scripts/python.exe', '.venv/Scripts/python']
      : ['.venv/bin/python', '.venv/bin/python3'];
  for (const rel of candidates) {
    const abs = join(SIDECAR_DIR, ...rel.split('/'));
    if (existsSync(abs)) return abs;
  }
  return null;
}

function run(python, pyArgs, env) {
  const res = spawnSync(python, pyArgs, {
    cwd: SIDECAR_DIR,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  if (res.error) throw new Error(`spawn failed: ${res.error.message}`);
  return res.status ?? 1;
}

function main() {
  const python = findVenvPython();
  if (!python) {
    step(`FAIL: sidecar venv not bootstrapped at ${join(SIDECAR_DIR, '.venv')}.`);
    step('      Create it first, then re-run:');
    step('        python -m venv .venv');
    step(
      process.platform === 'win32'
        ? '        .venv\\Scripts\\pip install -r requirements.txt'
        : '        .venv/bin/pip install -r requirements.txt',
    );
    process.exit(1);
  }
  step(`Using venv python: ${python}`);

  // Suppress the HF Hub symlink warning on a clean Windows box (no Developer
  // Mode) — benign, same as the qwen installer + runtime warning_filters.py.
  const env = { HF_HUB_DISABLE_SYMLINKS_WARNING: '1' };

  step('Installing faster-whisper (pinned via base.txt)...');
  if (installFasterWhisper(python, env) !== 0) {
    step('FAIL: pip install faster-whisper failed. Check network + sidecar venv.');
    process.exit(1);
  }

  step(`Pre-fetching the Whisper '${MODEL}' model into the default Hugging Face cache...`);
  // device='cpu', compute_type='int8' for the prefetch so a box without CUDA can
  // still download + validate the model; the runtime device is ASR_DEVICE.
  const code =
    `from faster_whisper import WhisperModel; ` +
    `WhisperModel(${JSON.stringify(MODEL)}, device="cpu", compute_type="int8"); ` +
    `print("[install-whisper] prefetch ok")`;
  if (run(python, ['-c', code], env) !== 0) {
    step('FAIL: model pre-fetch failed. Check network, disk space, and that');
    step('      faster-whisper imported cleanly. You can retry; downloads resume.');
    process.exit(1);
  }

  step('Done. Whisper ASR installed.');
  step(`  - The '${MODEL}' model is in the default Hugging Face cache.`);
  step('  - Enable the content-QA gate with SEG_ASR_ENABLED=1 (ASR_DEVICE=cpu|cuda).');
  step('  - It loads on demand on the first /transcribe and idle-evicts.');
}

// Run only when invoked directly; stay inert on import so a unit test can import
// helpers without bootstrapping.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
