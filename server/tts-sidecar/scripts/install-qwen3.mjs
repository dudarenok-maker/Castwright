#!/usr/bin/env node
// install-qwen3.mjs -- bootstrap the Qwen3-TTS engine into the sidecar venv
// and pre-fetch its model weights so the first synth/design call doesn't pay
// the download tax (plan 108).
//
// Cross-platform Node ESM (Windows + macOS + Linux) per the deployer-spread
// convention -- the .ps1 sibling is a thin wrapper that just calls this.
//
// What it does:
//   1. Locate the sidecar venv's python (.venv/Scripts/python.exe on Windows,
//      .venv/bin/python elsewhere). Fail with a clear bootstrap hint if absent.
//   2. `python -m pip install -U qwen-tts` (pulls torch + soundfile).
//   3. Pre-fetch the Base (resident synth) model and, unless --skip-design,
//      the VoiceDesign model via Qwen3TTSModel.from_pretrained, with the HF
//      cache pointed at server/tts-sidecar/voices/qwen/hf so the weights live
//      with the sidecar (and stay out of the release zip per its exclude list).
//
// Usage:
//   node server/tts-sidecar/scripts/install-qwen3.mjs [--skip-design] [--cpu]
//
// Idempotent: pip is a no-op when satisfied; from_pretrained is a no-op when
// the HF cache already has the snapshot.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIDECAR_DIR = resolve(__dirname, '..');

const args = process.argv.slice(2);
const SKIP_DESIGN = args.includes('--skip-design');
const FORCE_CPU = args.includes('--cpu');

const BASE_MODEL = process.env.QWEN_BASE_MODEL || 'Qwen/Qwen3-TTS-12Hz-0.6B-Base';
const VOICEDESIGN_MODEL =
  process.env.QWEN_VOICEDESIGN_MODEL || 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign';

function step(msg) {
  process.stdout.write(`[install-qwen3] ${msg}\n`);
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

  // HF cache lives with the sidecar so the weights are portable and the
  // release zip's exclude list (which already drops voices/) keeps them out.
  const hfHome = join(SIDECAR_DIR, 'voices', 'qwen', 'hf');
  const env = { HF_HOME: hfHome, HF_HUB_CACHE: hfHome };
  if (FORCE_CPU) env.QWEN_DEVICE = 'cpu';

  step('Installing qwen-tts (pulls torch + soundfile)...');
  if (run(python, ['-m', 'pip', 'install', '-U', 'qwen-tts'], env) !== 0) {
    step('FAIL: pip install qwen-tts failed. Check network + sidecar venv.');
    process.exit(1);
  }

  const models = SKIP_DESIGN ? [BASE_MODEL] : [BASE_MODEL, VOICEDESIGN_MODEL];
  step(
    `Pre-fetching ${models.length} model(s) into ${hfHome} ` +
      `(~1.8 GB Base${SKIP_DESIGN ? '' : ' + ~3.4 GB VoiceDesign'}; expect a few min)...`,
  );
  // device_map="cpu" for the prefetch so a box without CUDA can still download
  // weights; runtime device is chosen separately via QWEN_DEVICE.
  const prefetch = models
    .map(
      (m) =>
        `Qwen3TTSModel.from_pretrained(${JSON.stringify(m)}, device_map="cpu")`,
    )
    .join('; ');
  const code = `from qwen_tts import Qwen3TTSModel; ${prefetch}; print("[install-qwen3] prefetch ok")`;
  if (run(python, ['-c', code], env) !== 0) {
    step('FAIL: model pre-fetch failed. Check network, disk space, and that');
    step('      qwen-tts imported cleanly. You can retry; downloads resume.');
    process.exit(1);
  }

  step('Done. Qwen3-TTS installed.');
  step('  - Synthesis model (Base) and voice-design model are cached under voices/qwen/hf.');
  step('  - Qwen warms on demand via POST /load (or set PRELOAD_QWEN=1 to load Base on boot).');
  step('  - Design a per-character voice via POST /qwen/design-voice.');
}

main();
