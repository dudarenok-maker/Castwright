import { describe, it, expect, beforeAll, afterEach, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import { OllamaTransport } from './ollama-transport.js';
import type { TransportRequest } from '../runner/transport.js';
import type { ReasoningLevel } from '../reasoning.js';

const OLLAMA_OK =
  JSON.stringify({ model: 'q:4b', message: { role: 'assistant', content: '{"ok":true}' }, done: false }) + '\n' +
  JSON.stringify({ model: 'q:4b', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n';

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
beforeEach(() => { bodies.length = 0; });
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
