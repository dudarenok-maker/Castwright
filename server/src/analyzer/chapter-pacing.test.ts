import { describe, it, expect, vi } from 'vitest';
import { buildCharsByChapter, chapterPacingPhaseFields, accumulateChapterPacing } from './chapter-pacing.js';
import type { SentenceOutput } from '../handoff/schemas.js';

function sentence(chapterId: number, text: string): SentenceOutput {
  return { id: 1, chapterId, characterId: 'narrator', text };
}

describe('buildCharsByChapter', () => {
  it('sums sentence text length per chapter', () => {
    const byChapter = new Map<number, SentenceOutput[]>([
      [1, [sentence(1, 'abc'), sentence(1, 'de')]],
      [2, [sentence(2, 'x')]],
    ]);
    const result = buildCharsByChapter([1, 2], byChapter);
    expect(result.get(1)).toBe(5);
    expect(result.get(2)).toBe(1);
  });

  it('defaults an absent chapter to 0 chars', () => {
    const result = buildCharsByChapter([7], new Map());
    expect(result.get(7)).toBe(0);
  });
});

describe('chapterPacingPhaseFields', () => {
  it('omits estRemainingMs on the first tick (actualCharsTotal still 0)', () => {
    const charsByChapter = new Map([[1, 100], [2, 200]]);
    const fields = chapterPacingPhaseFields({
      index: 0,
      totalChapters: 2,
      actualMsTotal: 0,
      actualCharsTotal: 0,
      charsByChapter,
      remainingChapterIds: [1, 2],
    });
    expect(fields).toEqual({ chapterIndex: 1, totalChapters: 2 });
    expect('estRemainingMs' in fields).toBe(false);
  });

  it('never carries estRemainingMs across a single-chapter run', () => {
    // A single-chapter run's only tick fires before any chapter has been
    // counted (actualCharsTotal is always 0 at that point), so this falls
    // out of the same "omit until charsTotal>0" rule — no special case.
    const charsByChapter = new Map([[5, 500]]);
    const fields = chapterPacingPhaseFields({
      index: 0,
      totalChapters: 1,
      actualMsTotal: 0,
      actualCharsTotal: 0,
      charsByChapter,
      remainingChapterIds: [5],
    });
    expect(fields).toEqual({ chapterIndex: 1, totalChapters: 1 });
  });

  it('projects estRemainingMs from the observed ms/char rate once charsTotal > 0', () => {
    const charsByChapter = new Map([[1, 100], [2, 200], [3, 300]]);
    // Chapter 1 done: 1000ms / 100 chars = 10 ms/char observed rate.
    const fields = chapterPacingPhaseFields({
      index: 1,
      totalChapters: 3,
      actualMsTotal: 1000,
      actualCharsTotal: 100,
      charsByChapter,
      remainingChapterIds: [2, 3], // chapters from the current tick onward
    });
    expect(fields.chapterIndex).toBe(2);
    expect(fields.totalChapters).toBe(3);
    expect(fields.estRemainingMs).toBe(10 * (200 + 300));
  });

  it('keeps chapterIndex 1-based and distinct from chapter id', () => {
    const fields = chapterPacingPhaseFields({
      index: 4,
      totalChapters: 10,
      actualMsTotal: 0,
      actualCharsTotal: 0,
      charsByChapter: new Map(),
      remainingChapterIds: [],
    });
    expect(fields.chapterIndex).toBe(5);
  });
});

describe('accumulateChapterPacing', () => {
  it('adds elapsed wall-clock time and chapter chars to the running totals', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const result = accumulateChapterPacing({ actualMsTotal: 500, actualCharsTotal: 50 }, now - 250, 30);
    expect(result).toEqual({ actualMsTotal: 750, actualCharsTotal: 80 });
    vi.restoreAllMocks();
  });

  it('still accumulates for a zero-char chapter (a failed chapter counts its time)', () => {
    const now = 2_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const result = accumulateChapterPacing({ actualMsTotal: 0, actualCharsTotal: 0 }, now - 100, 0);
    expect(result).toEqual({ actualMsTotal: 100, actualCharsTotal: 0 });
    vi.restoreAllMocks();
  });

  it('does not mutate the input totals object', () => {
    const totals = { actualMsTotal: 10, actualCharsTotal: 10 };
    accumulateChapterPacing(totals, Date.now(), 5);
    expect(totals).toEqual({ actualMsTotal: 10, actualCharsTotal: 10 });
  });
});
