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
import { fileURLToPath } from 'node:url';
import { writeSanitizedConstraintsFile } from './pip-constraints.mjs';
import { isDirectlyInvoked } from '../../../scripts/lib/is-main-module.mjs';

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

// Like run(), but pipes stdout instead of inheriting it, so the caller can
// inspect what printed (the COQUI_VERIFY_MARKER check below) while still
// echoing everything to the user exactly as run() would.
function runCapture(python, pyArgs, env) {
  const res = spawnSync(python, pyArgs, {
    cwd: SIDECAR_DIR,
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  if (res.error) throw new Error(`spawn failed: ${res.error.message}`);
  const stdout = res.stdout ? res.stdout.toString() : '';
  const stderr = res.stderr ? res.stderr.toString() : '';
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  return { status: res.status ?? 1, stdout };
}

/**
 * The ordered pip-install steps the installer runs, before the XTTS prefetch.
 * Exported (pure) so the sequence — coqui-tts, then torchcodec, then the CJK
 * phonemizers, none with -U — is unit-testable without a real venv (see
 * install-coqui-steps.test.ts).
 *
 * Why torchcodec: coqui-tts 0.27.5's TTS/__init__.py raises ImportError at
 * package import when torch>=2.9 and torchcodec is absent — it presence-checks it
 * via transformers' is_torchcodec_available() (a bare `find_spec("torchcodec")`,
 * NOT a functional import). The sidecar venv pins torch 2.11 (CVE bump), so
 * without this `import TTS` (and the prefetch below) fails and Coqui can't load.
 * torchcodec only needs to be PRESENT, never functional: stock XTTS inference uses
 * precomputed manifest-speaker latents, and the one call path that WOULD have
 * reached torchcodec's FFmpeg decode — the XTTS clone path's reference-audio
 * loader, `TTS.tts.models.xtts.load_audio` — is patched out at derive time
 * (`xtts_audio_io.py`, #1967), so it stays unreached in practice. Without that
 * patch it would fail here: torchcodec's FFmpeg decode path can't even load its
 * shared libs against a static FFmpeg 8 build. `--no-deps` installs just the wheel
 * so torchcodec can never perturb the pinned torch (protects the ROCm-2.8 profile,
 * where torch<2.9 doesn't even need torchcodec). See also COQUI_VERIFY_CODE below,
 * which fails the install outright if the patch can no longer apply.
 *
 * Why the CJK phonemizers (pypinyin / cutlet / unidic-lite): XTTS v2 needs
 * language-specific text frontends that coqui-tts doesn't pull. Chinese (zh-cn)
 * needs `pypinyin` (TTS/tts/layers/xtts/tokenizer.py::chinese_transliterate raises
 * `ImportError: Chinese requires: pypinyin` on the first zh line otherwise). Japanese
 * (ja) needs `cutlet` (romanizer), which needs `fugashi` (MeCab) + a MeCab dict —
 * `unidic-lite` is the ~48 MB bundled dict fugashi auto-discovers; without a dict
 * cutlet raises at construction. cutlet transitively pulls fugashi/jaconv/mojimoji,
 * but `unidic-lite` must be named explicitly (cutlet doesn't depend on it). These are
 * runtime-SYNTH deps (not needed for the weights prefetch), and fs-59 makes zh/ja
 * Coqui render paths — so the opt-in install must provide them. They carry no torch
 * pin, so a normal `-c constraints` install is safe (no --no-deps: cutlet's
 * transitive deps are wanted).
 *
 * Why spacy rides in this same step (#2017): `CoquiEngine._infer_from_latents`
 * passes `enable_text_splitting=True` (config-faithful, mirrors `Xtts.synthesize`'s
 * own build), so a cloned-voice render at/above `tokenizer.char_limits[lang]`
 * reaches upstream's `get_spacy_lang`, which raises ImportError without spacy
 * installed. spacy is reached only via this same opt-in Coqui/XTTS path — never
 * by Qwen or Kokoro — so it belongs here, not in the shared manifest (measured
 * 22.3 MB / 16 packages the CPU-only and Kokoro-only installs would otherwise pay
 * for a library they never import). Plain spacy covers ar/en/es/hi/zh (zh confirmed
 * working here, despite the upstream error message naming `spacy[ja]` generically).
 *
 * #2038 — `sudachipy` + `sudachidict-core` (the `spacy[ja]` extra) are ALSO
 * installed here, closing the one language plain spacy left broken. Cost,
 * paid on every Coqui install (opt-in, not the shared manifest — see above):
 * +2 packages, **+68.9 MB**, `sudachidict-core` alone. Measured in the sidecar
 * venv: plain spacy install = 16 packages / 22.3 MB; with these two added =
 * 18 packages / 92.5 MB. Not gated behind a separate opt-in of its own — the
 * whole Coqui/XTTS install this step belongs to is ALREADY opt-in (a CPU-only
 * or Kokoro-only setup pays neither figure), and splitting Japanese out
 * further was judged not worth a second install toggle for 68.9 MB. Verified:
 * `get_spacy_lang('ja')` resolves with these installed (previously
 * `ImportError`, per `main.py`'s `_infer_from_latents` catch, which still
 * logs the #2038 explanation if a stale/broken venv somehow lacks them).
 */
export function coquiPipInstallSteps(constraints) {
  return [
    {
      label: 'Installing coqui-tts (opt-in)...',
      args: ['-m', 'pip', 'install', 'coqui-tts', '-c', constraints],
      failMsg: 'FAIL: pip install coqui-tts failed. Check network + sidecar venv.',
    },
    {
      label: 'Installing torchcodec (coqui-tts presence-checks it at import on torch>=2.9)...',
      args: ['-m', 'pip', 'install', 'torchcodec', '--no-deps'],
      failMsg:
        'FAIL: pip install torchcodec failed. coqui-tts import needs it present on torch>=2.9.',
    },
    {
      label:
        'Installing XTTS CJK phonemizers (pypinyin/cutlet/unidic-lite) + spacy + '
        + 'SudachiPy (text splitting, #2017/#2038)...',
      args: [
        '-m',
        'pip',
        'install',
        'pypinyin',
        'cutlet',
        'unidic-lite',
        'spacy>=3.8,<4.0',
        'sudachipy',
        'sudachidict-core',
        '-c',
        constraints,
      ],
      failMsg:
        'FAIL: pip install XTTS CJK phonemizers/spacy/SudachiPy failed. zh needs pypinyin; '
        + 'ja needs cutlet + a MeCab dict (unidic-lite) + SudachiPy/sudachidict-core; '
        + 'cloned-voice text-splitting needs spacy.',
    },
  ];
}

// Printed by COQUI_VERIFY_CODE immediately before it enters
// patched_xtts_load_audio() — the last checkpoint before the code that can
// actually detect loader drift. main() greps captured stdout for this line
// to tell "the patch itself failed to apply" apart from any earlier, unrelated
// crash (a numpy import error, a tempdir permission failure, `import TTS`
// itself failing) that never reached the patch at all.
export const COQUI_VERIFY_MARKER = '[install-coqui] entering clone-path patch';

/**
 * #1967 — verify the clone path can actually decode reference audio before we
 * spend 1.8 GB on weights. coqui-tts is NOT pinned (base.txt carries no
 * coqui-tts line), so an upstream release that renames or re-signatures XTTS's
 * reference loader would otherwise install cleanly and fail at first derive,
 * on every new install, with nobody able to reproduce it locally. Exported as
 * a string so it is unit-testable; kept OUT of coquiPipInstallSteps because
 * that array is asserted by exact equality.
 */
export const COQUI_VERIFY_CODE = [
  'import os, sys, tempfile, wave',
  'import numpy as np',
  'from xtts_audio_io import patched_xtts_load_audio',
  'import TTS.tts.models.xtts as _x',
  'd = tempfile.mkdtemp()',
  'p = os.path.join(d, "verify.wav")',
  // A real waveform, NOT np.zeros: XTTS's own range guard logs "Error with
  // <path>. Max=0.00 min=0.00" for an all-zero buffer (`not torch.any(audio < 0)`),
  // and run() uses stdio:'inherit', so the user would see a line starting
  // "Error with" immediately before "verify ok" in the installer output.
  'pcm = (np.sin(np.linspace(0, 6.28 * 220, 2400)) * 16000).astype("<i2")',
  'w = wave.open(p, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)',
  'w.writeframes(pcm.tobytes()); w.close()',
  `print(${JSON.stringify(COQUI_VERIFY_MARKER)})`,
  'with patched_xtts_load_audio():',
  '    a = _x.load_audio(p, 22050)',
  'assert a.shape[0] == 1, a.shape',
  'os.remove(p); os.rmdir(d)',
  'print("[install-coqui] clone-path verify ok")',
].join('\n');

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
  // base.txt to keep shared deps (numpy, transformers) in lockstep. Sanitise
  // first: base.txt carries extras (e.g. uvicorn[standard]) that pip rejects in
  // a constraints file ("ERROR: Constraints cannot have extras").
  const baseTxt = join(SIDECAR_DIR, 'requirements', 'base.txt');
  const constraints = writeSanitizedConstraintsFile(baseTxt);
  // No -U: base.txt already pins compatible versions; upgrading on every run could
  // pull a broken coqui-tts release. torchcodec, the CJK phonemizers, and spacy
  // are required too (see coquiPipInstallSteps' rationale) — installed here, NOT
  // the base overlay.
  for (const { label, args, failMsg } of coquiPipInstallSteps(constraints)) {
    step(label);
    if (run(python, args, env) !== 0) {
      step(failMsg);
      process.exit(1);
    }
  }

  step('Verifying the clone path can decode reference audio (#1967)...');
  const verify = runCapture(python, ['-c', COQUI_VERIFY_CODE], env);
  if (verify.status !== 0) {
    if (verify.stdout.includes(COQUI_VERIFY_MARKER)) {
      step('FAIL: the XTTS reference-audio patch could not be applied.');
      step("      This coqui-tts release has moved or reshaped XTTS's reference loader,");
      step('      so cloned-voice derives would fail. Report the version above on');
      step('      https://github.com/dudarenok-maker/Castwright/issues/1967');
    } else {
      step('FAIL: the clone-path verification could not run; check that coqui-tts imported cleanly.');
    }
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
// See scripts/lib/is-main-module.mjs — an un-realpathed comparison misses
// whenever the invocation path crosses a symlink/junction (#2291).
if (isDirectlyInvoked(import.meta.url)) {
  main();
}
