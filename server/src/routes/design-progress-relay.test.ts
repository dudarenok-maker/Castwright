// server/src/routes/design-progress-relay.test.ts
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { designProgressRelayRouter } from './design-progress-relay.js';
import { registerProgressToken, dropProgressToken, type SingleJob } from './single-design.js';

function appWith() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal', designProgressRelayRouter);
  return app;
}

function fakeJob() {
  const sent: unknown[] = [];
  const sub = { send: (p: unknown) => sent.push(p), res: {} as never, keepAlive: 0 as never };
  const job = { characterId: 'c1', phase: 'freeing-vram', subscribers: new Set([sub]) } as unknown as SingleJob;
  return { job, sent };
}

describe('POST /api/internal/design-progress', () => {
  it('broadcasts the phase to the job subscribers + advances job.phase on a valid token', async () => {
    const { job, sent } = fakeJob();
    registerProgressToken('tok', job);
    const res = await request(appWith())
      .post('/api/internal/design-progress')
      .send({ token: 'tok', phase: 'designing' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sent).toEqual([{ type: 'phase', phase: 'designing', characterId: 'c1' }]);
    expect(job.phase).toBe('designing');
    dropProgressToken('tok');
  });

  it('no-ops on an unknown token', async () => {
    const res = await request(appWith())
      .post('/api/internal/design-progress')
      .send({ token: 'nope', phase: 'designing' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false });
  });

  it('rejects a non-loopback client', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: '203.0.113.7' });
      next();
    });
    app.use('/api/internal', designProgressRelayRouter);
    const res = await request(app).post('/api/internal/design-progress').send({ token: 't', phase: 'designing' });
    expect(res.status).toBe(403);
  });

  it('rejects an unknown phase string (400)', async () => {
    const { job } = fakeJob();
    registerProgressToken('tok2', job);
    const res = await request(appWith())
      .post('/api/internal/design-progress')
      .send({ token: 'tok2', phase: 'bogus' });
    expect(res.status).toBe(400);
    dropProgressToken('tok2');
  });

  it('no-ops (200 {ok:false}) on an empty token with a valid phase (#1092)', async () => {
    const res = await request(appWith())
      .post('/api/internal/design-progress')
      .send({ token: '', phase: 'designing' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false });
  });
});
