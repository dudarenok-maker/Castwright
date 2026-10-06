/* Transport contract suite for OpenAITransport (#3084 spec "Testing →
   Transport contract suite" + 04-openai-sdk-facts). A REAL http.createServer on
   127.0.0.1:0 and the REAL undici Agent — no fetch stub, no vi.mock('undici'),
   following ollama-timeout.test.ts. Every case asserts the error CLASS.
   Env that module-load constants read (GEMINI_RETRY_BACKOFFS_MS → BACKOFFS_MS)
   is set BEFORE the dynamic imports below. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type LookupFunction } from 'node:net';
import { inspect } from 'node:util';
import { Agent } from 'undici';
import type { AnalyzerEndpoint } from '../../workspace/analyzer-endpoints.js';
import type { TransportRequest } from '../runner/transport.js';

process.env.GEMINI_RETRY_BACKOFFS_MS = '10,10';

const { OpenAITransport, allowlistedFetch, ANALYZER_USER_AGENT, resolveEndpointMaxOutputTokens } = await import('./openai-transport.js');
const { classifyAnalysisFailure } = await import('../../routes/failure-taxonomy.js');
const { _resetUserSettingsCache, _setUserSettingsCacheForTest } = await import('../../workspace/user-settings.js');
const { endpointSemaphore, servedModels, _resetEndpointRuntimeForTest } = await import('./endpoint-runtime.js');
const { geminiRateLimiter } = await import('../rate-limit.js');
const errors = await import('../errors.js');

type Handler = (req: IncomingMessage, res: ServerResponse, n: number) => void | Promise<void>;
let server: Server | undefined;
let seen: Array<{ url: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }> = [];
const agents: Agent[] = [];

async function start(handler: Handler): Promise<string> {
  seen = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
      void handler(req, res, seen.length);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/v1`;
}

const sse = (res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.flushHeaders();
};
const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`;
const DONE = 'data: [DONE]\n\n';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const endpoint = (baseUrl: string, over: Partial<AnalyzerEndpoint> = {}): AnalyzerEndpoint => ({
  id: 'lab',
  name: 'Lab',
  baseUrl,
  gpu: 'any',
  concurrency: 1,
  requestCeilingMs: 5_000,
  structuredOutput: 'schema',
  reasoningStyle: 'not_controllable',
  reasoning: 'model-default',
  maxOutputTokens: 0,
  contextTokens: 32_768,
  ...over,
});

const request = (over: Partial<TransportRequest> = {}): TransportRequest => ({
  system: 'sys',
  messages: [{ role: 'user', content: 'go' }],
  structuredOutput: { mode: 'json' },
  temperature: 0.2,
  maxOutputTokens: undefined,
  estimatedInputTokens: 10,
  call: {},
  ...over,
});

const transport = (baseUrl: string, over: Partial<AnalyzerEndpoint> = {}, apiKey: string | null = null, dispatcher?: Agent) =>
  new OpenAITransport({ endpoint: endpoint(baseUrl, over), apiKey, model: 'qwen3:30b', dispatcher });

const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

beforeAll(() => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
});
afterAll(() => {
  delete process.env.CASTWRIGHT_VRAM_SAMPLE;
  delete process.env.GEMINI_RETRY_BACKOFFS_MS;
});
beforeEach(() => {
  _resetEndpointRuntimeForTest();
  geminiRateLimiter._reset();
});
afterEach(async () => {
  delete process.env.GEMINI_STREAM_IDLE_MS;
  await Promise.all(agents.splice(0).map((a) => a.destroy()));
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

describe('OpenAITransport — streamed success', () => {
  it('streams answer text, maps finish_reason stop, reads usage, and sends the wire body', async () => {
    const url = await start((_req, res) => {
      sse(res);
      res.write(chunk({ role: 'assistant', content: '{"a":' }));
      res.write(chunk({ content: '1}' }));
      res.write(chunk({}, 'stop'));
      res.write(chunk({}, null, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 0 } } }));
      res.end(DONE);
    });
    const received: number[] = [];
    const r = await transport(url).send(
      request({
        maxOutputTokens: resolveEndpointMaxOutputTokens(endpoint(url)),
        call: { onChunk: (i) => received.push(i.receivedBytes) },
      }),
    );
    expect(r).toMatchObject({ text: '{"a":1}', finish: 'stop', reasoningSeen: false, usage: { inputTokens: 12, outputTokens: 3, reasoningTokens: 0 } });
    expect(received).toEqual([5, 7]);
    expect(seen[0].url).toBe('/v1/chat/completions');
    expect(seen[0].body).toMatchObject({
      model: 'qwen3:30b',
      stream: true,
      stream_options: { include_usage: true },
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }],
      /* P24: min(32 768 − 3 277, 32 768 − 10 − 3 277) */
      max_tokens: 29_481,
    });
    expect(servedModels('lab')).toEqual(['qwen3:30b']);
  });

  describe('served models for the {model} unload URL (#3084 P3)', () => {
    const okStream = (res: ServerResponse) => {
      sse(res);
      res.end(chunk({ content: '{}' }, 'stop') + DONE);
    };

    it('a call that fails with a 5xx still records its model: the request was sent, so the server may hold it (N2)', async () => {
      const url = await start((_req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'model failed to load' } }));
      });
      await failure(transport(url).send(request()));
      expect(servedModels('lab')).toEqual(['qwen3:30b']);
    });

    it('a model is recorded as soon as its request is sent, before any response (N2)', async () => {
      let onReceived!: () => void;
      const received = new Promise<void>((r) => (onReceived = r));
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const url = await start((_req, res) => {
        onReceived();
        void held.then(() => okStream(res));
      });
      const pending = transport(url).send(request());
      await received;
      expect(servedModels('lab')).toEqual(['qwen3:30b']);
      release();
      await pending;
    });

    it('a call aborted while queued on the endpoint semaphore records nothing', async () => {
      const url = await start((_req, res) => okStream(res));
      const holder = await endpointSemaphore(endpoint(url)).acquire();
      const controller = new AbortController();
      const pending = failure(transport(url).send(request({ signal: controller.signal })));
      await sleep(30);
      controller.abort();
      expect(await pending).toBeInstanceOf(errors.AnalysisAbortedError);
      holder();
      expect(seen).toHaveLength(0);
      expect(servedModels('lab')).toEqual([]);
    });

    it('two models sent to one endpoint are both recorded', async () => {
      const url = await start((_req, res) => okStream(res));
      await new OpenAITransport({ endpoint: endpoint(url), apiKey: null, model: 'qwen3:30b' }).send(request());
      await new OpenAITransport({ endpoint: endpoint(url), apiKey: null, model: 'gemma3:12b' }).send(request());
      expect(servedModels('lab')).toEqual(['qwen3:30b', 'gemma3:12b']);
    });

    it("a Test's own transport records its model too, so a {model} unload can name it (N2)", async () => {
      /* PR 3c builds the Test transport the same way, with no opt-out flag: a Test leaves the
         model loaded on the server, so the unload URL needs its name. */
      const url = await start((_req, res) => okStream(res));
      await new OpenAITransport({ endpoint: endpoint(url), apiKey: null, model: 'qwen3:30b' }).send(request());
      expect(seen).toHaveLength(1);
      expect(servedModels('lab')).toEqual(['qwen3:30b']);
    });
  });

  it('maps finish_reason length', async () => {
    const url = await start((_req, res) => {
      sse(res);
      res.write(chunk({ content: '{"a":' }, 'length'));
      res.end(DONE);
    });
    expect(await transport(url).send(request())).toMatchObject({ finish: 'length', text: '{"a":' });
  });

  it('schema mode sends json_schema with strict false', async () => {
    const url = await start((_req, res) => {
      sse(res);
      res.end(chunk({ content: '{}' }, 'stop') + DONE);
    });
    const schema = { type: 'object' };
    await transport(url).send(request({ structuredOutput: { mode: 'schema', name: 'castwright_1-ch1', schema } }));
    expect(seen[0].body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'castwright_1-ch1', schema, strict: false } });
  });
});

