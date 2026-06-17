import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeApiLimiter } from './rate-limit.js';

function appWith(limiter: express.RequestHandler) {
  const app = express();
  app.use(limiter);
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('makeApiLimiter', () => {
  it('passes under cap with standard headers', async () => {
    const res = await request(appWith(makeApiLimiter({ skip: () => false }))).get('/ping');
    expect(res.status).toBe(200);
    expect(res.headers).toHaveProperty('ratelimit-limit');
  });

  it('429s past the cap', async () => {
    const app = appWith(makeApiLimiter({ max: 1, skip: () => false }));
    await request(app).get('/ping');
    const blocked = await request(app).get('/ping');
    expect(blocked.status).toBe(429);
  });
});
