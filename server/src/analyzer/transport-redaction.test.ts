/* #3084 P22 — construction-time redaction in the Ollama and Gemini transports. A body
   that echoes a saved analyzer secret never reaches the thrown error, its stack,
   inspect(), the classified failure, or a log line. The Ollama case is a REAL
   http.createServer; the Gemini case uses GeminiTransport's injectable `client`
   (W1 Task 1.9) rejecting with the SDK's own ApiError. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { inspect } from 'node:util';
import { readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, type GoogleGenAI } from '@google/genai';
import { OllamaAnalyzer, generatePersonaViaOllama } from './ollama.js';
import { GeminiTransport } from './transports/gemini-transport.js';
import { AnalyzerHttpError } from './errors.js';
import { classifyAnalysisFailure } from '../routes/failure-taxonomy.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';
import type { TransportRequest } from './runner/transport.js';

const SECRET = 'AIzaSy-transport-echo-secret-1';
const HANDOFF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'handoff');
const ID = 'm_transport_redaction';
const savedEnvKey = process.env.GEMINI_API_KEY;
let server: Server | undefined;
let lines: string[] = [];
let spies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  delete process.env.GEMINI_API_KEY;
  _setUserSettingsCacheForTest({ geminiApiKey: SECRET });
  lines = [];
  spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 }))).join(' '));
    }),
  );
});

afterEach(async () => {
  for (const spy of spies) spy.mockRestore();
  _resetUserSettingsCache();
  if (savedEnvKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedEnvKey;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

afterAll(async () => {
  for (const sub of ['inbox', 'outbox']) {
    const dir = resolve(HANDOFF_ROOT, sub);
    const names = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(names.filter((n) => n.startsWith(ID)).map((n) => rm(resolve(dir, n), { force: true })));
  }
});

const surfaces = (err: unknown): string[] => [(err as Error).message, (err as Error).stack ?? '', inspect(err, { depth: 8 })];

const geminiRequest: TransportRequest = {
  system: 's',
  messages: [{ role: 'user', content: 'u' }],
  structuredOutput: { mode: 'json' },
  temperature: 0.2,
  estimatedInputTokens: 10,
  call: {},
};

const rejectingClient = (err: unknown) =>
  ({ models: { generateContentStream: () => Promise.reject(err) } }) as unknown as GoogleGenAI;

describe('Ollama transport redaction (#3084 P22)', () => {
  it('a 500 body echoing a saved secret never reaches the error, its stack, inspect(), the classified failure or a log line', async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `runner failed for key ${SECRET}` }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const err = await new OllamaAnalyzer({ url, model: 'qwen3.5:4b' })
      .runStage1Chapter(ID, 1, '# p', {})
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerHttpError);
    expect((err as AnalyzerHttpError).bodyExcerpt).toBe('{"error":"runner failed for key [redacted]"}');
    const classified = classifyAnalysisFailure(err, 'Ollama (qwen3.5:4b)');
    for (const s of [...surfaces(err), classified.userMessage, classified.detail ?? '', ...lines]) {
      expect(s).not.toContain(SECRET);
    }
  });

  it('an in-stream error line echoing a saved secret never reaches the error, its stack, inspect(), the classified failure or a log line (A8)', async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.end(`${JSON.stringify({ error: `model runner crashed for key ${SECRET}` })}\n`);
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const err = await new OllamaAnalyzer({ url, model: 'qwen3.5:4b' })
      .runStage1Chapter(ID, 1, '# p', {})
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(`Ollama ${url} stream error: model runner crashed for key [redacted]`);
    const classified = classifyAnalysisFailure(err, 'Ollama (qwen3.5:4b)');
    for (const s of [...surfaces(err), classified.userMessage, classified.detail ?? '', ...lines]) {
      expect(s).not.toContain(SECRET);
    }
  });
});

describe('Ollama persona call redaction (#3084 P22, A8)', () => {
  it('a non-OK persona body echoing a saved secret never reaches the error, its stack, inspect() or a log line', async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `persona runner failed for key ${SECRET}` }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    /* generatePersonaViaOllama reads its URL via getResolvedOllamaUrl (A3 —
       config/ollama-resolved.ts), which resolves through the config
       resolver; `ollamaUrl` is not a settings field any more, so seed the
       saved Advanced Settings override instead (#3084 A3 re-pin). */
    _setUserSettingsCacheForTest({ geminiApiKey: SECRET, configOverrides: { 'analyzer.ollama.url': url } });
    const err = await generatePersonaViaOllama('Describe the voice.', 'qwen3.5:4b').then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe(
      `Ollama ${url} returned 500 Internal Server Error: {"error":"persona runner failed for key [redacted]"}`,
    );
    for (const s of [...surfaces(err), ...lines]) {
      expect(s).not.toContain(SECRET);
    }
  });
});

describe('Gemini transport redaction (#3084 P22)', () => {
  it('an ApiError whose body echoes a saved secret is rebuilt redacted: still an ApiError with its status, and the [gemini] generate failed line carries no secret', async () => {
    const upstream = new ApiError({
      status: 400,
      message: `got status: 400 Bad Request. {"error":{"code":400,"message":"API key ${SECRET} not valid","status":"INVALID_ARGUMENT"}}`,
    });
    const err = await new GeminiTransport({ apiKey: 'unused-by-a-stub-client', model: 'gemini-3.5-flash-lite', client: rejectingClient(upstream) })
      .send(geminiRequest)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as Error).message).toContain('API key [redacted] not valid');
    /* A line the code under test wrote: logGenerateFailed (W1 Task 1.9). */
    expect(lines.some((l) => l.startsWith('[gemini] generate failed'))).toBe(true);
    const classified = classifyAnalysisFailure(err, 'Gemini');
    expect(classified.code).toBe('analyzer-request-rejected');
    for (const s of [...surfaces(err), classified.userMessage, classified.detail ?? '', ...lines]) {
      expect(s).not.toContain(SECRET);
    }
  });

  it('an error with no secret in it is rethrown as the same object, so every existing outcome is unchanged', async () => {
    const upstream = new ApiError({
      status: 400,
      message: 'got status: 400 Bad Request. {"error":{"code":400,"message":"no secret here","status":"INVALID_ARGUMENT"}}',
    });
    const err = await new GeminiTransport({ apiKey: 'unused-by-a-stub-client', model: 'gemini-3.5-flash-lite', client: rejectingClient(upstream) })
      .send(geminiRequest)
      .then(() => null, (e: unknown) => e);
    expect(err).toBe(upstream);
  });
});
