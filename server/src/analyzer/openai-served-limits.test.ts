/* #3084 P15 — endpoint served limits are warmed at run start through OpenAITransport.prepare(),
   cached per base URL with a TTL, and reach the wire through OpenAIAnalyzer's settings. No
   test here builds a catalog: a run never depends on the catalog view having been opened.
   Real http servers (Global Constraints). */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.GEMINI_RETRY_BACKOFFS_MS = '10,10';

const { OpenAIAnalyzer, openAIRequestSettings } = await import('./openai.js');
const { OpenAITransport, resolveEndpointMaxOutputTokens } = await import('./transports/openai-transport.js');
/* Wave 1 exports TransportAnalyzer from runner/transport-analyzer.ts, not stage-runner.ts. */
const { StageRunner } = await import('./runner/stage-runner.js');
const { TransportAnalyzer } = await import('./runner/transport-analyzer.js');
const { OPENAI_RETRY_POLICY } = await import('./runner/retry-policy.js');
const { adaptSchemaForOpenAI } = await import('./runner/schema-adapters.js');
const { AnalysisAbortedError } = await import('./errors.js');
const { resolveCapacity } = await import('./capacity.js');
const { modelTestDepsFor } = await import('./model-test-deps.js');
const {
  warmEndpointServedLimits,
  getEndpointServedLimits,
  SERVED_LIMITS_TTL_MS,
  SERVED_LIMITS_WARMUP_TIMEOUT_MS,
  _resetEndpointServedLimitsForTest,
} = await import('./catalog/endpoint-served-limits.js');
const { _resetCatalogCacheForTest } = await import('./catalog/analyzer-catalog.js');
const { _resetEndpointRuntimeForTest } = await import('./transports/endpoint-runtime.js');
const { geminiRateLimiter } = await import('./rate-limit.js');
const { analyzerEndpointSchema } = await import('../workspace/analyzer-endpoints.js');
const { DEFAULT_USER_SETTINGS, _resetUserSettingsCache, _setUserSettingsCacheForTest } = await import('../workspace/user-settings.js');

const HANDOFF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'handoff');
const ID = 'm_openai_served_limits';
const VALID = JSON.stringify({
  characters: [{ id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator', evidence: [{ quote: 'a' }, { quote: 'bb' }, { quote: 'ccc' }] }],
});

type Seen = { method: string; url: string; body: Record<string, unknown> };
const servers: Server[] = [];

/** A fake OpenRouter-shaped server: /v1/models lists one model with a served output limit.
    `listDelayMs` answers the listing late; `stallList` never answers it (P26). `listClosed`
    resolves when a listing response closes — for a stalled listing only the client can close it. */
async function lab(
  maxCompletionTokens: number,
  opts: { listDelayMs?: number; stallList?: boolean } = {},
): Promise<{ baseUrl: string; seen: Seen[]; listClosed: Promise<void> }> {
  const seen: Seen[] = [];
  let markListClosed: () => void = () => {};
  const listClosed = new Promise<void>((r) => (markListClosed = r));
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.on('close', () => markListClosed());
        if (opts.stallList) return;
        setTimeout(() => {
          if (res.destroyed) return;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              object: 'list',
              data: [{ id: 'qwen3-30b', object: 'model', created: 0, owned_by: 'x', context_length: 32768, top_provider: { context_length: 32768, max_completion_tokens: maxCompletionTokens } }],
            }),
          );
        }, opts.listDelayMs ?? 0);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: VALID }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, listClosed };
}

const endpoint = (baseUrl: string, over: Record<string, unknown> = {}) =>
  analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl, gpu: 'any', contextTokens: 32768, ...over });
const chatBodies = (seen: Seen[]) => seen.filter((s) => s.method === 'POST').map((s) => s.body);
const gets = (seen: Seen[]) => seen.filter((s) => s.method === 'GET');

