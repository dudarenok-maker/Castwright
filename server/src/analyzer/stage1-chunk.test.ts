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
  resolveStage1ChunkCharBudget,
  stage1ChunkBudgetForEngine,
  STAGE1_CLOUD_RESERVED_TOKENS,
  type Stage1ChunkRunOptions,
} from './stage1-chunk.js';
import { AnalyzerTruncatedError } from './errors.js';
import { buildSystemInstruction, loadSkill, estimateInputTokens } from './gemini.js';
import { cloudBodyCharBudget } from './token-budget.js';
import { buildStage1ChapterInbox } from '../routes/analysis.js';
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

  it('cloud stage-1 sizes to the token cap, not MAX_SAFE_INTEGER', () => {
    const ruBody = 'а'.repeat(60000);
    const budget = resolveStage1ChunkCharBudget('gemini', ruBody);
    expect(budget).toBeLessThan(60000);
    expect(budget).toBeGreaterThan(2000);
  });

  it('local stage-1 input fraction knob lowers the budget', () => {
    // large `configured` so the num_ctx-derived value (not the min clamp) decides.
    const hi = stage1ChunkBudgetForEngine(100000, 16384, 'local', 0.7); // floor(16384*1.4)=22937
    const lo = stage1ChunkBudgetForEngine(100000, 16384, 'local', 0.4); // floor(16384*0.8)=13107
    expect(lo).toBeLessThan(hi);
  });
});

/* #1682 REGRESSION LOCK — a worst-case Cyrillic stage-1 request must clear the
   finite Gemma TPM guard (RequestExceedsTpmError fires when the ESTIMATED input
   tokens exceed the model TPM, 16000/min). This reconstructs the REAL call the
   route makes — the actual per-chapter cast-detection system instruction
   (`buildSystemInstruction` over `loadSkill('per_chapter_stage1')`, the largest
   analyzer skill) + the actual Phase-0a inbox (`buildStage1ChapterInbox`) with a
   full body sized by `resolveStage1ChunkCharBudget('gemini', …)` and a
   conservative running roster — and asserts the same `estimateInputTokens` the
   limiter uses stays under the guard with margin.

   Using the REAL prompt (not a hand-faked string) is the point: if the skill or
   inbox scaffold grows, this test re-trips and forces the reservation to be
   re-tuned instead of silently dropping chapters again.

   RED/GREEN: with the prior 0-token reservation the body filled the full 12k
   cap and this construction estimated ~19.8k tokens (roster=60) — well OVER the
   16000 guard. With STAGE1_CLOUD_RESERVED_TOKENS=7000 it estimates ~13.2k. */
describe('#1682 — worst-case Cyrillic stage-1 request clears the Gemma TPM guard', () => {
  const GEMMA_TPM = 16000;
  const MARGIN_CEILING = 14500; // 16000 − 1500 safety margin

  /* A conservative running roster for a single book: 60 characters, Cyrillic
     names, in the compact {id,name,role} shape buildStage1ChapterInbox renders. */
  const worstCaseRoster = (n: number): CharacterOutput[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `personazh-imya-familiya-${i}`,
      name: `Антон Сергеевич Городецкий ${i}`,
      role: 'второстепенный персонаж',
      color: '#ffffff',
    }));

  it('the full request (system + scaffold + roster + body) estimates under the guard', async () => {
    const skill = await loadSkill('per_chapter_stage1');
    const systemInstruction = buildSystemInstruction(skill, 'ru', 'per_chapter_stage1');

    // Body sized exactly the way the route sizes it for a huge Cyrillic chapter.
    const bodyBudget = resolveStage1ChunkCharBudget('gemini', 'а'.repeat(120000));
    const body = 'а'.repeat(bodyBudget);

    const inbox = buildStage1ChapterInbox(
      'm_1682',
      'Ночной дозор',
      { id: 12, title: 'Глава двенадцатая', body },
      worstCaseRoster(60),
      [],
      'Сергей Лукьяненко',
    );

    const estimated = estimateInputTokens(systemInstruction, [
      { role: 'user', parts: [{ text: inbox }] },
    ]);

    // Primary invariant: clears the hard limiter guard.
    expect(estimated).toBeLessThanOrEqual(GEMMA_TPM);
    // Stronger lock: stays under the guard with the intended safety margin.
    expect(estimated).toBeLessThanOrEqual(MARGIN_CEILING);
  });

  it('proves the reservation is load-bearing: it shrinks the body budget by the reserved tokens', () => {
    // With reservedTokens=0 (the pre-#1682 behaviour) the body alone fills the
    // full cap, leaving no room for system+scaffold+roster — which is what blew
    // the guard. The reservation removes 7000 tokens' worth of Cyrillic chars.
    const zeroReserveBudget = cloudBodyCharBudget('а'.repeat(120000), 0, 0);
    const reservedBudget = cloudBodyCharBudget('а'.repeat(120000), 0, STAGE1_CLOUD_RESERVED_TOKENS);
    // The reservation genuinely shrinks the body budget by ~7000 tokens worth of
    // Cyrillic chars (7000 × 2.5), which is what buys back the TPM headroom.
    expect(reservedBudget).toBe(zeroReserveBudget - STAGE1_CLOUD_RESERVED_TOKENS * 2.5);
  });
});
