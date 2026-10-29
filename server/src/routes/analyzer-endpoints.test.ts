/* Integration test for the analyzer endpoint routes (#3084 PR 3b), mirroring
   routes/user-settings.test.ts: real express, real user-settings file under a
   temp workspace, supertest. */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let workspaceRoot: string;
let app: Express;
let userSettingsPath: string;
let resetCache: () => void;

const lab = { id: 'lab', name: 'Lab box', baseUrl: 'http://127.0.0.1:8080/v1', contextTokens: 32768 };

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-analyzer-endpoints-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ analyzerEndpointsRouter }, { userSettingsRouter }, settings] = await Promise.all([
    import('./analyzer-endpoints.js'),
    import('./user-settings.js'),
    import('../workspace/user-settings.js'),
  ]);
  userSettingsPath = settings.USER_SETTINGS_PATH;
  resetCache = settings._resetUserSettingsCache;
  app = express();
  app.use(express.json());
  app.use('/api/user/settings', userSettingsRouter);
  app.use('/api/analyzer/endpoints', analyzerEndpointsRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  if (userSettingsPath && existsSync(userSettingsPath)) rmSync(userSettingsPath, { force: true });
  resetCache();
});

describe('POST /api/analyzer/endpoints', () => {
  it('creates an endpoint with contract defaults and answers with the settings shape', async () => {
    const res = await request(app).post('/api/analyzer/endpoints').send(lab);
    expect(res.status).toBe(201);
    expect(res.body.analyzerEndpoints).toEqual([
      expect.objectContaining({ ...lab, gpu: 'any', concurrency: 1, requestCeilingMs: 1_800_000, structuredOutput: 'schema' }),
    ]);
    expect(res.body.analyzerEndpointKeyStatus).toEqual({ lab: 'unset' });
  });

  it('defaults gpu to none for a non-loopback host', async () => {
    const res = await request(app).post('/api/analyzer/endpoints').send({ ...lab, baseUrl: 'http://192.168.1.20:8080/v1' });
    expect(res.body.analyzerEndpoints[0].gpu).toBe('none');
  });

  it('refuses an ftp: base URL with 400 naming baseUrl (#3525 review)', async () => {
    const res = await request(app).post('/api/analyzer/endpoints').send({ ...lab, baseUrl: 'ftp://lab/v1' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid');
    expect(res.body.issues.some((i: { path: string[] }) => i.path.join('.') === 'baseUrl')).toBe(true);
  });

  it('refuses a missing context size with 400 naming contextTokens (F5: {error, issues})', async () => {
    const noContext = { id: lab.id, name: lab.name, baseUrl: lab.baseUrl };
    const res = await request(app).post('/api/analyzer/endpoints').send(noContext);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid');
    expect(res.body.issues.some((i: { path: string[] }) => i.path.join('.') === 'contextTokens')).toBe(true);
  });

  it('refuses a bad base URL with 400 and never echoes it in the response body (F5 no-echo)', async () => {
    const badUrl = 'http://[not-a-real-host/v1';
    const res = await request(app).post('/api/analyzer/endpoints').send({ ...lab, baseUrl: badUrl });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid');
    expect(JSON.stringify(res.body)).not.toContain(badUrl);
  });

  it('refuses a bad endpoint id with 400', async () => {
    const res = await request(app).post('/api/analyzer/endpoints').send({ ...lab, id: 'Lab_1' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid');
  });

  it('refuses a duplicate id with 409', async () => {
    await request(app).post('/api/analyzer/endpoints').send(lab);
    const res = await request(app).post('/api/analyzer/endpoints').send(lab);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('duplicate-id');
  });

  it('refuses an off-origin unload URL with 400', async () => {
    const res = await request(app)
      .post('/api/analyzer/endpoints')
      .send({ ...lab, unloadUrl: 'http://127.0.0.1:9999/api/models/unload/{model}' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unload-off-origin');
  });

  it('accepts a custom payload on create and update, validated by validateExtraParams', async () => {
    const created = await request(app).post('/api/analyzer/endpoints').send({ ...lab, extraParams: { top_k: 20 } });
    expect(created.status).toBe(201);
    const updated = await request(app).put('/api/analyzer/endpoints/lab').send({ ...lab, extraParams: { top_k: 20, min_p: 0.05 } });
    expect(updated.status).toBe(200);
    expect(JSON.parse(readFileSync(userSettingsPath, 'utf8')).analyzerEndpoints[0].extraParams).toEqual({ top_k: 20, min_p: 0.05 });
  });

  it('update refuses a protected endpoint payload key', async () => {
    await request(app).post('/api/analyzer/endpoints').send({ id: 'lab2', name: 'Lab 2', baseUrl: 'http://127.0.0.1:8082/v1', gpu: 'any', contextTokens: 32768 });
    const res = await request(app).put('/api/analyzer/endpoints/lab2').send({
      id: 'lab2', name: 'Lab 2', baseUrl: 'http://127.0.0.1:8082/v1', gpu: 'any', contextTokens: 32768, extraParams: { response_format: { type: 'text' } },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('cannot be set here: response_format');
  });

  it('accepts a reasoning level its control style offers on create and update, validated by the 5a rules', async () => {
    const created = await request(app).post('/api/analyzer/endpoints').send({ ...lab, reasoningStyle: 'reasoning_effort', reasoning: 'high' });
    expect(created.status).toBe(201);
    expect(created.body.analyzerEndpoints[0]).toMatchObject({ reasoningStyle: 'reasoning_effort', reasoning: 'high' });
    const updated = await request(app).put('/api/analyzer/endpoints/lab').send({ ...lab, reasoningStyle: 'enable_thinking', reasoning: 'off' });
    expect(updated.status).toBe(200);
    expect(JSON.parse(readFileSync(userSettingsPath, 'utf8')).analyzerEndpoints[0]).toMatchObject({ reasoningStyle: 'enable_thinking', reasoning: 'off' });
  });

  it('create refuses a reasoning level its control style does not offer', async () => {
    const res = await request(app).post('/api/analyzer/endpoints').send({ ...lab, reasoningStyle: 'reasoning_effort', reasoning: 'on' });
    expect(res.status).toBe(400);
    expect(res.body.issues[0].message).toContain('Reasoning "on" is not offered by the reasoning_effort control style');
  });

  it('keeps both endpoints when two creates race', async () => {
    await Promise.all([
      request(app).post('/api/analyzer/endpoints').send(lab),
      request(app).post('/api/analyzer/endpoints').send({ ...lab, id: 'lab2' }),
    ]);
    const res = await request(app).get('/api/user/settings');
    expect(res.body.analyzerEndpoints.map((e: { id: string }) => e.id).sort()).toEqual(['lab', 'lab2']);
  });
});

describe('PUT /api/analyzer/endpoints/:id and the key route', () => {
  it('stores a key bound to the base URL origin, never echoes it, and marks it on a host change', async () => {
    await request(app).post('/api/analyzer/endpoints').send(lab);
    const keyRes = await request(app).put('/api/analyzer/endpoints/lab/key').send({ key: 'sk-route-secret-1234' });
    expect(keyRes.status).toBe(200);
    expect(keyRes.body.analyzerEndpointKeyStatus).toEqual({ lab: 'set' });
    expect(JSON.stringify(keyRes.body)).not.toContain('sk-route-secret-1234');
    const onDisk = JSON.parse(readFileSync(userSettingsPath, 'utf8'));
    expect(onDisk.analyzerEndpointKeys.lab).toEqual({ origin: 'http://127.0.0.1:8080', key: 'sk-route-secret-1234' });

    const moved = await request(app)
      .put('/api/analyzer/endpoints/lab')
      .send({ ...lab, baseUrl: 'http://127.0.0.1:9090/v1' });
    expect(moved.status).toBe(200);
    expect(moved.body.analyzerEndpointKeyStatus).toEqual({ lab: 'origin-mismatch' });

    const cleared = await request(app).put('/api/analyzer/endpoints/lab/key').send({ key: null });
    expect(cleared.body.analyzerEndpointKeyStatus).toEqual({ lab: 'unset' });
  });

  it('404s an unknown endpoint for update and key write; 400s a changed id', async () => {
    expect((await request(app).put('/api/analyzer/endpoints/nope').send(lab)).status).toBe(404);
    expect((await request(app).put('/api/analyzer/endpoints/nope/key').send({ key: 'k' })).status).toBe(404);
    await request(app).post('/api/analyzer/endpoints').send(lab);
    expect((await request(app).put('/api/analyzer/endpoints/lab').send({ ...lab, id: 'other' })).status).toBe(400);
  });

  it('400s a key payload that is not { key: string | null }', async () => {
    await request(app).post('/api/analyzer/endpoints').send(lab);
    expect((await request(app).put('/api/analyzer/endpoints/lab/key').send({ key: 42 })).status).toBe(400);
  });

  it('refuses a key containing a control character with 400 naming the rule, never echoing or storing it (P22)', async () => {
    await request(app).post('/api/analyzer/endpoints').send(lab);
    const ctl = (code: number) => String.fromCharCode(code);
    for (const key of ['sk-route-crlf-1\r\nX-Injected: 1', `sk-route-nul-1${ctl(0x00)}x`, `sk-route-c1-1${ctl(0x85)}x`]) {
      const res = await request(app).put('/api/analyzer/endpoints/lab/key').send({ key });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'invalid',
        error: 'An API key cannot contain control characters (such as a line break, tab or NUL). Paste the key again without them.',
      });
      expect(JSON.stringify(res.body)).not.toContain('sk-route-');
    }
    expect(readFileSync(userSettingsPath, 'utf8')).not.toContain('sk-route-');
  });
});

describe('redactedFailureLine (#3084 P22)', () => {
  it('logs the error name and message with known secrets removed, never its stack or cause chain', async () => {
    const { redactedFailureLine } = await import('./analyzer-endpoints.js');
    const err = Object.assign(new Error('write failed near sk-route-log-secret-1'), { cause: new Error('inner sk-route-cause-secret-1') });
    expect(redactedFailureLine('save the analyzer endpoint key', err, ['sk-route-log-secret-1'])).toBe(
      '[analyzer-endpoints] save the analyzer endpoint key failed: Error: write failed near [redacted]',
    );
  });
});

describe('DELETE /api/analyzer/endpoints/:id', () => {
  it('is refused with 409 while a saved setting references the endpoint, listing each reference', async () => {
    /* Seeded on disk, not through PUT /api/user/settings: that PUT refuses endpoint
       ids until PR 3d (P23, Task 3a.5). A file written before PR 3d, or by PR 3d
       itself, is exactly what this refusal protects.

       #3084 A5 (re-pin to 80be2f1d) — analyzerPhase0Model is no longer a settings
       field: #3192's read-time migration moves a saved phase model into
       configOverrides['analyzer.phase0.model'], and findEndpointReferences (Task
       3b.5) classifies it through MODEL_ID_CONFIG_KNOBS. So the refusal names the
       Advanced setting, not the retired Account-setting field — the plan's original
       expectation ("Account setting \"analyzerPhase0Model\"") predates the re-pin.
       This mirrors the canonical workspace/analyzer-endpoints.test.ts delete case. */
    writeFileSync(
      userSettingsPath,
      JSON.stringify({
        analyzerEndpoints: [{ ...lab, gpu: 'any' }],
        analyzerPhase0Model: 'openai:lab::qwen3:30b',
        configOverrides: { 'analyzer.phase1.model': 'openai:lab::m' },
      }),
    );
    resetCache();
    const res = await request(app).delete('/api/analyzer/endpoints/lab');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('referenced');
    expect(res.body.issues).toEqual([
      { path: [], message: 'Advanced setting "analyzer.phase0.model"' },
      { path: [], message: 'Advanced setting "analyzer.phase1.model"' },
    ]);
  });

  it('deletes the endpoint and its key once nothing references it', async () => {
    await request(app).post('/api/analyzer/endpoints').send(lab);
    await request(app).put('/api/analyzer/endpoints/lab/key').send({ key: 'sk-route-secret-1234' });
    const res = await request(app).delete('/api/analyzer/endpoints/lab');
    expect(res.status).toBe(200);
    expect(res.body.analyzerEndpoints).toEqual([]);
    expect(readFileSync(userSettingsPath, 'utf8')).not.toContain('sk-route-secret-1234');
  });

  it('404s an unknown endpoint', async () => {
    expect((await request(app).delete('/api/analyzer/endpoints/nope')).status).toBe(404);
  });
});
