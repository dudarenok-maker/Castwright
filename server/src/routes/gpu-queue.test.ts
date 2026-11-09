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
import { recordTtsAutoFree, resetTtsAutoFreeForTests } from '../gpu/tts-auto-free-notice.js';

function makeApp() {
  const app = express();
  app.use('/api/gpu', gpuQueueRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetTtsAutoFreeForTests();
  getCapacityWaiterCount.mockReturnValue(0);
  capacityProbeRead.mockResolvedValue([]);
});

describe('readGpuQueueState()', () => {
  it('returns queueDepth from getCapacityWaiterCount() and devices from capacityProbe.read()', async () => {
    getCapacityWaiterCount.mockReturnValue(2);
    const devices = [{ kind: 'cuda' as const, index: 0, label: 'cuda:0', totalMb: 8000, freeMb: 500 }];
    capacityProbeRead.mockResolvedValue(devices);

    const state = await readGpuQueueState();

    expect(state).toEqual({ queueDepth: 2, devices, lastTtsAutoFree: null });
  });

  it('returns queueDepth 0 with no devices when nothing is waiting and no GPU is present', async () => {
    const state = await readGpuQueueState();
    expect(state).toEqual({ queueDepth: 0, devices: [], lastTtsAutoFree: null });
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
      lastTtsAutoFree: null,
    });
  });
});

describe('#4066 — the last TTS auto-free rides the queue payload', () => {
  it('reports what a voice design unloaded, so the browser can show the notice', async () => {
    recordTtsAutoFree(['Qwen 0.6B', 'Kokoro'], 'voice design');

    const res = await request(makeApp()).get('/api/gpu/queue');

    expect(res.body.lastTtsAutoFree).toMatchObject({
      seq: expect.any(Number),
      models: ['Qwen 0.6B', 'Kokoro'],
      purpose: 'voice design',
    });
  });
});