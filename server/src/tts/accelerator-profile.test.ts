/* accelerator-profile.mjs is side-effect-guarded (runs only when invoked
   directly), so importing it here is inert. */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
import { parseVendorFromProbe, detectVendor, resolveProfile, resolveInstallProfile, runtimeBackend, ortProviders, installRecipe, describeResolved } from '../../tts-sidecar/scripts/accelerator-profile.mjs';

describe('parseVendorFromProbe', () => {
  it('detects NVIDIA from a Windows controller list', () => {
    expect(parseVendorFromProbe('win32', 'NVIDIA GeForce RTX 4070')).toBe('nvidia');
  });
  it('detects AMD from "Radeon"', () => {
    expect(parseVendorFromProbe('win32', 'AMD Radeon RX 7900 XTX')).toBe('amd');
  });
  it('NVIDIA wins when both an AMD iGPU and an NVIDIA dGPU are present (M1/N6)', () => {
    const probe = 'AMD Radeon(TM) Graphics\nNVIDIA GeForce RTX 4060 Laptop GPU';
    expect(parseVendorFromProbe('win32', probe)).toBe('nvidia');
  });
  it('detects AMD-only (APU, no NVIDIA)', () => {
    expect(parseVendorFromProbe('win32', 'AMD Radeon(TM) Graphics')).toBe('amd');
  });
  it('resolves apple on darwin regardless of probe text', () => {
    expect(parseVendorFromProbe('darwin', '')).toBe('apple');
  });
  it('detects AMD from a Linux lspci VGA line', () => {
    const lspci = '01:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 31';
    expect(parseVendorFromProbe('linux', lspci)).toBe('amd');
  });
  it('falls back to cpu on empty/unrecognised probe', () => {
    expect(parseVendorFromProbe('linux', '')).toBe('cpu');
    expect(parseVendorFromProbe('win32', 'Microsoft Basic Display Adapter')).toBe('cpu');
  });
});

describe('detectVendor', () => {
  it('uses the injected exec output (Windows)', () => {
    const exec = () => 'NVIDIA GeForce RTX 4070';
    expect(detectVendor({ platform: 'win32', exec })).toBe('nvidia');
  });
  it('returns cpu when exec throws (probe unavailable)', () => {
    const exec = () => {
      throw new Error('no wmi');
    };
    expect(detectVendor({ platform: 'linux', exec })).toBe('cpu');
  });
  it('returns apple on darwin without invoking exec', () => {
    let called = false;
    const exec = () => {
      called = true;
      return '';
    };
    expect(detectVendor({ platform: 'darwin', exec })).toBe('apple');
    expect(called).toBe(false);
  });
});

describe('resolveProfile', () => {
  it('env override beats wizard choice and detection (N7)', () => {
    expect(resolveProfile({ envOverride: 'cpu', wizardChoice: 'amd', detected: 'nvidia' })).toBe('cpu');
  });
  it('wizard choice beats detection when no env override', () => {
    expect(resolveProfile({ envOverride: null, wizardChoice: 'amd', detected: 'nvidia' })).toBe('amd');
  });
  it('falls back to detection when neither override is set', () => {
    expect(resolveProfile({ envOverride: null, wizardChoice: null, detected: 'amd' })).toBe('amd');
  });
  it('maps unknown detection to cpu (never silently tries amd)', () => {
    expect(resolveProfile({ envOverride: null, wizardChoice: null, detected: 'unknown' })).toBe('cpu');
  });
  it('rejects an invalid override and falls through', () => {
    expect(resolveProfile({ envOverride: 'banana', wizardChoice: null, detected: 'nvidia' })).toBe('nvidia');
  });
});

describe('resolveInstallProfile (venv build/upgrade precedence: env → stamp carry-forward → detection)', () => {
  const amdExec = () => 'AMD Radeon RX 7900 XTX';
  const nvExec = () => 'NVIDIA GeForce RTX 4070';

  it('ACCELERATOR env override wins over the stamp AND detection', () => {
    expect(
      resolveInstallProfile({ envOverride: 'amd', stampProfile: 'nvidia', platform: 'win32', exec: nvExec }),
    ).toBe('amd');
  });

  it('carry-forward: an existing stamped profile beats detection (NO forced migration)', () => {
    // The classic regression: a box stamped nvidia by Phase 1 whose hardware now
    // detects amd must STAY nvidia on upgrade (else every existing install rebuilds).
    expect(
      resolveInstallProfile({ envOverride: null, stampProfile: 'nvidia', platform: 'win32', exec: amdExec }),
    ).toBe('nvidia');
  });

  it('fresh install (no stamp): falls through to hardware detection', () => {
    expect(
      resolveInstallProfile({ envOverride: null, stampProfile: null, platform: 'win32', exec: amdExec }),
    ).toBe('amd');
    expect(
      resolveInstallProfile({ envOverride: null, stampProfile: null, platform: 'win32', exec: nvExec }),
    ).toBe('nvidia');
  });

  it('fresh install on a box with no GPU probe → cpu (detection degrades, never amd)', () => {
    const bustedExec = () => {
      throw new Error('no wmi');
    };
    expect(
      resolveInstallProfile({ envOverride: null, stampProfile: null, platform: 'linux', exec: bustedExec }),
    ).toBe('cpu');
  });

  it('an invalid ACCELERATOR override is ignored (falls through to stamp/detection)', () => {
    expect(
      resolveInstallProfile({ envOverride: 'banana', stampProfile: 'cpu', platform: 'win32', exec: nvExec }),
    ).toBe('cpu');
  });
});

