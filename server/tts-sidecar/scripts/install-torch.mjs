#!/usr/bin/env node
// install-torch.mjs — pre-install the ROCm torch wheels for the AMD profile
// BEFORE the engine packages, so coqui-tts / qwen-tts see torch already
// satisfied (the amd-rocm.txt overlay deliberately pins no torch — the alpha
// ROCm local-version tags can't be matched by a `torch==` spec). No-op for
// nvidia / cpu / apple, where torch is pulled from PyPI via the overlay.
// Pure planner (planTorchPreinstall) + guarded CLI, mirroring install-qwen3.mjs.
//
// Usage (Phase 2 bootstrap wires this; manual form for testing):
//   CASTWRIGHT_ACCELERATOR_PROFILE=amd node install-torch.mjs <venv-python>
//
// Pure on import (the CLI only runs when invoked directly), so the unit test can
// exercise planTorchPreinstall without a venv.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { installRecipe } from './accelerator-profile.mjs';

/**
 * Decide whether torch must be pre-installed from explicit wheels for this
 * (profile, platform). Only the AMD profile's `{wheels:[…]}` recipe needs it;
 * every other profile gets torch from PyPI via its requirements overlay, so the
 * plan is a skip. Pure — no I/O.
 * @returns {{action:'skip', reason:string} | {action:'install', wheels:string[]}}
 */
export function planTorchPreinstall(profile, platform) {
  const recipe = installRecipe(profile, platform);
  const wheels = recipe.torchPreinstall && recipe.torchPreinstall.wheels;
  if (!wheels || wheels.length === 0) {
    return { action: 'skip', reason: 'torch comes from the overlay / PyPI for this profile' };
  }
  return { action: 'install', wheels };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const profile = process.env.CASTWRIGHT_ACCELERATOR_PROFILE ?? 'nvidia';
  const plan = planTorchPreinstall(profile, process.platform);
  if (plan.action === 'skip') {
    process.stdout.write(`[install-torch] skip — ${plan.reason}.\n`);
    process.exit(0);
  }
  const python = process.argv[2]; // venv python path
  if (!python) {
    process.stderr.write('[install-torch] FAIL: pass the venv python path as the first arg.\n');
    process.exit(1);
  }
  process.stdout.write(`[install-torch] pre-installing ${plan.wheels.length} ROCm wheel(s):\n`);
  for (const w of plan.wheels) process.stdout.write(`  ${w}\n`);
  const code =
    spawnSync(python, ['-m', 'pip', 'install', '--no-cache-dir', ...plan.wheels], {
      stdio: 'inherit',
      windowsHide: true,
    }).status ?? 1;
  process.exit(code);
}
