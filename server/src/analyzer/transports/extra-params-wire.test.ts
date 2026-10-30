import { describe, it, expect, beforeAll, afterEach, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import type { GoogleGenAI } from '@google/genai';
import { OllamaTransport } from './ollama-transport.js';
import { OpenAITransport } from './openai-transport.js';
import { GeminiTransport } from './gemini-transport.js';
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
  server = createServer((r, res) => {
    let raw = '';
    r.on('data', (c) => (raw += c));
    r.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(payload);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
const dispatcher = () => new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000 } });
const req = (extraParams: Record<string, unknown> | undefined, reasoning?: ReasoningLevel): TransportRequest => ({
  system: 'sys', messages: [{ role: 'user', content: 'p' }], structuredOutput: { mode: 'json' },
  temperature: 0.2, maxOutputTokens: 8192, reasoning, extraParams, estimatedInputTokens: 10, call: {},
});

beforeAll(() => { process.env.CASTWRIGHT_VRAM_SAMPLE = '0'; });
beforeEach(() => { bodies.length = 0; geminiRateLimiter._reset(); });
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>((r) => server!.close(() => r())); server = null; }
});

describe('Ollama payload merge', () => {
  it('merges options key by key and keeps pipeline-owned options', async () => {
    const url = await startCapture('application/x-ndjson', OLLAMA_OK);
    await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send(req({ top_k: 40, options: { min_p: 0.05, num_predict: 1024 } }));
    const options = bodies[0].options as Record<string, unknown>;
    expect(bodies[0].top_k).toBe(40);
    expect(options.min_p).toBe(0.05);
    expect(options.num_predict).toBe(1024);
    expect(typeof options.num_ctx).toBe('number');
    expect(options.temperature).toBe(0.2);
  });
  it('the persona (free-text) call merges the payload too, keeping its own num_gpu and stream:false', async () => {
    const url = await startCapture('application/json', JSON.stringify({ message: { role: 'assistant', content: 'A warm voice.' }, done: true, done_reason: 'stop' }));
    await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send({
      ...req({ top_k: 40, options: { min_p: 0.05, temperature: 0.7 } }),
      freeText: { onCpu: true, keepAlive: 0 },
    });
    const options = bodies[0].options as Record<string, unknown>;
    expect(bodies[0].stream).toBe(false);
    expect(bodies[0].top_k).toBe(40);
    expect(options.min_p).toBe(0.05);
    expect(options.num_gpu).toBe(0);
    expect(options.temperature).toBe(0.7); // single attempt: the payload temperature applies
  });

  it('the persona (free-text) call drops the payload output cap and keeps every other key (A4)', async () => {
    const url = await startCapture('application/json', JSON.stringify({ message: { role: 'assistant', content: 'A warm voice.' }, done: true, done_reason: 'stop' }));
    /* runFreeText strips the cap keys; what reaches the transport is the rest of the payload. */
    await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send({
      ...req({ top_k: 40, options: { min_p: 0.05 } }),
      maxOutputTokens: undefined,
      freeText: { onCpu: false, keepAlive: 0 },
    });
    const options = bodies[0].options as Record<string, unknown>;
    expect(bodies[0].top_k).toBe(40);
    expect(options.min_p).toBe(0.05);
    expect('num_predict' in options).toBe(false);
  });

  it('a request with no payload is byte-identical to one with an empty payload', async () => {
    const url = await startCapture('application/x-ndjson', OLLAMA_OK);
    const t = new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() });
    await t.send(req(undefined));
    await t.send(req({}));
    expect(JSON.stringify(bodies[1])).toBe(JSON.stringify(bodies[0]));
  });

  it('a stored options:null is ignored: pipeline-owned options stay (P17)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const url = await startCapture('application/x-ndjson', OLLAMA_OK);
    await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send(req({ options: null }));
    const options = bodies[0].options as Record<string, unknown>;
    expect(typeof options.num_ctx).toBe('number');
    expect(options.temperature).toBe(0.2);
    vi.restoreAllMocks();
  });

  it('the persona call ignores a stored options:null and a stored options.num_gpu, and keeps num_gpu 0 (P17)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const url = await startCapture('application/json', JSON.stringify({ message: { role: 'assistant', content: 'A warm voice.' }, done: true, done_reason: 'stop' }));
    const t = new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() });
    await t.send({ ...req({ options: null }), freeText: { onCpu: true, keepAlive: 0 } });
    await t.send({ ...req({ options: { num_gpu: 99 } }), freeText: { onCpu: true, keepAlive: 0 } });
    expect(bodies.map((b) => (b.options as Record<string, unknown>).num_gpu)).toEqual([0, 0]);
    vi.restoreAllMocks();
  });
});

