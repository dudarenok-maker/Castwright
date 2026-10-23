/* #3084 P30 — PUT /api/config refuses an unusable fallback target at save, and writes nothing. */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';

let workspaceRoot: string;
let app: Express;
let settings: typeof import('../workspace/user-settings.js');
const lab = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 32768 });
const KEY = 'analyzer.fallback.target';

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-config-fallback-target-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  delete process.env.ANALYZER_FALLBACK_TARGET;
  delete process.env.GEMINI_API_KEY;
  const [{ configRouter }, s] = await Promise.all([import('./config.js'), import('../workspace/user-settings.js')]);
  settings = s;
  settings._resetUserSettingsCache();
  await settings.mutateUserSettings(() => ({ analyzerEndpoints: [lab] }));
  app = express();
  app.use(express.json());
  app.use('/api/config', configRouter);
});

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  settings._resetUserSettingsCache();
});

describe('PUT /api/config — analyzer.fallback.target (#3084 P30)', () => {
  it.each(['off', 'local', 'openai:lab::qwen3-30b'])('saves %s', async (value) => {
    const res = await request(app).put('/api/config').send({ [KEY]: value });
    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual([KEY]);
  });

  it('saves gemini when a key is set', async () => {
    process.env.GEMINI_API_KEY = 'k';
    expect((await request(app).put('/api/config').send({ [KEY]: 'gemini' })).status).toBe(200);
  });

  it('refuses gemini with no Gemini key, and writes nothing', async () => {
    await request(app).put('/api/config').send({ [KEY]: 'off' });
    const res = await request(app).put('/api/config').send({ [KEY]: 'gemini' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^analyzer\.fallback\.target: gemini needs a Gemini API key/);
    expect((await settings.readUserSettings()).configOverrides[KEY]).toBe('off');
  });

  it('refuses an endpoint that is not saved, and writes no other key from the same patch', async () => {
    const res = await request(app).put('/api/config').send({ [KEY]: 'openai:gone::m', 'analyzer.phase1.model': 'qwen3.5:9b' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no analyzer endpoint "gone" is saved/);
    expect((await settings.readUserSettings()).configOverrides['analyzer.phase1.model']).toBeUndefined();
  });

  it('refuses a malformed value with the shape error', async () => {
    const res = await request(app).put('/api/config').send({ [KEY]: 'openai:lab:m' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^analyzer\.fallback\.target: does not match the required shape/);
  });
});

describe('GET /api/config — analyzer.fallback.target shows the effective target (#3084 P30)', () => {
  afterEach(() => {
    delete process.env.OLLAMA_MODEL;
  });

  it('reports off, with a source note, when only the legacy allowCloudFallback false applies', async () => {
    await settings.mutateUserSettings(() => ({ allowCloudFallback: false, configOverrides: {} }));
    const v = (await request(app).get('/api/config')).body.values[KEY];
    expect(v).toMatchObject({ effective: 'off', source: 'default', overridden: false });
    expect(v.analyzerEngine.sourceNote).toMatch(/old Model Manager "Cloud fallback" switch/);
  });

  it('labels local with the model a local selection resolves to, and gemini with no key as inactive', async () => {
    await settings.mutateUserSettings(() => ({ allowCloudFallback: true, defaultAnalysisModel: 'openai:lab::qwen3-30b', configOverrides: {} }));
    const v = (await request(app).get('/api/config')).body.values[KEY];
    expect(v.effective).toBe('gemini');
    expect(v.analyzerEngine).toEqual({
      localModel: 'qwen3.5:4b',
      optionLabels: { off: 'Off', local: 'Local Ollama — qwen3.5:4b', gemini: 'Gemini — no API key, fallback inactive' },
    });
  });

  it('labels gemini with its model when a key is set, and the PUT response carries the same state', async () => {
    process.env.GEMINI_API_KEY = 'k';
    const res = await request(app).put('/api/config').send({ [KEY]: 'local' });
    expect(res.body.values[KEY].effective).toBe('local');
    expect(res.body.values[KEY].analyzerEngine.optionLabels.gemini).toBe('Gemini — gemini-3.5-flash-lite');
  });
});
