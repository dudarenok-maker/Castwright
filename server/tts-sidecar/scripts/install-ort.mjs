#!/usr/bin/env node
// install-ort.mjs — the AMD-Windows ONNX-runtime swap (S0.3). Kokoro is installed
// plain (`kokoro-onnx`, no [gpu] extra), which pulls the base `onnxruntime` CPU
// module. To run Kokoro on DirectML we must REPLACE that module with
// `onnxruntime-directml` — the two can't co-exist (same import name). This runs
// AFTER the requirements overlay install (Wave B wires it into the bootstrap
// flow). No-op for every non-amd-win profile, where the overlay's onnxruntime
// (or onnxruntime-gpu via kokoro-onnx[gpu]) is already correct.
// Pure planner (planOrtSwap) + guarded CLI, mirroring install-torch.mjs.
//
// Usage (Phase 2 bootstrap wires this; manual form for testing):
//   CASTWRIGHT_ACCELERATOR_PROFILE=amd node install-ort.mjs <venv-python>
//
// NOTE: the minimum working onnxruntime-directml version (the release carrying
// the Kokoro ConvTranspose fix) is OWED on real AMD hardware (Wave H1). Until
// pinned there, we install the latest.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { installRecipe } from './accelerator-profile.mjs';

/**
 * Decide the ordered pip steps to put the correct ONNX runtime in place after
 * the overlay install. Only amd+win needs a swap (base onnxruntime →
 * onnxruntime-directml); every other profile already has the right runtime from
 * its overlay. Pure — no I/O. `steps` are pip sub-command arg arrays, run in
 * order with the venv python.
 * @returns {{action:'skip', reason:string} | {action:'swap', steps:string[][]}}
 */
export function planOrtSwap(profile, platform) {
  const { ortPackage } = installRecipe(profile, platform);
  if (ortPackage !== 'onnxruntime-directml') {
    return { action: 'skip', reason: `${ortPackage} is installed by the overlay; no swap` };
  }
  return {
    action: 'swap',
    steps: [
      ['uninstall', '-y', 'onnxruntime'],
      ['install', ortPackage],
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