describe('OpenAITransport — unreachable', () => {
  /* Host-independent DNS: the resolver's answer is injected through connect.lookup,
     which undici spreads into net.connect (undici/lib/core/connect.js:108-128). No
     machine's resolver can turn ENOTFOUND into EAI_AGAIN here. */
  const resolverAgent = (code: 'ENOTFOUND' | 'EAI_AGAIN', counter: { lookups: number }): Agent => {
    const lookup: LookupFunction = (hostname, _options, callback) => {
      counter.lookups += 1;
      callback(Object.assign(new Error(`getaddrinfo ${code} ${hostname}`), { code, syscall: 'getaddrinfo', hostname }), []);
    };
    const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000, lookup } });
    agents.push(agent);
    return agent;
  };

  it('a refused port → AnalyzerUnreachableError', async () => {
    const url = await start(() => {});
    server!.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    expect(await failure(transport(url).send(request()))).toBeInstanceOf(errors.AnalyzerUnreachableError);
  });

  it('an unresolvable host (ENOTFOUND injected through the resolver) → AnalyzerUnreachableError', async () => {
    const counter = { lookups: 0 };
    const err = await failure(transport('http://castwright-unresolvable.test/v1', {}, null, resolverAgent('ENOTFOUND', counter)).send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerUnreachableError);
    expect(counter.lookups).toBeGreaterThanOrEqual(1);
  });

  it('a DNS hiccup before headers (EAI_AGAIN injected) → retried, then AnalyzerStreamIncompleteError, never unreachable (P21)', async () => {
    const counter = { lookups: 0 };
    const err = await failure(transport('http://castwright-unresolvable.test/v1', {}, null, resolverAgent('EAI_AGAIN', counter)).send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerStreamIncompleteError);
    expect(err).not.toBeInstanceOf(errors.AnalyzerUnreachableError);
    expect(counter.lookups).toBeGreaterThanOrEqual(3);
    /* Q1 — the code survives the retries into the message and the classified failure. */
    expect((err as Error).message).toContain('before a response (EAI_AGAIN)');
    expect(classifyAnalysisFailure(err, 'Endpoint lab (m)').userMessage).toContain('(EAI_AGAIN)');
  });

  it('a server that accepts the connection and closes the socket before writing headers → retried, then AnalyzerStreamIncompleteError, never unreachable (P21)', async () => {
    /* A REAL socket: the request reaches the server, which destroys the socket without
       writing a status line. undici reports SocketError UND_ERR_SOCKET "other side closed". */
    const url = await start((req) => {
      req.socket.destroy();
    });
    const err = await failure(transport(url).send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerStreamIncompleteError);
    expect(err).not.toBeInstanceOf(errors.AnalyzerUnreachableError);
    expect(seen).toHaveLength(3);
  });

  it('an unroutable address with a short connect timeout → AnalyzerUnreachableError', async () => {
    /* Not port 9: undici refuses it immediately as a "bad port" (research fact 10). */
    const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 1_500 } });
    agents.push(agent);
    expect(await failure(transport('http://10.255.255.1:8080/v1', {}, null, agent).send(request()))).toBeInstanceOf(
      errors.AnalyzerUnreachableError,
    );
  }, 10_000);
});

