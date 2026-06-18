import { describe, it, expect } from 'vitest';
// @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
import { planTorchPreinstall } from '../../tts-sidecar/scripts/install-torch.mjs';

describe('planTorchPreinstall', () => {
  it('nvidia → install-index from the cu128 index (PyPI default torch is CPU-only on Windows)', () => {
    expect(planTorchPreinstall('nvidia', 'win32')).toEqual({
      action: 'install-index',
      url: 'https://download.pytorch.org/whl/cu128',
    });
  });

  it('cpu/apple → skip (torch comes from the overlay / PyPI, not a pre-install)', () => {
    expect(planTorchPreinstall('cpu', 'linux').action).toBe('skip');
    expect(planTorchPreinstall('apple', 'darwin').action).toBe('skip');
  });

  it('amd+win → install the two ROCm wheels before the engine packages', () => {
    const p = planTorchPreinstall('amd', 'win32');
    expect(p.action).toBe('install');
    expect(p.wheels).toHaveLength(2);
    expect(p.wheels[0]).toMatch(/repo\.radeon\.com.*torch-2\.8\.0a0.*cp312.*win_amd64\.whl/);
    expect(p.wheels[1]).toMatch(/torchaudio-2\.6\.0a0.*cp312.*win_amd64\.whl/);
  });

  it('amd+linux → skip (no ROCm-Linux wheels pinned yet; resolved in Wave H)', () => {
    expect(planTorchPreinstall('amd', 'linux').action).toBe('skip');
  });
});
