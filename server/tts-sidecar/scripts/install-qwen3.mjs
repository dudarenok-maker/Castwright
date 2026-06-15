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
//   4. With --flash-attn (opt-in): pip-install the pinned FlashAttention-2
//      prebuilt wheel. Win_amd64 + cp311 + torch 2.6/cu124 only; any other
//      platform/Python skips. Non-fatal — SDPA stays the default attention
//      impl (see main.py QWEN_ATTN_IMPL); activate FA2 with
//      QWEN_ATTN_IMPL=flash_attention_2 once installed.
//
// Usage:
//   node server/tts-sidecar/scripts/install-qwen3.mjs [--skip-design] [--cpu] [--flash-attn]
//
// Idempotent: pip is a no-op when satisfied; from_pretrained is a no-op when
// the HF cache already has the snapshot.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIDECAR_DIR = resolve(__dirname, '..');

/* ops-7 (#430) — pinned SHA256 for the FA2 wheel (the sharpest supply-chain
   risk: a single-maintainer community wheel that runs with the user's
   privileges on install). Returns the lowercased hex digest, or null when
   unpinned (verification then can't run — we warn and proceed). */
export function flashAttnWheelPin() {
  try {
    const manifest = JSON.parse(readFileSync(join(__dirname, 'model-hashes.json'), 'utf8'));
    const raw = manifest?.flashAttentionWheel?.sha256;
    return typeof raw === 'string' && raw.length > 0 ? raw.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** SHA256 a file as a lowercased hex string. */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const args = process.argv.slice(2);
const SKIP_DESIGN = args.includes('--skip-design');
const FORCE_CPU = args.includes('--cpu');
const INSTALL_FLASH_ATTN =
  args.includes('--flash-attn') || process.env.QWEN_INSTALL_FLASH_ATTN === '1';

const BASE_MODEL = process.env.QWEN_BASE_MODEL || 'Qwen/Qwen3-TTS-12Hz-0.6B-Base';
const VOICEDESIGN_MODEL =
  process.env.QWEN_VOICEDESIGN_MODEL || 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign';

// Pinned FlashAttention-2 prebuilt wheel. Published only for the exact stack the
// sidecar runs (Windows AMD64 + CPython 3.11 + torch 2.6.0/cu124), so the gate
// below refuses any other platform/Python rather than install a wheel that can't
// load. lldacing/flash-attention-windows-wheel is the community source for
// Windows FA2 builds (upstream flash-attn ships no Windows wheel on PyPI).
export const FLASH_ATTN_WHEEL_URL =
  'https://huggingface.co/lldacing/flash-attention-windows-wheel/resolve/main/' +
  'flash_attn-2.7.4+cu124torch2.6.0cxx11abiFALSE-cp311-cp311-win_amd64.whl';

// Pure decision fn (no I/O) so the platform/version gate is unit-testable without
// a venv. enabled=false short-circuits to a silent skip; the caller only invokes
// this once --flash-attn / QWEN_INSTALL_FLASH_ATTN has opted in. FA2 is an
// NVIDIA-only accelerator (the pinned wheel is a CUDA build); the AMD skip is
// checked first so an AMD box never tries to install it. SDPA is the default
// attention impl wherever FA2 isn't installed.
export function resolveFlashAttnInstall({ enabled, platform, pyTag, profile }) {
  if (!enabled) return { action: 'skip', reason: 'not requested' };
  if (profile === 'amd')
    return {
      action: 'skip',
      reason: 'no ROCm FlashAttention-2 wheel; SDPA remains the default on AMD',
    };
  if (platform !== 'win32')
    return {
      action: 'skip',
      reason: `no pinned wheel for ${platform}; SDPA remains the default`,
    };
  if (pyTag !== 'cp311')
    return { action: 'skip', reason: `pinned wheel is cp311-only; venv is ${pyTag}` };
  return { action: 'install', url: FLASH_ATTN_WHEEL_URL };
}

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
    windowsHide: true,
  });
  if (res.error) throw new Error(`spawn failed: ${res.error.message}`);
  return res.status ?? 1;
}

// Ask the venv python for its CPython tag (e.g. "cp311") — the wheel is built per
// minor version, so we must read the *venv's* interpreter, not Node's runtime.
function venvPyTag(python) {
  const res = spawnSync(
    python,
    ['-c', 'import sys;print(f"cp{sys.version_info.major}{sys.version_info.minor}")'],
    { cwd: SIDECAR_DIR, windowsHide: true },
  );
  if (res.status !== 0 || !res.stdout) return null;
  return res.stdout.toString().trim();
}