describe('runtimeBackend', () => {
  it('nvidia torch engines → cuda', () => {
    expect(runtimeBackend('nvidia', 'qwen', 'win32')).toBe('cuda');
    expect(runtimeBackend('nvidia', 'coqui', 'linux')).toBe('cuda');
  });
  it('amd torch engines → rocm (HIP aliases cuda at runtime)', () => {
    expect(runtimeBackend('amd', 'qwen', 'win32')).toBe('rocm');
  });
  // S0.1 RESOLVED (2026-06-15, on-box): DirectML can't run the Kokoro model
  // (ConvTranspose fails on onnxruntime-directml 1.24.4; CPU EP works), so AMD
  // Kokoro is CPU on every OS.
  it('amd Kokoro → cpu on every OS (S0.1 found DirectML can’t run the model)', () => {
    expect(runtimeBackend('amd', 'kokoro', 'win32')).toBe('cpu');
    expect(runtimeBackend('amd', 'kokoro', 'linux')).toBe('cpu');
  });
  it('apple torch → mps, apple kokoro → cpu', () => {
    expect(runtimeBackend('apple', 'qwen', 'darwin')).toBe('mps');
    expect(runtimeBackend('apple', 'kokoro', 'darwin')).toBe('cpu');
  });
  it('cpu profile → cpu everywhere', () => {
    expect(runtimeBackend('cpu', 'qwen', 'linux')).toBe('cpu');
    expect(runtimeBackend('cpu', 'kokoro', 'win32')).toBe('cpu');
  });
});

describe('ortProviders', () => {
  it('nvidia → CUDA then CPU', () => {
    expect(ortProviders('nvidia', 'win32')).toEqual(['CUDAExecutionProvider', 'CPUExecutionProvider']);
  });
  // S0.1 RESOLVED — DirectML can't run Kokoro, so AMD is CPU-only for ORT on
  // every OS (no DmlExecutionProvider).
  it('amd → CPU only on every OS (DirectML disabled after S0.1)', () => {
    expect(ortProviders('amd', 'win32')).toEqual(['CPUExecutionProvider']);
    expect(ortProviders('amd', 'linux')).toEqual(['CPUExecutionProvider']);
    expect(ortProviders('cpu', 'win32')).toEqual(['CPUExecutionProvider']);
  });
});

describe('installRecipe', () => {
  // Verified against the ACTUAL current install (P1): no cu124 index exists today;
  // torch is transitive from PyPI; onnxruntime-gpu via kokoro-onnx[gpu].
  it('nvidia == TODAY: NO explicit torch preinstall + onnxruntime-gpu (regression fence)', () => {
    const r = installRecipe('nvidia', 'win32');
    expect(r.torchPreinstall).toBeNull(); // engine packages pull torch from PyPI, unchanged
    expect(r.ortPackage).toBe('onnxruntime-gpu');
  });
  // S0.2 desk-pass-verified ROCm-Windows preview wheels (alpha; ROCm 6.4.4, cp312).
  // Import-ability + synthesis are OWED on real AMD hardware (Wave H2). torch 2.8
  // < 2.9 → coqui-tts without [codec]. ORT is plain onnxruntime (NOT directml):
  // S0.1 found DirectML can't run the Kokoro model, so Kokoro stays on the CPU EP.
  it('amd torchPreinstall = the pinned ROCm 6.4.4 cp312 wheels (win); plain onnxruntime (no directml)', () => {
    const r = installRecipe('amd', 'win32');
    expect(r.torchPreinstall.wheels).toEqual([
      'https://repo.radeon.com/rocm/windows/rocm-rel-6.4.4/torch-2.8.0a0+gitfc14c65-cp312-cp312-win_amd64.whl',
      'https://repo.radeon.com/rocm/windows/rocm-rel-6.4.4/torchaudio-2.6.0a0+1a8f621-cp312-cp312-win_amd64.whl',
    ]);
    expect(r.ortPackage).toBe('onnxruntime');
    // Linux ROCm wheels are resolved in Wave H; the win-only list is empty there.
    const l = installRecipe('amd', 'linux');
    expect(l.torchPreinstall.wheels).toEqual([]);
    expect(l.ortPackage).toBe('onnxruntime');
  });
  it('cpu is a Phase-2 IMPROVEMENT (not today): cpu torch preinstall + plain onnxruntime', () => {
    const r = installRecipe('cpu', 'linux');
    expect(r.torchPreinstall).toEqual({ source: 'index', url: 'https://download.pytorch.org/whl/cpu' });
    expect(r.ortPackage).toBe('onnxruntime');
  });
});

describe('describeResolved', () => {
  it('summarises the resolved profile + per-engine backends', () => {
    const out = describeResolved({ envOverride: null, wizardChoice: null, detected: 'nvidia', platform: 'win32' });
    expect(out.profile).toBe('nvidia');
    expect(out.backends.qwen).toBe('cuda');
    expect(out.backends.kokoro).toBe('cuda');
  });
});
