import { describe, it, expect, beforeAll, afterEach, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import type { GoogleGenAI } from '@google/genai';
import { OllamaTransport } from './ollama-transport.js';
import { OpenAITransport } from './openai-transport.js';
import { GeminiTransport, mergeGeminiThinkingConfig } from './gemini-transport.js';
import { analyzerEndpointSchema } from '../../workspace/analyzer-endpoints.js';
import { geminiRateLimiter } from '../rate-limit.js';
import type { TransportRequest } from '../runner/transport.js';
import type { ReasoningLevel } from '../reasoning.js';

const OLLAMA_OK =
  JSON.stringify({ model: 'q:4b', message: { role: 'assistant', content: '{"ok":true}' }, done: false }) + '\n' +
  JSON.stringify({ model: 'q:4b', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n';
const sseChunk = (delta: object, finish: string | null) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const OPENAI_OK = sseChunk({ role: 'assistant', content: '{"ok":true}' }, null) + sseChunk({}, 'stop') + 'data: [DONE]\n\n';

let server: Server | null = null;
const bodies: Array<Record<string, unknown>> = [];
async function startCapture(contentType: string, payload: string): Promise<string> {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(payload);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
const dispatcher = () => new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000 } });
const req = (reasoning: ReasoningLevel | undefined): TransportRequest => ({
  system: 'sys', messages: [{ role: 'user', content: 'p' }], structuredOutput: { mode: 'json' },
  temperature: 0.2, reasoning, estimatedInputTokens: 10, call: {},
});

beforeAll(() => { process.env.CASTWRIGHT_VRAM_SAMPLE = '0'; });
beforeEach(() => { bodies.length = 0; geminiRateLimiter._reset(); });
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>((r) => server!.close(() => r())); server = null; }
});

describe('Ollama wire', () => {
  it('undefined reasoning keeps think:false (pre-W5 behaviour)', async () => {
    const url = await startCapture('application/x-ndjson', OLLAMA_OK);
    await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send(req(undefined));
    expect(bodies[0].think).toBe(false);
  });
  it.each<[ReasoningLevel, unknown]>([['off', false], ['on', true], ['medium', 'medium']])('%s sends think=%s', async (level, think) => {
    const url = await startCapture('application/x-ndjson', OLLAMA_OK);
    await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send(req(level));
    expect(bodies[0].think).toEqual(think);
  });
  it('model-default omits think entirely', async () => {
    const url = await startCapture('application/x-ndjson', OLLAMA_OK);
    await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send(req('model-default'));
    expect('think' in bodies[0]).toBe(false);
  });
});

describe('Ollama free-text (persona) wire — W4 non-streaming branch', () => {
  const PERSONA_OK = JSON.stringify({ message: { role: 'assistant', content: 'A warm, low voice for audiobook narration.' }, done: true, done_reason: 'stop' });
  const freeTextReq = (reasoning: ReasoningLevel | undefined): TransportRequest => ({ ...req(reasoning), freeText: { onCpu: false, keepAlive: 0 } });
  it('undefined reasoning keeps think:false on the persona call', async () => {
    const url = await startCapture('application/json', PERSONA_OK);
    await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send(freeTextReq(undefined));
    expect(bodies[0].stream).toBe(false);
    expect(bodies[0].think).toBe(false);
  });
  it('a saved level reaches the persona call; model-default omits think', async () => {
    const url = await startCapture('application/json', PERSONA_OK);
    const t = new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() });
    await t.send(freeTextReq('on'));
    await t.send(freeTextReq('high'));
    await t.send(freeTextReq('model-default'));
    expect(bodies[0].think).toBe(true);
    expect(bodies[1].think).toBe('high');
    expect('think' in bodies[2]).toBe(false);
    expect(bodies.every((b) => b.stream === false)).toBe(true);
  });
});

describe('OpenAI-compatible wire', () => {
  const endpointAt = (base: string, reasoningStyle: 'reasoning_effort' | 'enable_thinking' | 'not_controllable') =>
    analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: `${base}/v1`, gpu: 'none', contextTokens: 32768, reasoningStyle });
  it('reasoning_effort none is sent verbatim', async () => {
    const base = await startCapture('text/event-stream', OPENAI_OK);
    await new OpenAITransport({ endpoint: endpointAt(base, 'reasoning_effort'), apiKey: null, model: 'm', dispatcher: dispatcher() }).send(req('none'));
    expect(bodies[0].reasoning_effort).toBe('none');
    expect('chat_template_kwargs' in bodies[0]).toBe(false);
  });
  it('enable_thinking off sends chat_template_kwargs.enable_thinking=false', async () => {
    const base = await startCapture('text/event-stream', OPENAI_OK);
    await new OpenAITransport({ endpoint: endpointAt(base, 'enable_thinking'), apiKey: null, model: 'm', dispatcher: dispatcher() }).send(req('off'));
    expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect('reasoning_effort' in bodies[0]).toBe(false);
  });
  it('model-default sends neither field', async () => {
    const base = await startCapture('text/event-stream', OPENAI_OK);
    await new OpenAITransport({ endpoint: endpointAt(base, 'reasoning_effort'), apiKey: null, model: 'm', dispatcher: dispatcher() }).send(req('model-default'));
    expect('reasoning_effort' in bodies[0] || 'chat_template_kwargs' in bodies[0]).toBe(false);
  });
});

