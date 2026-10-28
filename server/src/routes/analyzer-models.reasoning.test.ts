import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let workspaceRoot: string;
let app: Express;
let server: Server;
let ollamaUrl: string;
let settings: typeof import('../workspace/user-settings.js');
const thinkValues: unknown[] = [];
/* A2 — the model build /api/tags reports; a test flips it to stand for a re-pulled tag. */
let tagDigest = 'sha256-build-a';
let savedOllamaUrl: string | undefined;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'w5a-models-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  delete process.env.GEMINI_API_KEY;
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/api/tags')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      /* A real /api/tags entry carries the build's digest (checked against a live daemon). */
      res.end(
        JSON.stringify({
          models: [
            { name: 'q:4b', model: 'q:4b', digest: tagDigest },
            { name: 'qwen3:latest', model: 'qwen3:latest', digest: tagDigest },
          ],
        }),
      );
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as { think?: unknown }) : {};
      thinkValues.push('think' in body ? body.think : '<absent>');
      if (body.think === true || typeof body.think === 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '"q:4b" does not support thinking' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(JSON.stringify({ message: { role: 'assistant', content: '{"ok":true}' }, done: true, done_reason: 'stop' }) + '\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  ollamaUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /* #3141: the `ollamaUrl` setting is retired; getResolvedOllamaUrl() reads OLLAMA_URL first. */
  savedOllamaUrl = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = ollamaUrl;
  const [{ analyzerModelsRouter }, s] = await Promise.all([import('./analyzer-models.js'), import('../workspace/user-settings.js')]);
  settings = s;
  app = express();
  app.use(express.json());
  app.use('/api/analyzer', analyzerModelsRouter); // W3c's router defines /models, /models/test, /models/preview
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  if (savedOllamaUrl === undefined) delete process.env.OLLAMA_URL;
  else process.env.OLLAMA_URL = savedOllamaUrl;
});
beforeEach(async () => {
  thinkValues.length = 0;
  tagDigest = 'sha256-build-a';
  settings._resetUserSettingsCache();
  await settings.writeUserSettings({ defaultAnalysisModel: 'q:4b' });
});

function findModelEntry(node: unknown, id: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) { for (const n of node) { const hit = findModelEntry(n, id); if (hit) return hit; } return undefined; }
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (o.id === id) return o;
    for (const v of Object.values(o)) { const hit = findModelEntry(v, id); if (hit) return hit; }
  }
  return undefined;
}