describe('OpenAITransport — timeouts and the ceiling', () => {
  it('a post-connect stall with no headers ends at the ceiling → AnalyzerTimeoutError, semaphore released', async () => {
    const url = await start(() => {});
    const t = transport(url, { requestCeilingMs: 400 });
    const err = await failure(t.send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerTimeoutError);
    expect((err as InstanceType<typeof errors.AnalyzerTimeoutError>).reason).toBe('ceiling');
    expect(endpointSemaphore(endpoint(url)).inFlight).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it('a long silent prefill (headers after 1.5 s) completes before the ceiling', async () => {
    const url = await start(async (_req, res) => {
      await sleep(1_500);
      sse(res);
      res.end(chunk({ content: '{}' }, 'stop') + DONE);
    });
    expect(await transport(url, { requestCeilingMs: 5_000 }).send(request())).toMatchObject({ text: '{}', finish: 'stop' });
  });

  it('CONTROL: the same prefill against a 300 ms headersTimeout Agent is a connect-timeout, never unreachable', async () => {
    const url = await start(async (_req, res) => {
      await sleep(1_500);
      if (res.destroyed) return;
      sse(res);
      res.end(chunk({ content: '{}' }, 'stop') + DONE);
    });
    const agent = new Agent({ headersTimeout: 300, bodyTimeout: 0, connect: { timeout: 10_000 } });
    agents.push(agent);
    const err = await failure(transport(url, {}, null, agent).send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerTimeoutError);
    expect(err).not.toBeInstanceOf(errors.AnalyzerUnreachableError);
  });

  it('headers then silence: the ceiling ends it → AnalyzerTimeoutError, semaphore released', async () => {
    const url = await start((_req, res) => sse(res));
    const err = await failure(transport(url, { requestCeilingMs: 500 }).send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerTimeoutError);
    expect(endpointSemaphore(endpoint(url)).inFlight).toBe(0);
  });

  it('ceiling time is not charged while the call waits on the endpoint semaphore', async () => {
    const url = await start(async (_req, res, n) => {
      await sleep(n === 1 ? 450 : 300);
      sse(res);
      res.end(chunk({ content: '{}' }, 'stop') + DONE);
    });
    const t = transport(url, { concurrency: 1, requestCeilingMs: 600 });
    const results = await Promise.all([t.send(request()), t.send(request())]);
    expect(results.map((r) => r.finish)).toEqual(['stop', 'stop']);
  });
});

describe('OpenAITransport — aborts, incomplete streams, in-stream errors', () => {
  it('a caller abort mid-stream → AnalysisAbortedError, partial text never returned', async () => {
    const url = await start(async (_req, res) => {
      sse(res);
      res.write(chunk({ content: '{"partial":' }));
      await sleep(2_000);
      if (!res.destroyed) res.end(chunk({ content: '1}' }, 'stop') + DONE);
    });
    const ac = new AbortController();
    const err = await failure(
      transport(url).send(request({ signal: ac.signal, call: { onChunk: () => ac.abort() } })),
    );
    expect(err).toBeInstanceOf(errors.AnalysisAbortedError);
  });

  it('a stream that closes without finish_reason → AnalyzerStreamIncompleteError after 3 attempts', async () => {
    const url = await start((_req, res) => {
      sse(res);
      res.write(chunk({ content: '{"a":1' }));
      res.end();
    });
    expect(await failure(transport(url).send(request()))).toBeInstanceOf(errors.AnalyzerStreamIncompleteError);
    expect(seen).toHaveLength(3);
  });

  it('a socket dropped mid-stream → AnalyzerStreamIncompleteError (retried)', async () => {
    const url = await start(async (_req, res) => {
      sse(res);
      res.write(chunk({ content: '{"a":' }));
      await sleep(30);
      res.destroy();
    });
    expect(await failure(transport(url).send(request()))).toBeInstanceOf(errors.AnalyzerStreamIncompleteError);
    expect(seen).toHaveLength(3);
  });

  it('a socket error carrying ECONNREFUSED AFTER headers arrive → never AnalyzerUnreachableError: the headers already proved the endpoint is up (P21, T4)', async () => {
    /* The client socket is held in a closure so the server can destroy it AFTER the headers
       have gone out, with a code the pre-header classifier treats as "unreachable". Only the
       headersReceived guard in connectionLevel keeps this out of AnalyzerUnreachableError. */
    let clientSocket: import('node:net').Socket | undefined;
    const url = await start((_req, res) => {
      sse(res);
      res.write(chunk({ content: '{"a":' }));
      setTimeout(() => clientSocket?.destroy(Object.assign(new Error('read ECONNREFUSED'), { code: 'ECONNREFUSED' })), 50);
    });
    const dropAfterHeaders = new Agent({
      headersTimeout: 0,
      bodyTimeout: 0,
      connect: (opts, callback) => {
        const socket = netConnect({ host: opts.hostname, port: Number(opts.port) });
        clientSocket = socket;
        socket.once('connect', () => callback(null, socket));
      },
    });
    agents.push(dropAfterHeaders);
    const err = await failure(transport(url, {}, null, dropAfterHeaders).send(request()));
    expect(err).not.toBeInstanceOf(errors.AnalyzerUnreachableError);
    expect(err).toBeInstanceOf(errors.AnalyzerStreamIncompleteError);
  });

  it('an in-stream error event → AnalyzerHttpError(0), not retried', async () => {
    const url = await start((_req, res) => {
      sse(res);
      res.write(chunk({ content: 'partial' }));
      res.end(`data: ${JSON.stringify({ error: { message: 'context exceeded', type: 'exceed_context_size_error', code: 400 } })}\n\n`);
    });
    const err = await failure(transport(url).send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerHttpError);
    expect((err as InstanceType<typeof errors.AnalyzerHttpError>).httpStatus).toBe(0);
    expect(seen).toHaveLength(1);
  });
});

describe('OpenAITransport — HTTP statuses', () => {
  const jsonError = (res: ServerResponse, status: number, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ error: { message: `bad thing ${status}`, type: 'invalid_request_error' } }));
  };

  it.each([400, 401])('%i → AnalyzerHttpError with that status and the body excerpt, not retried', async (status) => {
    const url = await start((_req, res) => jsonError(res, status));
    const err = await failure(transport(url).send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerHttpError);
    expect((err as InstanceType<typeof errors.AnalyzerHttpError>).httpStatus).toBe(status);
    expect((err as InstanceType<typeof errors.AnalyzerHttpError>).bodyExcerpt).toContain(`bad thing ${status}`);
    expect(seen).toHaveLength(1);
  });

  it('503 is retried and a later success returns', async () => {
    const url = await start((_req, res, n) => {
      if (n === 1) return jsonError(res, 503);
      sse(res);
      res.end(chunk({ content: '{}' }, 'stop') + DONE);
    });
    expect(await transport(url).send(request())).toMatchObject({ finish: 'stop' });
    expect(seen).toHaveLength(2);
  });

  it('429 with retry-after is retried and a later success returns', async () => {
    const url = await start((_req, res, n) => {
      if (n === 1) return jsonError(res, 429, { 'retry-after': '0' });
      sse(res);
      res.end(chunk({ content: '{}' }, 'stop') + DONE);
    });
    expect(await transport(url).send(request())).toMatchObject({ finish: 'stop' });
    expect(seen).toHaveLength(2);
  });

  it('a 502 whose body carries code ECONNREFUSED → AnalyzerHttpError(502) after the 5xx retries, never AnalyzerUnreachableError (P21)', async () => {
    const url = await start((_req, res) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'ECONNREFUSED', message: 'upstream down' } }));
    });
    const err = await failure(transport(url).send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerHttpError);
    expect(err).not.toBeInstanceOf(errors.AnalyzerUnreachableError);
    expect((err as InstanceType<typeof errors.AnalyzerHttpError>).httpStatus).toBe(502);
    expect(seen).toHaveLength(3);
  });

  it('a 500 whose message is "fetch failed" → AnalyzerHttpError(500), never AnalyzerUnreachableError (P21)', async () => {
    const url = await start((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fetch failed' } }));
    });
    const err = await failure(transport(url).send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerHttpError);
    expect(err).not.toBeInstanceOf(errors.AnalyzerUnreachableError);
    expect((err as InstanceType<typeof errors.AnalyzerHttpError>).httpStatus).toBe(500);
  });

  it('a 503 body echoing the endpoint key and the saved Gemini key: neither reaches the error, the classified failure or any log line (P22)', async () => {
    const savedEnvKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    _setUserSettingsCacheForTest({ geminiApiKey: 'AIzaSy-echo-secret-9876' });
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 }))).join(' '));
      }),
    );
    try {
      const url = await start((_req, res) => {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream refused sk-echo-secret-1234 and AIzaSy-echo-secret-9876' } }));
      });
      const err = await failure(transport(url, {}, 'sk-echo-secret-1234').send(request()));
      expect(err).toBeInstanceOf(errors.AnalyzerHttpError);
      /* What the analysis route does with it: `[analysis] failed` logs the error's name,
         message and status (routes/analysis.ts:6437-6447), then classifyAnalysisFailure
         builds the SSE error event and the saved chapter error. Both read only what is
         asserted below. `lines` holds only what the code under test logged. */
      const classified = classifyAnalysisFailure(err, 'Endpoint lab (qwen3:30b)');
      const surfaces = [
        (err as Error).message,
        (err as InstanceType<typeof errors.AnalyzerHttpError>).bodyExcerpt,
        inspect(err, { depth: 8 }),
        classified.userMessage,
        classified.detail ?? '',
        classified.remediation,
        ...lines,
      ];
      for (const s of surfaces) {
        expect(s).not.toContain('sk-echo-secret-1234');
        expect(s).not.toContain('AIzaSy-echo-secret-9876');
      }
      expect((err as Error).message).toContain('[redacted]');
      /* A line the code under test wrote: withTransportRetry's 5xx retry line (W1 Task 1.9,
         `[${logTag}] transient ${describeStatus(err)} — retrying …`, logTag `openai:lab`).
         The loop above proved no line — this one included — carries either key. */
      expect(lines.some((l) => l.startsWith('[openai:lab] transient '))).toBe(true);
    } finally {
      for (const spy of spies) spy.mockRestore();
      _resetUserSettingsCache();
      if (savedEnvKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = savedEnvKey;
    }
  });
});

