/* #3061 review N5 — `ensureGpuDeviceListWarm`'s guard used to be
   `getLastKnownGpuDevices().length > 0`, which cannot tell "never probed"
   apart from "probed, and this box genuinely has zero GPUs": a CPU-only box
   re-ran the (2s-bounded) sidecar probe on every lazy-derive call instead of
   caching the answer. This file pins that the cache now distinguishes the
   two states via `hasWarmedGpuDeviceList()`. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureGpuDeviceListWarm } from './ensure-gpu-device-list-warm.js';
import {
  getLastKnownGpuDevices,
  hasWarmedGpuDeviceList,
  resetGpuDeviceListWarmForTests,
} from './gpu-device-list-state.js';
import { fetchSidecarDevices } from './fetch-sidecar-devices.js';

vi.mock('./fetch-sidecar-devices.js', () => ({
  fetchSidecarDevices: vi.fn(),
}));

const fetchMock = fetchSidecarDevices as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock.mockReset();
  resetGpuDeviceListWarmForTests();
});

describe('ensureGpuDeviceListWarm', () => {
  it('probes only once when the sidecar reports zero GPUs (the CPU-only-box case)', async () => {
    fetchMock.mockResolvedValue({ devices: [], cpu: true });

    await ensureGpuDeviceListWarm();
    await ensureGpuDeviceListWarm();
    await ensureGpuDeviceListWarm();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getLastKnownGpuDevices()).toEqual([]);
    expect(hasWarmedGpuDeviceList()).toBe(true);
  });

  it('keeps re-probing when the sidecar is unreachable (not warmed, by design)', async () => {
    fetchMock.mockResolvedValue(null);

    await ensureGpuDeviceListWarm();
    await ensureGpuDeviceListWarm();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(hasWarmedGpuDeviceList()).toBe(false);
  });

  it('probes only once when the sidecar reports real GPUs, same as before', async () => {
    fetchMock.mockResolvedValue({
      devices: [{ uuid: 'GPU-0', idx: 0, name: 'a', total_mb: 8000, free_mb: 6000 }],
      cpu: false,
    });

    await ensureGpuDeviceListWarm();
    await ensureGpuDeviceListWarm();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getLastKnownGpuDevices()).toEqual([{ uuid: 'GPU-0', idx: 0 }]);
  });
});
