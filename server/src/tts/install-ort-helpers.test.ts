import { describe, it, expect } from 'vitest';
// @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
import { planOrtSwap, extraRuntimeSteps } from '../../tts-sidecar/scripts/install-ort.mjs';

describe('planOrtSwap', () => {
  // The overlay ALWAYS installs plain `onnxruntime` (kokoro-onnx's core dep). The
  // swap then replaces it with whatever GPU runtime the profile actually needs —
  // keyed on installRecipe.ortPackage. Any package other than plain 'onnxruntime'
  // (today: nvidia → onnxruntime-gpu; a future DirectML re-enable → -directml) is a
  // swap; 'onnxruntime' itself is a no-op.
  it('nvidia → swap: uninstall BOTH (bare names) then force-reinstall onnxruntime-gpu, version-constrained', () => {
    const plan = planOrtSwap('nvidia', 'win32');
    expect(plan.action).toBe('swap');
    // The CLI's success message interpolates this rather than hardcoding a
    // package name (#1844 — it used to hardcode 'onnxruntime-directml' even
    // though nvidia is the only profile that reaches this code path).
    expect(plan.ortPackage).toBe('onnxruntime-gpu');
    // Uninstall plain onnxruntime AND any cached onnxruntime-gpu so the shared
    // namespace is cleared, then --force-reinstall lays it fresh (a plain install
    // is a no-op when onnxruntime-gpu is cached at a skewed version → broken import).
    // The uninstall step takes BARE package names (a version spec there is
    // meaningless to `pip uninstall`); side-28 adds an explicit floor-plus-cap
    // constraint to the INSTALL step only, so the runtime a user lands on isn't
    // just "whatever was latest on PyPI on their install date" — bump this
    // assertion's version alongside install-ort.mjs's ONNXRUNTIME_GPU_CONSTRAINT
    // when the pin is next deliberately moved.
    // #2600: onnxruntime-gpu declares nvidia-cudnn-cu12 only in its OPTIONAL
    // [cudnn] extra, and `--no-deps` on the install step above suppresses
    // extras entirely — so nothing here ever lands cuDNN, and a real
    // CUDAExecutionProvider InferenceSession silently falls back to CPU. The
    // cuDNN step below is separate and deliberately does NOT carry --no-deps:
    // cuDNN's own dependency tree (cublas, nvrtc) doesn't intersect the
    // overlay's numpy/protobuf/flatbuffers pins, so pulling it in full is safe
    // where dropping --no-deps on the onnxruntime-gpu step itself is not.
    expect(plan.steps).toEqual([
      ['uninstall', '-y', 'onnxruntime', 'onnxruntime-gpu'],
      ['install', '--force-reinstall', '--no-deps', 'onnxruntime-gpu>=1.26,<1.27'],
      ['install', 'nvidia-cudnn-cu12~=9.0'],
    ]);
  });

  // extraRuntimeSteps is the exported gate itself — tested directly rather
  // than only indirectly through planOrtSwap, since no profile installed
  // TODAY exercises a non-onnxruntime-gpu SWAP (amd/apple/cpu are all
  // 'onnxruntime', i.e. skip): a future onnxruntime-directml re-enable must
  // not silently inherit a CUDA-only cuDNN package.
  it('extraRuntimeSteps: only onnxruntime-gpu gets the cuDNN step', () => {
    expect(extraRuntimeSteps('onnxruntime-gpu')).toEqual([['install', 'nvidia-cudnn-cu12~=9.0']]);
    expect(extraRuntimeSteps('onnxruntime-directml')).toEqual([]);
    expect(extraRuntimeSteps('onnxruntime')).toEqual([]);
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

describe('planOrtSwap marker action', () => {
  it('nvidia → write', () => {
    expect(planOrtSwap('nvidia', 'win32').marker).toEqual({ action: 'write' });
  });

  it('cpu, amd and apple → delete (they are NOT GPU-swap profiles)', () => {
    for (const p of ['cpu', 'amd', 'apple']) {
      expect(planOrtSwap(p, 'win32').marker).toEqual({ action: 'delete' });
    }
  });

  it('the skip variant carries NO ortPackage — a write there would glob undefined', () => {
    expect(planOrtSwap('cpu', 'win32').ortPackage).toBeUndefined();
  });
});
