import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/resolver.js', () => ({ configValue: vi.fn() }));

import { engineDeviceIsGpu } from './engine-device.js';
import { configValue } from '../config/resolver.js';

describe('engineDeviceIsGpu', () => {
  beforeEach(() => vi.clearAllMocks());

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
});