describe('OpenAI-compatible payload merge', () => {
  const endpointAt = (base: string, reasoningStyle: 'reasoning_effort' | 'enable_thinking') =>
    analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: `${base}/v1`, gpu: 'none', contextTokens: 32768, reasoningStyle });
  it('sends the reporter payload and drops max_tokens when the payload sets max_completion_tokens', async () => {
    const base = await startCapture('text/event-stream', OPENAI_OK);
    await new OpenAITransport({ endpoint: endpointAt(base, 'reasoning_effort'), apiKey: null, model: 'm', dispatcher: dispatcher() })
      .send(req({ top_k: 20, min_p: 0.05, presence_penalty: 1.5, max_completion_tokens: 4096 }));
    expect(bodies[0]).toMatchObject({ top_k: 20, min_p: 0.05, presence_penalty: 1.5, max_completion_tokens: 4096 });
    expect('max_tokens' in bodies[0]).toBe(false);
  });
  it('keeps enable_thinking from the reasoning level when the payload adds template kwargs', async () => {
    const base = await startCapture('text/event-stream', OPENAI_OK);
    await new OpenAITransport({ endpoint: endpointAt(base, 'enable_thinking'), apiKey: null, model: 'm', dispatcher: dispatcher() })
      .send(req({ chat_template_kwargs: { add_generation_prompt: true } }, 'off'));
    expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false, add_generation_prompt: true });
  });
  it('drops a stored chat_template_kwargs.enable_thinking under the enable_thinking style (P17)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = await startCapture('text/event-stream', OPENAI_OK);
    await new OpenAITransport({ endpoint: endpointAt(base, 'enable_thinking'), apiKey: null, model: 'm', dispatcher: dispatcher() })
      .send(req({ chat_template_kwargs: { enable_thinking: true } }, 'off'));
    expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });
    vi.restoreAllMocks();
  });
});

describe('Gemini payload merge', () => {
  it('merges config key by key; payload temperature wins on this request', async () => {
    const captured: Array<{ config: Record<string, unknown> }> = [];
    const client = {
      models: {
        generateContentStream: vi.fn(async (params: { config: Record<string, unknown> }) => {
          captured.push(params);
          return (async function* () { yield { text: '{"ok":true}', candidates: [{ finishReason: 'STOP' }] }; })();
        }),
      },
    } as unknown as GoogleGenAI;
    await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client }).send(req({ config: { topK: 40, temperature: 0.9 } }));
    expect(captured[0].config.topK).toBe(40);
    expect(captured[0].config.temperature).toBe(0.9);
    expect(captured[0].config.responseMimeType).toBe('application/json');
    expect(captured[0].config.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('a stored config.httpOptions never reaches generateContentStream; allowlisted keys do (P16)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const captured: Array<{ config: Record<string, unknown> }> = [];
    const client = {
      models: {
        generateContentStream: vi.fn(async (params: { config: Record<string, unknown> }) => {
          captured.push(params);
          return (async function* () { yield { text: '{"ok":true}', candidates: [{ finishReason: 'STOP' }] }; })();
        }),
      },
    } as unknown as GoogleGenAI;
    await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client }).send(req({ config: { httpOptions: { baseUrl: 'http://evil' }, topK: 40 } }));
    expect(captured[0].config).not.toHaveProperty('httpOptions');
    expect(captured[0].config.topK).toBe(40);
    expect(JSON.stringify(captured[0])).not.toContain('evil');
    warn.mockRestore();
  });
});
