import { describe, it, expect } from 'vitest';
import { countSentencesHeuristic, countStreamedSentences, refineSentencesTotal, sentenceProgressForTick } from './sentence-progress.js';

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
