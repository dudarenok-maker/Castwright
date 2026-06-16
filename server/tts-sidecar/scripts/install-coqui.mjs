#!/usr/bin/env node
// install-coqui.mjs -- pre-fetch the Coqui XTTS v2 model weights so the sidecar
// doesn't pay the ~1.8 GB download tax on the first synth call.
//
// Cross-platform Node ESM (Windows + macOS + Linux) per the deployer-spread
// convention -- the in-app installer (Account -> Models) spawns THIS, and the
// .ps1/.sh siblings remain for scripted/offline setups.
//
// What it does:
//   1. Locate the sidecar venv's python (.venv/Scripts/python.exe on Windows,
//      .venv/bin/python elsewhere). Fail with a clear bootstrap hint if absent.
//   2. pip-install `coqui-tts` constrained by requirements/base.txt (opt-in:
//      coqui-tts is no longer a base requirement — it must be installed here).
//   3. Trigger the `coqui-tts` (import `TTS`) auto-downloader for XTTS v2 via
//      `from TTS.api import TTS; TTS('tts_models/multilingual/multi-dataset/
//      xtts_v2')`, with COQUI_TOS_AGREED=1 so the license click-through is
//      auto-accepted (running this script IS the consent).
//
// Crucially we do NOT set TTS_HOME: the sidecar runtime never sets it either,
// so the weights must land in the lib's DEFAULT user-data dir
// (get_user_data_dir("tts") -> %LOCALAPPDATA%\tts | ~/Library/Application
// Support/tts | ~/.local/share/tts). Pointing TTS_HOME at voices/coqui would
// pre-fetch into a directory the runtime ignores -- the same trap install-
// qwen3.mjs records for HF_HOME. (server/src/tts/coqui-install-detect.ts probes
// this same default path.)
//
// Usage:
//   node server/tts-sidecar/scripts/install-coqui.mjs
//
// Idempotent: from_pretrained / TTS() is a no-op when the model dir already has
// the weights.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIDECAR_DIR = resolve(__dirname, '..');

function step(msg) {
  process.stdout.write(`[install-coqui] ${msg}\n`);
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

  // Auto-accept the XTTS license click-through. Do NOT set TTS_HOME — let the
  // weights land in the lib's default user-data dir, which is exactly where the
  // sidecar runtime looks (it never sets TTS_HOME either).
  const env = { COQUI_TOS_AGREED: '1', HF_HUB_DISABLE_SYMLINKS_WARNING: '1' };

  // coqui-tts is opt-in (not in base.txt), so pip-install it now, constrained by
  // base.txt to keep shared deps (numpy, transformers) in lockstep.
  const baseTxt = join(SIDECAR_DIR, 'requirements', 'base.txt');
  // No -U: base.txt already pins compatible versions; upgrading on every run could pull a broken coqui-tts release.
  step('Installing coqui-tts (opt-in)...');
  if (run(python, ['-m', 'pip', 'install', 'coqui-tts', '-c', baseTxt], env) !== 0) {
    step('FAIL: pip install coqui-tts failed. Check network + sidecar venv.');
    process.exit(1);
  }

  step('Pre-fetching XTTS v2 into the default TTS cache (~1.8 GB; expect 2-5 min on a fast link)...');
  const code =
    "from TTS.api import TTS; TTS('tts_models/multilingual/multi-dataset/xtts_v2'); " +
    'print("[install-coqui] prefetch ok")';
  if (run(python, ['-c', code], env) !== 0) {
    step('FAIL: XTTS v2 pre-fetch failed. Check network, disk space, and that');
    step('      coqui-tts imported cleanly. You can retry; downloads resume.');
    process.exit(1);
  }

  step('Done. Coqui XTTS v2 installed.');
  step('  - XTTS v2 weights are in the default TTS user-data dir.');
  step('  - Coqui warms on demand via POST /load (or set PRELOAD_COQUI=1 to load on boot).');
}

// Run only when invoked directly (node install-coqui.mjs); stay inert on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
