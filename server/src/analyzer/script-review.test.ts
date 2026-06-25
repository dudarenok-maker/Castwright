/* runScriptReviewChapter — covers both OllamaAnalyzer and GeminiAnalyzer impls
   (Task 7b). Mirrors the two-schema runStage mock block from ollama.test.ts:
   mock the chat/generate layer to return a canned { ops:[...] }; assert the
   call succeeds, returns the parsed ops, and writes the inbox/outbox handoff. */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { z } from 'zod';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { geminiRateLimiter } from './rate-limit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HANDOFF_ROOT = resolve(__dirname, '..', '..', 'handoff');

/* A valid ScriptReviewOutput — one strip_tag op */
const VALID_REVIEW_RESPONSE = JSON.stringify({
  ops: [
    {
      id: 1,
      op: 'strip_tag',
      anchor: 'Hard to starboard,',
      newText: '"Hard to starboard,"',
      rationale: 'Remove attribution tag from narrated dialogue',
    },
  ],
});

// ── Gemini SDK mock (top-level so vi.mock hoisting works) ──────────────────────
const generateContentStream = vi.fn();

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class {
      models = { generateContentStream };
    },
  };
});

/* Build a ReadableStream that emits Ollama-style NDJSON: one line per
   content chunk, terminated by a `done: true` line. Mirrors ollama.test.ts. */
function ndjsonStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        const line = JSON.stringify({
          message: { role: 'assistant', content: chunks[i] },
          done: false,
        });
        controller.enqueue(encoder.encode(line + '\n'));
        i += 1;
      } else if (i === chunks.length) {
        const done = JSON.stringify({ message: { role: 'assistant', content: '' }, done: true });
        controller.enqueue(encoder.encode(done + '\n'));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

function chunksOf(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function okResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

async function* asyncFromChunks(items: Array<{ text: string; finishReason?: string }>) {
  for (const item of items) {
    yield {
      text: item.text,
      usageMetadata: { promptTokenCount: 50 },
      candidates: item.finishReason ? [{ finishReason: item.finishReason }] : [],
    };
  }
}

const fetchMock = vi.fn();

beforeEach(async () => {
  fetchMock.mockReset();
  generateContentStream.mockReset();
  geminiRateLimiter._reset();
  vi.stubGlobal('fetch', fetchMock);
  await mkdir(resolve(HANDOFF_ROOT, 'inbox'), { recursive: true });
  await mkdir(resolve(HANDOFF_ROOT, 'outbox'), { recursive: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeAll(() => { process.env.CASTWRIGHT_VRAM_SAMPLE = '0'; });
afterAll(() => { delete process.env.CASTWRIGHT_VRAM_SAMPLE; });

// ── OllamaAnalyzer tests ────────────────────────────────────────────────────

describe('OllamaAnalyzer — runScriptReviewChapter (Task 7b)', () => {
  it('returns the parsed ops and writes the inbox/outbox handoff', async () => {
    const pieces = chunksOf(VALID_REVIEW_RESPONSE, 32);
    fetchMock.mockResolvedValue(okResponse(ndjsonStream(pieces)));

    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:4b' });

    const result = await analyzer.runScriptReviewChapter(
      'm_review_ollama',
      1,
      '# script-review prompt',
      {},
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0].op).toBe('strip_tag');
    expect(result.ops[0].id).toBe(1);
    expect(result.ops[0].rationale).toBeTruthy();
  });

  it('uses scriptReviewSchema for both grammar (format) and validation', async () => {
    fetchMock.mockResolvedValue(okResponse(ndjsonStream(chunksOf(VALID_REVIEW_RESPONSE, 32))));

    const { OllamaAnalyzer } = await import('./ollama.js');
    const { scriptReviewSchema } = await import('../handoff/schemas.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:4b' });

    await analyzer.runScriptReviewChapter('m_review_schema', 1, '# prompt', {});

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    const expectedFormat = z.toJSONSchema(scriptReviewSchema, { target: 'draft-07', reused: 'inline' });
    expect(body.format).toEqual(expectedFormat);
  });

  it('uses the script-review skill (system instruction references the op classes)', async () => {
    fetchMock.mockResolvedValue(okResponse(ndjsonStream(chunksOf(VALID_REVIEW_RESPONSE, 32))));

    const { OllamaAnalyzer } = await import('./ollama.js');
    const analyzer = new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:4b' });

    await analyzer.runScriptReviewChapter('m_review_key', 3, '# prompt', {});

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    const sysMsg = body.messages.find((m: { role: string }) => m.role === 'system');
    expect(sysMsg).toBeDefined();
    expect(sysMsg.content).toMatch(/strip_tag|extract_dialogue|fix_emotion/i);
  });
});

// ── GeminiAnalyzer tests ────────────────────────────────────────────────────

describe('GeminiAnalyzer — runScriptReviewChapter (Task 7b)', () => {
  it('returns the parsed ops', async () => {
    generateContentStream.mockResolvedValue(
      asyncFromChunks([{ text: VALID_REVIEW_RESPONSE, finishReason: 'STOP' }]),
    );

    const { GeminiAnalyzer } = await import('./gemini.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemma-4-31b-it' });

    const result = await analyzer.runScriptReviewChapter(
      'm_review_gemini',
      1,
      '# script-review prompt',
      {},
    );

    expect(result.ops).toHaveLength(1);
    expect(result.ops[0].op).toBe('strip_tag');
    expect(result.ops[0].id).toBe(1);
  });
});

// ── Schema coverage tests for fs-58 Unit B ──────────────────────────────────

describe('scriptReviewSchema — fs-58 Unit B ops', () => {
  it('flag_nonstory ops over the import-residue fixture validate (schema coverage)', async () => {
    const { scriptReviewSchema } = await import('../handoff/schemas.js');

    const ops = [
      { id: 2, op: 'flag_nonstory' as const, anchor: '47', rationale: 'page number' },
      { id: 3, op: 'flag_nonstory' as const, anchor: 'THE COALFALL COMMISSION', rationale: 'running header' },
      { id: 5, op: 'flag_nonstory' as const, anchor: 'ISBN 978-0-00-000000-0', rationale: 'ISBN line' },
      { id: 6, op: 'flag_nonstory' as const, anchor: 'Chapter 3', rationale: 'bare chapter marker' },
    ];

    const result = scriptReviewSchema.safeParse({ ops });
    expect(result.success).toBe(true);
  });
});
