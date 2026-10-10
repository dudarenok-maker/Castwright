import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { readFileSync } from 'node:fs';
import { AnalyzerHttpError, AnalyzerTransportError } from '../errors.js';
import {
  buildAnalyzerCatalog,
  previewEndpointModels,
  servedLimitsFromModelEntry,
  listingErrorMessage,
  DEFAULT_CATALOG_DEPS,
  CATALOG_TTL_MS,
  TEST_REQUEST_MAX_ATTEMPTS,
  _resetCatalogCacheForTest,
  type CatalogDeps,
} from './analyzer-catalog.js';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '../../workspace/user-settings.js';
import { analyzerEndpointSchema } from '../../workspace/analyzer-endpoints.js';

const lab = analyzerEndpointSchema.parse({
  id: 'lab',
  name: 'Lab server',
  baseUrl: 'http://127.0.0.1:8080/v1',
  gpu: 'any',
  contextTokens: 32768,
});

function settings(over: Partial<UserSettings> = {}): UserSettings {
  return { ...DEFAULT_USER_SETTINGS, analyzerEndpoints: [lab], analyzerEndpointKeys: {}, ...over };
}

function deps(over: Partial<CatalogDeps> = {}): CatalogDeps {
  let t = 1_000_000;
  return {
    settings: () => settings(),
    ollamaUrl: () => 'http://localhost:11434',
    geminiApiKey: () => null,
    listOllamaTags: vi.fn(async () => [{ name: 'qwen3.5:4b' }]),
    listGemini: vi.fn(async () => [{ id: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 }]),
    listEndpoint: vi.fn(async () => [{ id: 'qwen3-30b', object: 'model', meta: { n_ctx: 32768, n_ctx_train: 262144 } }]),
    now: () => (t += 1),
    ...over,
  };
}

afterEach(() => _resetCatalogCacheForTest());

describe('servedLimitsFromModelEntry — served fields only (#3084 decision 3b)', () => {
  it.each([
    ['vLLM max_model_len', { id: 'm', max_model_len: 16384 }, { contextTokens: 16384 }],
    ['llama.cpp meta.n_ctx beats n_ctx_train', { id: 'm', meta: { n_ctx: 8192, n_ctx_train: 262144 } }, { contextTokens: 8192 }],
    ['llama.cpp with only n_ctx_train → nothing', { id: 'm', meta: { n_ctx_train: 262144 } }, {}],
    ['llama-swap context_length + meta.n_ctx → meta.n_ctx', { id: 'm', context_length: 40000, meta: { n_ctx: 32000 } }, { contextTokens: 32000 }],
    ['OpenRouter context_length + top_provider.max_completion_tokens', { id: 'm', context_length: 128000, top_provider: { context_length: 128000, max_completion_tokens: 16384 } }, { contextTokens: 128000, maxOutputTokens: 16384 }],
    ['LiteLLM catalogue max_input_tokens → nothing', { id: 'm', max_input_tokens: 200000, max_output_tokens: 8192 }, {}],
    ['vLLM max_model_len wins over context_length', { id: 'm', max_model_len: 4096, context_length: 999999 }, { contextTokens: 4096 }],
  ])('%s', (_name, entry, expected) => {
    expect(servedLimitsFromModelEntry(entry as Record<string, unknown>)).toEqual(expected);
  });
});

