import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { Analyzer } from './types.js';
import { readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';
import type { AnalyzerReasoningOverflowError } from './errors.js';

process.env.GEMINI_RETRY_BACKOFFS_MS = '10,10';

const { OpenAIAnalyzer, openAIRequestSettings } = await import('./openai.js');
const { FallbackAnalyzer } = await import('./index.js');
const { OPENAI_RETRY_POLICY, OPENAI_DEFAULT_TEMPERATURE, OPENAI_RETRY_TEMPERATURE } = await import('./runner/retry-policy.js');
const { _resetEndpointRuntimeForTest } = await import('./transports/endpoint-runtime.js');
const { geminiRateLimiter } = await import('./rate-limit.js');
const errors = await import('./errors.js');
const { classifyAnalysisFailure } = await import('../routes/failure-taxonomy.js');

const HANDOFF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'handoff');
const ID = 'm_openai_analyzer';
const VALID = JSON.stringify({
  characters: [
    { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator', evidence: [{ quote: 'a' }, { quote: 'bb' }, { quote: 'ccc' }] },
  ],
});

let server: Server | undefined;
let bodies: Array<{ messages: Array<{ role: string; content: string }>; temperature: number; response_format?: unknown }> = [];

async function start(reply: (n: number, res: ServerResponse, req: IncomingMessage) => void): Promise<string> {
  bodies = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      reply(bodies.length, res, req);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/v1`;
}

const streamText = (res: ServerResponse, content: string) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
};

const endpoint = (baseUrl: string, over: Partial<AnalyzerEndpoint> = {}): AnalyzerEndpoint => ({
  id: 'lab',
  name: 'Lab',
  baseUrl,
  gpu: 'any',
  concurrency: 1,
  requestCeilingMs: 10_000,
  structuredOutput: 'schema',
  reasoningStyle: 'not_controllable',
  reasoning: 'model-default',
  maxOutputTokens: 0,
  contextTokens: 32_768,
  ...over,
});

beforeEach(() => {
  _resetEndpointRuntimeForTest();
  geminiRateLimiter._reset();
});
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});
afterAll(async () => {
  delete process.env.GEMINI_RETRY_BACKOFFS_MS;
  for (const sub of ['inbox', 'outbox']) {
    const dir = resolve(HANDOFF_ROOT, sub);
    const names = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(names.filter((n) => n.startsWith(ID)).map((n) => rm(resolve(dir, n), { force: true })));
  }
});

describe('OpenAIAnalyzer (#3084 PR 3b)', () => {
  it('runs a stage over the endpoint with the OpenAI-adapted schema', async () => {
    const url = await start((_n, res) => streamText(res, VALID));
    const out = await new OpenAIAnalyzer({ endpoint: endpoint(url), apiKey: null, model: 'qwen3:30b' }).runStage1Chapter(ID, 1, '# p', {});
    expect(out.characters.map((c) => c.id)).toEqual(['narrator']);
    expect(bodies[0].temperature).toBe(OPENAI_DEFAULT_TEMPERATURE);
    const format = bodies[0].response_format as { type: string; json_schema: { schema: Record<string, unknown>; strict: boolean } };
    expect(format.type).toBe('json_schema');
    expect(format.json_schema.strict).toBe(false);
    expect(format.json_schema.schema).not.toHaveProperty('$schema');
  });

  it('invalid JSON: retries without the assistant turn at the retry temperature', async () => {
    const url = await start((n, res) => streamText(res, n === 1 ? 'not json' : VALID));
    await new OpenAIAnalyzer({ endpoint: endpoint(url), apiKey: null, model: 'qwen3:30b' }).runStage1Chapter(ID, 1, '# p', {});
    expect(bodies).toHaveLength(2);
    expect(bodies[1].temperature).toBe(OPENAI_RETRY_TEMPERATURE);
    expect(bodies[1].messages.some((m) => m.role === 'assistant')).toBe(false);
  });

  it('schema failure: replays the output with a correction message at the default temperature', async () => {
    const url = await start((n, res) => streamText(res, n === 1 ? '{"characters":[{"id":"narrator"}]}' : VALID));
    await new OpenAIAnalyzer({ endpoint: endpoint(url), apiKey: null, model: 'qwen3:30b' }).runStage1Chapter(ID, 1, '# p', {});
    expect(bodies).toHaveLength(2);
    expect(bodies[1].temperature).toBe(OPENAI_DEFAULT_TEMPERATURE);
    expect(bodies[1].messages.at(-2)).toEqual({ role: 'assistant', content: '{"characters":[{"id":"narrator"}]}' });
    expect(bodies[1].messages.at(-1)?.content).toContain('failed schema validation');
  });

  it('a 400 fails as analyzer-request-rejected with no second request', async () => {
    const url = await start((_n, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: "'response_format.type' must be 'json_schema' or 'text'" } }));
    });
    const err = await new OpenAIAnalyzer({ endpoint: endpoint(url, { structuredOutput: 'json' }), apiKey: null, model: 'm' })
      .runStage1Chapter(ID, 1, '# p', {})
      .then(() => null, (e: unknown) => e);
    expect(bodies).toHaveLength(1);
    const classified = classifyAnalysisFailure(err, 'Endpoint lab (m)');
    expect(classified.code).toBe('analyzer-request-rejected');
    expect(classified.remediation).toContain("the endpoint's Structured output field");
  });

  it('two invalid replies fail as AnalyzerInvalidOutputError(openai) with today\'s message shape', async () => {
    const url = await start((_n, res) => streamText(res, 'not json'));
    const err = await new OpenAIAnalyzer({ endpoint: endpoint(url), apiKey: null, model: 'qwen3:30b' })
      .runStage1Chapter(ID, 1, '# p', {})
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(errors.AnalyzerInvalidOutputError);
    expect((err as Error).message).toMatch(/^Endpoint qwen3:30b 1-ch1 failed validation after retry: invalid-json — /);
  });

  it('escalation returns null on unusable output but rethrows unreachable', async () => {
    expect(OPENAI_RETRY_POLICY.escalationRethrows(new errors.AnalyzerUnreachableError('x', 'openai'))).toBe(true);
    expect(OPENAI_RETRY_POLICY.escalationRethrows(new errors.AnalysisAbortedError('x'))).toBe(true);
    expect(OPENAI_RETRY_POLICY.escalationRethrows(new Error('bad json'))).toBe(false);
    expect(OPENAI_RETRY_POLICY.writesRawAttempts).toBe(true);
  });

  it('resolves a numeric output cap for Auto and manual endpoints — never undefined (P24)', () => {
    /* The wire cannot tell `undefined` from Auto's number (the transport takes the same
       per-request bound either way), so the resolved setting is asserted directly. */
    expect(openAIRequestSettings(endpoint('http://127.0.0.1:8080/v1'))).toEqual({ structuredOutput: 'schema', maxOutputTokens: 29_491 });
    expect(openAIRequestSettings(endpoint('http://127.0.0.1:8080/v1'), 8_192).maxOutputTokens).toBe(8_192);
    expect(openAIRequestSettings(endpoint('http://127.0.0.1:8080/v1', { maxOutputTokens: 4_096 })).maxOutputTokens).toBe(4_096);
  });

  it('a 502 whose body says ECONNREFUSED fails as that HTTP error and never falls back to Gemini (P21)', async () => {
    const url = await start((_n, res) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'ECONNREFUSED', message: 'upstream down' } }));
    });
    const fallbackStage = vi.fn();
    const fallback = { runStage1Chapter: fallbackStage } as unknown as Analyzer;
    const primary = new OpenAIAnalyzer({ endpoint: endpoint(url), apiKey: null, model: 'qwen3:30b' });
    const err = await new FallbackAnalyzer(primary, fallback)
      .runStage1Chapter(ID, 1, '# p', {})
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(errors.AnalyzerHttpError);
    expect(err).not.toBeInstanceOf(errors.AnalyzerUnreachableError);
    expect(fallbackStage).not.toHaveBeenCalled();
  });

  it('a server that closes the socket before writing headers is retried and never falls back to Gemini (P21)', async () => {
    /* A REAL socket: the server accepts the connection, reads the request, and
       destroys the socket without writing headers — an up server that reset. */
    const url = await start((_n, _res, req) => {
      req.socket.destroy();
    });
    const fallbackStage = vi.fn();
    const fallback = { runStage1Chapter: fallbackStage } as unknown as Analyzer;
    const primary = new OpenAIAnalyzer({ endpoint: endpoint(url), apiKey: null, model: 'qwen3:30b' });
    const err = await new FallbackAnalyzer(primary, fallback)
      .runStage1Chapter(ID, 1, '# p', {})
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(errors.AnalyzerStreamIncompleteError);
    expect(err).not.toBeInstanceOf(errors.AnalyzerUnreachableError);
    expect(fallbackStage).not.toHaveBeenCalled();
    expect(bodies).toHaveLength(3);
  });

  it('reasoning deltas then an empty length finish stop the run as AnalyzerReasoningOverflowError, never a split (P20)', async () => {
    const url = await start((_n, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'thinking' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    const err = await new OpenAIAnalyzer({ endpoint: endpoint(url), apiKey: null, model: 'qwen3:30b' })
      .runStage1Chapter(ID, 1, '# p', {})
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(errors.AnalyzerReasoningOverflowError);
    expect(err).not.toBeInstanceOf(errors.AnalyzerTruncatedError);
    expect(classifyAnalysisFailure(err, 'Endpoint lab (qwen3:30b)').code).toBe('analyzer-reasoning-overflow');
  });

  /* #3084 F7 (Task 3b.1b) — the runner raising the overflow has no endpoint; this class
     stamps its own id. Both surfaces are real: a thrown first attempt, and an escalation
     that REPORTS through onReasoningOverflow instead of throwing. */
  const overflowReply = (_n: number, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'thinking' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  };

  it('a thrown reasoning overflow carries the endpoint id, and classification names it in the fixes (3b.1b)', async () => {
    const url = await start(overflowReply);
    const err = await new OpenAIAnalyzer({ endpoint: endpoint(url), apiKey: null, model: 'qwen3:30b' })
      .runStage1Chapter(ID, 1, '# p', {})
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(errors.AnalyzerReasoningOverflowError);
    expect((err as AnalyzerReasoningOverflowError).endpointId).toBe('lab');
    const fixes = classifyAnalysisFailure(err, 'Endpoint lab (qwen3:30b)').fixes ?? [];
    expect(fixes.some((f) => 'endpointField' in f && f.endpointField?.endpointId === 'lab')).toBe(true);
  });

  it('an escalation-path overflow is stamped with the endpoint id before it is reported onward (3b.1b)', async () => {
    const url = await start(overflowReply);
    const overflows: AnalyzerReasoningOverflowError[] = [];
    const result = await new OpenAIAnalyzer({ endpoint: endpoint(url), apiKey: null, model: 'qwen3:30b' }).runAttributionEscalation(
      ID,
      1,
      0,
      '# p',
      { onReasoningOverflow: (e) => overflows.push(e) },
    );
    expect(result).toBeNull();
    expect(overflows).toHaveLength(1);
    expect(overflows[0]).toBeInstanceOf(errors.AnalyzerReasoningOverflowError);
    expect(overflows[0].endpointId).toBe('lab');
  });
});
