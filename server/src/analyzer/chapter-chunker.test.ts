import { describe, it, expect } from 'vitest';
import { chunkSentencesByBudget, chunkWithContext, ownsOp, primarySentenceId } from './chapter-chunker.js';

const S = (id: number, len = 10) => ({ id, text: 'x'.repeat(len) });

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
