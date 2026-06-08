/* fs-1 — pin the /api/upgrade router's HTTP surface + state-file bookkeeping.
   The destructive helpers (zip-validate, apply, busy-probe, path resolution)
   are mocked so the test asserts ONLY the route logic: status-code mapping
   (409 busy, 412 downgrade, 400 bad zip), the staged→applying transition, and
   the 202 dispatch. Their real logic is covered by the upgrade/*.test.ts units. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

// Mutable holders the hoisted mock factories read at call time.
const h = vi.hoisted(() => ({
  paths: null as null | Record<string, unknown>,
  validate: null as null | (() => Promise<unknown>),
  busy: { busy: false, generationBooks: [] as string[], analysisManuscripts: [] as string[] },
  applyResult: { ok: false, version: '1.6.0', releaseDir: '/r', phase: 'extract', error: 'stub' } as Record<string, unknown>,
  applyCalls: [] as unknown[],
}));

vi.mock('../upgrade/paths.js', () => ({ resolveUpgradePaths: () => h.paths }));
vi.mock('../upgrade/busy-probe.js', () => ({ anyJobInFlight: () => h.busy }));
vi.mock('../upgrade/zip-validate.js', () => ({ validateUpgradeZip: (...a: unknown[]) => (h.validate ?? (async () => ({ ok: false, code: 'bad-structure', reason: 'no stub' })))(...(a as [])) }));
vi.mock('../upgrade/apply.js', () => ({
  applyUpgrade: async (ctx: unknown) => {
    h.applyCalls.push(ctx);
    return h.applyResult;
  },
  createApplySteps: () => ({ readReqHash: () => 'old-hash' }),
}));
vi.mock('../app-version.js', () => ({ getAppVersion: () => '1.6.0' }));

let app: Express;
let stagingDir: string;

function readState() {
  return JSON.parse(readFileSync(join(stagingDir, 'state.json'), 'utf8'));
}

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'fs1-route-'));
  stagingDir = join(root, '.upgrade-staging');
  mkdirSync(stagingDir, { recursive: true });
  h.paths = {
    repoRoot: root,
    installRoot: root,
    releasesDir: join(root, 'releases'),
    isVersioned: true,
    stagingDir,
    stagedZip: join(stagingDir, 'incoming.zip'),
    stateFile: join(stagingDir, 'state.json'),
    venvDir: join(root, 'venv'),
    serverPidFile: join(root, '.run', 'server.pid'),
  };
  h.busy = { busy: false, generationBooks: [], analysisManuscripts: [] };
  h.validate = null;
  h.applyResult = { ok: false, version: '1.6.0', releaseDir: '/r', phase: 'extract', error: 'stub' };
  h.applyCalls = [];

  const { upgradeRouter } = await import('./upgrade.js');
  app = express();
  app.use(express.json());
  app.use('/api/upgrade', upgradeRouter);
});

afterEach(() => {
  vi.resetModules();
  if (h.paths) rmSync((h.paths.repoRoot as string), { recursive: true, force: true });
});

describe('GET /api/upgrade/state', () => {
  it('reports idle with no staged upgrade', async () => {
    const res = await request(app).get('/api/upgrade/state');
    expect(res.status).toBe(200);
    expect(res.body.phase).toBe('idle');
    expect(res.body.busy).toBe(false);
  });
});

describe('POST /api/upgrade/stage', () => {
  it('refuses with 409 while a job is in flight', async () => {
    h.busy = { busy: true, generationBooks: ['book-a'], analysisManuscripts: [] };
    const res = await request(app).post('/api/upgrade/stage').attach('zip', Buffer.from('PK'), 'x.zip');
    expect(res.status).toBe(409);
    expect(res.body.generationBooks).toEqual(['book-a']);
  });

  it('returns 412 for a downgrade and clears the staged file', async () => {
    h.validate = async () => ({ ok: false, code: 'downgrade', reason: 'older', isDowngrade: true });
    const res = await request(app).post('/api/upgrade/stage').attach('zip', Buffer.from('PK'), 'x.zip');
    expect(res.status).toBe(412);
    expect(res.body.code).toBe('downgrade');
    expect(existsSync(join(stagingDir, 'incoming.zip'))).toBe(false);
  });

  it('returns 400 for a structurally invalid zip', async () => {
    h.validate = async () => ({ ok: false, code: 'bad-structure', reason: 'two top dirs' });
    const res = await request(app).post('/api/upgrade/stage').attach('zip', Buffer.from('PK'), 'x.zip');
    expect(res.status).toBe(400);
  });

  it('stages a valid candidate and records it', async () => {
    h.validate = async () => ({ ok: true, code: 'ok', candidateVersion: '1.6.0', reqHash: 'new-hash', topDir: 'castwright-v1.6.0', isDowngrade: false });
    const res = await request(app).post('/api/upgrade/stage').attach('zip', Buffer.from('PK'), 'x.zip');
    expect(res.status).toBe(200);
    expect(res.body.candidateVersion).toBe('1.6.0');
    expect(res.body.requiresPipInstall).toBe(true); // new-hash != old-hash
    expect(readState().phase).toBe('staged');
  });
});

describe('POST /api/upgrade/abort', () => {
  it('drops the staged zip and resets to idle', async () => {
    writeFileSync(join(stagingDir, 'incoming.zip'), 'zip');
    writeFileSync(join(stagingDir, 'state.json'), JSON.stringify({ phase: 'staged', candidateVersion: '1.6.0' }));
    const res = await request(app).post('/api/upgrade/abort');
    expect(res.status).toBe(200);
    expect(existsSync(join(stagingDir, 'incoming.zip'))).toBe(false);
    expect(readState().phase).toBe('idle');
  });
});

describe('POST /api/upgrade/apply', () => {
  it('refuses with 409 when nothing is staged', async () => {
    const res = await request(app).post('/api/upgrade/apply');
    expect(res.status).toBe(409);
  });

  it('refuses with 409 while a job is in flight', async () => {
    h.busy = { busy: true, generationBooks: ['b'], analysisManuscripts: [] };
    const res = await request(app).post('/api/upgrade/apply');
    expect(res.status).toBe(409);
  });

  it('accepts a staged candidate with 202 and dispatches applyUpgrade', async () => {
    writeFileSync(
      join(stagingDir, 'state.json'),
      JSON.stringify({ phase: 'staged', candidateVersion: '1.6.0', topDir: 'castwright-v1.6.0', reqHash: 'h' }),
    );
    const res = await request(app).post('/api/upgrade/apply');
    expect(res.status).toBe(202);
    expect(res.body.toVersion).toBe('1.6.0');
    // Background apply (mocked ok:false → no SIGTERM) was invoked with the ctx.
    await vi.waitFor(() => expect(h.applyCalls.length).toBe(1));
    expect((h.applyCalls[0] as { candidateVersion: string }).candidateVersion).toBe('1.6.0');
    await vi.waitFor(() => expect(readState().phase).toBe('error')); // ok:false → error state
  });
});