describe('Test action — reasoning', () => {
  it('scope all records named levels rejected by a non-thinking Ollama model, only after a successful control', async () => {
    const res = await request(app).post('/api/analyzer/models/test').send({ modelId: 'q:4b', scope: 'all' });
    expect(res.status).toBe(200);
    expect(res.body.control).toEqual({ ok: true });
    expect(res.body.reasoning).toEqual({ 'model-default': 'accepted', off: 'accepted', on: 'rejected', low: 'rejected', medium: 'rejected', high: 'rejected' });
    expect(thinkValues[0]).toBe(false); // the control request runs at Ollama's default level
  });

  it('keys the schema probe by the configured level', async () => {
    await settings.writeUserSettings({ analyzerReasoningByEngine: { ollama: { 'q:4b': 'model-default' } } });
    const res = await request(app).post('/api/analyzer/models/test').send({ modelId: 'q:4b', scope: 'configured' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.structuredOutput.schema ?? {})).toEqual(['model-default']);
  });

  it('the catalog offers named Ollama levels only after a Test accepted them', async () => {
    const before = await request(app).get('/api/analyzer/models?refresh=1');
    expect(findModelEntry(before.body, 'q:4b')?.offeredReasoningLevels).toEqual(['model-default', 'off', 'on']);
    settings._setUserSettingsCacheForTest({
      ...settings.getCachedUserSettings(),
      analyzerCapabilitiesByModel: {
        'q:4b': { serverUrl: ollamaUrl, testedAt: '2026-09-11T10:00:00.000Z', control: { ok: true }, structuredOutput: {}, reasoning: { low: 'accepted', high: 'rejected' } },
      },
    });
    const after = await request(app).get('/api/analyzer/models?refresh=1');
    expect(findModelEntry(after.body, 'q:4b')?.offeredReasoningLevels).toEqual(['model-default', 'off', 'on', 'low']);
  });

  it('a configured Test merges its verdicts into the record an earlier all Test wrote for the same server (N14)', async () => {
    settings._setUserSettingsCacheForTest({ ...settings.getCachedUserSettings(), analyzerCapabilitiesByModel: {} });
    await settings.writeUserSettings({ analyzerReasoningByEngine: {} }); // configured level = Ollama's default, off
    expect((await request(app).post('/api/analyzer/models/test').send({ modelId: 'q:4b', scope: 'all' })).status).toBe(200);
    const configured = await request(app).post('/api/analyzer/models/test').send({ modelId: 'q:4b', scope: 'configured' });
    expect(configured.status).toBe(200);
    expect(configured.body.reasoning).toEqual({ off: 'accepted' });
    const stored = (await settings.readUserSettings()).analyzerCapabilitiesByModel['q:4b'];
    expect(stored.reasoning).toEqual({ 'model-default': 'accepted', off: 'accepted', on: 'rejected', low: 'rejected', medium: 'rejected', high: 'rejected' });
    expect(stored.testedAt).toBe(configured.body.testedAt);
  });

  it('a Test record is saved under the normalised Ollama tag (N7)', async () => {
    settings._setUserSettingsCacheForTest({ ...settings.getCachedUserSettings(), analyzerCapabilitiesByModel: {} });
    const res = await request(app).post('/api/analyzer/models/test').send({ modelId: 'qwen3:latest', scope: 'configured' });
    expect(res.status).toBe(200);
    const records = (await settings.readUserSettings()).analyzerCapabilitiesByModel;
    expect(Object.keys(records)).toEqual(['qwen3']);
  });

  it('a Test whose digest (3c) differs from the stored record replaces it instead of merging, dropping verdicts never probed for the new build (A2)', async () => {
    settings._setUserSettingsCacheForTest({
      ...settings.getCachedUserSettings(),
      analyzerCapabilitiesByModel: {
        'q:4b': {
          serverUrl: ollamaUrl, testedAt: '2026-09-10T10:00:00.000Z', control: { ok: true }, structuredOutput: {},
          reasoning: { on: 'rejected', low: 'rejected' }, digest: 'sha256-build-old',
        },
      },
    });
    await settings.writeUserSettings({ analyzerReasoningByEngine: {} }); // configured level = Ollama's default, off
    const res = await request(app).post('/api/analyzer/models/test').send({ modelId: 'q:4b', scope: 'configured' });
    expect(res.status).toBe(200);
    expect(res.body.digest).toBe('sha256-build-a');
    const stored = (await settings.readUserSettings()).analyzerCapabilitiesByModel['q:4b'];
    /* The re-pulled build keeps no verdict it was never probed for. */
    expect(stored.reasoning).toEqual({ off: 'accepted' });
  });

  it('a record W3c saved under :latest is found, merged into and rewritten under the canonical tag, each verdict keeping its own date (A2, N7)', async () => {
    settings._setUserSettingsCacheForTest({
      ...settings.getCachedUserSettings(),
      analyzerCapabilitiesByModel: {
        'qwen3:latest': {
          serverUrl: ollamaUrl, testedAt: '2026-09-10T10:00:00.000Z', control: { ok: true }, structuredOutput: {},
          reasoning: { on: 'rejected' }, digest: 'sha256-build-a',
        },
      },
    });
    await settings.writeUserSettings({ analyzerReasoningByEngine: {} });
    expect((await request(app).post('/api/analyzer/models/test').send({ modelId: 'qwen3:latest', scope: 'configured' })).status).toBe(200);
    const records = (await settings.readUserSettings()).analyzerCapabilitiesByModel;
    expect(Object.keys(records)).toEqual(['qwen3']);
    expect(records.qwen3.reasoning).toEqual({ on: 'rejected', off: 'accepted' });
    expect(records.qwen3.verdictTestedAt?.reasoning?.on).toBe('2026-09-10T10:00:00.000Z');
  });
});
