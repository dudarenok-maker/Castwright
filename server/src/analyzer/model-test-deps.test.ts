import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { modelTestDepsFor, GeminiKeyMissingForTestError } from './model-test-deps.js';
import { AnalysisAbortedError, AnalyzerEndpointMissingError, AnalyzerKeyOriginError } from './errors.js';
import { OpenAITransport } from './transports/openai-transport.js';
import { OllamaTransport } from './transports/ollama-transport.js';
import { endpointSemaphore, servedModels, _resetEndpointRuntimeForTest } from './transports/endpoint-runtime.js';
import { resolveCapacity } from './capacity.js';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '../workspace/user-settings.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';
import { getResolvedOllamaUrl } from '../config/ollama-resolved.js';

const lab = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 32768, structuredOutput: 'json' });
const settings = (over: Partial<UserSettings> = {}): UserSettings => ({ ...DEFAULT_USER_SETTINGS, analyzerEndpoints: [lab], analyzerEndpointKeys: {}, ...over });

beforeEach(() => _resetEndpointRuntimeForTest());
afterEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.ANALYZER_NUM_PREDICT;
});

describe('modelTestDepsFor (#3084)', () => {
  it('endpoint model → OpenAITransport, the endpoint URL, its own structured-output mode and its context as the probe limit', () => {
    const d = modelTestDepsFor('openai:lab::qwen3-30b', settings());
    expect(d.transport).toBeInstanceOf(OpenAITransport);
    expect(d.serverUrl).toBe('http://127.0.0.1:8080/v1');
    expect(d.configuredMode).toBe('json');
    expect(d.probeLimits()).toEqual({ contextTokens: 32768, maxOutputTokens: null });
  });

  const PROBE_REQUEST = {
    system: 's',
    messages: [{ role: 'user' as const, content: 'hi' }],
    structuredOutput: { mode: 'off' as const },
    temperature: 0,
    estimatedInputTokens: 10,
    call: {},
  };

  it('the Test transport records the model it sends to, so a {model} unload can name it (N2)', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { content: '{}' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const { port } = server.address() as AddressInfo;
      const local = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: `http://127.0.0.1:${port}/v1`, gpu: 'any', contextTokens: 32768 });
      const d = modelTestDepsFor('openai:lab::qwen3-30b', settings({ analyzerEndpoints: [local] }));
      const result = await d.transport.send(PROBE_REQUEST);
      expect(result.finish).toBe('stop');
      /* A Test leaves the model loaded, so it is a valid unload target (P3, N2). */
      expect(servedModels('lab')).toEqual(['qwen3-30b']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("a Test queued on the endpoint's concurrency semaphore stops as soon as the route aborts, and records nothing", async () => {
    /* The route passes its client-disconnect signal into every request (Task 3c.4). 3b's
       transport hands that signal to CountSemaphore.acquire({ signal }), so a Test that is
       still queued behind a concurrency-1 endpoint's in-flight call stops at the abort
       instead of waiting for the holder. */
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { content: '{}' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const { port } = server.address() as AddressInfo;
      const local = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: `http://127.0.0.1:${port}/v1`, gpu: 'any', contextTokens: 32768, concurrency: 1 });
      const d = modelTestDepsFor('openai:lab::qwen3-30b', settings({ analyzerEndpoints: [local] }));
      const holder = await endpointSemaphore(local).acquire();
      const controller = new AbortController();
      const pending = d.transport.send({ ...PROBE_REQUEST, signal: controller.signal });
      await new Promise((r) => setTimeout(r, 30));
      controller.abort();
      await expect(pending).rejects.toBeInstanceOf(AnalysisAbortedError);
      holder();
      expect(hits).toBe(0);
      expect(servedModels('lab')).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('A3 — only an Ollama model gets a modelDigest dep', () => {
    expect(modelTestDepsFor('qwen3.5:4b', settings()).modelDigest).toBeTypeOf('function');
    expect(modelTestDepsFor('openai:lab::qwen3-30b', settings()).modelDigest).toBeUndefined();
    process.env.GEMINI_API_KEY = 'k';
    expect(modelTestDepsFor('gemini-3.6-flash', settings()).modelDigest).toBeUndefined();
  });

  it("Ollama's probe limit is its num_ctx, with no output cap by default and ANALYZER_NUM_PREDICT when set", () => {
    const context = resolveCapacity({ engine: 'local', model: 'qwen3.5:4b' }).contextTokens;
    expect(modelTestDepsFor('qwen3.5:4b', settings()).probeLimits()).toEqual({ contextTokens: context, maxOutputTokens: null });
    process.env.ANALYZER_NUM_PREDICT = '4096';
    expect(modelTestDepsFor('qwen3.5:4b', settings()).probeLimits()).toEqual({ contextTokens: context, maxOutputTokens: 4096 });
  });

  it("Gemini's probe limit is its resolved Auto output cap (8192 while the model list is unavailable)", () => {
    process.env.GEMINI_API_KEY = 'k';
    expect(modelTestDepsFor('gemini-3.6-flash', settings()).probeLimits().maxOutputTokens).toBe(8192);
  });

  it('a missing endpoint throws AnalyzerEndpointMissingError', () => {
    expect(() => modelTestDepsFor('openai:gone::m', settings())).toThrow(AnalyzerEndpointMissingError);
  });

  it('a key bound to another origin throws AnalyzerKeyOriginError before any transport exists', () => {
    expect(() =>
      modelTestDepsFor('openai:lab::m', settings({ analyzerEndpointKeys: { lab: { origin: 'http://10.0.0.5:8080', key: 'k' } } })),
    ).toThrow(AnalyzerKeyOriginError);
  });

  it('Ollama model → OllamaTransport and the Ollama URL', () => {
    const d = modelTestDepsFor('qwen3.5:4b', settings());
    expect(d.transport).toBeInstanceOf(OllamaTransport);
    expect(d.serverUrl).toBe(getResolvedOllamaUrl());
  });

  it("a Gemini model's Test record is filed under serverUrl 'gemini' — the key preflight and the catalog look it up by (#3084)", () => {
    process.env.GEMINI_API_KEY = 'k';
    expect(modelTestDepsFor('gemini-3.6-flash', settings()).serverUrl).toBe('gemini');
  });

  it('Gemini model without a key throws GeminiKeyMissingForTestError', () => {
    expect(() => modelTestDepsFor('gemini-3.6-flash', settings())).toThrow(GeminiKeyMissingForTestError);
  });

  it('redact removes the endpoint key and every saved analyzer secret, so 3c.4 caps redacted text (P22)', () => {
    process.env.GEMINI_API_KEY = 'gk-test-secret-0001';
    const d = modelTestDepsFor(
      'openai:lab::m',
      settings({ analyzerEndpointKeys: { lab: { origin: 'http://127.0.0.1:8080', key: 'sk-lab-test-secret-01' } } }),
    );
    expect(d.redact?.('401 sk-lab-test-secret-01 / gk-test-secret-0001')).toBe('401 [redacted] / [redacted]');
  });
});
