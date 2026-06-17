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
 * Resolve the effective install profile for the venv build/upgrade path.
 * Precedence: the ACCELERATOR env override → the existing venv's stamped profile
 * (carry-forward) → live hardware detection → cpu. The carry-forward slot is the
 * load-bearing rule: an existing install (Phase 1 stamped every box 'nvidia') is
 * NEVER force-migrated by a hardware re-detect on upgrade — only an explicit
 * ACCELERATOR override switches it. `stampProfile` is null on a fresh install
 * (no venv yet), so detection drives a clean box. `exec` is injectable for tests;
 * it defaults to a real subprocess GPU probe. Pure precedence over
 * resolveProfile + detectVendor.
 * @param {{envOverride: string|null, stampProfile: string|null, platform: string,
 *          exec?: (cmd: string) => string}} a
 * @returns {'nvidia'|'amd'|'apple'|'cpu'}
 */
export function resolveInstallProfile({ envOverride, stampProfile, platform, exec }) {
  const detected = detectVendor({
    platform,
    exec: exec ?? ((cmd) => execSync(cmd, { encoding: 'utf8' })),
  });
  return resolveProfile({
    envOverride: envOverride ?? null,
    wizardChoice: stampProfile ?? null, // carry-forward occupies the wizard slot
    detected,
  });
}

/**
 * Per-engine runtime backend. `engine` is 'qwen' | 'coqui' (torch) or 'kokoro'
 * (onnxruntime). Note rocm: at runtime HIP aliases the CUDA API, but we REPORT
 * 'rocm' for honesty; the sidecar still uses device="cuda".
 * @returns {'cuda'|'rocm'|'directml'|'cpu'|'mps'}
 */
export function runtimeBackend(profile, engine, platform) {
  void platform; // kept in the signature (per-platform by design); unused since the
  // S0.1 flip made AMD Kokoro CPU on every OS — a directml re-enable would use it.
  const isTorch = engine === 'qwen' || engine === 'coqui';
  if (profile === 'nvidia') return 'cuda';
  if (profile === 'apple') return isTorch ? 'mps' : 'cpu';
  if (profile === 'amd') {
    if (isTorch) return 'rocm';
    // S0.1 RESOLVED (2026-06-15, on-box): DirectML CANNOT run the Kokoro model —
    // onnxruntime-directml 1.24.4 errors on the `/encoder/F0.1/pool/ConvTranspose`
    // node (the same inputs synthesize fine on the CPU EP), an EP-level op
    // limitation, not silicon-specific. So Kokoro on AMD stays CPU on every OS.
    // (Revisit if a future onnxruntime-directml gains ConvTranspose support.)
    return 'cpu';
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
  // S0.1 RESOLVED (2026-06-15): DirectML can't run the Kokoro model (ConvTranspose
  // fails on onnxruntime-directml; CPU EP works), so AMD Kokoro is CPU on every OS.
  void platform;
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
 * is `onnxruntime-gpu`, swapped in by install-ort.mjs after the overlay (which
 * carries plain kokoro-onnx → core onnxruntime) — NOT via kokoro-onnx[gpu], whose
 * extra can leave the CPU build owning the namespace. AMD pre-installs the ROCm torch
 * wheels (a {wheels:[…]} list) BEFORE the engine packages — install-torch.mjs
 * runs them; their alpha local-version tags can't be pinned in amd-rocm.txt.
 * The CPU recipe (cpu-index torch) is a Phase-2 improvement.
 * @returns {{torchPreinstall: null | {wheels:string[]} | {source:string,url:string}, ortPackage: string}}
 */
export function installRecipe(profile, platform) {
  if (profile === 'nvidia') return { torchPreinstall: null, ortPackage: 'onnxruntime-gpu' };
  if (profile === 'amd') {
    // S0.2 desk-verified ROCm-Windows preview wheels (alpha; ROCm 6.4.4). The amd
    // overlay uses coqui-tts WITHOUT [codec] (no torchcodec). Import-ability +
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
      // S0.1 RESOLVED (2026-06-15): DirectML can't run the Kokoro model, so the
      // AMD profile installs plain onnxruntime (CPU EP for Kokoro) on every OS —
      // no onnxruntime-directml. Qwen/Coqui still ride ROCm via the torch wheels.
      ortPackage: 'onnxruntime',
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
