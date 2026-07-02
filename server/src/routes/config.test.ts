/* Integration tests for GET /api/config, PUT /api/config, POST /api/config/reset,
   and the prompt endpoints (GET/PUT /api/config/prompts/:id,
   POST /api/config/prompts/:id/reset).

   Test isolation: we point USER_SETTINGS_FILE at a throwaway temp file (same
   approach as user-settings.test.ts) so writes never touch real settings, then
   call _resetUserSettingsCache() between tests so the in-process cache is
   cold on every run. The configRouter import is dynamic (after env is set) to
   ensure the module's singleton import of user-settings sees the temp path.
   CASTWRIGHT_PROMPTS_DIR is also overridden so fork files land in the temp dir. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let workspaceRoot: string;
let settingsPath: string;
let app: Express;
let resetCache: () => void;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'castwright-config-route-test-'));
  settingsPath = join(workspaceRoot, 'user-settings.json');
  process.env.USER_SETTINGS_FILE = settingsPath;
  process.env.CASTWRIGHT_PROMPTS_DIR = join(workspaceRoot, 'prompts');

  // Import AFTER setting env so user-settings.ts resolves to the temp path
  const [{ configRouter }, us] = await Promise.all([
    import('./config.js'),
    import('../workspace/user-settings.js'),
  ]);

  resetCache = us._resetUserSettingsCache;

  app = express();
  app.use(express.json());
  app.use('/api/config', configRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.USER_SETTINGS_FILE;
  delete process.env.CASTWRIGHT_PROMPTS_DIR;
  delete process.env.STAGE2_MIN_COVERAGE;
});

beforeEach(() => {
  // Wipe settings file and cache so each test starts fresh
  if (settingsPath && existsSync(settingsPath)) {
    rmSync(settingsPath, { force: true });
  }
  resetCache?.();
  delete process.env.STAGE2_MIN_COVERAGE;
});

describe('GET /api/config', () => {
  it('returns groups + descriptors + values', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.groups)).toBe(true);
    expect(res.body.descriptors.length).toBeGreaterThan(20);
    expect(res.body.values['analyzer.stage2.minCoverage'].effective).toBeDefined();
    expect(res.body.values['GEMINI_API_KEY']).toBeUndefined(); // secret never present
  });

  it('prompts are excluded from values', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    // Prompt keys have isPrompt=true — resolver skips them
    expect(res.body.values['prompt.castDetection']).toBeUndefined();
  });

  it('restartPending is false by default', async () => {
    const res = await request(app).get('/api/config');
    expect(res.body.restartPending).toBe(false);
  });
});

describe('PUT /api/config', () => {
  it('validates range and rejects out-of-bounds', async () => {
    const ok = await request(app).put('/api/config').send({ 'analyzer.stage2.minCoverage': 0.5 });
    expect(ok.status).toBe(200);
    const bad = await request(app).put('/api/config').send({ 'analyzer.stage2.minCoverage': 9 });
    expect(bad.status).toBe(400);
  });

  it('PUT rejects an env-locked key with 409', async () => {
    process.env.STAGE2_MIN_COVERAGE = '0.7';
    const res = await request(app).put('/api/config').send({ 'analyzer.stage2.minCoverage': 0.5 });
    expect(res.status).toBe(409);
    delete process.env.STAGE2_MIN_COVERAGE;
  });

  it('PUT rejects an unknown key with 400', async () => {
    const res = await request(app).put('/api/config').send({ 'no.such.knob': 1 });
    expect(res.status).toBe(400);
  });

  it('PUT rejects a prompt key with 400', async () => {
    const res = await request(app).put('/api/config').send({ 'prompt.castDetection': 'some-path.md' });
    expect(res.status).toBe(400);
  });

  it('PUT applies and reflects override in values', async () => {
    const res = await request(app).put('/api/config').send({ 'analyzer.stage2.minCoverage': 0.5 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.applied).toContain('analyzer.stage2.minCoverage');
    expect(res.body.values['analyzer.stage2.minCoverage'].effective).toBe(0.5);
    expect(res.body.values['analyzer.stage2.minCoverage'].overridden).toBe(true);
  });
});

describe('POST /api/config/reset', () => {
  it('reset by key clears the override', async () => {
    await request(app).put('/api/config').send({ 'analyzer.stage2.minCoverage': 0.5 });
    const res = await request(app).post('/api/config/reset').send({ keys: ['analyzer.stage2.minCoverage'] });
    expect(res.status).toBe(200);
    const after = await request(app).get('/api/config');
    expect(after.body.values['analyzer.stage2.minCoverage'].overridden).toBe(false);
  });

  it('reset by group clears all overrides in that group', async () => {
    await request(app).put('/api/config').send({ 'analyzer.stage2.minCoverage': 0.5 });
    await request(app).put('/api/config').send({ 'analyzer.stage2.maxCoverage': 2.0 });
    const res = await request(app).post('/api/config/reset').send({ group: 'analyzer-chunking' });
    expect(res.status).toBe(200);
    const after = await request(app).get('/api/config');
    expect(after.body.values['analyzer.stage2.minCoverage'].overridden).toBe(false);
    expect(after.body.values['analyzer.stage2.maxCoverage'].overridden).toBe(false);
  });

  it('reset all clears every override', async () => {
    await request(app).put('/api/config').send({ 'analyzer.stage2.minCoverage': 0.5 });
    const res = await request(app).post('/api/config/reset').send({ all: true });
    expect(res.status).toBe(200);
    const after = await request(app).get('/api/config');
    expect(after.body.values['analyzer.stage2.minCoverage'].overridden).toBe(false);
  });

  it('reset with no spec returns 400', async () => {
    const res = await request(app).post('/api/config/reset').send({});
    expect(res.status).toBe(400);
  });
});

describe('GET /api/config/prompts/:id', () => {
  it('returns the shipped default before any fork', async () => {
    const res = await request(app).get('/api/config/prompts/prompt.sentenceAttribution');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('prompt.sentenceAttribution');
    expect(res.body.isForked).toBe(false);
    expect(typeof res.body.text).toBe('string');
    expect(res.body.text.length).toBeGreaterThan(0);
    expect(res.body.text).toBe(res.body.defaultText);
  });

  it('returns 404 for an unknown prompt id', async () => {
    const res = await request(app).get('/api/config/prompts/prompt.doesNotExist');
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/config/prompts/:id', () => {
  it('fork via PUT then GET shows isForked:true with the forked text', async () => {
    const putRes = await request(app)
      .put('/api/config/prompts/prompt.castDetection')
      .send({ text: 'MY FORKED PROMPT TEXT' });
    expect(putRes.status).toBe(200);
    expect(putRes.body.ok).toBe(true);
    expect(putRes.body.isForked).toBe(true);
    expect(putRes.body.text).toBe('MY FORKED PROMPT TEXT');

    const getRes = await request(app).get('/api/config/prompts/prompt.castDetection');
    expect(getRes.status).toBe(200);
    expect(getRes.body.isForked).toBe(true);
    expect(getRes.body.text).toBe('MY FORKED PROMPT TEXT');
  });

  it('PUT returns 404 for unknown id', async () => {
    const res = await request(app)
      .put('/api/config/prompts/prompt.nope')
      .send({ text: 'something' });
    expect(res.status).toBe(404);
  });

  it('PUT returns 400 when text is missing', async () => {
    const res = await request(app)
      .put('/api/config/prompts/prompt.castDetection')
      .send({});
    expect(res.status).toBe(400);
  });

  it('PUT returns 400 when text is empty string', async () => {
    const res = await request(app)
      .put('/api/config/prompts/prompt.castDetection')
      .send({ text: '' });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/config — device knob UUID translation (Plan 2 §2.1)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Mirrors gpu-devices.test.ts's fetch-stub convention: this file has no
  // existing device-knob test / mock plumbing to reuse, and writeConfigOverride
  // here is the REAL file-backed implementation (no mock) — so we assert the
  // persisted value via readConfigOverrides() rather than a spy.
  function mockGpuDevices(devices: Array<{ uuid: string; idx: number; name?: string; total_mb?: number; free_mb?: number }>) {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ devices, cpu: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }

  it('translates a cuda:N write into cuda-uuid:<uuid> before persisting', async () => {
    mockGpuDevices([{ uuid: 'GPU-1', idx: 1, name: 'x', total_mb: 16000, free_mb: 14000 }]);
    const res = await request(app).put('/api/config').send({ 'tts.qwen.device': 'cuda:1' });
    expect(res.status).toBe(200);
    const { readConfigOverrides } = await import('../workspace/user-settings.js');
    expect(readConfigOverrides()['tts.qwen.device']).toBe('cuda-uuid:GPU-1');
  });

  it('stores the raw cuda:N when the sidecar device list has no match yet (reconciled on next read)', async () => {
    mockGpuDevices([]);
    const res = await request(app).put('/api/config').send({ 'tts.qwen.device': 'cuda:9' });
    expect(res.status).toBe(200);
    const { readConfigOverrides } = await import('../workspace/user-settings.js');
    expect(readConfigOverrides()['tts.qwen.device']).toBe('cuda:9');
  });

  it('leaves auto/cpu/mps values untouched', async () => {
    const res = await request(app).put('/api/config').send({ 'tts.qwen.device': 'auto' });
    expect(res.status).toBe(200);
    const { readConfigOverrides } = await import('../workspace/user-settings.js');
    expect(readConfigOverrides()['tts.qwen.device']).toBe('auto');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/config/prompts/:id/reset', () => {
  it('fork then reset clears the fork — GET shows isForked:false', async () => {
    // Fork it first.
    await request(app)
      .put('/api/config/prompts/prompt.emotionAnnotation')
      .send({ text: 'FORKED' });
    let getRes = await request(app).get('/api/config/prompts/prompt.emotionAnnotation');
    expect(getRes.body.isForked).toBe(true);

    // Reset.
    const resetRes = await request(app).post(
      '/api/config/prompts/prompt.emotionAnnotation/reset',
    );
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.ok).toBe(true);
    expect(resetRes.body.isForked).toBe(false);

    // GET after reset should be unforked.
    getRes = await request(app).get('/api/config/prompts/prompt.emotionAnnotation');
    expect(getRes.status).toBe(200);
    expect(getRes.body.isForked).toBe(false);
  });

  it('reset returns 404 for unknown id', async () => {
    const res = await request(app).post('/api/config/prompts/prompt.nope/reset');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/config — CUDA env-shadow surfacing (Plan 2 §2.5)', () => {
  const prevCVD = process.env.CUDA_VISIBLE_DEVICES;
  const prevCDO = process.env.CUDA_DEVICE_ORDER;
  afterEach(() => {
    if (prevCVD === undefined) delete process.env.CUDA_VISIBLE_DEVICES; else process.env.CUDA_VISIBLE_DEVICES = prevCVD;
    if (prevCDO === undefined) delete process.env.CUDA_DEVICE_ORDER; else process.env.CUDA_DEVICE_ORDER = prevCDO;
  });

  it('reports cudaEnvShadow true when CUDA_VISIBLE_DEVICES is set', async () => {
    process.env.CUDA_VISIBLE_DEVICES = '1,0';
    delete process.env.CUDA_DEVICE_ORDER;
    const res = await request(app).get('/api/config');
    expect(res.body.cudaEnvShadow).toBe(true);
  });

  it('reports cudaEnvShadow false when neither var is set', async () => {
    delete process.env.CUDA_VISIBLE_DEVICES;
    delete process.env.CUDA_DEVICE_ORDER;
    const res = await request(app).get('/api/config');
    expect(res.body.cudaEnvShadow).toBe(false);
  });
});
