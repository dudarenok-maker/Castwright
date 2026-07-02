import { describe, it, expect, vi } from 'vitest';
vi.mock('../config/resolver.js', () => ({ configValue: vi.fn(() => 11000) }));
import { shouldEvictBeforeSidecarLoad } from './residency.js';
import { configValue } from '../config/resolver.js';

describe('shouldEvictBeforeSidecarLoad', () => {
  it('CPU never evicts', () => {
    expect(shouldEvictBeforeSidecarLoad({ accelerator: 'cpu', totalMb: null })).toBe(false);
  });
  it('GPU unknown total → evict (conservative)', () => {
    expect(shouldEvictBeforeSidecarLoad({ accelerator: 'cuda', totalMb: null })).toBe(true);
  });
  it('accelerator unknown (never probed) → evict (conservative)', () => {
    expect(shouldEvictBeforeSidecarLoad({ accelerator: 'unknown', totalMb: null })).toBe(true);
  });
  it('8 GB evicts; 12/16 GB coexist', () => {
    expect(shouldEvictBeforeSidecarLoad({ accelerator: 'cuda', totalMb: 8188 })).toBe(true);
    expect(shouldEvictBeforeSidecarLoad({ accelerator: 'cuda', totalMb: 12288 })).toBe(false);
    expect(shouldEvictBeforeSidecarLoad({ accelerator: 'cuda', totalMb: 16384 })).toBe(false);
  });
});

describe('shouldEvictBeforeSidecarLoad — engineOnGpu guard (W2.6)', () => {
  it('never evicts when the engine about to load is not itself on the GPU', () => {
    (configValue as any).mockReturnValue(11000);
    expect(shouldEvictBeforeSidecarLoad({ accelerator: 'cuda', totalMb: 8000 }, false)).toBe(false);
  });

  it('preserves existing behaviour when engineOnGpu defaults true', () => {
    (configValue as any).mockReturnValue(11000);
    expect(shouldEvictBeforeSidecarLoad({ accelerator: 'cuda', totalMb: 8000 })).toBe(true);
  });
});
