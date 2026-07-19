/* vram-aware placement (Task 10) — readGpuQueueState() migrated off the
   deleted gpuSemaphore: queueDepth now comes from the sidecar client's
   no-capacity poll-wait counter, and devices from a live capacityProbe read.
   Both dependencies are mocked so this pins the new {queueDepth, devices}
   shape and the GET /queue route wiring in isolation. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const getCapacityWaiterCount = vi.fn();
const capacityProbeRead = vi.fn();

vi.mock('../tts/sidecar.js', () => ({
  getCapacityWaiterCount: () => getCapacityWaiterCount(),
}));
vi.mock('../gpu/capacity-probe.js', () => ({
  capacityProbe: { read: (...args: unknown[]) => capacityProbeRead(...args) },
}));

import { gpuQueueRouter, readGpuQueueState } from './gpu-queue.js';

function makeApp() {
  const app = express();
  app.use('/api/gpu', gpuQueueRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  getCapacityWaiterCount.mockReturnValue(0);
  capacityProbeRead.mockResolvedValue([]);
});

describe('readGpuQueueState()', () => {
  it('returns queueDepth from getCapacityWaiterCount() and devices from capacityProbe.read()', async () => {
    getCapacityWaiterCount.mockReturnValue(2);
    const devices = [{ kind: 'cuda' as const, index: 0, label: 'cuda:0', totalMb: 8000, freeMb: 500 }];
    capacityProbeRead.mockResolvedValue(devices);

    const state = await readGpuQueueState();

    expect(state).toEqual({ queueDepth: 2, devices });
  });

  it('returns queueDepth 0 with no devices when nothing is waiting and no GPU is present', async () => {
    const state = await readGpuQueueState();
    expect(state).toEqual({ queueDepth: 0, devices: [] });
  });
});

describe('GET /api/gpu/queue', () => {
  it('serves the readGpuQueueState() payload as JSON', async () => {
    getCapacityWaiterCount.mockReturnValue(1);
    capacityProbeRead.mockResolvedValue([
      { kind: 'cuda', index: 0, label: 'cuda:0', totalMb: 8000, freeMb: 1200 },
    ]);

    const res = await request(makeApp()).get('/api/gpu/queue');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      queueDepth: 1,
      devices: [{ kind: 'cuda', index: 0, label: 'cuda:0', totalMb: 8000, freeMb: 1200 }],
    });
  });
});
