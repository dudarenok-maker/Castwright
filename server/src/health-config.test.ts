import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { buildHealthPayload } from './health-payload.js';
import { isLoopbackRequest } from './lan-auth.js';

// health-payload.ts's own repoRoot is two directories up from this file's
// location (server/src -> repoRoot) — computed independently here so the
// test doesn't just restate the implementation.
const expectedRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Mirrors app.ts's /api/health one-liner exactly; the source-level assertion
// below pins that the real mount cannot drift from this mirror.
function makeApp(ip = '127.0.0.1') {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: ip, configurable: true });
    next();
  });
  app.get('/api/health', (req, res) => {
    res.json(buildHealthPayload({ includePaths: isLoopbackRequest(req) }));
  });
  return app;
}

describe('buildHealthPayload', () => {
  it('returns the expected shape: ok, ts (ISO string), configLoad.{envLoaded,cwd,runDir}', () => {
    const payload = buildHealthPayload({ includePaths: true });
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
      const payload = buildHealthPayload({ includePaths: true });
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
    try {
      // Castwright#3030 round 4 (finding R3): both mutations must be INSIDE
      // the try, not above it — process.chdir throws under some pool
      // configurations (e.g. --pool=threads), and a throw above the try
      // would skip the finally entirely, leaving APP_RUN_DIR deleted and
      // process.cwd() pointed at the temp dir for every later test in this
      // worker.
      delete process.env.APP_RUN_DIR;
      process.chdir(os.tmpdir());
      const payload = buildHealthPayload({ includePaths: true });
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

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('loopback ip %s still gets cwd + runDir', async (ip) => {
    const res = await request(makeApp(ip)).get('/api/health');
    expect(typeof res.body.configLoad.cwd).toBe('string');
    expect(typeof res.body.configLoad.runDir).toBe('string');
  });

  it('LAN ip 192.168.1.50 gets NO cwd/runDir, but keeps envLoaded, ok, ts', async () => {
    const res = await request(makeApp('192.168.1.50')).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.configLoad).not.toHaveProperty('cwd');
    expect(res.body.configLoad).not.toHaveProperty('runDir');
    expect(typeof res.body.configLoad.envLoaded).toBe('boolean');
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.ts).toBe('string');
  });

  // lan-port-forwarder.ts:92 sources forwarded :443 LAN traffic from 127.0.0.2
  // (NOT 127.0.0.1) so it must NOT count as loopback.
  it('forwarder ip 127.0.0.2 is treated as non-loopback: paths absent', async () => {
    const res = await request(makeApp('127.0.0.2')).get('/api/health');
    expect(res.body.configLoad).not.toHaveProperty('cwd');
    expect(res.body.configLoad).not.toHaveProperty('runDir');
  });

  it('app.ts mounts /api/health gated on isLoopbackRequest(req)', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'app.ts'), 'utf8');
    expect(src).toContain('buildHealthPayload({ includePaths: isLoopbackRequest(req) })');
  });
});
