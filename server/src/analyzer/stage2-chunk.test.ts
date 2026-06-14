/* Stage-2 large-chapter chunking (#528).

   Covers the splitter (paragraph-bounded, lossless, budget-respecting) and the
   runner: single-call path stays a single call, an over-budget chapter splits +
   renumbers contiguously, later chunks carry preceding context, a chunk that
   truncates is adaptively re-split, and a per-chunk coverage miss retries. */

import { describe, it, expect, vi } from 'vitest';
import type { SentenceOutput } from '../handoff/schemas.js';
import { AnalyzerTruncatedError } from './errors.js';
import {
  splitBodyIntoChunks,
  splitParagraphIntoSentences,
  stage2ChunkBudgetForEngine,
  tailParagraphs,
  runStage2ChapterChunked,
} from './stage2-chunk.js';

/* A fake "model": one sentence per paragraph, text copied verbatim so the
   coverage guard (word-overlap vs the body) passes. */
function fakeAttribute(subBody: string): { sentences: SentenceOutput[] } {
  const paras = subBody
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    sentences: paras.map((text, i) => ({
      id: i + 1,
      chapterId: 1,
      characterId: 'narrator',
      text,
    })),
  };
}

function makeBody(paraCount: number): string {
  return Array.from({ length: paraCount }, (_, i) => `Paragraph ${i + 1} has several words here.`).join(
    '\n\n',
  );
}

describe('splitBodyIntoChunks', () => {
  it('returns the body unchanged when it fits the budget', () => {
    const body = makeBody(3);
    expect(splitBodyIntoChunks(body, 10_000)).toEqual([body]);
  });

  it('splits at paragraph boundaries, losslessly, under budget', () => {
    const body = makeBody(8);
    const chunks = splitBodyIntoChunks(body, 80);
    expect(chunks.length).toBeGreaterThan(1);
    // Lossless: concatenation reproduces the body exactly (no dropped/dup prose).
    expect(chunks.join('')).toBe(body);
    // Every paragraph lands wholly inside exactly one chunk (never split).
    for (let i = 1; i <= 8; i += 1) {
      const para = `Paragraph ${i} has several words here.`;
      expect(chunks.filter((c) => c.includes(para))).toHaveLength(1);
    }
  });

  it('keeps an over-budget single paragraph as its own chunk (never cut)', () => {
    const huge = 'A'.repeat(500);
    const body = `${huge}\n\nshort tail.`;
    const chunks = splitBodyIntoChunks(body, 100);
    expect(chunks.join('')).toBe(body);
    expect(chunks.some((c) => c.includes(huge))).toBe(true);
    // The huge paragraph is not fragmented across chunks.
    expect(chunks.filter((c) => c.includes(huge))).toHaveLength(1);
  });
});

