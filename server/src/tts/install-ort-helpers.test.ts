import { describe, it, expect } from 'vitest';
// @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
import { planOrtSwap } from '../../tts-sidecar/scripts/install-ort.mjs';

describe('planOrtSwap', () => {
  // The overlay ALWAYS installs plain `onnxruntime` (kokoro-onnx's core dep). The
  // swap then replaces it with whatever GPU runtime the profile actually needs —
  // keyed on installRecipe.ortPackage. Any package other than plain 'onnxruntime'
  // (today: nvidia → onnxruntime-gpu; a future DirectML re-enable → -directml) is a
  // swap; 'onnxruntime' itself is a no-op.
  it('nvidia → swap plain onnxruntime → onnxruntime-gpu', () => {
    const plan = planOrtSwap('nvidia', 'win32');
    expect(plan.action).toBe('swap');
    expect(plan.steps).toEqual([
      ['uninstall', '-y', 'onnxruntime'],
      ['install', 'onnxruntime-gpu'],
    ]);
  });

  // S0.1 RESOLVED (2026-06-15): DirectML can't run the Kokoro model, so the AMD
  // profile installs plain onnxruntime (CPU EP) — no swap on any OS.
  it('amd → skip on every OS (DirectML disabled; plain onnxruntime, no swap)', () => {
    expect(planOrtSwap('amd', 'win32').action).toBe('skip');
    expect(planOrtSwap('amd', 'linux').action).toBe('skip');
  });

  it('cpu → skip (plain onnxruntime installed by the overlay)', () => {
    expect(planOrtSwap('cpu', 'win32').action).toBe('skip');
  });
});
