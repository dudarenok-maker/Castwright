/* GET /api/gpu/devices — proxy that forwards the sidecar's /devices response
   (CUDA card enumeration). Mirrors sidecar-health.test.ts: stubbed global fetch,
   supertest against a minimal Express app. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { gpuDevicesRouter } from './gpu-devices.js';
import { _resetUserSettingsCache } from '../workspace/user-settings.js';
import { setLastKnownGpuDevices, getLastKnownGpuDevices } from '../gpu/gpu-device-list-state.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/gpu', gpuDevicesRouter);
  return app;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  _resetUserSettingsCache();
  setLastKnownGpuDevices([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/gpu/devices', () => {
  it('forwards the sidecar /devices response verbatim', async () => {
    const payload = {
      devices: [
        { uuid: 'GPU-0', idx: 0, name: 'RTX 4070', total_mb: 8000, free_mb: 6000 },
        { uuid: 'GPU-1', idx: 1, name: 'RTX 5070 Ti', total_mb: 16000, free_mb: 14000 },
      ],
      cpu: true,
    };
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await request(makeApp()).get('/api/gpu/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/devices$/),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('returns {devices:[],cpu:true} when the sidecar is down', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      }),
    );

    const res = await request(makeApp()).get('/api/gpu/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [], cpu: true });
  });

  it('populates the last-known-device-list cache on a successful response', async () => {
    const payload = {
      devices: [
        { uuid: 'GPU-0', idx: 0, name: 'RTX 4070', total_mb: 8000, free_mb: 6000 },
        { uuid: 'GPU-1', idx: 1, name: 'RTX 5070 Ti', total_mb: 16000, free_mb: 14000 },
      ],
      cpu: true,
    };
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await request(makeApp()).get('/api/gpu/devices');
    expect(res.status).toBe(200);

    const cached = getLastKnownGpuDevices().map(({ uuid, idx }) => ({ uuid, idx }));
    expect(cached).toEqual([
      { uuid: 'GPU-0', idx: 0 },
      { uuid: 'GPU-1', idx: 1 },
    ]);
  });

  it('returns {devices:[],cpu:true} when the fetch times out', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    );

    const res = await request(makeApp()).get('/api/gpu/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [], cpu: true });
  });
});

describe('GET /api/gpu/devices — merges live resident/stale_reason data (Plan 2 §2.2)', () => {
  function mockSidecarDevices(devices: Array<{ uuid: string; idx: number; name: string; total_mb: number; free_mb: number }>) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ devices, cpu: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }

  function mockSidecarHealth(health: { gpus?: unknown[] }) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(health), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }

  function mockSidecarHealthUnreachable() {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      }),
    );
  }

  it('includes resident and stale_reason per device from the sidecar /health', async () => {
    mockSidecarDevices([{ uuid: 'GPU-1', idx: 1, name: 'x', total_mb: 16000, free_mb: 14000 }]);
    mockSidecarHealth({
      gpus: [{ uuid: 'GPU-1', idx: 1, resident: [{ engine: 'qwen', actual_card: 1 }], torch_reserved_mb: 4000 }],
    });
    const res = await request(makeApp()).get('/api/gpu/devices');
    expect(res.body.devices[0].resident).toEqual([{ engine: 'qwen', actual_card: 1 }]);
    expect(res.body.devices[0].torchReservedMb).toBe(4000);
  });

  it('falls back to devices-only (no resident field) when /health is unreachable', async () => {
    mockSidecarDevices([{ uuid: 'GPU-1', idx: 1, name: 'x', total_mb: 16000, free_mb: 14000 }]);
    mockSidecarHealthUnreachable();
    const res = await request(makeApp()).get('/api/gpu/devices');
    expect(res.body.devices[0].resident).toBeUndefined();
  });

  /* Plan 2a on-box acceptance found a real gap here: /health's gpus[] carries
     a SYNTHETIC idx:-1 "unindexed (cpu / ORT / CT2)" entry whenever an
     engine has actually fallen back to CPU — that's where
     stale_reason:'cpu_fallback' lives (main.py's _build_gpus_payload). The
     original merge only walked the static /devices list's REAL indexed
     cards and looked up a matching /health entry by idx, so the idx:-1
     bucket was silently dropped — a Kokoro engine forced onto an
     out-of-range cuda:9 correctly fell back to CPU sidecar-side, but the
     picker never showed the cpu_fallback badge at all. Reproduced against a
     real sidecar on real 2-GPU hardware before this fix. */
  it('surfaces the cpu_fallback badge from /health\'s synthetic idx:-1 unindexed bucket', async () => {
    mockSidecarDevices([
      { uuid: 'GPU-0', idx: 0, name: 'RTX 4070', total_mb: 8000, free_mb: 6000 },
      { uuid: 'GPU-1', idx: 1, name: 'RTX 5070 Ti', total_mb: 16000, free_mb: 14000 },
    ]);
    mockSidecarHealth({
      gpus: [
        { uuid: 'GPU-0', idx: 0, resident: [], torch_reserved_mb: 0 },
        { uuid: 'GPU-1', idx: 1, resident: [], torch_reserved_mb: 0 },
        {
          uuid: null,
          idx: -1,
          name: 'unindexed (cpu / ORT / CT2)',
          resident: [{ engine: 'kokoro', actual_card: null, stale_reason: 'cpu_fallback' }],
          torch_reserved_mb: 0,
        },
      ],
    });
    const res = await request(makeApp()).get('/api/gpu/devices');
    expect(res.status).toBe(200);
    expect(res.body.devices).toHaveLength(3);
    const unindexed = res.body.devices.find((d: { idx: number }) => d.idx === -1);
    expect(unindexed).toBeDefined();
    expect(unindexed.resident).toEqual([
      { engine: 'kokoro', actual_card: null, stale_reason: 'cpu_fallback' },
    ]);
  });

  it('does not append an idx:-1 entry when the unindexed bucket is empty', async () => {
    mockSidecarDevices([{ uuid: 'GPU-0', idx: 0, name: 'RTX 4070', total_mb: 8000, free_mb: 6000 }]);
    mockSidecarHealth({
      gpus: [
        { uuid: 'GPU-0', idx: 0, resident: [], torch_reserved_mb: 0 },
        { uuid: null, idx: -1, name: 'unindexed (cpu / ORT / CT2)', resident: [], torch_reserved_mb: 0 },
      ],
    });
    const res = await request(makeApp()).get('/api/gpu/devices');
    expect(res.body.devices).toHaveLength(1);
    expect(res.body.devices.find((d: { idx: number }) => d.idx === -1)).toBeUndefined();
  });
});
