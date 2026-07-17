import { describe, it, expect } from 'vitest';
import {
  chunkSentencesByBudget,
  chunkWithContext,
  ownsOp,
  primarySentenceId,
  chapterChunkBudget,
} from './chapter-chunker.js';
import { resolveStage1ChunkCharBudget } from './stage1-chunk.js';

const S = (id: number, len = 10) => ({ id, text: 'x'.repeat(len) });

describe('chapterChunkBudget (Part 4 — finite Gemini budget for output-heavy passes)', () => {
  it('gemini is FINITE now (not MAX_SAFE_INTEGER) so a large chapter splits', () => {
    const budget = chapterChunkBudget('gemini');
    expect(budget).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(budget).toBe(32000); // registry default analyzer.gemini.outputHeavyChunkChars
  });

  it('local stays the num_ctx-derived stage-1 budget (unchanged behaviour)', () => {
    expect(chapterChunkBudget('local')).toBe(resolveStage1ChunkCharBudget('local'));
  });

  it('stage-1 cast detection now sizes gemini to a finite token-derived budget (no longer MAX_SAFE_INTEGER)', () => {
    expect(resolveStage1ChunkCharBudget('gemini', 'x'.repeat(200000))).toBeLessThan(200000);
  });

  it('a Night-Watch-sized chapter yields >=2 gemini chunks (was exactly 1 under MAX_SAFE_INTEGER)', () => {
    const budget = chapterChunkBudget('gemini');
    // ~60k chars — 600 sentences of ~100 chars.
    const sentences = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, text: 'x'.repeat(100) }));
    const chunks = chunkSentencesByBudget(sentences, { charBudget: budget, overlap: 3, serialize: (s) => s.text });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Under the old MAX_SAFE_INTEGER budget this was exactly 1.
    const oneCall = chunkSentencesByBudget(sentences, { charBudget: Number.MAX_SAFE_INTEGER, overlap: 3, serialize: (s) => s.text });
    expect(oneCall.length).toBe(1);
  });
});

describe('chunkSentencesByBudget', () => {
  it('cores partition the sentences with no gaps or overlaps', () => {
    const sents = Array.from({ length: 10 }, (_, i) => S(i + 1, 30));
    const chunks = chunkSentencesByBudget(sents, { charBudget: 90, overlap: 1, serialize: (s) => s.text });
    const cores = chunks.flatMap((c) => c.core.map((s) => s.id));
    expect(cores).toEqual([1,2,3,4,5,6,7,8,9,10]);
    expect(chunks.length).toBeGreaterThan(1);
  });
  it('context overlaps neighbours but is excluded from coreIds', () => {
    const sents = Array.from({ length: 6 }, (_, i) => S(i + 1, 40));
    const chunks = chunkSentencesByBudget(sents, { charBudget: 80, overlap: 1, serialize: (s) => s.text });
    const second = chunks[1];
    expect(chunkWithContext(second).length).toBeGreaterThan(second.core.length);
    for (const s of second.core) expect(second.coreIds.has(s.id)).toBe(true);
    expect([...second.coreIds].some((id) => chunks[0].coreIds.has(id))).toBe(false);
  });
  it('an oversize single sentence still forms its own core (no infinite loop)', () => {
    const chunks = chunkSentencesByBudget([S(1, 500), S(2, 10)], { charBudget: 50, overlap: 0, serialize: (s) => s.text });
    expect(chunks[0].core.map((s) => s.id)).toEqual([1]);
    expect(chunks.flatMap((c) => c.core.map((s) => s.id))).toEqual([1, 2]);
  });
  it('chunkWithContext preserves document order when ids are non-monotonic (split offspring)', () => {
    // Document order [25, 5, 20, 30]: a split offspring (high id 25) sits at the
    // front, and the second core's ids (20, 30) bracket it numerically. The old
    // `s.id`-comparison split mis-orders/drops such context sentences from the
    // prompt; structural ordering (contextBefore ++ core ++ contextAfter) must
    // keep every sentence, in document order, with none dropped.
    const docOrder = [25, 5, 20, 30];
    const sents = docOrder.map((id) => S(id, 30));
    const chunks = chunkSentencesByBudget(sents, { charBudget: 60, overlap: 2, serialize: (s) => s.text });
    // second chunk: core = [20, 30], context-before = [25, 5], context-after = []
    expect(chunkWithContext(chunks[1]).map((s) => s.id)).toEqual([25, 5, 20, 30]);
  });
});

describe('ownership', () => {
  it('primarySentenceId is min(mergeIds) for merge, else id', () => {
    expect(primarySentenceId({ id: 0, op: 'merge', mergeIds: [7, 5, 6] })).toBe(5);
    expect(primarySentenceId({ id: 9, op: 'strip_tag' })).toBe(9);
  });
  it('ownsOp is true only when the primary id is in the core', () => {
    const core = new Set([5, 6]);
    expect(ownsOp(core, 5)).toBe(true);
    expect(ownsOp(core, 7)).toBe(false);
  });
});
