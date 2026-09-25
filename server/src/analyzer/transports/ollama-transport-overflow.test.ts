/* #3084 wave 2b — Ollama's empty `length` stream (spec §7). At 80be2f1d an
   empty buffer was checked before done_reason (ollama.ts:830 vs :839), so an
   empty `length` finish failed as "returned an empty response". The overflow
   rule now applies uniformly: OllamaTransport reports finish 'length' (and
   reasoningSeen from message.thinking) and mapFinish decides. */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import { OllamaTransport } from './ollama-transport.js';
import { mapFinish } from '../runner/finish.js';
import { AnalyzerReasoningOverflowError, AnalyzerTruncatedError } from '../errors.js';
import type { TransportRequest } from '../runner/transport.js';

const MODEL = 'qwen3.5:4b';
let server: Server | null = null;
const agents: Agent[] = [];

async function serveNdjson(lines: object[]): Promise<string> {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const request = (call: TransportRequest['call'] = {}): TransportRequest => ({
  system: 'sys',
  messages: [{ role: 'user', content: 'p' }],
  structuredOutput: { mode: 'json' },
  temperature: 0.2,
  estimatedInputTokens: 10,
  call,
});

async function sendTo(url: string, call: TransportRequest['call'] = {}) {
  const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000 } });
  agents.push(dispatcher);
  return new OllamaTransport({ url, model: MODEL, dispatcher }).send(request(call));
}

const thrownBy = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
};

beforeAll(() => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
});
afterAll(() => {
  delete process.env.CASTWRIGHT_VRAM_SAMPLE;
});
afterEach(async () => {
  await Promise.all(agents.splice(0).map((a) => a.destroy()));
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

describe('Ollama empty `length` stream (#3084 wave 2b)', () => {
  it('empty content, no message.thinking → finish length, and mapFinish splits it (AnalyzerTruncatedError)', async () => {
    const url = await serveNdjson([
      { message: { role: 'assistant', content: '' }, done: false },
      { message: { role: 'assistant', content: '' }, done: true, done_reason: 'length' },
    ]);
    const r = await sendTo(url);
    expect(r).toMatchObject({ text: '', finish: 'length', reasoningSeen: false, receivedBytes: 0 });
    const err = thrownBy(() => mapFinish(r, { kind: 'ollama', model: MODEL }));
    expect(err).toBeInstanceOf(AnalyzerTruncatedError);
    expect(err).toMatchObject({ engine: 'ollama', reason: 'length', receivedBytes: 0 });
  });

  it('empty content after message.thinking chunks → reasoningSeen, and mapFinish fails it as reasoning overflow', async () => {
    const url = await serveNdjson([
      { message: { role: 'assistant', content: '', thinking: 'The narrator opens the scene, then' }, done: false },
      { message: { role: 'assistant', content: '', thinking: ' Mara answers.' }, done: false },
      { message: { role: 'assistant', content: '' }, done: true, done_reason: 'length' },
    ]);
    const onChunk = vi.fn();
    const r = await sendTo(url, { onChunk });
    expect(r).toMatchObject({ text: '', finish: 'length', reasoningSeen: true, receivedBytes: 0 });
    // P4: each thinking chunk feeds the heartbeat with the answer byte count unchanged.
    expect(onChunk).toHaveBeenCalledTimes(2);
    for (const [info] of onChunk.mock.calls) expect(info).toMatchObject({ receivedBytes: 0, receivedText: '' });
    const err = thrownBy(() => mapFinish(r, { kind: 'ollama', model: MODEL }));
    expect(err).toBeInstanceOf(AnalyzerReasoningOverflowError);
    expect(err).toMatchObject({ transport: 'ollama', model: MODEL, reasoningTokens: undefined });
  });

  it('empty content on a `stop` stream is still the empty-response error', async () => {
    const url = await serveNdjson([{ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }]);
    const r = await sendTo(url);
    expect(r).toMatchObject({ text: '', finish: 'stop', receivedBytes: 0 });
    const err = thrownBy(() => mapFinish(r, { kind: 'ollama', model: MODEL }));
    expect(err).not.toBeInstanceOf(AnalyzerTruncatedError);
    expect(err).not.toBeInstanceOf(AnalyzerReasoningOverflowError);
    expect((err as Error).message).toBe(`Ollama ${MODEL} returned an empty response.`);
  });
});
