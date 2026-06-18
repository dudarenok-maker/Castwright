#!/usr/bin/env node
// install-ort.mjs — the ONNX-runtime swap that puts the RIGHT Kokoro runtime in
// place after the requirements overlay. The overlay always installs plain
// `onnxruntime` (kokoro-onnx's core dependency — see requirements/nvidia-cuda.txt),
// so any profile whose Kokoro must run on a GPU runtime has to REPLACE that module
// with the accelerator-specific one (they all share the `onnxruntime` import name
// and can't co-exist reliably):
//   - nvidia  → onnxruntime-gpu      (CUDAExecutionProvider)
//   - amd-win → onnxruntime-directml (disabled after S0.1 — Kokoro stays CPU)
//   - cpu/apple → no swap (plain onnxruntime is correct)
// This is the SINGLE enforcement point for GPU Kokoro: we deliberately do NOT lean
// on `kokoro-onnx[gpu]`, because that extra coexists with the core `onnxruntime`
// dep and pip's resolution order can leave the CPU build owning the namespace — a
// silent CPU-only Kokoro on a GPU box (the 2026-06-16 regression). Runs AFTER the
// overlay install (bootstrap-venv.mjs wires it into every profile's flow).
// Pure planner (planOrtSwap) + guarded CLI, mirroring install-torch.mjs.
//
// Usage (the bootstrap wires this; manual form for testing):
//   CASTWRIGHT_ACCELERATOR_PROFILE=nvidia node install-ort.mjs <venv-python>
//
// NOTE: the minimum working onnxruntime-directml version (the release carrying
// the Kokoro ConvTranspose fix) is OWED on real AMD hardware (Wave H1). Until
// pinned there, we install the latest.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { installRecipe } from './accelerator-profile.mjs';

/**
 * Decide the ordered pip steps to put the correct ONNX runtime in place after the
 * overlay install. The overlay always lands plain `onnxruntime` (kokoro-onnx's
 * core dep), so any profile whose recipe needs a different ortPackage (nvidia →
 * onnxruntime-gpu; a future DirectML re-enable → onnxruntime-directml) is a swap;
 * a recipe that already wants plain `onnxruntime` (cpu/amd/apple) is a no-op. Pure
 * — no I/O. `steps` are pip sub-command arg arrays, run in order with the venv
 * python.
 * @returns {{action:'skip', reason:string} | {action:'swap', steps:string[][]}}
 */
export function planOrtSwap(profile, platform) {
  const { ortPackage } = installRecipe(profile, platform);
  if (ortPackage === 'onnxruntime') {
    return { action: 'skip', reason: 'plain onnxruntime from the overlay is correct; no swap' };
  }
  return {
    action: 'swap',
    steps: [
      // Uninstall BOTH the plain `onnxruntime` the overlay landed AND any cached
      // `ortPackage` first, so the shared `onnxruntime/` namespace directory is
      // fully cleared — then `--force-reinstall` lays ortPackage's files fresh.
      // A plain `install ortPackage` is a NO-OP when ortPackage is already cached
      // (at a skewed version — e.g. the overlay pulls onnxruntime 1.27.0 but
      // onnxruntime-gpu 1.26.0 is in pip's cache): pip reports "already
      // satisfied" and skips, leaving the namespace half-overwritten by the
      // just-uninstalled onnxruntime → `import onnxruntime` breaks (no
      // __version__/get_available_providers) and Kokoro silently fails to load.
      // `--no-deps` keeps the overlay's numpy/protobuf/etc. pins untouched.
      ['uninstall', '-y', 'onnxruntime', ortPackage],
      ['install', '--force-reinstall', '--no-deps', ortPackage],
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const profile = process.env.CASTWRIGHT_ACCELERATOR_PROFILE ?? 'nvidia';
  const plan = planOrtSwap(profile, process.platform);
  if (plan.action === 'skip') {
    process.stdout.write(`[install-ort] skip — ${plan.reason}.\n`);
    process.exit(0);
  }
  const python = process.argv[2]; // venv python path
  if (!python) {
    process.stderr.write('[install-ort] FAIL: pass the venv python path as the first arg.\n');
    process.exit(1);
  }
  for (const step of plan.steps) {
    process.stdout.write(`[install-ort] pip ${step.join(' ')}\n`);
    const code =
      spawnSync(python, ['-m', 'pip', ...step], { stdio: 'inherit', windowsHide: true }).status ?? 1;
    if (code !== 0) {
      process.stderr.write(`[install-ort] FAIL: pip ${step.join(' ')} exited ${code}.\n`);
      process.exit(code);
    }
  }
  process.stdout.write('[install-ort] onnxruntime-directml in place.\n');
  process.exit(0);
}
