import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/resolver.js', () => ({ configValue: vi.fn() }));

import { engineDeviceIsGpu } from './engine-device.js';
import { configValue } from '../config/resolver.js';

describe('engineDeviceIsGpu', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { _resetEngineDevicesForTests } = await import('./engine-device-state.js');
    _resetEngineDevicesForTests();
  });

  it('true for cuda / cuda:N', () => {
    (configValue as any).mockReturnValue('cuda:1');
    expect(engineDeviceIsGpu('qwen')).toBe(true);
  });

  it('true for auto (conservative — auto usually resolves to a GPU)', () => {
    (configValue as any).mockReturnValue('auto');
    expect(engineDeviceIsGpu('coqui')).toBe(true);
  });

  it('false for cpu / mps', () => {
    (configValue as any).mockReturnValue('cpu');
    expect(engineDeviceIsGpu('kokoro')).toBe(false);
    (configValue as any).mockReturnValue('mps');
    expect(engineDeviceIsGpu('kokoro')).toBe(false);
  });

  it('true (conservative) for an engine with no registered device knob', () => {
    expect(engineDeviceIsGpu('gemini')).toBe(true);
    expect(configValue).not.toHaveBeenCalled();
  });

  it('ground truth cpu/mps wins over a GPU-looking knob', async () => {
    const { setLastKnownEngineDevices } = await import('./engine-device-state.js');
    setLastKnownEngineDevices({ kokoro: 'mps', coqui: 'cpu', qwen: 'cuda' });
    (configValue as any).mockReturnValue('cuda'); // knob would say "GPU" if consulted
    expect(engineDeviceIsGpu('kokoro')).toBe(false);
    expect(engineDeviceIsGpu('coqui')).toBe(false);
    expect(configValue).not.toHaveBeenCalled(); // ground truth short-circuits the knob read
  });

  it('ground truth cuda/rocm/directml wins over a cpu-pinned knob', async () => {
    const { setLastKnownEngineDevices } = await import('./engine-device-state.js');
    setLastKnownEngineDevices({ kokoro: 'rocm', coqui: 'directml', qwen: 'cuda' });
    (configValue as any).mockReturnValue('cpu'); // knob would say "not GPU" if consulted
    expect(engineDeviceIsGpu('kokoro')).toBe(true);
    expect(engineDeviceIsGpu('coqui')).toBe(true);
    expect(engineDeviceIsGpu('qwen')).toBe(true);
  });

  it('falls back to the knob when ground truth is unknown (never probed)', async () => {
    (configValue as any).mockReturnValue('cpu');
    expect(engineDeviceIsGpu('kokoro')).toBe(false);
    (configValue as any).mockReturnValue('cuda:1');
    expect(engineDeviceIsGpu('kokoro')).toBe(true);
  });
});
