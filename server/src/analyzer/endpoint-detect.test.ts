import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { detectServedContext, propsUrl } from './endpoint-detect.js';

let server: Server | undefined;
let seen: Array<{ url: string; auth: string | undefined }> = [];

async function upstream(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  seen = [];
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization });
    handler(req, res);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

describe('detectServedContext (#3084 decision 3b)', () => {
  it('reads default_generation_settings.n_ctx from the server-root /props, never n_ctx_train', async () => {
    const origin = await upstream((_req, res) =>
      json(res, 200, { n_ctx_train: 262144, default_generation_settings: { n_ctx: 32768 } }),
    );
    const r = await detectServedContext({ baseUrl: `${origin}/v1`, flavor: 'llama.cpp', apiKey: null });
    expect(r).toEqual({ ok: true, contextTokens: 32768, source: 'llama.cpp /props' });
    expect(seen).toEqual([{ url: '/props', auth: undefined }]);
  });

  it.each([
    ['https://host/llm/v1', 'https://host/llm/props'],
    ['https://host/llm/v1/', 'https://host/llm/props'],
    ['https://host/llm', 'https://host/llm/props'],
    ['http://127.0.0.1:8080/v1', 'http://127.0.0.1:8080/props'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080/props'],
  ])('builds props relative to the base URL with a trailing /v1 removed (P25): %s → %s', (base, expected) => {
    expect(propsUrl(base).href).toBe(expected);
  });

  it('keeps a reverse-proxy path prefix on the wire (P25)', async () => {
    const origin = await upstream((_req, res) => json(res, 200, { default_generation_settings: { n_ctx: 8192 } }));
    const r = await detectServedContext({ baseUrl: `${origin}/llm/v1`, flavor: 'llama.cpp', apiKey: null });
    expect(r).toEqual({ ok: true, contextTokens: 8192, source: 'llama.cpp /props' });
    expect(seen).toEqual([{ url: '/llm/props', auth: undefined }]);
  });

  it('llama-swap passes the model as a query parameter and sends the key as a Bearer token', async () => {
    const origin = await upstream((_req, res) => json(res, 200, { default_generation_settings: { n_ctx: 65536 } }));
    const r = await detectServedContext({ baseUrl: `${origin}/v1`, flavor: 'llama-swap', model: 'qwen3:30b', apiKey: 'sk-detect-1234' });
    expect(r).toEqual({ ok: true, contextTokens: 65536, source: 'llama-swap /props' });
    expect(new URL(seen[0].url, 'http://x').pathname).toBe('/props');
    expect(new URL(seen[0].url, 'http://x').searchParams.get('model')).toBe('qwen3:30b');
    expect(seen[0].auth).toBe('Bearer sk-detect-1234');
  });

  it('reports an upstream HTTP error with its status', async () => {
    const origin = await upstream((_req, res) => json(res, 401, { error: 'bad key' }));
    const r = await detectServedContext({ baseUrl: origin, flavor: 'llama.cpp', apiKey: null });
    expect(r).toMatchObject({ ok: false, upstreamStatus: 401 });
  });

  it('refuses a response without a positive integer n_ctx', async () => {
    const origin = await upstream((_req, res) => json(res, 200, { n_ctx_train: 262144 }));
    const r = await detectServedContext({ baseUrl: origin, flavor: 'llama.cpp', apiKey: null });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('default_generation_settings.n_ctx');
  });

  it('reports an unreachable server', async () => {
    const origin = await upstream((_req, res) => json(res, 200, {}));
    server!.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    const r = await detectServedContext({ baseUrl: origin, flavor: 'llama.cpp', apiKey: null });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('Could not reach');
  });
});
