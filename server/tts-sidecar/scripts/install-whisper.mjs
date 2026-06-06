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
//   2. `python -m pip install -U faster-whisper` (pulls ctranslate2 + av).
//   3. Pre-fetch the model via `WhisperModel(<model>, device='cpu',
//      compute_type='int8')` into the default Hugging Face cache, so the first
//      real transcription doesn't stall on the download. The runtime device
//      (cpu/cuda) is chosen separately via ASR_DEVICE.
//
// Usage:
//   node server/tts-sidecar/scripts/install-whisper.mjs [--model base]
//
// Idempotent: pip is a no-op when satisfied; the model download is a no-op when
// the HF cache already has the snapshot.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIDECAR_DIR = resolve(__dirname, '..');

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

  step('Installing faster-whisper (pulls ctranslate2 + av)...');
  if (run(python, ['-m', 'pip', 'install', '-U', 'faster-whisper'], env) !== 0) {
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
// MODEL resolution helpers without bootstrapping.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