/** OpenAIAnalyzer's own wiring (openai.ts), with the transport's test-only warm-up bound (P26). */
function runnerFor(ep: ReturnType<typeof endpoint>, servedLimitsTimeoutMs: number) {
  return new TransportAnalyzer(
    new StageRunner({
      transport: new OpenAITransport({ endpoint: ep, apiKey: null, model: 'qwen3-30b', servedLimitsTimeoutMs }),
      policy: OPENAI_RETRY_POLICY,
      settings: () => openAIRequestSettings(ep, getEndpointServedLimits(ep.baseUrl, 'qwen3-30b')?.maxOutputTokens),
      adaptSchema: adaptSchemaForOpenAI,
    }),
  );
}

beforeEach(() => {
  _resetEndpointServedLimitsForTest();
  _resetCatalogCacheForTest();
  _resetEndpointRuntimeForTest();
  geminiRateLimiter._reset();
});
afterEach(async () => {
  _resetUserSettingsCache();
  await Promise.all(
    servers.splice(0).map((s) => {
      s.closeAllConnections();
      return new Promise<void>((r) => s.close(() => r()));
    }),
  );
});
afterAll(async () => {
  delete process.env.GEMINI_RETRY_BACKOFFS_MS;
  for (const sub of ['inbox', 'outbox']) {
    const dir = resolve(HANDOFF_ROOT, sub);
    const names = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(names.filter((n) => n.startsWith(ID)).map((n) => rm(resolve(dir, n), { force: true })));
  }
});

