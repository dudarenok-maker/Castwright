import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { resolve } from 'node:path';
import { buildHealthPayload } from './health-payload.js';

function makeApp() {
  const app = express();
  app.get('/api/health', (_req, res) => {
    res.json(buildHealthPayload());
  });
  return app;
}

describe('buildHealthPayload', () => {
  it('returns the expected shape: ok, ts (ISO string), configLoad.{envLoaded,cwd,runDir}', () => {
    const payload = buildHealthPayload();
    expect(payload.ok).toBe(true);
    expect(typeof payload.ts).toBe('string');
    expect(() => new Date(payload.ts).toISOString()).not.toThrow();
    expect(typeof payload.configLoad.envLoaded).toBe('boolean');
    expect(typeof payload.configLoad.cwd).toBe('string');
    expect(typeof payload.configLoad.runDir).toBe('string');
  });

  it('runDir honours APP_RUN_DIR (fs-1 versioned installs share one runDir across releases)', () => {
    const saved = process.env.APP_RUN_DIR;
    try {
      process.env.APP_RUN_DIR = '/srv/audiobook/.run';
      const payload = buildHealthPayload();
      expect(payload.configLoad.runDir).toBe(resolve('/srv/audiobook/.run'));
    } finally {
      if (saved === undefined) delete process.env.APP_RUN_DIR;
      else process.env.APP_RUN_DIR = saved;
    }
  });
});

describe('GET /api/health', () => {
  it('reports whether server/.env loaded + the cwd + runDir', async () => {
    const res = await request(makeApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.configLoad.envLoaded).toBe('boolean');
    expect(typeof res.body.configLoad.cwd).toBe('string');
    expect(typeof res.body.configLoad.runDir).toBe('string');
  });
});
