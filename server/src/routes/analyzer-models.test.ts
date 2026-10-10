import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnalysisAbortedError, AnalyzerEndpointMissingError, AnalyzerKeyOriginError } from '../analyzer/errors.js';

const h = vi.hoisted(() => ({
  buildAnalyzerCatalog: vi.fn(),
  previewEndpointModels: vi.fn(),
  modelTestDepsFor: vi.fn(),
  runModelTest: vi.fn(),
  writeAnalyzerCapabilityRecord: vi.fn(),
  readUserSettings: vi.fn(),
}));

vi.mock('../analyzer/catalog/analyzer-catalog.js', () => ({
  buildAnalyzerCatalog: h.buildAnalyzerCatalog,
  previewEndpointModels: h.previewEndpointModels,
}));
vi.mock('../analyzer/model-test-deps.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analyzer/model-test-deps.js')>()),
  modelTestDepsFor: h.modelTestDepsFor,
}));
vi.mock('../analyzer/capabilities.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analyzer/capabilities.js')>()),
  runModelTest: h.runModelTest,
}));
vi.mock('../workspace/user-settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace/user-settings.js')>()),
  readUserSettings: h.readUserSettings,
  writeAnalyzerCapabilityRecord: h.writeAnalyzerCapabilityRecord,
}));

const { analyzerModelsRouter } = await import('./analyzer-models.js');
const { DEFAULT_USER_SETTINGS } = await import('../workspace/user-settings.js');
const { ModelTestControlFailedError, ModelTestInconclusiveError } = await import('../analyzer/capabilities.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/analyzer', analyzerModelsRouter);
  return app;
}

const RECORD = {
  serverUrl: 'http://127.0.0.1:8080/v1',
  testedAt: '2026-09-11T10:00:00.000Z',
  control: { ok: true },
  structuredOutput: { schema: { 'model-default': 'ignored' } },
  reasoning: {},
};

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.readUserSettings.mockResolvedValue({
    ...DEFAULT_USER_SETTINGS,
    analyzerEndpoints: [],
    analyzerEndpointKeys: { lab: { origin: 'http://127.0.0.1:8080', key: 'sk-stored' } },
  });
});

describe('GET /api/analyzer/models', () => {
  it('passes refresh=1 through and returns the catalog', async () => {
    h.buildAnalyzerCatalog.mockResolvedValue({ groups: [] });
    const res = await request(makeApp()).get('/api/analyzer/models?refresh=1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groups: [] });
    expect(h.buildAnalyzerCatalog).toHaveBeenCalledWith({ refresh: true });
  });

  it('defaults refresh to false', async () => {
    h.buildAnalyzerCatalog.mockResolvedValue({ groups: [] });
    await request(makeApp()).get('/api/analyzer/models');
    expect(h.buildAnalyzerCatalog).toHaveBeenCalledWith({ refresh: false });
  });

  it('logs a catalog failure without a saved secret (P22)', async () => {
    process.env.GEMINI_API_KEY = 'gk-route-secret-0001';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      h.buildAnalyzerCatalog.mockRejectedValue(new Error('boom gk-route-secret-0001'));
      const res = await request(makeApp()).get('/api/analyzer/models');
      expect(res.status).toBe(500);
      const logged = error.mock.calls.flat().map(String).join('\n');
      expect(logged).toContain('[redacted]');
      expect(logged).not.toContain('gk-route-secret-0001');
    } finally {
      error.mockRestore();
      delete process.env.GEMINI_API_KEY;
    }
  });
});