describe('endpoint served limits warmed at run start (#3084 P15)', () => {
  it('a run with no prior catalog view sends max_tokens clamped to the served output limit', async () => {
    const { baseUrl, seen } = await lab(2048);
    const ep = endpoint(baseUrl);
    _setUserSettingsCacheForTest({ analyzerEndpoints: [ep], analyzerRateLimitsByModel: {} });
    await new OpenAIAnalyzer({ endpoint: ep, apiKey: null, model: 'qwen3-30b' }).runStage1Chapter(ID, 1, '# p', {});
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/v1/models' });
    expect(chatBodies(seen)[0].max_tokens).toBe(2048);
  });

  it('a manual max output above the served limit is clamped to it on the wire', async () => {
    const { baseUrl, seen } = await lab(2048);
    const ep = endpoint(baseUrl, { maxOutputTokens: 8192 });
    _setUserSettingsCacheForTest({ analyzerEndpoints: [ep], analyzerRateLimitsByModel: {} });
    await new OpenAIAnalyzer({ endpoint: ep, apiKey: null, model: 'qwen3-30b' }).runStage1Chapter(ID, 1, '# p', {});
    expect(chatBodies(seen)[0].max_tokens).toBe(2048);
  });

  it('limits are cached per base URL: an endpoint moved to another server never reads the old limits', async () => {
    const a = await lab(2048);
    const b = await lab(1024);
    await new OpenAITransport({ endpoint: endpoint(a.baseUrl), apiKey: null, model: 'qwen3-30b' }).prepare();
    const moved = endpoint(b.baseUrl);
    _setUserSettingsCacheForTest({ analyzerEndpoints: [moved], analyzerRateLimitsByModel: {} });
    expect(resolveCapacity({ engine: 'openai', model: 'openai:lab::qwen3-30b' }).maxOutputTokens).toBeNull();
    await new OpenAITransport({ endpoint: moved, apiKey: null, model: 'qwen3-30b' }).prepare();
    expect(resolveCapacity({ engine: 'openai', model: 'openai:lab::qwen3-30b' }).maxOutputTokens).toBe(1024);
  });

  it('within the TTL a second warm-up does not list again; once it expires, it does', async () => {
    let now = 1_000;
    const listEndpoint = vi.fn(async () => [{ id: 'm', top_provider: { max_completion_tokens: 512 } }]);
    const ep = { baseUrl: 'http://127.0.0.1:1/v1' };
    await warmEndpointServedLimits(ep, null, { listEndpoint, now: () => now });
    now += SERVED_LIMITS_TTL_MS - 1;
    await warmEndpointServedLimits(ep, null, { listEndpoint, now: () => now });
    expect(listEndpoint).toHaveBeenCalledTimes(1);
    expect(getEndpointServedLimits(ep.baseUrl, 'm', now)).toEqual({ maxOutputTokens: 512 });
    now += 2;
    expect(getEndpointServedLimits(ep.baseUrl, 'm', now)).toBeUndefined();
    await warmEndpointServedLimits(ep, null, { listEndpoint, now: () => now });
    expect(listEndpoint).toHaveBeenCalledTimes(2);
  });

  it('a failed listing never rejects, leaves the limits unknown, and logs no key (P22)', async () => {
    const KEY = 'sk-lab-listing-secret-01';
    const listEndpoint = vi.fn(async () => {
      throw new Error(`401 invalid key ${KEY}`);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(warmEndpointServedLimits({ baseUrl: 'http://127.0.0.1:1/v1' }, KEY, { listEndpoint })).resolves.toBeUndefined();
    expect(getEndpointServedLimits('http://127.0.0.1:1/v1', 'm')).toBeUndefined();
    const logged = warn.mock.calls.flat().join('\n');
    expect(logged).toContain('[redacted]');
    expect(logged).not.toContain(KEY);
    warn.mockRestore();
  });

  it('resolveEndpointMaxOutputTokens clamps a manual cap to the served limit only when one is known (P15, P24)', () => {
    const ep = endpoint('http://127.0.0.1:8080/v1', { maxOutputTokens: 8192 });
    expect(resolveEndpointMaxOutputTokens(ep, 2048)).toBe(2048);
    expect(resolveEndpointMaxOutputTokens(ep, 16384)).toBe(8192);
    expect(resolveEndpointMaxOutputTokens(ep)).toBe(8192);
    expect(openAIRequestSettings(ep, 2048).maxOutputTokens).toBe(2048);
  });

  it("the Test action's probe cap uses the served limit prepare() warmed", async () => {
    const { baseUrl } = await lab(2048);
    const ep = endpoint(baseUrl);
    _setUserSettingsCacheForTest({ analyzerEndpoints: [ep], analyzerRateLimitsByModel: {} });
    const d = modelTestDepsFor('openai:lab::qwen3-30b', { ...DEFAULT_USER_SETTINGS, analyzerEndpoints: [ep], analyzerEndpointKeys: {} });
    expect(d.probeLimits().maxOutputTokens).toBeNull();
    await d.transport.prepare?.();
    expect(d.probeLimits()).toEqual({ contextTokens: 32768, maxOutputTokens: 2048 });
  });
});

describe('the served-limits warm-up is bounded (#3084 P26)', () => {
  it('the production bound is 10 s', () => {
    expect(SERVED_LIMITS_WARMUP_TIMEOUT_MS).toBe(10_000);
  });

  it('a server that never answers /v1/models releases the run after the warm-up bound, with fallback limits, and backs off', async () => {
    const { baseUrl, seen } = await lab(2048, { stallList: true });
    const ep = endpoint(baseUrl);
    _setUserSettingsCacheForTest({ analyzerEndpoints: [ep], analyzerRateLimitsByModel: {} });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const started = Date.now();
    await runnerFor(ep, 300).runStage1Chapter(ID, 1, '# p', {});
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect(elapsed).toBeLessThan(5_000);
    expect(gets(seen)).toHaveLength(1);
    /* Fallback limits: the listing never arrived, so Auto is the context bound, not the 2048 the server would list. */
    expect(chatBodies(seen)[0].max_tokens).toBeGreaterThan(2048);
    expect(resolveCapacity({ engine: 'openai', model: 'openai:lab::qwen3-30b' }).maxOutputTokens).toBeNull();
    expect(warn.mock.calls.flat().join('\n')).toContain('no answer within 300 ms');
    /* A timeout counts as a failed listing: the 60 s back-off stops the next run from listing (and waiting) again. */
    await runnerFor(ep, 300).runStage1Chapter(ID, 2, '# p', {});
    expect(gets(seen)).toHaveLength(1);
    expect(chatBodies(seen)).toHaveLength(2);
    warn.mockRestore();
  }, 15_000);

  it('a paused run (caller abort) during a stalled warm-up stops at once and sends no chat request', async () => {
    const { baseUrl, seen } = await lab(2048, { stallList: true });
    const ep = endpoint(baseUrl);
    _setUserSettingsCacheForTest({ analyzerEndpoints: [ep], analyzerRateLimitsByModel: {} });
    const controller = new AbortController();
    const run = runnerFor(ep, 8_000).runStage1Chapter(ID, 3, '# p', { signal: controller.signal });
    await vi.waitFor(() => expect(gets(seen)).toHaveLength(1));
    const abortedAt = Date.now();
    controller.abort();
    await expect(run).rejects.toBeInstanceOf(AnalysisAbortedError);
    expect(Date.now() - abortedAt).toBeLessThan(1_000);
    expect(chatBodies(seen)).toHaveLength(0);
  });

  it('concurrent requests share one bounded listing per base URL', async () => {
    const { baseUrl, seen } = await lab(2048, { listDelayMs: 150 });
    const ep = endpoint(baseUrl);
    const t1 = new OpenAITransport({ endpoint: ep, apiKey: null, model: 'qwen3-30b' });
    const t2 = new OpenAITransport({ endpoint: ep, apiKey: null, model: 'qwen3-30b' });
    await Promise.all([t1.prepare(), t2.prepare(), t1.prepare()]);
    expect(gets(seen)).toHaveLength(1);
    expect(getEndpointServedLimits(baseUrl, 'qwen3-30b')?.maxOutputTokens).toBe(2048);
  });

  it('a caller abort releases prepare() at once, cancels the listing when no one else waits, and caches nothing', async () => {
    const { baseUrl, seen, listClosed } = await lab(2048, { stallList: true });
    const transport = new OpenAITransport({ endpoint: endpoint(baseUrl), apiKey: null, model: 'qwen3-30b', servedLimitsTimeoutMs: 8_000 });
    const first = new AbortController();
    const pending = transport.prepare(first.signal);
    await vi.waitFor(() => expect(gets(seen)).toHaveLength(1));
    const abortedAt = Date.now();
    first.abort();
    await expect(pending).resolves.toBeUndefined();
    expect(Date.now() - abortedAt).toBeLessThan(1_000);
    await listClosed; // the client closed the GET itself, long before the 8 s bound or the SDK's 10 s timeout
    expect(Date.now() - abortedAt).toBeLessThan(2_000);
    expect(getEndpointServedLimits(baseUrl, 'qwen3-30b')).toBeUndefined();
    /* An abandoned listing is not a failed one: no back-off, so the next warm-up lists again. */
    const second = new AbortController();
    const again = transport.prepare(second.signal);
    await vi.waitFor(() => expect(gets(seen)).toHaveLength(2));
    second.abort();
    await again;
  });

  it('an abort releases only that caller: a request still waiting gets the listing', async () => {
    const { baseUrl, seen } = await lab(2048, { listDelayMs: 300 });
    const ep = endpoint(baseUrl);
    const leaving = new AbortController();
    const left = new OpenAITransport({ endpoint: ep, apiKey: null, model: 'qwen3-30b' }).prepare(leaving.signal);
    const stayed = new OpenAITransport({ endpoint: ep, apiKey: null, model: 'qwen3-30b' }).prepare();
    await vi.waitFor(() => expect(gets(seen)).toHaveLength(1));
    leaving.abort();
    await left;
    expect(getEndpointServedLimits(baseUrl, 'qwen3-30b')).toBeUndefined();
    await stayed;
    expect(gets(seen)).toHaveLength(1);
    expect(getEndpointServedLimits(baseUrl, 'qwen3-30b')?.maxOutputTokens).toBe(2048);
  });
});
