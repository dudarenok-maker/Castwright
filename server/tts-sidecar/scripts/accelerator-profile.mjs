#!/usr/bin/env node
// accelerator-profile.mjs — pure resolver for the GPU accelerator profile.
// Source of truth for: vendor detection parsing, profile precedence, per-engine
// runtime backend, ONNX Runtime provider list, and install recipe. Plain Node
// ESM so both the server runtime and the install scripts can consume it; tested
// from server/src/tts/accelerator-profile.test.ts which imports it directly.
// Side-effect-guarded (see the bottom) so importing it is inert.

import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

/**
 * Parse a GPU-vendor probe into a vendor tag. Pure — no I/O.
 * NVIDIA wins over AMD when both appear (the common iGPU+dGPU case): the proven
 * path is the safe default when ambiguous (M1/N6).
 * @param {string} platform  process.platform ('win32' | 'linux' | 'darwin' | …)
 * @param {string} probeText raw text from Win32_VideoController / lspci
 * @returns {'nvidia'|'amd'|'apple'|'cpu'}
 */
export function parseVendorFromProbe(platform, probeText) {
  const text = String(probeText ?? '');
  if (/nvidia/i.test(text)) return 'nvidia';
  if (/\bamd\b|radeon|\[amd\/ati\]/i.test(text)) return 'amd';
  if (platform === 'darwin') return 'apple';
  return 'cpu';
}

/**
 * Detect GPU vendor by running a platform probe via the injected `exec`. The
 * `exec` indirection keeps this testable without real hardware. Any probe
 * failure degrades to 'cpu' (never throws). darwin short-circuits to 'apple'
 * without probing.
 * @param {{platform: string, exec: (cmd: string) => string}} args
 * @returns {'nvidia'|'amd'|'apple'|'cpu'}
 */
export function detectVendor({ platform, exec }) {
  if (platform === 'darwin') return 'apple';
  const cmd =
    platform === 'win32'
      ? 'powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController).Name"'
      : 'lspci';
  try {
    return parseVendorFromProbe(platform, exec(cmd));
  } catch {
    return 'cpu';
  }
}

/** Valid machine-level profiles. */
export const PROFILES = ['nvidia', 'amd', 'apple', 'cpu'];

/**
 * Resolve the effective profile. Precedence (N7): env override → wizard choice →
 * detection → 'cpu'. An invalid value at any tier is ignored (falls through).
 * 'unknown' detection resolves to 'cpu' — never silently 'amd'.
 * @param {{envOverride: string|null, wizardChoice: string|null, detected: string}} a
 * @returns {'nvidia'|'amd'|'apple'|'cpu'}
 */
export function resolveProfile({ envOverride, wizardChoice, detected }) {
  for (const candidate of [envOverride, wizardChoice, detected]) {
    if (PROFILES.includes(candidate)) return candidate;
  }
  return 'cpu';
}

/**
 * Per-engine runtime backend. `engine` is 'qwen' | 'coqui' (torch) or 'kokoro'
 * (onnxruntime). Note rocm: at runtime HIP aliases the CUDA API, but we REPORT
 * 'rocm' for honesty; the sidecar still uses device="cuda".
 * @returns {'cuda'|'rocm'|'directml'|'cpu'|'mps'}
 */
export function runtimeBackend(profile, engine, platform) {
  const isTorch = engine === 'qwen' || engine === 'coqui';
  if (profile === 'nvidia') return 'cuda';
  if (profile === 'apple') return isTorch ? 'mps' : 'cpu';
  if (profile === 'amd') {
    if (isTorch) return 'rocm';
    // PROVISIONAL (P2): the AMD-Windows Kokoro backend is exactly what spike S0.1
    // tests. We encode the INTENDED 'directml' here, but if S0.1 finds DirectML
    // can't run the Kokoro model (the ConvTranspose issue), Phase 2 flips this — and
    // this test case — to 'cpu'. The value is dormant in Phase 1, so a later flip is
    // a one-line change + one test edit, not a behavior regression.
    return platform === 'win32' ? 'directml' : 'cpu'; // Kokoro: DML only on Windows
  }
  return 'cpu';
}

