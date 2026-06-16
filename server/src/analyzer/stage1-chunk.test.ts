/* Stage-1 cast-detection chunking (plan 219 / srv-40). Pins:
   - a within-budget chapter runs exactly ONE call and returns its raw roster
     (byte-identical to pre-chunking),
   - an over-budget chapter is split, each chunk detected, rosters UNIONed
     (a character recurring across chunks collapses to one entry),
   - each section is detected independently (the intra-chapter roster is NOT
     threaded — it amplified a small-model surname-smear on Russian),
   - a chunk that truncates is adaptively re-split rather than failing the
     chapter,
   - the local budget derives from num_ctx. */

import { describe, it, expect, vi } from 'vitest';
import {
  runStage1ChapterChunked,
  stage1ChunkBudgetForEngine,
  type Stage1ChunkRunOptions,
} from './stage1-chunk.js';
import { AnalyzerTruncatedError } from './errors.js';
import type { CharacterOutput } from '../handoff/schemas.js';

const char = (id: string, extra: Partial<CharacterOutput> = {}): CharacterOutput => ({
  id,
  name: id,
  role: 'role',
  color: '#fff',
  ...extra,
});

/* A minimal stand-in for the route's mergeRosterChapter: union by id, first
   wins. (The real merge's field-level rules are exercised by analysis tests.) */
const mergeRosters: Stage1ChunkRunOptions['mergeRosters'] = (running, chars) => {
  for (const c of chars) if (!running.has(c.id)) running.set(c.id, c);
};

/* A body with N paragraphs of `size` chars each, blank-line separated. */
const bodyOfParas = (n: number, size: number): string =>
  Array.from({ length: n }, (_, i) => `${String.fromCharCode(97 + (i % 26))}`.repeat(size)).join(
    '\n\n',
  );

describe('runStage1ChapterChunked', () => {
  it('runs ONE call and returns the raw roster when the body fits the budget', async () => {
    const callForBody = vi.fn(async () => ({ characters: [char('anton'), char('geser')] }));
    const out = await runStage1ChapterChunked({
      body: 'A short chapter.',
      charBudget: 9000,
      callForBody,
      mergeRosters,
    });
    expect(callForBody).toHaveBeenCalledTimes(1);
    expect(out.chunkCount).toBe(1);
    expect(out.characters.map((c) => c.id)).toEqual(['anton', 'geser']);
  });

  it('splits an over-budget body and unions per-chunk rosters (dedup by id)', async () => {
    // 6 paragraphs × 2000 chars = ~12K; budget 5000 → multiple chunks.
    const body = bodyOfParas(6, 2000);
    // Every chunk re-detects "anton"; each adds one unique character.
    let n = 0;
    const callForBody = vi.fn(async () => {
      n += 1;
      return { characters: [char('anton'), char(`extra${n}`)] };
    });
    const out = await runStage1ChapterChunked({
      body,
      charBudget: 5000,
      callForBody,
      mergeRosters,
    });
    expect(out.chunkCount).toBeGreaterThan(1);
    expect(callForBody).toHaveBeenCalledTimes(out.chunkCount);
    // "anton" appears once despite being detected in every chunk.
    expect(out.characters.filter((c) => c.id === 'anton')).toHaveLength(1);
    // every chunk's unique character survived.
    expect(out.characters.filter((c) => c.id.startsWith('extra'))).toHaveLength(out.chunkCount);
  });

  it('detects each section independently — does NOT thread the intra-chapter roster', async () => {
    // Threading the accumulated roster into later sections amplified a small-model
    // surname-smear on Russian (2026-06-16), so callForBody now takes ONLY the
    // sub-body — section context comes solely from the caller's book-level roster.
    const body = bodyOfParas(4, 3000);
    const callForBody = vi.fn(async (...args: unknown[]) => {
      expect(args).toHaveLength(1); // sub-body only, no roster argument
      return { characters: [char('anton')] };
    });
    await runStage1ChapterChunked({ body, charBudget: 4000, callForBody, mergeRosters });
    expect(callForBody.mock.calls.every((c) => c.length === 1)).toBe(true);
  });

  it('adaptively re-splits a chunk that truncates instead of failing', async () => {
    const body = bodyOfParas(4, 3000);
    let calls = 0;
    const callForBody = vi.fn(async (sub: string) => {
      calls += 1;
      // The first (largest) span truncates; smaller re-split spans succeed.
      if (sub.length > 4000) throw new AnalyzerTruncatedError('ollama', 'length', 2);
      return { characters: [char(`c${calls}`)] };
    });
    const out = await runStage1ChapterChunked({
      body,
      charBudget: 999999, // force the single-call path, then truncation → forced split
      callForBody,
      mergeRosters,
    });
    expect(out.characters.length).toBeGreaterThan(0);
  });

  it('re-throws a non-truncation error', async () => {
    const callForBody = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(
      runStage1ChapterChunked({ body: 'x', charBudget: 9000, callForBody, mergeRosters }),
    ).rejects.toThrow('boom');
  });
});

describe('stage1ChunkBudgetForEngine', () => {
  it('derives a smaller budget from num_ctx for local engines', () => {
    // 16384 ctx × 0.7 × 2 = 22937 < configured 24000 → derived wins.
    expect(stage1ChunkBudgetForEngine(24000, 16384, 'local')).toBe(22937);
    // bigger ctx → bigger budget, capped at configured.
    expect(stage1ChunkBudgetForEngine(24000, 32768, 'local')).toBe(24000);
  });

  it('never chunks cloud engines (huge budget)', () => {
    expect(stage1ChunkBudgetForEngine(24000, 8192, 'gemini')).toBe(Number.MAX_SAFE_INTEGER);
  });
});