describe('buildAnalyzerCatalog', () => {
  it('returns Ollama, Gemini (fallback without a key, no list call) and one group per saved endpoint', async () => {
    const d = deps();
    const catalog = await buildAnalyzerCatalog({ refresh: false }, d);
    expect(Object.keys(catalog)).toEqual(['groups']);
    expect(catalog.groups.map((g) => [g.kind, g.id, g.status])).toEqual([
      ['ollama', 'ollama', 'ok'],
      ['gemini', 'gemini', 'fallback'],
      ['endpoint', 'lab', 'ok'],
    ]);
    expect(catalog.groups[1].models).toEqual([]);
    expect(d.listGemini).not.toHaveBeenCalled();
    expect(catalog.groups[0].models[0]).toMatchObject({ id: 'qwen3.5:4b', label: 'qwen3.5:4b' });
    const entry = catalog.groups[2].models[0];
    expect(entry).toMatchObject({ id: 'openai:lab::qwen3-30b', label: 'qwen3-30b', engine: 'openai', model: 'qwen3-30b', contextTokens: 32768 });
    /* N6: `attempts` is the most attempts one Test request can take on that transport. */
    expect(entry.testPlan).toEqual({ configured: 2, all: 3, attempts: 3 });
    expect(catalog.groups[0].models[0].testPlan.attempts).toBe(1);
  });

  it("TEST_REQUEST_MAX_ATTEMPTS matches each transport's own retry budget (N6)", () => {
    const source = (file: string) => readFileSync(new URL(`../transports/${file}`, import.meta.url), 'utf8');
    expect(source('openai-transport.ts')).toContain(`maxAttempts: ${TEST_REQUEST_MAX_ATTEMPTS.openai},`);
    expect(source('gemini-transport.ts')).toContain(`maxAttempts: ${TEST_REQUEST_MAX_ATTEMPTS.gemini},`);
    /* Ollama's transport has no transport retry (W1 Task 1.9 moved chat() as is). */
    expect(source('ollama-transport.ts')).not.toContain('withTransportRetry');
    expect(TEST_REQUEST_MAX_ATTEMPTS.local).toBe(1);
  });

  it('lists Gemini with limits and display-name labels when a key is set', async () => {
    const d = deps({ geminiApiKey: () => 'k' });
    const catalog = await buildAnalyzerCatalog({ refresh: true }, d);
    expect(d.listGemini).toHaveBeenCalledWith('k', true);
    expect(catalog.groups[1].status).toBe('ok');
    expect(catalog.groups[1].models[0]).toMatchObject({
      id: 'gemini-3.6-flash',
      label: 'Gemini 3.6 Flash',
      engine: 'gemini',
      contextTokens: 1_048_576,
      outputTokens: 65_536,
    });
  });

  it('a failed Gemini listing is a fallback group (the frontend overlays its curated list)', async () => {
    const d = deps({ geminiApiKey: () => 'k', listGemini: vi.fn(async () => { throw new Error('503 UNAVAILABLE'); }) });
    const catalog = await buildAnalyzerCatalog({ refresh: false }, d);
    expect(catalog.groups[1]).toMatchObject({ kind: 'gemini', status: 'fallback', models: [] });
    expect(catalog.groups[1].error).toContain('503');
  });

  it('a stored key for another origin sends no request and marks the group error', async () => {
    const d = deps({ settings: () => settings({ analyzerEndpointKeys: { lab: { origin: 'http://10.0.0.5:8080', key: 'sk-x' } } }) });
    const catalog = await buildAnalyzerCatalog({ refresh: false }, d);
    expect(d.listEndpoint).not.toHaveBeenCalled();
    expect(catalog.groups[2]).toMatchObject({ status: 'error', models: [] });
    expect(catalog.groups[2].error).toMatch(/Re-enter the API key for Lab server/);
  });

  it('a matching stored key is passed to the listing', async () => {
    const d = deps({ settings: () => settings({ analyzerEndpointKeys: { lab: { origin: 'http://127.0.0.1:8080', key: 'sk-x' } } }) });
    await buildAnalyzerCatalog({ refresh: false }, d);
    expect(d.listEndpoint).toHaveBeenCalledWith('http://127.0.0.1:8080/v1', 'sk-x');
  });

  it('a failed endpoint listing that echoes the stored key is shown redacted (P22)', async () => {
    const KEY = 'sk-lab-catalog-secret-01';
    const d = deps({
      settings: () => settings({ analyzerEndpointKeys: { lab: { origin: 'http://127.0.0.1:8080', key: KEY } } }),
      listEndpoint: vi.fn(async () => { throw new Error(`401 Incorrect API key provided: ${KEY}`); }),
    });
    const group = (await buildAnalyzerCatalog({ refresh: false }, d)).groups[2];
    expect(group.status).toBe('error');
    expect(group.error).toContain('[redacted]');
    expect(group.error).not.toContain(KEY);
  });

  it('a failed Ollama listing keeps the group, marked error, without models (installed-only)', async () => {
    const d = deps({ listOllamaTags: vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }) });
    const catalog = await buildAnalyzerCatalog({ refresh: false }, d);
    expect(catalog.groups[0]).toMatchObject({ kind: 'ollama', status: 'error', models: [] });
    expect(catalog.groups[0].error).toContain('ECONNREFUSED');
  });

  it('caches listings for CATALOG_TTL_MS; refresh bypasses the cache', async () => {
    let now = 0;
    const d = deps({ now: () => now });
    await buildAnalyzerCatalog({ refresh: false }, d);
    now = CATALOG_TTL_MS - 1;
    await buildAnalyzerCatalog({ refresh: false }, d);
    expect(d.listOllamaTags).toHaveBeenCalledTimes(1);
    await buildAnalyzerCatalog({ refresh: true }, d);
    expect(d.listOllamaTags).toHaveBeenCalledTimes(2);
    now = 10 * CATALOG_TTL_MS;
    await buildAnalyzerCatalog({ refresh: false }, d);
    expect(d.listOllamaTags).toHaveBeenCalledTimes(3);
  });

  it('attaches a Test record only while its serverUrl matches, and labels from it', async () => {
    const rec = {
      serverUrl: 'http://127.0.0.1:8080/v1',
      testedAt: '2026-09-11T10:00:00.000Z',
      control: { ok: true as const },
      structuredOutput: { schema: { 'model-default': 'ignored' as const } },
      reasoning: {},
    };
    const d = deps({ settings: () => settings({ analyzerCapabilitiesByModel: { 'openai:lab::qwen3-30b': rec } }) });
    const entry = (await buildAnalyzerCatalog({ refresh: false }, d)).groups[2].models[0];
    expect(entry.capability).toEqual(rec);
    expect(entry.structuredOutput.label).toBe('schema (not enforced)');

    _resetCatalogCacheForTest();
    const moved = deps({
      settings: () =>
        settings({
          analyzerEndpoints: [{ ...lab, baseUrl: 'http://127.0.0.1:9090/v1' }],
          analyzerCapabilitiesByModel: { 'openai:lab::qwen3-30b': rec },
        }),
    });
    expect((await buildAnalyzerCatalog({ refresh: false }, moved)).groups[2].models[0].capability).toBeUndefined();
  });

  it('labels an Ollama entry from a record filed under off, the level Ollama sends (P7)', async () => {
    const rec = {
      serverUrl: 'http://localhost:11434',
      testedAt: '2026-09-11T10:00:00.000Z',
      control: { ok: true as const },
      structuredOutput: { schema: { off: 'ignored' as const, 'model-default': 'enforced' as const } },
      reasoning: {},
    };
    const d = deps({ settings: () => settings({ analyzerCapabilitiesByModel: { 'qwen3.5:4b': rec } }) });
    const entry = (await buildAnalyzerCatalog({ refresh: false }, d)).groups[0].models[0];
    expect(entry.structuredOutput.label).toBe('schema (not enforced)');
  });

  it('carries structuredOutput.outcome from the record at the configured mode and the level a run sends, and omits it when unprobed (#3084 W3c)', async () => {
    const rec = {
      serverUrl: 'http://localhost:11434',
      testedAt: '2026-09-11T10:00:00.000Z',
      control: { ok: true as const },
      structuredOutput: { schema: { off: 'rejected' as const, 'model-default': 'enforced' as const }, json: { 'model-default': 'accepted' as const } },
      reasoning: {},
    };
    const d = deps({ settings: () => settings({ analyzerCapabilitiesByModel: { 'qwen3.5:4b': rec } }) });
    const entry = (await buildAnalyzerCatalog({ refresh: false }, d)).groups[0].models[0];
    // Ollama sends the 'off' level: the 'rejected' there wins over the 'enforced' filed under another level.
    expect(entry.structuredOutput.outcome).toBe('rejected');

    _resetCatalogCacheForTest();
    const unprobed = deps({
      settings: () => settings({ analyzerCapabilitiesByModel: { 'qwen3.5:4b': { ...rec, structuredOutput: { json: { off: 'accepted' as const } } } } }),
    });
    const bare = (await buildAnalyzerCatalog({ refresh: false }, unprobed)).groups[0].models[0];
    expect(bare.capability).toBeDefined();
    expect('outcome' in bare.structuredOutput).toBe(false);
  });

  it('reports off mode as accepted when the control passed and the record has no off entry; an explicit off entry wins (#3570)', async () => {
    const rec = {
      serverUrl: 'http://127.0.0.1:8080/v1',
      testedAt: '2026-09-11T10:00:00.000Z',
      control: { ok: true as const },
      structuredOutput: { schema: { 'model-default': 'enforced' as const } },
      reasoning: {},
    };
    const offLab = { ...lab, structuredOutput: 'off' as const };
    const run = async (r: unknown) => {
      _resetCatalogCacheForTest();
      const d = deps({ settings: () => settings({ analyzerEndpoints: [offLab], analyzerCapabilitiesByModel: { 'openai:lab::qwen3-30b': r as typeof rec } }) });
      return (await buildAnalyzerCatalog({ refresh: true }, d)).groups.find((g) => g.kind === 'endpoint')!.models[0].structuredOutput;
    };
    expect((await run(rec)).outcome).toBe('accepted');
    expect((await run({ ...rec, control: { ok: false, error: 'x' } })).outcome).toBeUndefined();
    expect((await run({ ...rec, structuredOutput: { off: { 'model-default': 'rejected' } } })).outcome).toBe('rejected');
  });

  it("attaches a Gemini entry's Test record only when it is filed under serverUrl 'gemini' (#3084)", async () => {
    const rec = {
      serverUrl: 'gemini',
      testedAt: '2026-09-11T10:00:00.000Z',
      control: { ok: true as const },
      structuredOutput: { json: { 'model-default': 'rejected' as const } },
      reasoning: {},
    };
    const withRec = (r: typeof rec) => deps({ geminiApiKey: () => 'k', settings: () => settings({ analyzerCapabilitiesByModel: { 'gemini-3.6-flash': r } }) });
    const entry = (await buildAnalyzerCatalog({ refresh: true }, withRec(rec))).groups[1].models[0];
    expect(entry.capability).toEqual(rec);
    expect(entry.structuredOutput.outcome).toBe('rejected');

    _resetCatalogCacheForTest();
    const other = (await buildAnalyzerCatalog({ refresh: true }, withRec({ ...rec, serverUrl: 'http://localhost:11434' }))).groups[1].models[0];
    expect(other.capability).toBeUndefined();
  });

  it('A3 — drops an Ollama Test record once the installed digest differs, and keeps it while it matches', async () => {
    const rec = {
      serverUrl: 'http://localhost:11434',
      testedAt: '2026-09-11T10:00:00.000Z',
      control: { ok: true as const },
      structuredOutput: { schema: { off: 'rejected' as const } },
      reasoning: {},
      digest: 'sha256:old',
    };
    const withRec = () => settings({ analyzerCapabilitiesByModel: { 'qwen3.5:4b': rec } });
    const repulled = deps({ settings: withRec, listOllamaTags: vi.fn(async () => [{ name: 'qwen3.5:4b', digest: 'sha256:new' }]) });
    expect((await buildAnalyzerCatalog({ refresh: false }, repulled)).groups[0].models[0].capability).toBeUndefined();
    _resetCatalogCacheForTest();
    const same = deps({ settings: withRec, listOllamaTags: vi.fn(async () => [{ name: 'qwen3.5:4b', digest: 'sha256:old' }]) });
    expect((await buildAnalyzerCatalog({ refresh: false }, same)).groups[0].models[0].capability).toEqual(rec);
  });
});