/**
 * Ordered ONNX Runtime provider list for Kokoro. The first available provider in
 * the list wins; CPU is always the final fallback.
 * @returns {string[]}
 */
export function ortProviders(profile, platform) {
  if (profile === 'nvidia') return ['CUDAExecutionProvider', 'CPUExecutionProvider'];
  // PROVISIONAL (P2/Q2): amd+win DirectML is gated by spike S0.1 — Phase 2 flips this to
  // ['CPUExecutionProvider'] if DirectML can't run the Kokoro model. Dormant in Phase 1.
  if (profile === 'amd' && platform === 'win32')
    return ['DmlExecutionProvider', 'CPUExecutionProvider'];
  return ['CPUExecutionProvider'];
}

/**
 * Install recipe per (profile, platform). NVIDIA installs torch from PyPI as an
 * EXPLICIT requirement in `requirements/nvidia-cuda.txt` (the CUDA-bundled wheel
 * on win/linux x86_64) — NOT a separate-wheel pre-install step, so
 * `torchPreinstall` is null (= "the requirements file handles torch"). NB: torch
 * USED to arrive transitively via coqui-tts, but coqui-tts 0.27.5 dropped that
 * declaration, so it is now pinned explicitly in the overlay; null here means
 * "nothing extra beyond the requirements," not "torch is transitive." NVIDIA ORT
 * is `onnxruntime-gpu` via kokoro-onnx[gpu]. AMD pre-installs the ROCm torch
 * wheels (a {wheels:[…]} list) BEFORE the engine packages — install-torch.mjs
 * runs them; their alpha local-version tags can't be pinned in amd-rocm.txt.
 * The CPU recipe (cpu-index torch) is a Phase-2 improvement.
 * @returns {{torchPreinstall: null | {wheels:string[]} | {source:string,url:string}, ortPackage: string}}
 */
export function installRecipe(profile, platform) {
  if (profile === 'nvidia') return { torchPreinstall: null, ortPackage: 'onnxruntime-gpu' };
  if (profile === 'amd') {
    // S0.2 desk-verified ROCm-Windows preview wheels (alpha; ROCm 6.4.4). torch 2.8
    // < 2.9 → the amd overlay uses coqui-tts WITHOUT [codec]. Import-ability +
    // synthesis on real AMD silicon are OWED (Wave H2). Linux ROCm wheels are
    // resolved in Wave H if/when an AMD-Linux box validates them.
    const ROCM = 'https://repo.radeon.com/rocm/windows/rocm-rel-6.4.4/';
    return {
      torchPreinstall: {
        wheels:
          platform === 'win32'
            ? [
                `${ROCM}torch-2.8.0a0+gitfc14c65-cp312-cp312-win_amd64.whl`,
                `${ROCM}torchaudio-2.6.0a0+1a8f621-cp312-cp312-win_amd64.whl`,
              ]
            : [],
      },
      ortPackage: platform === 'win32' ? 'onnxruntime-directml' : 'onnxruntime',
    };
  }
  // cpu / apple — Phase-2 improvement, not today's behavior
  return {
    torchPreinstall: { source: 'index', url: 'https://download.pytorch.org/whl/cpu' },
    ortPackage: 'onnxruntime',
  };
}

/** Convenience summary used by the CLI + consumers; pure. */
export function describeResolved({ envOverride, wizardChoice, detected, platform }) {
  const profile = resolveProfile({ envOverride, wizardChoice, detected });
  return {
    profile,
    backends: {
      qwen: runtimeBackend(profile, 'qwen', platform),
      coqui: runtimeBackend(profile, 'coqui', platform),
      kokoro: runtimeBackend(profile, 'kokoro', platform),
    },
    kokoroOrtProviders: ortProviders(profile, platform),
  };
}

// Side-effect guard: only runs when invoked directly (`node accelerator-profile.mjs`),
// stays inert on import so tests/consumers don't trigger I/O.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const detected = detectVendor({
    platform: process.platform,
    exec: (cmd) => execSync(cmd, { encoding: 'utf8' }),
  });
  const summary = describeResolved({
    envOverride: process.env.CASTWRIGHT_ACCELERATOR_PROFILE ?? null,
    wizardChoice: null,
    detected,
    platform: process.platform,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
