import { describe, it, expect } from 'vitest';
import { countSentencesHeuristic, countStreamedSentences, monotonicHighWater, refineSentencesTotal, sentenceProgressForTick, projectChapterEstMsFromSentences, clampChapterEstMs, selectChapterEstMs } from './sentence-progress.js';

describe('countSentencesHeuristic', () => {
  it('counts sentence-boundary splits', () => {
    expect(countSentencesHeuristic('He ran. She hid! Did he? Yes.')).toBe(4);
  });
  it('returns 0 for empty / whitespace', () => {
    expect(countSentencesHeuristic('')).toBe(0);
    expect(countSentencesHeuristic('   \n  ')).toBe(0);
  });
  it('counts a single unpunctuated line as 1', () => {
    expect(countSentencesHeuristic('a quiet fragment')).toBe(1);
  });
});

describe('countStreamedSentences', () => {
  it('counts one per "characterId": key token', () => {
    const buf = '{"sentences":[{"id":1,"characterId":"narrator","text":"Hi."},{"id":2,"characterId":"mara","text":"Go."}';
    expect(countStreamedSentences(buf)).toBe(2);
  });
  it('tolerates whitespace before the colon and a mid-token tail', () => {
    const buf = '{"sentences":[{"id":1,"characterId" : "narrator","text":"Hi."},{"id":2,"characterId';
    expect(countStreamedSentences(buf)).toBe(1); // the half-written 2nd has no colon yet
  });
  it('returns 0 for empty', () => {
    expect(countStreamedSentences('')).toBe(0);
  });
});

describe('monotonicHighWater (anti-snap-back across a stream retry within a section)', () => {
  it('rises with the live counter while it grows', () => {
    expect(monotonicHighWater(40, 55)).toBe(55); // sentence markers
    expect(monotonicHighWater(2_700, 13_000)).toBe(13_000); // received bytes
  });
  it('does NOT drop when a transient retry restarts the buffer mid-section', () => {
    // The reported bug: a section streamed to ~250 markers / 13 KB, then a
    // coverage/Gemini retry restarted the buffer, so the raw live counts
    // collapsed (~250→30 markers, 13 KB→2.7 KB). The high-water mark holds, so
    // "Attributed ~N" and "N KB received" never regress.
    expect(monotonicHighWater(250, 30)).toBe(250);
    expect(monotonicHighWater(13_000, 2_700)).toBe(13_000);
  });
  it('holds steady when the count is unchanged', () => {
    expect(monotonicHighWater(100, 100)).toBe(100);
  });
  it('starts fresh from a boundary reset (prev = 0)', () => {
    // The caller resets the slot to 0 at a real boundary (section start / done
    // for sentences), so a new section legitimately begins counting from its
    // own markers, not the prior section's mark.
    expect(monotonicHighWater(0, 3)).toBe(3);
  });
});

describe('sentenceProgressForTick (anti-snap-back across a section boundary)', () => {
  const base = { totalChars: 2000, heuristicTotal: 200 };
  it('mid section 1: committed 0 + in-flight markers', () => {
    const r = sentenceProgressForTick({ ...base, committedSentences: 0, committedChars: 0, inflightSentences: 40 });
    expect(r.sentencesDone).toBe(40);
  });
  it('section 1 done (100 over 1000 chars), section 2 just started: count does NOT drop', () => {
    const afterS1 = sentenceProgressForTick({ ...base, committedSentences: 100, committedChars: 1000, inflightSentences: 0 });
    const earlyS2 = sentenceProgressForTick({ ...base, committedSentences: 100, committedChars: 1000, inflightSentences: 3 });
    expect(afterS1.sentencesDone).toBe(100);
    expect(earlyS2.sentencesDone).toBe(103); // committed + new in-flight, never < 100
    expect(earlyS2.sentencesDone).toBeGreaterThanOrEqual(afterS1.sentencesDone);
  });
  it('displayed total never falls below sentencesDone', () => {
    const r = sentenceProgressForTick({ totalChars: 1000, heuristicTotal: 5, committedSentences: 50, committedChars: 1000, inflightSentences: 0 });
    expect(r.sentencesTotal).toBeGreaterThanOrEqual(r.sentencesDone);
  });
});