describe('splitParagraphIntoSentences', () => {
  it('returns the paragraph unchanged when it fits the budget', () => {
    const para = 'One sentence. Two sentence.';
    expect(splitParagraphIntoSentences(para, 10_000)).toEqual([para]);
  });

  it('splits a long single paragraph at sentence boundaries under budget', () => {
    const para = Array.from({ length: 6 }, (_, i) => `Sentence ${i + 1} has a few words.`).join(' ');
    const chunks = splitParagraphIntoSentences(para, 40);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk ends at a sentence boundary (no mid-sentence cut).
    for (const c of chunks) expect(c.trim()).toMatch(/[.!?]["')\]]?$/);
    // No sentence is dropped — each appears in exactly one chunk.
    for (let i = 1; i <= 6; i += 1) {
      expect(chunks.filter((c) => c.includes(`Sentence ${i} has a few words.`))).toHaveLength(1);
    }
  });

  it('returns the blob unchanged when there is no sentence boundary to split on', () => {
    const blob = 'word '.repeat(40).trim(); // no terminal punctuation
    expect(splitParagraphIntoSentences(blob, 10)).toEqual([blob]);
  });
});

describe('stage2ChunkBudgetForEngine (num_ctx-aware budget sizing)', () => {
  it('leaves the configured budget unchanged for cloud engines', () => {
    expect(stage2ChunkBudgetForEngine(9000, 16384, 'gemini')).toBe(9000);
  });
  it('lowers the budget for local engines with a small num_ctx', () => {
    // 4096 tokens × 2 chars/token × 0.3 = 2457 < 9000 → budget tightens.
    expect(stage2ChunkBudgetForEngine(9000, 4096, 'local')).toBe(2457);
  });
  it('never raises the budget above the configured value (large num_ctx)', () => {
    expect(stage2ChunkBudgetForEngine(9000, 65536, 'local')).toBe(9000);
  });
  it('keeps a sane floor for a tiny num_ctx', () => {
    expect(stage2ChunkBudgetForEngine(9000, 512, 'local')).toBe(1000);
  });
});

describe('tailParagraphs', () => {
  it('returns the last N paragraphs joined', () => {
    const body = makeBody(5);
    const tail = tailParagraphs(body, 2);
    expect(tail).toBe('Paragraph 4 has several words here.\n\nParagraph 5 has several words here.');
  });
});

describe('runStage2ChapterChunked', () => {
  it('runs a single call (no chunking) for a body within budget', async () => {
    const body = makeBody(3);
    const call = vi.fn(async (subBody: string, _preceding: string | null) => fakeAttribute(subBody));
    const out = await runStage2ChapterChunked({
      body,
      charBudget: 10_000,
      coverageRetries: 1,
      callForBody: call,
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][1]).toBeNull(); // precedingContext null on single-call path
    expect(out.chunkCount).toBe(1);
    expect(out.sentences).toHaveLength(3);
    expect(out.coverage.ok).toBe(true);
  });

  it('splits an over-budget chapter, renumbers ids 1..N, and passes preceding context', async () => {
    const body = makeBody(10);
    const call = vi.fn(async (subBody: string, _preceding: string | null) => fakeAttribute(subBody));
    const out = await runStage2ChapterChunked({
      body,
      charBudget: 80,
      coverageRetries: 1,
      callForBody: call,
    });
    expect(call.mock.calls.length).toBeGreaterThan(1);
    expect(out.chunkCount).toBeGreaterThan(1);
    // All 10 paragraphs attributed, ids contiguous 1..10.
    expect(out.sentences.map((s) => s.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(out.coverage.ok).toBe(true);
    // First chunk gets null preceding context; later chunks get a non-null tail.
    expect(call.mock.calls[0][1]).toBeNull();
    expect(call.mock.calls[1][1]).toBeTruthy();
  });

  it('adaptively re-splits a chunk that truncates, then succeeds', async () => {
    const body = makeBody(6);
    let truncations = 0;
    /* Throw on any span longer than 60 chars (forces the ~2-paragraph chunks
       to re-split into single paragraphs), succeed otherwise. */
    const call = vi.fn(async (subBody: string, _preceding: string | null) => {
      if (subBody.length > 60) {
        truncations += 1;
        throw new AnalyzerTruncatedError('gemini', 'MAX_TOKENS', subBody.length);
      }
      return fakeAttribute(subBody);
    });
    const out = await runStage2ChapterChunked({
      body,
      charBudget: 80,
      coverageRetries: 1,
      callForBody: call,
    });
    expect(truncations).toBeGreaterThan(0); // adaptive path exercised
    expect(out.sentences.map((s) => s.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out.coverage.ok).toBe(true);
  });

  it('re-splits an UNDER-budget body that still truncates on the single call', async () => {
    /* A dense chapter whose char count fits the budget but whose per-sentence
       JSON output overflows the model cap (output scales with sentence count,
       not chars). The single-call path must fall back to the adaptive split
       instead of propagating the truncation. */
    const body = makeBody(6);
    let fullBodyTruncations = 0;
    const call = vi.fn(async (subBody: string, _preceding: string | null) => {
      // The whole body truncates; any strictly-smaller span succeeds.
      if (subBody.length >= body.length) {
        fullBodyTruncations += 1;
        throw new AnalyzerTruncatedError('gemini', 'MAX_TOKENS', subBody.length);
      }
      return fakeAttribute(subBody);
    });
    const out = await runStage2ChapterChunked({
      body,
      charBudget: 10_000, // > body.length → single-call path is selected first
      coverageRetries: 1,
      callForBody: call,
    });
    expect(fullBodyTruncations).toBe(1); // tried the single call once, then split
    expect(out.chunkCount).toBeGreaterThan(1); // reported as a chunked run
    expect(out.sentences.map((s) => s.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out.coverage.ok).toBe(true);
  });

  it('propagates an under-budget truncation that is a single un-splittable paragraph', async () => {
    // One paragraph, under budget, but the model truncates on it: nothing to split.
    const body = 'word '.repeat(40).trim();
    const call = vi.fn(async (_subBody: string, _preceding: string | null) => {
      throw new AnalyzerTruncatedError('gemini', 'MAX_TOKENS', body.length);
    });
    await expect(
      runStage2ChapterChunked({ body, charBudget: 10_000, coverageRetries: 1, callForBody: call }),
    ).rejects.toBeInstanceOf(AnalyzerTruncatedError);
  });

  it('sentence-splits a single oversized paragraph that truncates (no paragraph boundary)', async () => {
    /* The 2026-06-14 hard-fail: qwen3.5:4b truncated on a chapter whose
       over-cap span was a SINGLE paragraph — paragraph-splitting had nothing
       to cut, so the adaptive re-split gave up and failed the whole chapter.
       It must now fall back to sentence boundaries and recover. */
    const para = Array.from({ length: 10 }, (_, i) => `Sentence number ${i + 1} carries a few words.`).join(' ');
    let truncations = 0;
    const call = vi.fn(async (subBody: string) => {
      if (subBody.length > 90) {
        truncations += 1;
        throw new AnalyzerTruncatedError('ollama', 'length', subBody.length);
      }
      return fakeAttribute(subBody);
    });
    const out = await runStage2ChapterChunked({
      body: para, // one paragraph, no blank lines
      charBudget: 10_000, // single-call path first; whole paragraph truncates
      coverageRetries: 1,
      callForBody: call,
    });
    expect(truncations).toBeGreaterThan(0); // truncation path exercised
    expect(out.chunkCount).toBeGreaterThan(1); // recovered via sentence split
    expect(out.sentences.length).toBeGreaterThan(1);
    expect(out.coverage.ok).toBe(true);
  });

  it('retries a chunk whose first attempt has low coverage', async () => {
    const body = makeBody(8);
    const onRetry = vi.fn();
    let firstChunkCalls = 0;
    const call = vi.fn(async (subBody: string, _preceding: string | null) => {
      // Starve the very first call so its coverage fails, then recover.
      if (subBody.includes('Paragraph 1 ') && firstChunkCalls === 0) {
        firstChunkCalls += 1;
        return { sentences: [] as SentenceOutput[] };
      }
      return fakeAttribute(subBody);
    });
    const out = await runStage2ChapterChunked({
      body,
      charBudget: 80,
      coverageRetries: 2,
      callForBody: call,
      onRetry,
    });
    expect(onRetry).toHaveBeenCalled();
    expect(out.coverage.ok).toBe(true);
  });

  it('propagates a truncation that cannot be split further', async () => {
    // Two paragraphs, the first an un-splittable over-cap blob.
    const blob = 'word '.repeat(60).trim();
    const body = `${blob}\n\n${makeBody(3)}`;
    const call = vi.fn(async (subBody: string, _preceding: string | null) => {
      if (subBody.includes(blob)) throw new AnalyzerTruncatedError('ollama', 'length', subBody.length);
      return fakeAttribute(subBody);
    });
    await expect(
      runStage2ChapterChunked({ body, charBudget: 80, coverageRetries: 1, callForBody: call }),
    ).rejects.toBeInstanceOf(AnalyzerTruncatedError);
  });
});
