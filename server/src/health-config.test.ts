import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildHealthPayload } from './health-payload.js';

function makeApp() {
  const app = express();
  app.get('/api/health', (_req, res) => {
    res.json(buildHealthPayload());
  });
  return app;
}

describe('buildHealthPayload', () => {
  it('returns the expected shape: ok, ts (ISO string), configLoad.{envLoaded,cwd}', () => {
    const payload = buildHealthPayload();
    expect(payload.ok).toBe(true);
    expect(typeof payload.ts).toBe('string');
    expect(() => new Date(payload.ts).toISOString()).not.toThrow();
    expect(typeof payload.configLoad.envLoaded).toBe('boolean');
    expect(typeof payload.configLoad.cwd).toBe('string');
  });
});

describe('GET /api/health', () => {
  it('reports whether server/.env loaded + the cwd', async () => {
    const res = await request(makeApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.configLoad.envLoaded).toBe('boolean');
    expect(typeof res.body.configLoad.cwd).toBe('string');
  });
});