describe('Gemini wire', () => {
  function fakeClient(captured: Array<{ config: Record<string, unknown> }>) {
    return {
      models: {
        generateContentStream: vi.fn(async (params: { config: Record<string, unknown> }) => {
          captured.push(params);
          return (async function* () { yield { text: '{"ok":true}', candidates: [{ finishReason: 'STOP' }] }; })();
        }),
      },
    } as unknown as GoogleGenAI;
  }
  it('3.x low → thinkingLevel LOW, never thinkingBudget', async () => {
    const captured: Array<{ config: Record<string, unknown> }> = [];
    await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client: fakeClient(captured) }).send(req('low'));
    const tc = captured[0].config.thinkingConfig as Record<string, unknown>;
    expect(tc.thinkingLevel).toBe('LOW');
    expect('thinkingBudget' in tc).toBe(false);
  });
  it('undefined and model-default leave config.thinkingConfig as W2 built it', async () => {
    const a: Array<{ config: Record<string, unknown> }> = [];
    const b: Array<{ config: Record<string, unknown> }> = [];
    await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client: fakeClient(a) }).send(req(undefined));
    await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client: fakeClient(b) }).send(req('model-default'));
    expect(b[0].config.thinkingConfig).toEqual(a[0].config.thinkingConfig);
  });
  it('mergeGeminiThinkingConfig: the fragment decides includeThoughts (P19)', () => {
    expect(mergeGeminiThinkingConfig({ temperature: 0.2, thinkingConfig: { includeThoughts: true } }, { thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: true } }))
      .toEqual({ temperature: 0.2, thinkingConfig: { includeThoughts: true, thinkingLevel: 'LOW' } });
    /* A model wave 2 does not treat as thinking (Gemma 4 at its default) gains summaries from its level. */
    expect(mergeGeminiThinkingConfig({ temperature: 0.2 }, { thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } }))
      .toEqual({ temperature: 0.2, thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } });
    /* A model the catalog marks as thinking, turned off with Gemma's MINIMAL: nothing to summarise. */
    expect(mergeGeminiThinkingConfig({ thinkingConfig: { includeThoughts: true } }, { thinkingConfig: { thinkingLevel: 'MINIMAL' } }))
      .toEqual({ thinkingConfig: { thinkingLevel: 'MINIMAL' } });
    const same = { temperature: 0.2 };
    expect(mergeGeminiThinkingConfig(same, {})).toBe(same);
  });

  /* F2 — 2.5 Flash-Lite dropped from the illustration (its thinkingBudget row is retired); a 3.x
     Flash-Lite id at 'low' demonstrates the same "gains includeThoughts from its level" behaviour. */
  it('Gemma 4 on and gemini-3.5-flash-lite low carry includeThoughts; Gemma 4 off does not (P19)', async () => {
    const cap: Array<{ config: Record<string, unknown> }> = [];
    await new GeminiTransport({ apiKey: 'k', model: 'gemma-4-31b-it', client: fakeClient(cap) }).send(req('on'));
    await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.5-flash-lite', client: fakeClient(cap) }).send(req('low'));
    await new GeminiTransport({ apiKey: 'k', model: 'gemma-4-31b-it', client: fakeClient(cap) }).send(req('off'));
    expect(cap[0].config.thinkingConfig).toEqual({ thinkingLevel: 'HIGH', includeThoughts: true });
    expect(cap[1].config.thinkingConfig).toEqual({ thinkingLevel: 'LOW', includeThoughts: true });
    expect(cap[2].config.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
  });

  it('a free-text request sends no thinkingConfig at model-default, and only the level fragment otherwise', async () => {
    const cap: Array<{ config: Record<string, unknown> }> = [];
    const t = new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client: fakeClient(cap) });
    const free = (reasoning: ReasoningLevel | undefined): TransportRequest => ({ ...req(reasoning), system: '', temperature: undefined, freeText: {} });
    await t.send(free(undefined));
    await t.send(free('model-default'));
    await t.send(free('low'));
    expect('thinkingConfig' in cap[0].config).toBe(false);
    expect('thinkingConfig' in cap[1].config).toBe(false);
    expect(cap[2].config.thinkingConfig).toEqual({ thinkingLevel: 'LOW', includeThoughts: true });
  });

  it('a level keeps structured output and the abort signal on the config actually sent', async () => {
    const cap: Array<{ config: Record<string, unknown> }> = [];
    await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client: fakeClient(cap) }).send(req('low'));
    expect(cap[0].config.responseMimeType).toBe('application/json');
    expect(cap[0].config.abortSignal).toBeInstanceOf(AbortSignal);
    expect(cap[0].config.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'LOW' });
  });
});