describe('refineSentencesTotal', () => {
  it('returns the heuristic when no section has completed', () => {
    expect(
      refineSentencesTotal({ committedSentences: 0, committedChars: 0, totalChars: 9000, heuristicTotal: 300 }),
    ).toBe(300);
  });
  it('projects from observed sentences-per-char once a section is done', () => {
    // section 1: 100 sentences over 1000 chars → 0.1/char; 9000 total chars.
    // projected = 100 + 0.1 * (9000 - 1000) = 900.
    expect(
      refineSentencesTotal({ committedSentences: 100, committedChars: 1000, totalChars: 9000, heuristicTotal: 300 }),
    ).toBe(900);
  });
  it('never returns below the committed count', () => {
    expect(
      refineSentencesTotal({ committedSentences: 50, committedChars: 9000, totalChars: 9000, heuristicTotal: 10 }),
    ).toBe(50);
  });
});

describe('projectChapterEstMsFromSentences', () => {
  it('returns null before MIN_REFINE_ELAPSED (8s)', () => {
    expect(projectChapterEstMsFromSentences(5000, 50, 100)).toBeNull();
  });
  it('returns null below the 2% fraction floor', () => {
    expect(projectChapterEstMsFromSentences(20000, 1, 100)).toBeNull(); // 1% done
  });
  it('returns null when no sentence is done yet (done < 1)', () => {
    expect(projectChapterEstMsFromSentences(20000, 0, 100)).toBeNull();
  });
  it('returns null when the total is not yet known (total <= 0)', () => {
    expect(projectChapterEstMsFromSentences(20000, 5, 0)).toBeNull();
  });
  it('projects total from the fraction once meaningful', () => {
    // 10s elapsed at 25% done → ~40s total.
    expect(projectChapterEstMsFromSentences(10000, 25, 100)).toBe(40000);
  });
});

describe('clampChapterEstMs', () => {
  it('never returns below a floor just above elapsed', () => {
    expect(clampChapterEstMs(1000, 60000, 0, 600000)).toBeGreaterThan(60000);
  });
  it('falls back to lastGood when candidate is null', () => {
    expect(clampChapterEstMs(null, 10000, 90000, 600000)).toBe(90000);
  });
  it('never returns the whole-stage value (multi-chapter)', () => {
    expect(clampChapterEstMs(600000, 10000, 0, 600000)).toBeLessThan(600000);
  });
  it('applies NO stage ceiling when stageEstMs<=0 (single-chapter book)', () => {
    // A 1-chapter book: chapter estimate legitimately equals the stage estimate,
    // so the caller passes stageEstMs=0 to disable the ceiling. The candidate
    // survives (only the elapsed-floor applies).
    expect(clampChapterEstMs(300000, 10000, 0, 0)).toBe(300000);
  });
});

describe('selectChapterEstMs (estimate-band invariants — bugs 1 & 2)', () => {
  const stage = 600_000; // whole-stage value that must NEVER appear in a chapter row
  it('prefers the sentence projection over bytes', () => {
    const r = selectChapterEstMs({ elapsedMs: 10_000, bySentenceMs: 40_000, byBytesMs: 99_000, lastGoodMs: 50_000, stageEstMs: stage });
    expect(r).toBe(40_000);
  });
  it('falls back to bytes, then last-good, when earlier signals are null', () => {
    expect(selectChapterEstMs({ elapsedMs: 10_000, bySentenceMs: null, byBytesMs: 70_000, lastGoodMs: 50_000, stageEstMs: stage })).toBe(70_000);
    expect(selectChapterEstMs({ elapsedMs: 10_000, bySentenceMs: null, byBytesMs: null, lastGoodMs: 50_000, stageEstMs: stage })).toBe(50_000);
  });
  it('never returns null/blank, never the stage value, always > elapsed', () => {
    const r = selectChapterEstMs({ elapsedMs: 120_000, bySentenceMs: stage, byBytesMs: null, lastGoodMs: 0, stageEstMs: stage });
    expect(r).toBeGreaterThan(120_000);
    expect(r).toBeLessThan(stage);
    expect(r).toBeTypeOf('number');
  });
});
