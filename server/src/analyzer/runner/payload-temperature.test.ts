import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import { z } from 'zod';
import { StageRunner } from './stage-runner.js';
import { OLLAMA_RETRY_POLICY, type ValidationRetryPolicy } from './retry-policy.js';
import { parseAndValidate } from './parse.js';
import { OllamaTransport } from '../transports/ollama-transport.js';
import type { ChatTransport } from './transport.js';

const hoisted = vi.hoisted(() => ({ dirName: `castwright-w5b-temp-${process.pid}-${Date.now()}` }));
vi.mock('../../handoff/protocol.js', async (orig) => {
  const actual = await orig<typeof import('../../handoff/protocol.js')>();
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = join(tmpdir(), hoisted.dirName);
  await mkdir(dir, { recursive: true });
  return {
    ...actual,
    writeInbox: async (m: string, k: string, body: string) => { const p = join(dir, `${m}-${k}.inbox.md`); await writeFile(p, body); return p; },
    outboxPath: (m: string, k: string) => join(dir, `${m}-${k}.json`),
    errorPath: (m: string, k: string) => join(dir, `${m}-${k}.errors.json`),
    rawAttemptPath: (m: string, k: string, a: number) => join(dir, `${m}-${k}.attempt${a}.raw.txt`),
  };
});

const schema = z.object({ ok: z.literal(true) });
let server: Server | null = null;
const bodies: Array<Record<string, unknown>> = [];

async function startSequence(contentType: string, responses: string[]): Promise<string> {
  server = createServer((r, res) => {
    if (r.method === 'GET') {
      /* #3084 P15 — the runner awaits OpenAITransport.prepare(), which lists the served models first. */
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
      return;
    }
    let raw = '';
    r.on('data', (c) => (raw += c));
    r.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(responses[bodies.length - 1]);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
const ollamaText = (content: string) =>
  JSON.stringify({ message: { role: 'assistant', content }, done: false }) + '\n' +
  JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n';
const dispatcher = () => new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000 } });

function expectedRetryTemperature(policy: ValidationRetryPolicy): number {
  const failure = parseAndValidate('not json', schema);
  if (failure.ok) throw new Error('fixture must fail');
  return policy.buildRetry({ messages: [{ role: 'user', content: 'p' }], firstRaw: 'not json', failure }).temperature;
}
async function runWith(transport: ChatTransport, policy: ValidationRetryPolicy, extraParams: Record<string, unknown>) {
  const runner = new StageRunner({
    transport, policy,
    settings: () => ({ structuredOutput: 'json', maxOutputTokens: undefined, reasoning: undefined, extraParams }),
    adaptSchema: (s) => ({ schema: s, dropped: [] }),
  });
  await runner.runStage({ manuscriptId: 'm1', key: 'review-ch1', skillName: 'script_review', promptMd: 'p', grammarSchema: schema, validationSchema: schema }, {});
}

beforeAll(() => { process.env.CASTWRIGHT_VRAM_SAMPLE = '0'; });
afterEach(async () => {
  bodies.length = 0;
  if (server) { server.closeAllConnections(); await new Promise<void>((r) => server!.close(() => r())); server = null; }
});

describe('a payload temperature sets attempt 1 only', () => {
  it('Ollama policy: attempt 2 uses the retry policy temperature, other payload options survive', async () => {
    const url = await startSequence('application/x-ndjson', [ollamaText('not json'), ollamaText('{"ok":true}')]);
    await runWith(new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }), OLLAMA_RETRY_POLICY, { options: { temperature: 0.95, min_p: 0.05 } });
    const [first, second] = bodies.map((b) => b.options as Record<string, unknown>);
    expect(first.temperature).toBe(0.95);
    expect(second.temperature).toBe(expectedRetryTemperature(OLLAMA_RETRY_POLICY));
    expect(second.temperature).not.toBe(0.95);
    expect(second.min_p).toBe(0.05);
  });
});
