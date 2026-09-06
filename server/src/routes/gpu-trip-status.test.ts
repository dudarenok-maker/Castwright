/* GET /api/gpu/trip-status — Task 16/16.5 (#2974). Pins the route wiring: it
   forwards whatever server/src/gpu/auto-revert.ts's getTripStatus() reports,
   including the null "nothing has tripped yet" case. */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { gpuTripStatusRouter } from './gpu-trip-status.js';
import { _resetTripStatusForTest, runAutoRevert } from '../gpu/auto-revert.js';

function makeApp() {
  const app = express();
  app.use('/api/gpu', gpuTripStatusRouter);
  return app;
}

beforeEach(() => {
  _resetTripStatusForTest();
});

describe('GET /api/gpu/trip-status', () => {
  it('returns null when nothing has tripped since boot', async () => {
    const res = await request(makeApp()).get('/api/gpu/trip-status');
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it('returns the reverted outcome after a card-specific trip', async () => {
    await runAutoRevert(
      { card: 1, residentEngines: ['qwen'] },
      { clearOverride: async () => {}, resetAndRespawn: async () => {} },
    );

    const res = await request(makeApp()).get('/api/gpu/trip-status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'reverted',
      card: 1,
      engines: ['qwen'],
      toast: expect.stringMatching(/auto-reverted/i),
    });
  });

  it('returns the unrevertable outcome after a non-card-specific trip', async () => {
    await runAutoRevert({ card: null, residentEngines: [] }, { resetAndRespawn: async () => {} });

    const res = await request(makeApp()).get('/api/gpu/trip-status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'unrevertable',
      toast: expect.stringMatching(/not tied to a specific gpu card/i),
    });
  });
});