describe('previewEndpointModels', () => {
  it('suggests the smallest served context among the listed models', async () => {
    const out = await previewEndpointModels(
      { baseUrl: 'http://127.0.0.1:8080/v1', apiKey: null },
      { listEndpoint: async () => [{ id: 'a', meta: { n_ctx: 32768 } }, { id: 'b', max_model_len: 8192 }, { id: 'c' }] },
    );
    expect(out).toEqual({
      status: 'ok',
      models: [{ model: 'a', contextTokens: 32768 }, { model: 'b', contextTokens: 8192 }, { model: 'c' }],
      suggestedContextTokens: 8192,
    });
  });

  it('reports a listing failure instead of throwing', async () => {
    const out = await previewEndpointModels(
      { baseUrl: 'http://127.0.0.1:8080/v1', apiKey: null },
      { listEndpoint: async () => { throw new Error('401 Unauthorized'); } },
    );
    expect(out).toMatchObject({ status: 'failed', models: [] });
    expect(out.error).toContain('401');
  });

  it('logs one line per failure, carrying only the redacted message, never the error object (P22)', async () => {
    const KEY = 'sk-preview-log-secret-0001';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await previewEndpointModels(
        { baseUrl: 'http://127.0.0.1:8080/v1', apiKey: KEY },
        { listEndpoint: async () => { throw new Error(`401 bad key ${KEY}`); } },
      );
      const lines = warn.mock.calls.map((args) => args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 }))).join(' '));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('preview listing failed');
      expect(lines[0]).toContain('[redacted]');
      expect(lines[0]).not.toContain(KEY);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('listingErrorMessage (P21, P22)', () => {
  it.each(['ECONNRESET', 'UND_ERR_SOCKET', 'EAI_AGAIN'])('%s anywhere in the cause chain is a transient failure, never unreachable', (code) => {
    const err = Object.assign(new Error('Connection error.'), {
      cause: Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket'), { code }) }),
    });
    const message = listingErrorMessage(err, []);
    expect(message).toMatch(/connection dropped/i);
    expect(message).toContain(code);
    expect(message).not.toMatch(/unreachable|could not be reached/i);
  });

  it('any other failure keeps its redacted message, capped at 300 characters', () => {
    const KEY = 'sk-listing-secret-0001';
    const message = listingErrorMessage(new Error(`401 bad key ${KEY} ${'x'.repeat(400)}`), [KEY]);
    expect(message.startsWith('401 bad key [redacted]')).toBe(true);
    expect(message).toHaveLength(300);
  });

  it('a rebuilt AnalyzerTransportError reads its transient code from causeCode; any other keeps its own text, never unreachable (P21, P22)', () => {
    const dropped = new AnalyzerTransportError('openai', 'models.list', 'Endpoint model listing failed (UND_ERR_SOCKET).', 'UND_ERR_SOCKET');
    expect(listingErrorMessage(dropped, [])).toMatch(/connection dropped/i);
    expect(listingErrorMessage(dropped, [])).toContain('UND_ERR_SOCKET');
    const refused = new AnalyzerTransportError('openai', 'models.list', 'Endpoint model listing failed (ECONNREFUSED).', 'ECONNREFUSED');
    expect(listingErrorMessage(refused, [])).toBe('Endpoint model listing failed (ECONNREFUSED).');
    expect(listingErrorMessage(refused, [])).not.toMatch(/unreachable|could not be reached/i);
  });
});

