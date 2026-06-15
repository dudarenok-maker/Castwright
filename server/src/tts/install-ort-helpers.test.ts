import { describe, it, expect } from 'vitest';
// @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
import { planOrtSwap } from '../../tts-sidecar/scripts/install-ort.mjs';

describe('planOrtSwap', () => {
  // S0.1 RESOLVED (2026-06-15): DirectML can't run the Kokoro model, so the AMD
  // profile installs plain onnxruntime (CPU EP) — no onnxruntime-directml swap on
  // any OS. The swap logic stays (keyed on installRecipe.ortPackage ===
  // 'onnxruntime-directml') so re-enabling DirectML later is a one-line revert.
  it('amd → skip on every OS (DirectML disabled; plain onnxruntime, no swap)', () => {
    expect(planOrtSwap('amd', 'win32').action).toBe('skip');
    expect(planOrtSwap('amd', 'linux').action).toBe('skip');
  });

  it('nvidia → skip (onnxruntime-gpu arrives via kokoro-onnx[gpu], no swap)', () => {
    expect(planOrtSwap('nvidia', 'win32').action).toBe('skip');
  });

  it('cpu → skip (plain onnxruntime installed by the overlay)', () => {
    expect(planOrtSwap('cpu', 'win32').action).toBe('skip');
  });
});
