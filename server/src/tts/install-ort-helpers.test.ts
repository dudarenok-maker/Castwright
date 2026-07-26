import { describe, it, expect } from 'vitest';
// @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
import { planOrtSwap } from '../../tts-sidecar/scripts/install-ort.mjs';

describe('planOrtSwap', () => {
  // The overlay ALWAYS installs plain `onnxruntime` (kokoro-onnx's core dep). The
  // swap then replaces it with whatever GPU runtime the profile actually needs —
  // keyed on installRecipe.ortPackage. Any package other than plain 'onnxruntime'
  // (today: nvidia → onnxruntime-gpu; a future DirectML re-enable → -directml) is a
  // swap; 'onnxruntime' itself is a no-op.
  it('nvidia → swap: uninstall BOTH (bare names) then force-reinstall onnxruntime-gpu, version-constrained', () => {
    const plan = planOrtSwap('nvidia', 'win32');
    expect(plan.action).toBe('swap');
    // Uninstall plain onnxruntime AND any cached onnxruntime-gpu so the shared
    // namespace is cleared, then --force-reinstall lays it fresh (a plain install
    // is a no-op when onnxruntime-gpu is cached at a skewed version → broken import).
    // The uninstall step takes BARE package names (a version spec there is
    // meaningless to `pip uninstall`); side-28 adds an explicit floor-plus-cap
    // constraint to the INSTALL step only, so the runtime a user lands on isn't
    // just "whatever was latest on PyPI on their install date" — bump this
    // assertion's version alongside install-ort.mjs's ONNXRUNTIME_GPU_CONSTRAINT
    // when the pin is next deliberately moved.
    expect(plan.steps).toEqual([
      ['uninstall', '-y', 'onnxruntime', 'onnxruntime-gpu'],
      ['install', '--force-reinstall', '--no-deps', 'onnxruntime-gpu>=1.27,<1.28'],
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