describe('OpenAITransport — reasoning deltas and the idle watchdog', () => {
  it.each([
    [{ reasoning_content: 'thinking' }],
    [{ reasoning: 'thinking' }],
    [{ reasoning_details: [{ type: 'reasoning.text', text: 'thinking' }] }],
  ])('%j keeps the watchdog alive, feeds the heartbeat with the answer bytes unchanged, sets reasoningSeen, and never enters the text', async (delta) => {
    process.env.GEMINI_STREAM_IDLE_MS = '300';
    const url = await start(async (_req, res) => {
      sse(res);
      for (let i = 0; i < 4; i += 1) {
        res.write(chunk(delta));
        await sleep(200);
      }
      res.end(chunk({ content: '{}' }, 'stop') + DONE);
    });
    const beats: Array<{ bytes: number; text: string }> = [];
    const r = await transport(url).send(
      request({ call: { onChunk: (i) => beats.push({ bytes: i.receivedBytes, text: i.receivedText }) } }),
    );
    expect(r).toMatchObject({ text: '{}', reasoningSeen: true, finish: 'stop' });
    /* Spec §1: reasoning deltas feed the route heartbeat — same convention as
       wave 2's Gemini thought-only chunk: onChunk fires, answer bytes unchanged. */
    expect(beats).toEqual([
      { bytes: 0, text: '' },
      { bytes: 0, text: '' },
      { bytes: 0, text: '' },
      { bytes: 0, text: '' },
      { bytes: 2, text: '{}' },
    ]);
    expect(seen).toHaveLength(1);
  });

  it('silence past the idle window after the first delta → AnalyzerStreamIncompleteError', async () => {
    process.env.GEMINI_STREAM_IDLE_MS = '300';
    const url = await start(async (_req, res) => {
      sse(res);
      res.write(chunk({ content: '{' }));
      await sleep(1_500);
      if (!res.destroyed) res.end(chunk({ content: '}' }, 'stop') + DONE);
    });
    expect(await failure(transport(url).send(request()))).toBeInstanceOf(errors.AnalyzerStreamIncompleteError);
  });

  it('a finish_reason, then silence past the idle window before [DONE]: the answer is returned, not retried (P25)', async () => {
    process.env.GEMINI_STREAM_IDLE_MS = '300';
    const url = await start(async (_req, res) => {
      sse(res);
      res.write(chunk({ content: '{"a":1}' }));
      res.write(chunk({}, 'stop'));
      await sleep(1_500);
      if (!res.destroyed) res.end(DONE);
    });
    expect(await transport(url).send(request())).toMatchObject({ text: '{"a":1}', finish: 'stop' });
    expect(seen).toHaveLength(1);
  });

  it('a finish_reason, then the socket drops before [DONE]: the answer is returned, not retried (P25)', async () => {
    const url = await start(async (_req, res) => {
      sse(res);
      res.write(chunk({ content: '{"a":1}' }));
      res.write(chunk({}, 'stop'));
      await sleep(50);
      res.destroy();
    });
    expect(await transport(url).send(request())).toMatchObject({ text: '{"a":1}', finish: 'stop' });
    expect(seen).toHaveLength(1);
  });
});