describe('DEFAULT_CATALOG_DEPS.listEndpoint over a real socket', () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  it('lists /v1/models through the openai SDK and sends no Authorization header without a key', async () => {
    let seenAuth: string | undefined = 'not-called';
    server = createServer((req, res) => {
      seenAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3-30b', object: 'model', created: 0, owned_by: 'x', meta: { n_ctx: 32768, n_ctx_train: 262144 } }] }));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    const out = await DEFAULT_CATALOG_DEPS.listEndpoint(`http://127.0.0.1:${port}/v1`, null);
    expect(out.map((m) => m.id)).toEqual(['qwen3-30b']);
    expect((out[0].meta as Record<string, unknown>).n_ctx).toBe(32768);
    expect(seenAuth).toBeUndefined();
  });

  it('sends the key as a Bearer token when one is given', async () => {
    let seenAuth: string | undefined;
    server = createServer((req, res) => {
      seenAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    await DEFAULT_CATALOG_DEPS.listEndpoint(`http://127.0.0.1:${port}/v1`, 'sk-local');
    expect(seenAuth).toBe('Bearer sk-local');
  });

  it('OPENAI_CUSTOM_HEADERS in the host env never reaches the listing; the endpoint key does (P22)', async () => {
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    server = createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    /* The SDK merges this env into every request after its own auth header (client.mjs:240-249). */
    process.env.OPENAI_CUSTOM_HEADERS = 'Authorization: Bearer stolen\nX-Leak: 1\nX-Stainless-Lang: evil';
    try {
      await DEFAULT_CATALOG_DEPS.listEndpoint(`http://127.0.0.1:${port}/v1`, 'sk-local');
    } finally {
      delete process.env.OPENAI_CUSTOM_HEADERS;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].authorization).toBe('Bearer sk-local');
    expect(seen[0]['x-leak']).toBeUndefined();
    /* P22: no x-stainless-* header at all, so the injected X-Stainless-Lang cannot ride along. */
    expect(Object.keys(seen[0]).filter((name) => name.startsWith('x-stainless-'))).toEqual([]);
  });

  it('a connection the server drops is a transient listing failure, never unreachable (P21)', async () => {
    server = createServer((req) => req.socket.destroy());
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    const out = await previewEndpointModels({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: null });
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/connection dropped/i);
    expect(out.error).not.toMatch(/unreachable|could not be reached/i);
  });

  it('a refused listing whose body echoes the key is rebuilt as AnalyzerHttpError: redacted, no cause, nothing in inspect() (P22)', async () => {
    const KEY = 'sk-listing-echo-secret-0001';
    /* The endpoint echoes the Authorization header it received, as some proxies do on a 401. */
    server = createServer((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${req.headers.authorization ?? 'none'}`, type: 'invalid_request_error' } }));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    const err = await DEFAULT_CATALOG_DEPS.listEndpoint(`http://127.0.0.1:${port}/v1`, KEY).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AnalyzerHttpError);
    expect((err as AnalyzerHttpError).httpStatus).toBe(401);
    /* '[redacted]' proves the key reached the endpoint and came back, so the checks below cannot pass vacuously. */
    expect((err as Error).message).toContain('[redacted]');
    expect((err as { cause?: unknown }).cause).toBeUndefined();
    for (const s of [(err as Error).message, (err as Error).stack ?? '', inspect(err, { depth: 8 })]) {
      expect(s).not.toContain(KEY);
    }
  });

  it('a key undici refuses as a header value is rebuilt as AnalyzerTransportError: no cause, nothing in inspect() (P22)', async () => {
    const KEY = 'sk-listing-inject-secret-0001';
    let requests = 0;
    server = createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    /* undici throws `Headers.append: "Bearer <key>" is an invalid header value.` before dispatching;
       the SDK wraps it as APIConnectionError's cause, so the raw error's chain carries the key. */
    const err = await DEFAULT_CATALOG_DEPS.listEndpoint(`http://127.0.0.1:${port}/v1`, `${KEY}\nX-Injected: 1`).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(requests).toBe(0);
    expect(err).toBeInstanceOf(AnalyzerTransportError);
    expect((err as Error).message).toMatch(/^Endpoint model listing failed/);
    expect((err as { cause?: unknown }).cause).toBeUndefined();
    for (const s of [(err as Error).message, (err as Error).stack ?? '', inspect(err, { depth: 8 })]) {
      expect(s).not.toContain(KEY);
    }
  });
});
