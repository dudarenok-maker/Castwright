import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let workspaceRoot: string;
let app: Express;
let userSettingsPath: string;
let resetCache: () => void;
const servers: Server[] = [];
let hits: Array<{ port: number; url: string; auth: string | undefined }> = [];

async function upstream(): Promise<string> {
  const s = createServer((req, res) => {
    const port = (s.address() as { port: number }).port;
    hits.push({ port, url: req.url ?? '', auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ default_generation_settings: { n_ctx: 16384 } }));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-detect-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ analyzerEndpointsRouter }, settings] = await Promise.all([
    import('./analyzer-endpoints.js'),
    import('../workspace/user-settings.js'),
  ]);
  userSettingsPath = settings.USER_SETTINGS_PATH;
  resetCache = settings._resetUserSettingsCache;
  app = express();
  app.use(express.json());
  app.use('/api/analyzer/endpoints', analyzerEndpointsRouter);
});

beforeEach(() => {
  hits = [];
  if (userSettingsPath && existsSync(userSettingsPath)) rmSync(userSettingsPath, { force: true });
  resetCache();
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.closeAllConnections();
          s.close(() => r());
        }),
    ),
  );
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('POST /api/analyzer/endpoints/detect-context (#3084 PR 3b)', () => {
  it('llama.cpp: returns the served context', async () => {
    const origin = await upstream();
    const res = await request(app).post('/api/analyzer/endpoints/detect-context').send({ baseUrl: `${origin}/v1`, flavor: 'llama.cpp' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ contextTokens: 16384, source: 'llama.cpp /props' });
  });

  it('llama-swap without allowModelLoad is refused and never contacts the server', async () => {
    const origin = await upstream();
    const res = await request(app)
      .post('/api/analyzer/endpoints/detect-context')
      .send({ baseUrl: `${origin}/v1`, flavor: 'llama-swap', model: 'qwen3:30b' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('model-load-confirmation-required');
    expect(hits).toHaveLength(0);
  });

  it('llama-swap without a model is refused', async () => {
    const origin = await upstream();
    const res = await request(app)
      .post('/api/analyzer/endpoints/detect-context')
      .send({ baseUrl: origin, flavor: 'llama-swap', allowModelLoad: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('model-required');
  });

  it('sends a stored key only to its own origin; a mismatch is refused as auth without a request', async () => {
    const home = await upstream();
    const elsewhere = await upstream();
    await request(app).post('/api/analyzer/endpoints').send({ id: 'lab', name: 'Lab', baseUrl: `${home}/v1`, contextTokens: 4096 });
    await request(app).put('/api/analyzer/endpoints/lab/key').send({ key: 'sk-stored-secret-1' });

    const ok = await request(app)
      .post('/api/analyzer/endpoints/detect-context')
      .send({ baseUrl: `${home}/v1`, flavor: 'llama.cpp', endpointId: 'lab' });
    expect(ok.status).toBe(200);
    expect(hits.at(-1)?.auth).toBe('Bearer sk-stored-secret-1');

    const before = hits.length;
    const refused = await request(app)
      .post('/api/analyzer/endpoints/detect-context')
      .send({ baseUrl: `${elsewhere}/v1`, flavor: 'llama.cpp', endpointId: 'lab' });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('auth');
    expect(JSON.stringify(refused.body)).not.toContain('sk-stored-secret-1');
    expect(hits).toHaveLength(before);
  });

  it('a body apiKey is sent to the body baseUrl', async () => {
    const origin = await upstream();
    await request(app)
      .post('/api/analyzer/endpoints/detect-context')
      .send({ baseUrl: origin, flavor: 'llama.cpp', apiKey: 'sk-typed-now-1' });
    expect(hits[0].auth).toBe('Bearer sk-typed-now-1');
  });

  it('502s when the upstream cannot answer', async () => {
    const origin = await upstream();
    await new Promise<void>((r) => {
      const s = servers.pop()!;
      s.closeAllConnections();
      s.close(() => r());
    });
    const res = await request(app).post('/api/analyzer/endpoints/detect-context').send({ baseUrl: origin, flavor: 'llama.cpp' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('detect-failed');
  });

  it('400s an invalid body', async () => {
    const res = await request(app).post('/api/analyzer/endpoints/detect-context').send({ baseUrl: 'nope', flavor: 'vllm' });
    expect(res.status).toBe(400);
  });

  it('the 502 body never carries a typed key that the HTTP client echoed in its error (P22)', async () => {
    /* undici refuses the header value before dispatching and throws
       `Headers.append: "Bearer <key>" is an invalid header value.` (undici
       lib/web/webidl/index.js:68-73, lib/web/fetch/headers.js:101-105). */
    const origin = await upstream();
    const res = await request(app)
      .post('/api/analyzer/endpoints/detect-context')
      .send({ baseUrl: origin, flavor: 'llama.cpp', apiKey: 'sk-detect-echo-1\nX-Injected: 1' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('detect-failed');
    expect(JSON.stringify(res.body)).not.toContain('sk-detect-echo-1');
    expect(res.body.error).toContain('[redacted]');
    expect(hits).toHaveLength(0);
  });
});
