/* GeminiAnalyzer streaming behaviour. Mocks @google/genai's
   generateContentStream and asserts:
     - chunks accumulate into the assembled buffer
     - onChunk fires per chunk with monotonic receivedBytes
     - sinceLastChunkMs is set on every chunk
     - the schema-validated stage 1 result is returned at the end
   Pairs with the analysis route's heartbeat / silence-watchdog wiring. */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HANDOFF_ROOT = resolve(__dirname, '..', '..', 'handoff');

/* Build a stage-1-shaped JSON payload, sliced into chunks the same way a
   real model would stream tokens — partial JSON inside any one chunk is
   fine because we only validate the assembled buffer at the end. */
const STAGE1_RESPONSE = JSON.stringify({
  characters: [
    { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator',
      evidence: [{ quote: 'aaa' }, { quote: 'bbbb' }, { quote: 'ccccc' }] },
    { id: 'sophie',   name: 'Sophie',   role: 'protagonist', color: 'orange',
      evidence: [{ quote: 'ddd' }, { quote: 'eeee' }, { quote: 'fffff' }] },
    { id: 'keefe',    name: 'Keefe',    role: 'sidekick',    color: 'magenta',
      evidence: [{ quote: 'ggg' }, { quote: 'hhhh' }, { quote: 'iiiii' }] },
  ],
  chapters: [
    { id: 1, title: 'One' },
  ],
});

function chunksOf(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const generateContentStream = vi.fn();

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class {
      models = { generateContentStream };
    },
  };
});

beforeEach(async () => {
  generateContentStream.mockReset();
  /* writeInbox writes a real file under server/handoff/inbox/. Ensure the
     directory exists so the test doesn't trip over a missing parent. */
  await mkdir(resolve(HANDOFF_ROOT, 'inbox'),  { recursive: true });
  await mkdir(resolve(HANDOFF_ROOT, 'outbox'), { recursive: true });
});

async function* asyncFromArray<T>(items: T[], delayMs = 0): AsyncGenerator<T> {
  for (const item of items) {
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    yield item;
  }
}

describe('GeminiAnalyzer.runStage1 — streaming chunk feedback', () => {
  it('fires onChunk per stream chunk with monotonic receivedBytes and assembles the full response', async () => {
    const slices = chunksOf(STAGE1_RESPONSE, 64);
    expect(slices.length).toBeGreaterThan(2); // ensure we exercise multi-chunk
    generateContentStream.mockResolvedValue(asyncFromArray(slices.map(text => ({ text }))));

    const { GeminiAnalyzer } = await import('./gemini.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemini-2.5-flash' });

    const onChunk = vi.fn();
    const result = await analyzer.runStage1('m_test', '# stage 1 prompt', { onChunk });

    expect(generateContentStream).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledTimes(slices.length);

    const calls = onChunk.mock.calls.map(args => args[0]);
    /* receivedBytes must be monotonically non-decreasing and end at the
       full assembled length. */
    const lengths = calls.map(c => c.receivedBytes);
    for (let i = 1; i < lengths.length; i += 1) {
      expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i - 1]);
    }
    expect(lengths[lengths.length - 1]).toBe(STAGE1_RESPONSE.length);
    /* sinceLastChunkMs is set on every call (≥0). */
    for (const c of calls) {
      expect(c.sinceLastChunkMs).toBeGreaterThanOrEqual(0);
      expect(typeof c.elapsedMs).toBe('number');
    }
    /* receivedText on the last call equals the assembled buffer. */
    expect(calls[calls.length - 1].receivedText).toBe(STAGE1_RESPONSE);

    /* And the analyzer returned the parsed payload. */
    expect(result.characters).toHaveLength(3);
    expect(result.characters.map(c => c.id)).toEqual(['narrator', 'sophie', 'keefe']);
  });

  it('skips empty chunks (text undefined) without firing onChunk', async () => {
    const slices = chunksOf(STAGE1_RESPONSE, 128);
    /* Interleave a couple of empty chunks. */
    const withGaps = [
      { text: slices[0] },
      { text: undefined },
      ...slices.slice(1).map(text => ({ text })),
    ];
    generateContentStream.mockResolvedValue(asyncFromArray(withGaps));

    const { GeminiAnalyzer } = await import('./gemini.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemini-2.5-flash' });

    const onChunk = vi.fn();
    await analyzer.runStage1('m_skip_empty', '# prompt', { onChunk });

    /* Empty chunk does not produce an onChunk call. */
    expect(onChunk).toHaveBeenCalledTimes(slices.length);
  });

  it('throws a clear error when the stream emits zero text chunks', async () => {
    generateContentStream.mockResolvedValue(asyncFromArray([{ text: undefined }, { text: '' }]));

    const { GeminiAnalyzer } = await import('./gemini.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemini-2.5-flash' });

    await expect(analyzer.runStage1('m_empty', '# prompt', {})).rejects.toThrow(/empty response/);
  });
});

describe('GeminiAnalyzer.runStage1Chapter — Phase 0a per-chapter cast detection', () => {
  /* Per-chapter cast output is a strict subset of stage 1: { characters }
     only. Schema rejects an extra `chapters` field, which is the load-bearing
     test that we can't accidentally call the whole-book schema by mistake. */
  const PER_CHAPTER_RESPONSE = JSON.stringify({
    characters: [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator',
        evidence: [{ quote: 'a' }, { quote: 'bb' }] },
      { id: 'sophie', name: 'Sophie', role: 'protagonist', color: 'orange',
        evidence: [{ quote: 'cc' }, { quote: 'dddd' }] },
    ],
  });

  it('reuses the same streaming path as runStage1 and returns parsed per-chapter output', async () => {
    const slices = chunksOf(PER_CHAPTER_RESPONSE, 32);
    generateContentStream.mockResolvedValue(asyncFromArray(slices.map(text => ({ text }))));

    const { GeminiAnalyzer } = await import('./gemini.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemini-2.5-flash' });

    const onChunk = vi.fn();
    const result = await analyzer.runStage1Chapter('m_test', 7, '# stage 1 chapter prompt', { onChunk });

    expect(generateContentStream).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledTimes(slices.length);

    expect(result.characters).toHaveLength(2);
    expect(result.characters.map(c => c.id)).toEqual(['narrator', 'sophie']);
    /* No chapters[] field on the per-chapter shape — the parser is the
       source of truth for the chapter list. */
    expect((result as unknown as { chapters?: unknown }).chapters).toBeUndefined();
  });
});

afterAll(async () => {
  /* Tidy the test inbox/outbox we touched so the workspace stays clean. */
  await rm(resolve(HANDOFF_ROOT, 'inbox',  'm_test-stage1.md'),       { force: true });
  await rm(resolve(HANDOFF_ROOT, 'inbox',  'm_skip_empty-stage1.md'), { force: true });
  await rm(resolve(HANDOFF_ROOT, 'inbox',  'm_empty-stage1.md'),      { force: true });
  await rm(resolve(HANDOFF_ROOT, 'inbox',  'm_test-stage1-ch7.md'),   { force: true });
  await rm(resolve(HANDOFF_ROOT, 'outbox', 'm_test-stage1.json'),       { force: true });
  await rm(resolve(HANDOFF_ROOT, 'outbox', 'm_skip_empty-stage1.json'), { force: true });
  await rm(resolve(HANDOFF_ROOT, 'outbox', 'm_test-stage1-ch7.json'),   { force: true });
});
