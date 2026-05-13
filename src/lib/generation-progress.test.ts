// Pairs with docs/features/16-generation-stream.md

import { describe, expect, it } from 'vitest';
import {
  characterStatsByChapter, countWords, overallProgress, sentencesPerChapter,
} from './generation-progress';
import type { Chapter, Sentence } from './types';

const makeChapter = (id: number, overrides: Partial<Chapter> = {}): Chapter => ({
  id,
  title: `Chapter ${id}`,
  duration: '00:00',
  state: 'queued',
  progress: 0,
  characters: { narrator: 'queued' },
  ...overrides,
});

const mkSentence = (id: number, chapterId: number, characterId: string, text: string): Sentence =>
  ({ id, chapterId, characterId, text });

describe('countWords', () => {
  it('counts whitespace-delimited tokens', () => {
    expect(countWords('Hello there, friend.')).toBe(3);
  });

  it('ignores [audio-tag] chips so a tag does not inflate the count', () => {
    expect(countWords('[laughs] Welcome home.')).toBe(2);
  });

  it('returns 0 for empty / whitespace-only strings', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
  });
});

describe('sentencesPerChapter', () => {
  it('groups sentence counts by chapterId', () => {
    const out = sentencesPerChapter([
      mkSentence(1, 1, 'narrator', 'a.'),
      mkSentence(2, 1, 'eliza',    'b.'),
      mkSentence(3, 2, 'narrator', 'c.'),
    ]);
    expect(out).toEqual({ 1: 2, 2: 1 });
  });
});

describe('characterStatsByChapter', () => {
  it('aggregates lines and words per character within each chapter', () => {
    const out = characterStatsByChapter([
      mkSentence(1, 1, 'narrator', 'One two three.'),
      mkSentence(2, 1, 'narrator', 'Four.'),
      mkSentence(3, 1, 'eliza',    'Five six.'),
      mkSentence(4, 2, 'narrator', 'Seven.'),
    ]);
    expect(out).toEqual({
      1: {
        narrator: { lines: 2, words: 4 },
        eliza:    { lines: 1, words: 2 },
      },
      2: {
        narrator: { lines: 1, words: 1 },
      },
    });
  });
});

describe('overallProgress — the 3/7-done-shows-4 % regression', () => {
  /* The bug: Done chapters hydrated from disk have no totalLines. The
     old math `weightedNum / totalLinesSum` weighted only the in-flight
     chapter, collapsing the bar to its own progress (~4 %). */
  it('counts Done chapters at full weight using the manuscript counts', () => {
    const chapters = [
      makeChapter(1, { state: 'done',        progress: 1    }),
      makeChapter(2, { state: 'done',        progress: 1    }),
      makeChapter(3, { state: 'done',        progress: 1    }),
      makeChapter(4, { state: 'in_progress', progress: 0.04, totalLines: 100 }),
      makeChapter(5, { state: 'queued',      progress: 0    }),
      makeChapter(6, { state: 'queued',      progress: 0    }),
      makeChapter(7, { state: 'queued',      progress: 0    }),
    ];
    /* Each chapter is roughly the same size in the manuscript: 100 lines. */
    const counts = { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100, 7: 100 };
    const p = overallProgress(chapters, counts);
    /* 3 full + 0.04 of one of seven equal-weight chapters → ~0.434 */
    expect(p).toBeCloseTo((3 + 0.04) / 7, 5);
  });

  it('falls back to equal-weight when nothing is known yet', () => {
    const chapters = [
      makeChapter(1, { progress: 1 }),
      makeChapter(2, { progress: 0.5 }),
      makeChapter(3, { progress: 0 }),
    ];
    expect(overallProgress(chapters, {})).toBeCloseTo((1 + 0.5 + 0) / 3, 5);
  });

  it('uses live totalLines when the manuscript count is missing', () => {
    const chapters = [
      makeChapter(1, { progress: 1,   totalLines: 200 }),
      makeChapter(2, { progress: 0.5, totalLines: 200 }),
    ];
    expect(overallProgress(chapters, {})).toBeCloseTo(0.75, 5);
  });

  it('fills unknown weights with the average of known weights', () => {
    const chapters = [
      makeChapter(1, { progress: 1 }),                       // unknown weight
      makeChapter(2, { progress: 0, totalLines: 100 }),       // known: 100
      makeChapter(3, { progress: 0, totalLines: 300 }),       // known: 300
    ];
    /* avg known = 200; chapter 1 gets weight 200; total = 600; weighted
       numerator = 1 * 200 = 200; → 200/600 = 0.333… */
    expect(overallProgress(chapters, {})).toBeCloseTo(200 / 600, 5);
  });

  it('returns 0 for an empty chapter list', () => {
    expect(overallProgress([], {})).toBe(0);
  });
});