describe('OpenAITransport — credentials', () => {
  it('sends the key as a Bearer token', async () => {
    const url = await start((_req, res) => {
      sse(res);
      res.end(chunk({ content: '{}' }, 'stop') + DONE);
    });
    await transport(url, {}, 'sk-contract-1234').send(request());
    expect(seen[0].headers.authorization).toBe('Bearer sk-contract-1234');
  });

  it('sends no Authorization header without a key, and none of the host OPENAI_API_KEY / org / project', async () => {
    process.env.OPENAI_API_KEY = 'sk-env-leak-1234';
    process.env.OPENAI_ORG_ID = 'org-leak';
    process.env.OPENAI_PROJECT_ID = 'proj-leak';
    try {
      const url = await start((_req, res) => {
        sse(res);
        res.end(chunk({ content: '{}' }, 'stop') + DONE);
      });
      await transport(url).send(request());
      expect(seen[0].headers.authorization).toBeUndefined();
      expect(seen[0].headers['openai-organization']).toBeUndefined();
      expect(seen[0].headers['openai-project']).toBeUndefined();
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_ORG_ID;
      delete process.env.OPENAI_PROJECT_ID;
    }
  });

  it('OPENAI_CUSTOM_HEADERS in the host env never reaches the wire; the endpoint key does (P22)', async () => {
    /* The SDK merges this env into every request after its own auth header (client.mjs:240-249). */
    process.env.OPENAI_CUSTOM_HEADERS = 'Authorization: Bearer stolen\nX-Leak: 1';
    try {
      const url = await start((_req, res) => {
        sse(res);
        res.end(chunk({ content: '{}' }, 'stop') + DONE);
      });
      await transport(url, {}, 'sk-contract-1234').send(request());
      await transport(url).send(request());
      expect(seen).toHaveLength(2);
      expect(seen[0].headers.authorization).toBe('Bearer sk-contract-1234');
      expect(seen[1].headers.authorization).toBeUndefined();
      for (const s of seen) expect(s.headers['x-leak']).toBeUndefined();
    } finally {
      delete process.env.OPENAI_CUSTOM_HEADERS;
    }
  });

  it('allowlistedFetch sends the key only to the origin it was resolved for, and drops a caller-supplied Authorization (P22)', async () => {
    const url = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await allowlistedFetch('sk-origin-1234', 'http://127.0.0.1:1')(`${url}/models`, {
      headers: { authorization: 'Bearer sk-origin-1234', 'x-leak': '1' },
    });
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].headers['x-leak']).toBeUndefined();
    await allowlistedFetch('sk-origin-1234', new URL(url).origin)(`${url}/models`, {});
    expect(seen[1].headers.authorization).toBe('Bearer sk-origin-1234');
  });

  it('sends only the fixed accept, content-type and user-agent values and no x-stainless-* header, whatever OPENAI_CUSTOM_HEADERS says (P22)', async () => {
    process.env.OPENAI_CUSTOM_HEADERS = 'X-Stainless-Lang: evil\nUser-Agent: evil\nAccept: evil';
    try {
      const url = await start((_req, res) => {
        sse(res);
        res.end(chunk({ content: '{}' }, 'stop') + DONE);
      });
      await transport(url).send(request());
      const h = seen[0].headers;
      expect(ANALYZER_USER_AGENT).toBe('castwright-analyzer');
      expect(h['user-agent']).toBe('castwright-analyzer');
      expect(h.accept).toBe('application/json');
      expect(h['content-type']).toBe('application/json');
      expect(Object.keys(h).filter((name) => name.startsWith('x-stainless-'))).toEqual([]);
      expect(Object.values(h).join('\n')).not.toContain('evil');
    } finally {
      delete process.env.OPENAI_CUSTOM_HEADERS;
    }
  });

  it('a saved key the HTTP client rejects as a header value (a line break, saved before the write rule) never surfaces in the thrown error, inspect() or the classified failure (P22)', async () => {
    const url = await start((_req, res) => {
      sse(res);
      res.end(chunk({ content: '{}' }, 'stop') + DONE);
    });
    /* undici throws `Headers.append: "Bearer <key>" is an invalid header value.` before
       dispatching; the SDK wraps it as APIConnectionError's cause (client.mjs:817-820). */
    const err = await failure(transport(url, {}, 'sk-inject-secret-1\nX-Injected: 1').send(request()));
    expect(err).toBeInstanceOf(errors.AnalyzerTransportError);
    expect(seen).toHaveLength(0);
    const classified = classifyAnalysisFailure(err, 'Endpoint lab (qwen3:30b)');
    for (const s of [(err as Error).message, (err as Error).stack ?? '', inspect(err, { depth: 8 }), classified.userMessage, classified.detail ?? '']) {
      expect(s).not.toContain('sk-inject-secret-1');
    }
  });
});