describe('POST /api/analyzer/models/test', () => {
  it('runs the test, persists the record and returns it', async () => {
    const deps = { transport: {} };
    h.modelTestDepsFor.mockReturnValue(deps);
    h.runModelTest.mockResolvedValue(RECORD);
    const res = await request(makeApp()).post('/api/analyzer/models/test').send({ modelId: 'openai:lab::m', scope: 'all' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(RECORD);
    expect(h.runModelTest).toHaveBeenCalledWith(
      { modelId: 'openai:lab::m', scope: 'all' },
      expect.objectContaining({ transport: deps.transport, signal: expect.any(AbortSignal) }),
    );
    expect(h.writeAnalyzerCapabilityRecord).toHaveBeenCalledWith('openai:lab::m', RECORD);
  });

  it('400 on a bad scope', async () => {
    const res = await request(makeApp()).post('/api/analyzer/models/test').send({ modelId: 'm', scope: 'everything' });
    expect(res.status).toBe(400);
  });

  it('404 analyzer-endpoint-missing for a deleted endpoint', async () => {
    h.modelTestDepsFor.mockImplementation(() => {
      throw new AnalyzerEndpointMissingError('gone', 'settings');
    });
    const res = await request(makeApp()).post('/api/analyzer/models/test').send({ modelId: 'openai:gone::m', scope: 'configured' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('analyzer-endpoint-missing');
  });

  it('401 auth for a key bound to another host', async () => {
    h.modelTestDepsFor.mockImplementation(() => {
      throw new AnalyzerKeyOriginError('lab', 'Lab');
    });
    const res = await request(makeApp()).post('/api/analyzer/models/test').send({ modelId: 'openai:lab::m', scope: 'configured' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('auth');
  });

  it('a failed control answers 502 outcome failed and keeps the previous record (nothing written)', async () => {
    h.modelTestDepsFor.mockReturnValue({});
    h.runModelTest.mockRejectedValue(new ModelTestControlFailedError('openai:lab::m', 'HTTP 503 loading model.'));
    const res = await request(makeApp()).post('/api/analyzer/models/test').send({ modelId: 'openai:lab::m', scope: 'configured' });
    expect(res.status).toBe(502);
    expect(res.body.outcome).toBe('failed');
    expect(res.body.error).toContain('control request');
    expect(h.writeAnalyzerCapabilityRecord).not.toHaveBeenCalled();
  });

  it('an inconclusive step answers 502 outcome inconclusive and writes nothing', async () => {
    h.modelTestDepsFor.mockReturnValue({});
    h.runModelTest.mockRejectedValue(new ModelTestInconclusiveError('openai:lab::m', 'schema', 'finish=length'));
    const res = await request(makeApp()).post('/api/analyzer/models/test').send({ modelId: 'openai:lab::m', scope: 'configured' });
    expect(res.status).toBe(502);
    expect(res.body.outcome).toBe('inconclusive');
    expect(h.writeAnalyzerCapabilityRecord).not.toHaveBeenCalled();
  });

  it('a 502 never returns a saved key the provider echoed (P22)', async () => {
    h.modelTestDepsFor.mockReturnValue({});
    h.runModelTest.mockRejectedValue(new Error('upstream rejected Bearer sk-stored'));
    const res = await request(makeApp()).post('/api/analyzer/models/test').send({ modelId: 'openai:lab::m', scope: 'configured' });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('[redacted]');
    expect(res.body.error).not.toContain('sk-stored');
  });

  it('a client that disconnects aborts the running test, and nothing is written', async () => {
    h.modelTestDepsFor.mockReturnValue({ transport: {} });
    let seenSignal: AbortSignal | undefined;
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    h.runModelTest.mockImplementation((_input: unknown, d: { signal: AbortSignal }) => {
      seenSignal = d.signal;
      started();
      return new Promise((_resolve, reject) => d.signal.addEventListener('abort', () => reject(new AnalysisAbortedError('cancelled'))));
    });
    const server = makeApp().listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    try {
      const { port } = server.address() as AddressInfo;
      const body = JSON.stringify({ modelId: 'openai:lab::m', scope: 'configured' });
      const clientReq = httpRequest({
        host: '127.0.0.1',
        port,
        path: '/api/analyzer/models/test',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      });
      clientReq.on('error', () => {});
      clientReq.end(body);
      await running;
      clientReq.destroy();
      await vi.waitFor(() => expect(seenSignal?.aborted).toBe(true));
      await new Promise((r) => setImmediate(r));
      expect(h.writeAnalyzerCapabilityRecord).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('POST /api/analyzer/models/preview', () => {
  it('uses the stored key only when its origin matches the previewed base URL', async () => {
    h.previewEndpointModels.mockResolvedValue({ status: 'ok', models: [] });
    await request(makeApp()).post('/api/analyzer/models/preview').send({ baseUrl: 'http://127.0.0.1:8080/v1', endpointId: 'lab' });
    expect(h.previewEndpointModels).toHaveBeenLastCalledWith({ baseUrl: 'http://127.0.0.1:8080/v1', apiKey: 'sk-stored' });
    await request(makeApp()).post('/api/analyzer/models/preview').send({ baseUrl: 'http://10.0.0.5:8080/v1', endpointId: 'lab' });
    expect(h.previewEndpointModels).toHaveBeenLastCalledWith({ baseUrl: 'http://10.0.0.5:8080/v1', apiKey: null });
  });

  it('a typed key wins and is never echoed back', async () => {
    h.previewEndpointModels.mockResolvedValue({ status: 'ok', models: [{ model: 'm', contextTokens: 8192 }], suggestedContextTokens: 8192 });
    const res = await request(makeApp()).post('/api/analyzer/models/preview').send({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-typed' });
    expect(h.previewEndpointModels).toHaveBeenLastCalledWith({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-typed' });
    expect(JSON.stringify(res.body)).not.toContain('sk-typed');
  });
});
