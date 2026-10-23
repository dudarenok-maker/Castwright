/* #3084 W4 — a free-text (persona) request through OpenAITransport sends no response_format,
   max_tokens, temperature or empty system message. Stage requests are the control. */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { OpenAIAnalyzer } from '../openai.js';
import { OpenAITransport } from './openai-transport.js';
import { AnalyzerTimeoutError } from '../errors.js';
import type { AnalyzerEndpoint } from '../../workspace/analyzer-endpoints.js';

let server: Server | undefined;
const bodies: Array<Record<string, unknown>> = [];
const gets: string[] = [];

function sseChunk(delta: object, finish: string | null): string {
  return `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'qwen3', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function startFakeOpenAI(content: string, delayMs = 0): Promise<string> {
  server = createServer((req, res) => {
    if (req.method === 'GET') {
      /* #3084 P15 — runFreeText awaits OpenAITransport.prepare(), which lists the served models once per base URL. */
      gets.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      /* delayMs holds the POST answer, so the ceiling tests can prove a free-text request is cut at its own bound. */
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(sseChunk({ role: 'assistant', content }, null));
        res.write(sseChunk({}, 'stop'));
        res.end('data: [DONE]\n\n');
      }, delayMs);
    });
  });
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      const a = server!.address();
      resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/v1`);
    });
  });
}

function endpoint(baseUrl: string): AnalyzerEndpoint {
  return {
    id: 'lab', name: 'Lab', baseUrl, gpu: 'none', concurrency: 1, requestCeilingMs: 1_800_000,
    structuredOutput: 'schema', reasoningStyle: 'not_controllable', reasoning: 'model-default',
    maxOutputTokens: 0, contextTokens: 32768,
  };
}

afterEach(async () => {
  bodies.length = 0;
  gets.length = 0;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

describe('OpenAITransport — free-text request', () => {
  it('sends one user message and no response_format, max_tokens or temperature', async () => {
    const baseUrl = await startFakeOpenAI('A calm voice.');
    const out = await new OpenAIAnalyzer({ endpoint: endpoint(baseUrl), apiKey: null, model: 'qwen3' }).runner.runFreeText({
      prompt: 'PROMPT',
    });
    expect(out).toBe('A calm voice.');
    /* runFreeText awaited the transport's prepare() (W3c Task 3c.9) before the persona request. */
    expect(gets).toHaveLength(1);
    expect(gets[0]).toMatch(/\/models$/);
    const body = bodies[0];
    expect(body.model).toBe('qwen3');
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([{ role: 'user', content: 'PROMPT' }]);
    expect(body).not.toHaveProperty('response_format');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
  });

  it('CONTROL: a stage request still sends its system message, response_format, max_tokens and temperature', async () => {
    const baseUrl = await startFakeOpenAI('{}');
    await new OpenAITransport({ endpoint: endpoint(baseUrl), apiKey: null, model: 'qwen3' }).send({
      system: 'SYS',
      messages: [{ role: 'user', content: 'P' }],
      structuredOutput: { mode: 'json' },
      temperature: 0.2,
      maxOutputTokens: 1024,
      estimatedInputTokens: 10,
      call: {},
    });
    const body = bodies[0];
    expect(body.messages).toEqual([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'P' }]);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_tokens).toBe(1024);
    expect(body.temperature).toBe(0.2);
  });

  /* Owner decision 4.3-B1(b): the endpoint ceiling is 30 min, but a free-text request is bounded at
     min(endpoint ceiling, absoluteMaxMs). The fake server holds its POST answer for 600 ms. */
  it('a free-text request stops at its absoluteMaxMs ceiling (AnalyzerTimeoutError ceiling, one POST) though the endpoint ceiling is 30 min', async () => {
    const baseUrl = await startFakeOpenAI('A calm voice.', 600);
    const err = await new OpenAIAnalyzer({ endpoint: endpoint(baseUrl), apiKey: null, model: 'qwen3' }).runner
      .runFreeText({ prompt: 'PROMPT', absoluteMaxMs: 200 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerTimeoutError);
    expect((err as AnalyzerTimeoutError).reason).toBe('ceiling');
    expect(bodies).toHaveLength(1); // terminal: no retry
  });

  it('CONTROL: a stage request is not cut by the free-text ceiling (same 600 ms delay)', async () => {
    const baseUrl = await startFakeOpenAI('{}', 600);
    const out = await new OpenAITransport({ endpoint: endpoint(baseUrl), apiKey: null, model: 'qwen3' }).send({
      system: 'SYS',
      messages: [{ role: 'user', content: 'P' }],
      structuredOutput: { mode: 'json' },
      temperature: 0.2,
      maxOutputTokens: 1024,
      estimatedInputTokens: 10,
      call: {},
    });
    expect(out.text).toBe('{}');
  });
});