// Opt-in FlashAttention-2 install. Platform/version-gated and fully non-fatal:
// flash-attn is an optional accelerator, so every failure path warns and returns
// rather than aborting the (already-succeeded) qwen-tts install.
function installFlashAttn(python, env) {
  const plan = resolveFlashAttnInstall({
    enabled: true,
    platform: process.platform,
    pyTag: venvPyTag(python),
    profile: process.env.CASTWRIGHT_ACCELERATOR_PROFILE ?? 'nvidia',
  });
  if (plan.action === 'skip') {
    step(`FlashAttention-2: skipped — ${plan.reason}.`);
    return;
  }
  step('FlashAttention-2: installing pinned prebuilt wheel (opt-in)...');
  step(`  ${plan.url}`);
  const pin = flashAttnWheelPin();
  let installTarget = plan.url;
  if (pin) {
    /* ops-7 — download the wheel WITHOUT installing, verify its SHA256, then
       install the verified local file. Refuse + delete on a mismatch so a
       tampered/corrupted wheel never executes its setup with the user's
       privileges. */
    const dlDir = mkdtempSync(join(tmpdir(), 'fa2-wheel-'));
    if (run(python, ['-m', 'pip', 'download', '--no-deps', '-d', dlDir, plan.url], env) !== 0) {
      step('FlashAttention-2: WARN wheel download failed — continuing on SDPA.');
      return;
    }
    const wheel = readdirSync(dlDir).find((f) => f.endsWith('.whl'));
    if (!wheel) {
      step('FlashAttention-2: WARN no .whl downloaded — continuing on SDPA.');
      return;
    }
    const wheelPath = join(dlDir, wheel);
    const actual = sha256File(wheelPath);
    if (actual !== pin) {
      step('FlashAttention-2: FAIL integrity check — refusing to install.');
      step(`  expected SHA256 ${pin}`);
      step(`  got      SHA256 ${actual}`);
      step('  The wheel does not match the pinned hash. Continuing on SDPA;');
      step('  re-bless model-hashes.json if the upstream wheel legitimately changed.');
      return;
    }
    step('FlashAttention-2: wheel SHA256 verified.');
    installTarget = wheelPath;
  } else {
    step('FlashAttention-2: WARN wheel is UNPINNED in model-hashes.json — installing');
    step('  without hash verification. Bless the wheel to enable the integrity gate.');
  }
  if (run(python, ['-m', 'pip', 'install', installTarget], env) !== 0) {
    step('FlashAttention-2: WARN install failed — continuing on SDPA. Retry the');
    step('  wheel URL above, or just leave QWEN_ATTN_IMPL=sdpa (the default).');
    return;
  }
  const imported = run(
    python,
    ['-c', 'import flash_attn;print("[install-qwen3] flash_attn",flash_attn.__version__)'],
    env,
  );
  if (imported === 0) {
    step('FlashAttention-2: installed. Activate with QWEN_ATTN_IMPL=flash_attention_2');
    step('  in the sidecar env (SDPA stays the default until benchmarked).');
  } else {
    step('FlashAttention-2: WARN wheel installed but `import flash_attn` failed —');
    step('  it may not match torch/CUDA. SDPA remains the default; safe to ignore.');
  }
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

  // Prefetch into the DEFAULT Hugging Face cache (~/.cache/huggingface) so the
  // weights land exactly where the sidecar's QwenEngine.from_pretrained looks
  // at runtime. (An earlier version pointed HF_HOME at voices/qwen/hf, but the
  // engine doesn't set HF_HOME, so it ignored that copy and re-downloaded on
  // first use — a ~6-min cold stall. Aligning on the default cache fixes it;
  // the multi-GB weights live outside the repo, so the release zip is unaffected.)
  // Silence the Hugging Face Hub symlink warning during the model prefetch.
  // On a clean Windows box without Developer Mode, HF Hub can't create cache
  // symlinks and prints a multi-line scary-looking warning on every download —
  // benign here (the cache falls back to file copies, which works fine), so we
  // suppress it rather than ask deployers to flip a Windows setting. The sidecar
  // sets the same flag at runtime (warning_filters.py) so it can't reappear at
  // first model load.
  const env = { HF_HUB_DISABLE_SYMLINKS_WARNING: '1' };
  if (FORCE_CPU) env.QWEN_DEVICE = 'cpu';

  step('Installing qwen-tts (pulls torch + soundfile)...');
  if (run(python, ['-m', 'pip', 'install', '-U', 'qwen-tts'], env) !== 0) {
    step('FAIL: pip install qwen-tts failed. Check network + sidecar venv.');
    process.exit(1);
  }

  if (INSTALL_FLASH_ATTN) installFlashAttn(python, env);

  const models = SKIP_DESIGN ? [BASE_MODEL] : [BASE_MODEL, VOICEDESIGN_MODEL];
  step(
    `Pre-fetching ${models.length} model(s) into the default Hugging Face cache ` +
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
  step('  - Base (synth) + VoiceDesign models are in the default Hugging Face cache (~/.cache/huggingface).');
  step('  - Qwen warms on demand via POST /load (or set PRELOAD_QWEN=1 to load Base on boot).');
  step('  - Design a per-character voice via POST /qwen/design-voice.');
}

// Run only when invoked directly (node install-qwen3.mjs); stay inert on import
// so the unit test can exercise resolveFlashAttnInstall without bootstrapping.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
