/* api.gpu-devices.test.ts — covers the /api/gpu/devices mock, consumed by
   the Advanced Configuration "device" knob dropdowns. */

import { describe, it, expect } from 'vitest';
import { mockGetGpuDevices } from './api';

describe('mockGetGpuDevices', () => {
  it('returns a list of GPU cards with uuid/idx/name/memory fields', async () => {
    const result = await mockGetGpuDevices();
    expect(result.devices.length).toBeGreaterThan(0);
    for (const d of result.devices) {
      expect(typeof d.uuid).toBe('string');
      expect(typeof d.idx).toBe('number');
      expect(typeof d.name).toBe('string');
      expect(typeof d.total_mb).toBe('number');
      expect(typeof d.free_mb).toBe('number');
    }
  });

  it('always reports cpu as available', async () => {
    const result = await mockGetGpuDevices();
    expect(result.cpu).toBe(true);
  });
});
