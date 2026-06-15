import { describe, it, expect } from 'vitest';
// @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
import { planOrtSwap } from '../../tts-sidecar/scripts/install-ort.mjs';

describe('planOrtSwap', () => {
  it('amd+win → uninstall base onnxruntime, then install onnxruntime-directml (ordered)', () => {
    const p = planOrtSwap('amd', 'win32');
    expect(p.action).toBe('swap');
    expect(p.steps).toEqual([
      ['uninstall', '-y', 'onnxruntime'],
      ['install', 'onnxruntime-directml'],
    ]);
  });

  it('amd+linux → skip (base onnxruntime / CPU EP is correct; no DirectML)', () => {
    expect(planOrtSwap('amd', 'linux').action).toBe('skip');
  });

  it('nvidia → skip (onnxruntime-gpu arrives via kokoro-onnx[gpu], no swap)', () => {
    expect(planOrtSwap('nvidia', 'win32').action).toBe('skip');
  });

  it('cpu → skip (plain onnxruntime installed by the overlay)', () => {
    expect(planOrtSwap('cpu', 'win32').action).toBe('skip');
  });
});
