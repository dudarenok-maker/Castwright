/* #3084 P1 — an endpoint call on a GPU keeps that endpoint busy for exactly as long as it
   runs. Real http server + real undici Agent (Global Constraints).
   Env that module-load constants read (GEMINI_RETRY_BACKOFFS_MS → BACKOFFS_MS) is set
   BEFORE the dynamic imports below (same convention as openai-transport.contract.test.ts):
   the production 1.5s/6s backoffs would push "a failed call releases its registration"
   (3 retry attempts on a reset connection) past the default 15s test budget. */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';

process.env.GEMINI_RETRY_BACKOFFS_MS = '10,10';

const { OpenAITransport } = await import('./openai-transport.js');
const { analyzerEndpointSchema } = await import('../../workspace/analyzer-endpoints.js');
const { isEndpointBusy, _resetEndpointBusyForTest } = await import('../analyzer-concurrency.js');

let server: Server | undefined;
afterEach(async () => {
  _resetEndpointBusyForTest();
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

const CHUNK = `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { content: '{}' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;

async function heldServer(): Promise<{ baseUrl: string; received: Promise<void>; finish: () => void }> {
  let onReceived!: () => void;
  const received = new Promise<void>((r) => (onReceived = r));
  let held: ServerResponse | undefined;
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    held = res;
    onReceived();
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, received, finish: () => held?.end(CHUNK) };
}

function transportFor(baseUrl: string, gpu: string) {
  const endpoint = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl, gpu, contextTokens: 4096 });
  return new OpenAITransport({ endpoint, apiKey: null, model: 'm', dispatcher: new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 2_000 } }) });
}

const REQUEST = {
  system: 's',
  messages: [{ role: 'user' as const, content: 'hi' }],
  structuredOutput: { mode: 'off' as const },
  temperature: 0,
  estimatedInputTokens: 10,
  call: {},
};

describe('OpenAITransport call registration (#3084 P1)', () => {
  it('a gpu endpoint call keeps its own endpoint busy while streaming, and not after', async () => {
    const s = await heldServer();
    const pending = transportFor(s.baseUrl, 'cuda:1').send(REQUEST);
    await s.received;
    expect(isEndpointBusy('lab')).toBe(true);
    expect(isEndpointBusy('other')).toBe(false);
    s.finish();
    await pending;
    expect(isEndpointBusy('lab')).toBe(false);
  });

  it("a gpu 'none' endpoint never registers", async () => {
    const s = await heldServer();
    const pending = transportFor(s.baseUrl, 'none').send(REQUEST);
    await s.received;
    expect(isEndpointBusy('lab')).toBe(false);
    s.finish();
    await pending;
  });

  it('a failed call releases its registration', async () => {
    /* Each connection's socket is destroyed as soon as it is received, so every retry
       attempt fails immediately with a connection-reset — deterministic, unlike
       server.closeAllConnections() (which only severs connections already open: a later
       retry attempt opens a fresh one that then idles, which only the 45s production
       GEMINI_STREAM_IDLE_MS window — never armed here, since no delta is ever sent —
       would eventually catch). Same assertion, same intent: a failed call releases
       its endpoint registration. */
    server = createServer((req) => {
      req.socket.destroy();
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    const pending = transportFor(`http://127.0.0.1:${port}/v1`, 'any').send(REQUEST);
    await pending.catch(() => undefined);
    expect(isEndpointBusy('lab')).toBe(false);
  });
});
