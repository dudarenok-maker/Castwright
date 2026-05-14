/* Integration test for the user-settings route.

   Asserts:
     1. GET seeds defaults on first call (no file on disk).
     2. PUT persists a partial patch and the merged shape comes back.
     3. PUT drops secret-shaped fields (geminiApiKey, apiKey, etc.) —
        nothing reaches user-settings.json.
     4. GET reports apiKeyStatus='set' iff GEMINI_API_KEY is present.
     5. Read-only fields (apiKeyStatus, workspaceRoot, workspaceSource)
        submitted in PUT are ignored, not stored, not echoed verbatim. */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let workspaceRoot: string;
let app: Express;
let userSettingsPath: string;
let resetCache: () => void;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-user-settings-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  delete process.env.GEMINI_API_KEY;

  const [{ userSettingsRouter }, settings] = await Promise.all([
    import('./user-settings.js'),
    import('../workspace/user-settings.js'),
  ]);

  userSettingsPath = settings.USER_SETTINGS_PATH;
  resetCache = settings._resetUserSettingsCache;

  app = express();
  app.use(express.json());
  app.use('/api/user/settings', userSettingsRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.GEMINI_API_KEY;
});

beforeEach(() => {
  /* Wipe the user-settings.json between tests so each starts fresh. The
     route's first GET will recreate it from defaults. */
  if (userSettingsPath && existsSync(userSettingsPath)) {
    rmSync(userSettingsPath, { force: true });
  }
  resetCache();
  delete process.env.GEMINI_API_KEY;
});

describe('user-settings router', () => {
  it('GET returns built-in defaults when no file exists', async () => {
    const res = await request(app).get('/api/user/settings');
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('Mike Dudarenok');
    expect(res.body.defaultAnalysisModel).toBe('qwen3.5:9b');
    expect(res.body.defaultTtsEngine).toBe('local');
    expect(res.body.defaultTtsModelKey).toBe('coqui-xtts-v2');
    expect(res.body.sidecarUrl).toBe('http://localhost:9000');
    expect(res.body.workspaceDirOverride).toBeNull();
    /* Minor-cast fold default — see server/src/analyzer/fold-minor-cast.ts. */
    expect(res.body.minorCastMinLines).toBe(3);
  });

  it('PUT round-trips minorCastMinLines and rejects out-of-range values', async () => {
    /* Happy path — explicit override persists. */
    const ok = await request(app)
      .put('/api/user/settings')
      .send({ minorCastMinLines: 5 });
    expect(ok.status).toBe(200);
    expect(ok.body.minorCastMinLines).toBe(5);
    const onDisk = JSON.parse(readFileSync(userSettingsPath, 'utf8'));
    expect(onDisk.minorCastMinLines).toBe(5);

    /* 0 disables the line-count trigger entirely (still a valid setting). */
    const zero = await request(app)
      .put('/api/user/settings')
      .send({ minorCastMinLines: 0 });
    expect(zero.status).toBe(200);
    expect(zero.body.minorCastMinLines).toBe(0);

    /* Negative is out of schema range. */
    const neg = await request(app)
      .put('/api/user/settings')
      .send({ minorCastMinLines: -1 });
    expect(neg.status).toBe(400);

    /* > 50 cap. */
    const big = await request(app)
      .put('/api/user/settings')
      .send({ minorCastMinLines: 51 });
    expect(big.status).toBe(400);
  });

  it('PUT persists a partial patch and merges into the on-disk file', async () => {
    const res = await request(app)
      .put('/api/user/settings')
      .send({ displayName: 'Test User', defaultAnalysisModel: 'gemini-2.5-flash' });

    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('Test User');
    expect(res.body.defaultAnalysisModel).toBe('gemini-2.5-flash');
    // Untouched defaults survive the merge.
    expect(res.body.sidecarUrl).toBe('http://localhost:9000');

    // On disk
    expect(existsSync(userSettingsPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(userSettingsPath, 'utf8'));
    expect(onDisk.displayName).toBe('Test User');
    expect(onDisk.defaultAnalysisModel).toBe('gemini-2.5-flash');
  });

  it('PUT drops secret-shaped fields — the API key never reaches disk', async () => {
    const res = await request(app)
      .put('/api/user/settings')
      .send({
        displayName: 'Phisher',
        geminiApiKey: 'leaked-key-12345',
        apiKey: 'another-leaked-key',
        GEMINI_API_KEY: 'shouted-leaked-key',
      });

    expect(res.status).toBe(200);
    // Echoed shape carries no api-key field
    expect((res.body as Record<string, unknown>).geminiApiKey).toBeUndefined();
    expect((res.body as Record<string, unknown>).apiKey).toBeUndefined();

    const onDisk = JSON.parse(readFileSync(userSettingsPath, 'utf8'));
    expect(onDisk.geminiApiKey).toBeUndefined();
    expect(onDisk.apiKey).toBeUndefined();
    expect(onDisk.GEMINI_API_KEY).toBeUndefined();
  });

  it('GET reports apiKeyStatus=set when GEMINI_API_KEY is present, unset otherwise', async () => {
    const unset = await request(app).get('/api/user/settings');
    expect(unset.body.apiKeyStatus).toBe('unset');

    process.env.GEMINI_API_KEY = 'fake-but-non-empty';
    const set = await request(app).get('/api/user/settings');
    expect(set.body.apiKeyStatus).toBe('set');
  });

  it('GET exposes workspaceRoot + workspaceSource for the UI to display', async () => {
    const res = await request(app).get('/api/user/settings');
    expect(typeof res.body.workspaceRoot).toBe('string');
    expect(res.body.workspaceRoot.length).toBeGreaterThan(0);
    expect(['env', 'default', 'override']).toContain(res.body.workspaceSource);
  });

  it('PUT ignores read-only fields submitted in the body', async () => {
    const res = await request(app)
      .put('/api/user/settings')
      .send({
        displayName: 'Adversary',
        apiKeyStatus: 'set',           // can't be promoted by the client
        workspaceRoot: '/etc/secret',  // can't be retargeted by the client
        workspaceSource: 'env',
      });

    expect(res.status).toBe(200);
    // Echoed values come from the env-derived layer, not the body.
    expect(res.body.apiKeyStatus).toBe('unset');
    expect(res.body.workspaceRoot).not.toBe('/etc/secret');

    const onDisk = JSON.parse(readFileSync(userSettingsPath, 'utf8'));
    expect(onDisk.apiKeyStatus).toBeUndefined();
    expect(onDisk.workspaceRoot).toBeUndefined();
    expect(onDisk.workspaceSource).toBeUndefined();
  });

  it('PUT rejects an out-of-range enum with 400', async () => {
    const res = await request(app)
      .put('/api/user/settings')
      .send({ defaultTtsEngine: 'definitely-not-an-engine' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });
});
