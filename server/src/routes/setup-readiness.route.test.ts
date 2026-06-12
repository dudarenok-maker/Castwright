import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { setupReadinessRouter } from './setup-readiness.js';

describe('GET /api/setup/readiness route (integration — live probe)', () => {
  it('returns 200 with the readiness shape even when the sidecar is down', async () => {
    const app = express();
    app.use('/api/setup', setupReadinessRouter);
    const res = await request(app).get('/api/setup/readiness');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ready');
    expect(res.body).toHaveProperty('blockers.sidecar');
    expect(res.body).toHaveProperty('info.gpu');
  });
});
