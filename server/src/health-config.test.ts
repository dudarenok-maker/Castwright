import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { buildHealthPayload } from './health-payload.js';

// health-payload.ts's own repoRoot is two directories up from this file's
// location (server/src -> repoRoot) — computed independently here so the
// test doesn't just restate the implementation.
const expectedRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

  // Castwright#3030 round 3 (finding N3): resolveRunDir short-circuits on
  // APP_RUN_DIR before ever reading its argument, so the test above alone
  // cannot tell "derived from the compiled file's own location" apart from
  // "derived from process.cwd()" — both pass it identically. This test
  // clears APP_RUN_DIR and moves process.cwd() somewhere else entirely, so
  // only the correct (file-location-based) implementation can still name
  // the real repo's .run.
  it('with APP_RUN_DIR unset, runDir derives from the compiled file location, not process.cwd()', () => {
    const savedRunDir = process.env.APP_RUN_DIR;
    const savedCwd = process.cwd();
    delete process.env.APP_RUN_DIR;
    process.chdir(os.tmpdir());
    try {
      const payload = buildHealthPayload();
      expect(payload.configLoad.runDir).toBe(resolve(expectedRepoRoot, '.run'));
      expect(payload.configLoad.runDir).not.toBe(resolve(process.cwd(), '.run'));
    } finally {
      process.chdir(savedCwd);
      if (savedRunDir === undefined) delete process.env.APP_RUN_DIR;
      else process.env.APP_RUN_DIR = savedRunDir;
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
