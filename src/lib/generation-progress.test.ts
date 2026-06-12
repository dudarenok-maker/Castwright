// Pairs with docs/features/archive/16-generation-stream.md

import { describe, expect, it } from 'vitest';
import {
  characterLinePositionsByChapter,
  characterRowProgress,
  characterSentenceIdsByChapter,
  characterStatsByChapter,
  countWords,
  estimateGenMinutes,
  linesDoneAt,
  overallProgress,
  sentencesPerChapter,
  TARGET_RTF,
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

const mkSentence = (
  id: number,
  chapterId: number,
  characterId: string,
  text: string,
): Sentence => ({ id, chapterId, characterId, text });

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

describe('estimateGenMinutes — RTF-based regenerate ETA', () => {
  it('scales generation minutes by the target RTF', () => {
    /* 600s of audio × 2.5 = 1500s = 25 min. */
    expect(estimateGenMinutes(600)).toBe(Math.round((600 * TARGET_RTF) / 60));
    expect(estimateGenMinutes(600)).toBe(25);
  });

  it('rounds to the nearest minute', () => {
    /* 45s × 2.5 = 112.5s = 1.875 min → 2. */
    expect(estimateGenMinutes(45)).toBe(2);
  });

  it('floors at 1 minute so a tiny chapter never reads as "0 min"', () => {
    expect(estimateGenMinutes(1)).toBe(1);
    expect(estimateGenMinutes(0)).toBe(1);
  });
});

describe('sentencesPerChapter', () => {
  it('groups sentence counts by chapterId', () => {
    const out = sentencesPerChapter([
      mkSentence(1, 1, 'narrator', 'a.'),
      mkSentence(2, 1, 'eliza', 'b.'),
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
      mkSentence(3, 1, 'eliza', 'Five six.'),
      mkSentence(4, 2, 'narrator', 'Seven.'),
    ]);
    expect(out).toEqual({
      1: {
        narrator: { lines: 2, words: 4 },
        eliza: { lines: 1, words: 2 },
      },
      2: {
        narrator: { lines: 1, words: 1 },
      },
    });
  });
});

describe('characterLinePositionsByChapter + linesDoneAt — the false-Done regression', () => {
  /* The bug: by line 13 of an 82-line chapter every cast member had spoken
     at least once. The slice flipped previously-active speakers to `done`,
     so the expanded chapter row showed three "Done" full-green bars while
     synthesis was still on line 13. Real per-character completion now
     derives from manuscript line positions + chapter.currentLine. */

  const screenshotChapter: Sentence[] = [
    /* Narrator-dominated chapter with the other speakers interleaved early.
       Narrator speaks 4 of the first 13 lines, then everyone else speaks
       once before line 13, then narrator carries through. Mirrors the
       "Day One" chapter from the screenshot enough to pin the bug. */
    { id: 1, chapterId: 2, characterId: 'narrator', text: 'opening line' },
    { id: 2, chapterId: 2, characterId: 'narrator', text: 'narrator continues' },
    { id: 3, chapterId: 2, characterId: 'marlow', text: 'marlow one' },
    { id: 4, chapterId: 2, characterId: 'narrator', text: 'narrator three' },
    { id: 5, chapterId: 2, characterId: 'ro', text: 'ro one' },
    { id: 6, chapterId: 2, characterId: 'narrator', text: 'narrator four' },
    { id: 7, chapterId: 2, characterId: 'oduvan', text: 'oduvan one' },
    { id: 8, chapterId: 2, characterId: 'narrator', text: 'narrator five' },
    { id: 9, chapterId: 2, characterId: 'narrator', text: 'narrator six' },
    { id: 10, chapterId: 2, characterId: 'narrator', text: 'narrator seven' },
    { id: 11, chapterId: 2, characterId: 'narrator', text: 'narrator eight' },
    { id: 12, chapterId: 2, characterId: 'narrator', text: 'narrator nine' },
    { id: 13, chapterId: 2, characterId: 'narrator', text: 'narrator ten (current)' },
    { id: 14, chapterId: 2, characterId: 'narrator', text: 'still to come' },
  ];

  it('groups 1-indexed line positions per character per chapter in narrative order', () => {
    const out = characterLinePositionsByChapter(screenshotChapter);
    expect(out[2].narrator).toEqual([1, 2, 4, 6, 8, 9, 10, 11, 12, 13, 14]);
    expect(out[2].marlow).toEqual([3]);
    expect(out[2].ro).toEqual([5]);
    expect(out[2].oduvan).toEqual([7]);
  });

  it('counts lines ≤ currentLine for each character (no false "Done")', () => {
    const positions = characterLinePositionsByChapter(screenshotChapter)[2];
    /* At currentLine=13 (the screenshot moment): narrator has 10 of 11
       lines done, marlow/ro/oduvan have each spoken once, none of them are
       finished. Pre-fix the slice would have marked marlow/ro/oduvan as
       "done" with a full green bar at this moment. */
    expect(linesDoneAt(positions.narrator, 13)).toBe(10);
    expect(linesDoneAt(positions.marlow, 13)).toBe(1);
    expect(linesDoneAt(positions.ro, 13)).toBe(1);
    expect(linesDoneAt(positions.oduvan, 13)).toBe(1);
  });

  it('returns 0 when currentLine is 0 or negative (start-of-run / post-regenerate)', () => {
    const positions = characterLinePositionsByChapter(screenshotChapter)[2];
    expect(linesDoneAt(positions.narrator, 0)).toBe(0);
    expect(linesDoneAt(positions.marlow, 0)).toBe(0);
    expect(linesDoneAt(positions.narrator, -1)).toBe(0);
  });

  it('returns positions.length once currentLine reaches the chapter end (chapter_complete)', () => {
    const positions = characterLinePositionsByChapter(screenshotChapter)[2];
    expect(linesDoneAt(positions.narrator, 14)).toBe(11);
    expect(linesDoneAt(positions.marlow, 14)).toBe(1);
  });

  it('returns 0 for an unknown character (no positions)', () => {
    expect(linesDoneAt(undefined, 13)).toBe(0);
    expect(linesDoneAt([], 13)).toBe(0);
  });
});

describe('overallProgress — the 3/7-done-shows-4 % regression', () => {
  /* The bug: Done chapters hydrated from disk have no totalLines. The
     old math `weightedNum / totalLinesSum` weighted only the in-flight
     chapter, collapsing the bar to its own progress (~4 %). */
  it('counts Done chapters at full weight using the manuscript counts', () => {
    const chapters = [
      makeChapter(1, { state: 'done', progress: 1 }),
      makeChapter(2, { state: 'done', progress: 1 }),
      makeChapter(3, { state: 'done', progress: 1 }),
      makeChapter(4, { state: 'in_progress', progress: 0.04, totalLines: 100 }),
      makeChapter(5, { state: 'queued', progress: 0 }),
      makeChapter(6, { state: 'queued', progress: 0 }),
      makeChapter(7, { state: 'queued', progress: 0 }),
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
      makeChapter(1, { progress: 1, totalLines: 200 }),
      makeChapter(2, { progress: 0.5, totalLines: 200 }),
    ];
    expect(overallProgress(chapters, {})).toBeCloseTo(0.75, 5);
  });

  it('fills unknown weights with the average of known weights', () => {
    const chapters = [
      makeChapter(1, { progress: 1 }), // unknown weight
      makeChapter(2, { progress: 0, totalLines: 100 }), // known: 100
      makeChapter(3, { progress: 0, totalLines: 300 }), // known: 300
    ];
    /* avg known = 200; chapter 1 gets weight 200; total = 600; weighted
       numerator = 1 * 200 = 200; → 200/600 = 0.333… */
    expect(overallProgress(chapters, {})).toBeCloseTo(200 / 600, 5);
  });

  it('returns 0 for an empty chapter list', () => {
    expect(overallProgress([], {})).toBe(0);
  });

  it('excluded chapters do not count toward either numerator or denominator', () => {
    /* 4 chapters, 2 excluded. Of the 2 active, both done at progress=1.
       Bar must hit 100 % — without the filter the excluded chapters
       (progress=0) would drag it to 50 %. */
    const chapters = [
      makeChapter(1, { state: 'done', progress: 1 }),
      makeChapter(2, { excluded: true, progress: 0 }),
      makeChapter(3, { state: 'done', progress: 1 }),
      makeChapter(4, { excluded: true, progress: 0 }),
    ];
    const counts = { 1: 100, 2: 100, 3: 100, 4: 100 };
    expect(overallProgress(chapters, counts)).toBe(1);
  });

  it('returns 0 when every chapter is excluded', () => {
    const chapters = [
      makeChapter(1, { excluded: true, progress: 1 }),
      makeChapter(2, { excluded: true, progress: 1 }),
    ];
    expect(overallProgress(chapters, { 1: 100, 2: 100 })).toBe(0);
  });
});

describe('characterRowProgress — the regenerate stale-Done regression', () => {
  /* The bug: regenerating a previously-rendered chapter left each cast row at
     a full-green "Done" bar until that character's first sentence of the new
     run. Cause: a hydrate re-seeds the on-disk chapter's cast as `'done'`, and
     applyGenerationTick only un-done's the live speaker — so the slice's
     per-character `status` stays stale at `'done'` while the chapter is
     in_progress. Completion must derive from currentLine + line positions, not
     that status. positions [14, 17] = a speaker whose lines are all still ahead
     of the line-13 playhead. */

  it('ignores a stale per-character status="done" while the chapter is in_progress', () => {
    const r = characterRowProgress({
      chapterState: 'in_progress',
      status: 'done',
      linesTotal: 2,
      positions: [14, 17],
      currentLine: 13,
    });
    expect(r).toEqual({ derivedDone: 0, fraction: 0, fullyDone: false });
  });

  it('reads as zero for everyone at the start of a (re)generation (currentLine=0)', () => {
    const r = characterRowProgress({
      chapterState: 'in_progress',
      status: 'done',
      linesTotal: 9,
      positions: [3, 20, 41],
      currentLine: 0,
    });
    expect(r.derivedDone).toBe(0);
    expect(r.fullyDone).toBe(false);
  });

  it('marks a row done by derivation once all its lines are behind the playhead', () => {
    /* The legitimately-done-early speaker (e.g. Mr. Sweeney by line 80): all
       five lines precede the playhead, so the row is correctly "Done" even
       though the chapter is still in_progress. */
    const r = characterRowProgress({
      chapterState: 'in_progress',
      status: 'queued',
      linesTotal: 5,
      positions: [2, 9, 14, 22, 30],
      currentLine: 80,
    });
    expect(r.derivedDone).toBe(5);
    expect(r.fraction).toBe(1);
    expect(r.fullyDone).toBe(true);
  });

  it('shows partial progress for a non-active speaker mid-run', () => {
    /* Wren at line 80: positions [10, 41, 75, 90, ...], 3 of 9 behind. */
    const r = characterRowProgress({
      chapterState: 'in_progress',
      status: 'queued',
      linesTotal: 9,
      positions: [10, 41, 75, 90, 101, 120, 140, 160, 175],
      currentLine: 80,
    });
    expect(r.derivedDone).toBe(3);
    expect(r.fraction).toBeCloseTo(3 / 9, 5);
    expect(r.fullyDone).toBe(false);
  });

  it('honors the slice only when the WHOLE chapter is done (chapter_complete)', () => {
    const r = characterRowProgress({
      chapterState: 'done',
      status: 'done',
      linesTotal: 7,
      positions: [1, 2, 3],
      currentLine: 0,
    });
    expect(r).toEqual({ derivedDone: 7, fraction: 1, fullyDone: true });
  });

  it('treats a skipped character as zero-done with no false completion', () => {
    const r = characterRowProgress({
      chapterState: 'in_progress',
      status: 'skipped',
      linesTotal: 0,
      positions: undefined,
      currentLine: 50,
    });
    expect(r).toEqual({ derivedDone: 0, fraction: 0, fullyDone: false });
  });
});

describe('fs-13 — exact per-character progress from the completed-id set', () => {
  /* Under parallel synthesis (poolWidth > 1 + Qwen batching) groups complete
     out of narrative order, so the chapter-wide `currentLine` COUNT can sit
     ahead of or behind a given character's true done count. The set carries
     the EXACT sentence ids that finished, so each character's bar reads its
     real intersection regardless of completion order. */
  const sentences: Sentence[] = [
    { id: 1, chapterId: 2, characterId: 'narrator', text: 'a' },
    { id: 2, chapterId: 2, characterId: 'marlow', text: 'b' },
    { id: 3, chapterId: 2, characterId: 'narrator', text: 'c' },
    { id: 4, chapterId: 2, characterId: 'wren', text: 'd' },
    { id: 5, chapterId: 2, characterId: 'wren', text: 'e' },
  ];

  it('maps each character to their sentence ids per chapter in narrative order', () => {
    const out = characterSentenceIdsByChapter(sentences);
    expect(out[2].narrator).toEqual([1, 3]);
    expect(out[2].marlow).toEqual([2]);
    expect(out[2].wren).toEqual([4, 5]);
  });

  it('reads an EXACT done count for a late-clustered character even when the chapter count is low', () => {
    /* Only one group has completed so far (count = 1, currentLine = 1), but it
       was wren's LAST line (id 5). A currentLine/positions approximation
       would credit wren 0 (her positions 4,5 are both > 1); the set credits
       exactly the one finished sentence. */
    const ids = characterSentenceIdsByChapter(sentences)[2];
    const completedSet = new Set([5]);
    const r = characterRowProgress({
      chapterState: 'in_progress',
      status: 'queued',
      linesTotal: 2,
      positions: [4, 5],
      currentLine: 1,
      sentenceIds: ids.wren,
      completedSet,
    });
    expect(r.derivedDone).toBe(1);
    expect(r.fraction).toBeCloseTo(0.5, 5);
    expect(r.fullyDone).toBe(false);
  });

  it('does not over-count a character whose lines have NOT finished even when the chapter count is high', () => {
    /* count is high (3 groups done) but none of them were marlow's line (id 2).
       The approximation would credit marlow 1 (position 2 ≤ currentLine 3); the
       set correctly credits 0. */
    const ids = characterSentenceIdsByChapter(sentences)[2];
    const completedSet = new Set([1, 3, 5]);
    const r = characterRowProgress({
      chapterState: 'in_progress',
      status: 'queued',
      linesTotal: 1,
      positions: [2],
      currentLine: 3,
      sentenceIds: ids.marlow,
      completedSet,
    });
    expect(r.derivedDone).toBe(0);
    expect(r.fullyDone).toBe(false);
  });

  it('marks a character fully done when all their sentence ids are in the set', () => {
    const ids = characterSentenceIdsByChapter(sentences)[2];
    const r = characterRowProgress({
      chapterState: 'in_progress',
      status: 'queued',
      linesTotal: 2,
      positions: [4, 5],
      currentLine: 5,
      sentenceIds: ids.wren,
      completedSet: new Set([4, 5]),
    });
    expect(r.derivedDone).toBe(2);
    expect(r.fraction).toBe(1);
    expect(r.fullyDone).toBe(true);
  });

  it('falls back to the currentLine approximation when no completed set is present (older server)', () => {
    /* No set / undefined → behave exactly as before: linesDoneAt(positions, currentLine). */
    const r = characterRowProgress({
      chapterState: 'in_progress',
      status: 'queued',
      linesTotal: 9,
      positions: [10, 41, 75, 90, 101, 120, 140, 160, 175],
      currentLine: 80,
      sentenceIds: undefined,
      completedSet: undefined,
    });
    expect(r.derivedDone).toBe(3);
    expect(r.fraction).toBeCloseTo(3 / 9, 5);
  });

  it('still honors chapter_complete (whole chapter done) over the set', () => {
    const ids = characterSentenceIdsByChapter(sentences)[2];
    const r = characterRowProgress({
      chapterState: 'done',
      status: 'done',
      linesTotal: 2,
      positions: [4, 5],
      currentLine: 0,
      sentenceIds: ids.wren,
      completedSet: new Set<number>(),
    });
    expect(r).toEqual({ derivedDone: 2, fraction: 1, fullyDone: true });
  });
});
