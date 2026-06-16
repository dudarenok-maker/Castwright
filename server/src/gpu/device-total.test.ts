import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseNvidiaSmiTotalMb,
  setDeviceTotalVramMb,
  getDeviceTotalVramMb,
  _resetDeviceTotalForTests,
} from './device-total.js';

describe('device-total VRAM', () => {
  beforeEach(() => _resetDeviceTotalForTests());

  it('parses nvidia-smi memory.total CSV output (MiB)', () => {
    expect(parseNvidiaSmiTotalMb('8188\n')).toBe(8188);
    expect(parseNvidiaSmiTotalMb('8188 MiB\n')).toBe(8188);
  });

  it('returns null for unparseable output', () => {
    expect(parseNvidiaSmiTotalMb('')).toBeNull();
    expect(parseNvidiaSmiTotalMb('no GPU')).toBeNull();
  });

  it('caches a set value and serves it synchronously', () => {
    expect(getDeviceTotalVramMb()).toBeNull();
    setDeviceTotalVramMb(8188);
    expect(getDeviceTotalVramMb()).toBe(8188);
  });
});
