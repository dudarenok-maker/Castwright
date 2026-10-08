/* End-to-end: the knob → analyzer constructor → runner → transport → wire.
   Ollama over a real local HTTP server (no fetch stub); Gemini through the
   same `@google/genai` module mock gemini.test.ts:57-63 uses. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const generateContentStream = vi.fn();
vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return {
    ...actual,
    GoogleGenAI: class {
      models = { generateContentStream };
    },
  };
});

const { OllamaAnalyzer } = await import('./ollama.js');
const { GeminiAnalyzer } = await import('./gemini.js');
const { geminiRateLimiter } = await import('./rate-limit.js');

const HANDOFF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'handoff');
const ID = 'm_structured_output_settings';
const VALID = JSON.stringify({
  characters: [
    { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator', evidence: [{ quote: 'a' }, { quote: 'bb' }, { quote: 'ccc' }] },
  ],
});

let server: Server;
let url = '';
let bodies: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  await mkdir(resolve(HANDOFF_ROOT, 'inbox'), { recursive: true });
  await mkdir(resolve(HANDOFF_ROOT, 'outbox'), { recursive: true });
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: VALID }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  delete process.env.CASTWRIGHT_VRAM_SAMPLE;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  for (const sub of ['inbox', 'outbox']) {
    const dir = resolve(HANDOFF_ROOT, sub);
    const names = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(names.filter((n) => n.startsWith(ID)).map((n) => rm(resolve(dir, n), { force: true })));
  }
});

beforeEach(() => {
  bodies = [];
  generateContentStream.mockReset();
  geminiRateLimiter._reset();
});

afterEach(() => {
  delete process.env.ANALYZER_OLLAMA_STRUCTURED_OUTPUT;
  delete process.env.ANALYZER_GEMINI_STRUCTURED_OUTPUT;
});

describe('analyzer.ollama.structuredOutput reaches the /api/chat body', () => {
  it('default (schema) sends the stage schema as format — today\'s request', async () => {
    await new OllamaAnalyzer({ url, model: 'qwen3.5:4b' }).runStage1Chapter(ID, 1, '# p', {});
    expect(bodies[0].format).toMatchObject({ type: 'object' });
  });
  it('json sends format "json"', async () => {
    process.env.ANALYZER_OLLAMA_STRUCTURED_OUTPUT = 'json';
    await new OllamaAnalyzer({ url, model: 'qwen3.5:4b' }).runStage1Chapter(ID, 1, '# p', {});
    expect(bodies[0].format).toBe('json');
  });
  it('off sends no format key at all', async () => {
    process.env.ANALYZER_OLLAMA_STRUCTURED_OUTPUT = 'off';
    await new OllamaAnalyzer({ url, model: 'qwen3.5:4b' }).runStage1Chapter(ID, 1, '# p', {});
    expect(bodies[0]).not.toHaveProperty('format');
  });
});

describe('analyzer.gemini.structuredOutput reaches generateContentStream config', () => {
  const stream = () =>
    (async function* () {
      yield {
        text: VALID,
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: VALID }] } }],
        usageMetadata: { promptTokenCount: 10 },
      };
    })();
  const config = () => (generateContentStream.mock.calls[0][0] as { config: Record<string, unknown> }).config;

  it('default (json) sends responseMimeType only — today\'s request', async () => {
    generateContentStream.mockResolvedValue(stream());
    await new GeminiAnalyzer({ apiKey: 'k', model: 'gemini-3.5-flash-lite' }).runStage1Chapter(ID, 1, '# p', {});
    expect(config().responseMimeType).toBe('application/json');
    expect(config()).not.toHaveProperty('responseJsonSchema');
  });
  it('schema sends the Gemini-adapted schema (no $schema key)', async () => {
    process.env.ANALYZER_GEMINI_STRUCTURED_OUTPUT = 'schema';
    generateContentStream.mockResolvedValue(stream());
    await new GeminiAnalyzer({ apiKey: 'k', model: 'gemini-3.5-flash-lite' }).runStage1Chapter(ID, 1, '# p', {});
    expect(config().responseMimeType).toBe('application/json');
    expect(config().responseJsonSchema).toMatchObject({ type: 'object' });
    expect(config().responseJsonSchema).not.toHaveProperty('$schema');
  });
  it('off sends neither', async () => {
    process.env.ANALYZER_GEMINI_STRUCTURED_OUTPUT = 'off';
    generateContentStream.mockResolvedValue(stream());
    await new GeminiAnalyzer({ apiKey: 'k', model: 'gemini-3.5-flash-lite' }).runStage1Chapter(ID, 1, '# p', {});
    expect(config()).not.toHaveProperty('responseMimeType');
    expect(config()).not.toHaveProperty('responseJsonSchema');
  });
});
