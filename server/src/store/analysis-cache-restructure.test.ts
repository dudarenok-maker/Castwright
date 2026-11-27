import { describe, it, expect } from 'vitest';
import type { AnalysisCache, ChapterErrorRecord } from './analysis-cache.js';
import { remapCacheChapterKeys } from './analysis-cache-restructure.js';

const take = (chapterId: number) => [
  { id: 1, chapterId, characterId: 'narrator', text: `Take ${chapterId}.` },
];
const cast = (id: string) => [{ id, name: id, role: 'minor', color: 'halloran' }];
const failure = (message: string): ChapterErrorRecord => ({
  code: 'analyzer-timeout',
  message,
  remediation: 'Retry.',
  phase: 'cast',
});

/* Three chapters, every chapter-keyed member populated for each, plus the
   members the helper must leave alone. */
function seed(): AnalysisCache {
  return {
    version: 2,
    chapterCast: { 1: cast('a'), 2: cast('b'), 3: cast('c') },
    castDurations: { 1: 11, 2: 12, 3: 13 },
    stage2Durations: { 1: 21, 2: 22, 3: 23 },
    failedChapterIds: [1, 2, 3],
    failedChapterErrors: { '1': failure('one'), '2': failure('two'), '3': failure('three') },
    pendingAttributionChapterIds: [1, 3],
    chapters: { 1: take(1), 2: take(2), 3: take(3) },
    stage1: { characters: cast('a'), chapters: [{ id: 1, title: 'One' }] },
    matchPlan: { decisions: [] } as never,
    confirmReached: true,
    takesPersisted: false,
  };
}

const identity = new Map([
  [1, 1],
  [2, 2],
  [3, 3],
]);

describe('remapCacheChapterKeys (#3506)', () => {
  it('(a) a reorder carries all six members to the new chapter ids', () => {
    const reorder = new Map([
      [1, 3],
      [2, 1],
      [3, 2],
    ]);
    /* Only 1 and 2 in the id list, so an uncarried or unsorted list shows. */
    const out = remapCacheChapterKeys({ ...seed(), failedChapterIds: [1, 2] }, reorder, new Set());

    expect(out.chapterCast).toEqual({ 3: cast('a'), 1: cast('b'), 2: cast('c') });
    expect(out.castDurations).toEqual({ 3: 11, 1: 12, 2: 13 });
    expect(out.stage2Durations).toEqual({ 3: 21, 1: 22, 2: 23 });
    expect(out.failedChapterIds).toEqual([1, 3]);
    expect(out.failedChapterErrors).toEqual({
      '3': failure('one'),
      '1': failure('two'),
      '2': failure('three'),
    });
    /* Old P [1, 3] becomes new [3, 2], sorted ascending. */
    expect(out.pendingAttributionChapterIds).toEqual([2, 3]);
  });

  it('(b) an old id with no mapping is dropped from all six members', () => {
    const out = remapCacheChapterKeys(
      seed(),
      new Map([
        [1, 1],
        [2, 2],
      ]),
      new Set(),
    );

    expect(out.chapterCast).toEqual({ 1: cast('a'), 2: cast('b') });
    expect(out.castDurations).toEqual({ 1: 11, 2: 12 });
    expect(out.stage2Durations).toEqual({ 1: 21, 2: 22 });
    expect(out.failedChapterIds).toEqual([1, 2]);
    expect(out.failedChapterErrors).toEqual({ '1': failure('one'), '2': failure('two') });
    expect(out.pendingAttributionChapterIds).toEqual([1]);
  });

  it('(c) a reset id loses its five entries and lands in P once', () => {
    /* 3 is already in P, 2 is not. */
    const out = remapCacheChapterKeys(seed(), identity, new Set([3, 2]));

    expect(out.chapterCast).toEqual({ 1: cast('a') });
    expect(out.castDurations).toEqual({ 1: 11 });
    expect(out.stage2Durations).toEqual({ 1: 21 });
    expect(out.failedChapterIds).toEqual([1]);
    expect(out.failedChapterErrors).toEqual({ '1': failure('one') });
    expect(out.pendingAttributionChapterIds).toEqual([1, 2, 3]);
    /* The take stays: a pending take is kept until replaced. */
    expect(out.chapters).toEqual(seed().chapters);
  });

  it('(c) a reset id is read as a NEW id, applied after the carry', () => {
    const reorder = new Map([
      [1, 3],
      [2, 1],
      [3, 2],
    ]);
    const out = remapCacheChapterKeys(seed(), reorder, new Set([3]));

    /* New id 3 is old chapter 1. */
    expect(out.chapterCast).toEqual({ 1: cast('b'), 2: cast('c') });
    expect(out.failedChapterIds).toEqual([1, 2]);
    expect(out.failedChapterErrors).toEqual({ '1': failure('two'), '2': failure('three') });
    expect(out.pendingAttributionChapterIds).toEqual([2, 3]);
  });

  it('(d) a reset id with no prior entries still lands in P, adding no other member', () => {
    const out = remapCacheChapterKeys({ chapters: {} }, new Map(), new Set([5, 4]));

    expect(out).toStrictEqual({ chapters: {}, pendingAttributionChapterIds: [4, 5] });
  });

  it('(d) absent members stay absent when nothing is reset', () => {
    const out = remapCacheChapterKeys({ chapters: {} }, identity, new Set());

    expect(out).toStrictEqual({ chapters: {} });
  });

  it('(e) leaves the takes and the non-chapter-keyed members alone', () => {
    const before = seed();
    const out = remapCacheChapterKeys(seed(), new Map([[1, 2]]), new Set([2]));

    expect(out.chapters).toEqual(before.chapters);
    expect(out.stage1).toEqual(before.stage1);
    expect(out.matchPlan).toEqual(before.matchPlan);
    expect(out.confirmReached).toEqual(before.confirmReached);
    expect(out.takesPersisted).toEqual(before.takesPersisted);
  });

  it('(f) returns a new object and does not mutate the input', () => {
    const input = seed();
    const snapshot = structuredClone(input);
    const out = remapCacheChapterKeys(
      input,
      new Map([
        [1, 3],
        [2, 1],
      ]),
      new Set([1, 7]),
    );

    expect(out).not.toBe(input);
    expect(input).toStrictEqual(snapshot);
  });

  it('(g) throws, naming both old ids, when two map to the same new id', () => {
    const collision = new Map([
      [1, 1],
      [2, 4],
      [3, 4],
    ]);

    expect(() => remapCacheChapterKeys(seed(), collision, new Set())).toThrow(
      /old chapters 2 and 3 both map to new chapter 4/,
    );
  });
});
