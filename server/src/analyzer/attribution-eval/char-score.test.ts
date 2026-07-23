/* scoreCharRecall + diffHelpedHarmed — the char-level scorer that succeeds
   scorer.ts's line-level scoreAttribution for review-op evaluation. Keying on
   character positions (rather than normalised line text) lets a correct
   split/extract/reattribute op register as a genuine recall lift with
   harmed === 0 — exactly the case the old line-level scorer, which sees a
   split as the original line simply vanishing, misread as a regression. */
import { describe, it, expect } from 'vitest';
import { scoreCharRecall, diffHelpedHarmed } from './char-score.js';
import type { CharProjection } from './char-project.js';

function projection(
  chapterLength: number,
  spans: Array<{ start: number; end: number; speakerId: string }>
): CharProjection {
  const speakerByChar: Array<string | null> = new Array(chapterLength).fill(null);
  for (const span of spans) {
    for (let i = span.start; i < span.end; i++) speakerByChar[i] = span.speakerId;
  }
  return { speakerByChar, spans, dropped: 0 };
}

describe('scoreCharRecall', () => {
  it('(a) all chars correct: charRecall === 1, lineRecall === 1', () => {
    const truth = projection(10, [{ start: 0, end: 10, speakerId: 'anakin' }]);
    const predicted = projection(10, [{ start: 0, end: 10, speakerId: 'anakin' }]);

    const score = scoreCharRecall(truth, predicted);

    expect(score.charRecall).toBe(1);
    expect(score.lineRecall).toBe(1);
    expect(score.truthChars).toBe(10);
  });

  it('(b) the split-lift case: a correct split raises charRecall/helped with harmed === 0', () => {
    // truth: a single 20-char utterance actually spoken by two speakers —
    // chars [0,10) = A, [10,20) = B.
    const truth = projection(20, [
      { start: 0, end: 10, speakerId: 'A' },
      { start: 10, end: 20, speakerId: 'B' },
    ]);
    // final: the whole span attributed to A (second half wrong).
    const final = projection(20, [{ start: 0, end: 20, speakerId: 'A' }]);
    // reviewed: split so the second half becomes B, matching truth exactly.
    const reviewed = projection(20, [
      { start: 0, end: 10, speakerId: 'A' },
      { start: 10, end: 20, speakerId: 'B' },
    ]);

    const finalScore = scoreCharRecall(truth, final);
    const reviewedScore = scoreCharRecall(truth, reviewed);
    expect(finalScore.charRecall).toBe(0.5);
    expect(reviewedScore.charRecall).toBe(1);

    const diff = diffHelpedHarmed(final.speakerByChar, reviewed.speakerByChar, truth.speakerByChar);
    expect(diff.helped).toBe(10);
    expect(diff.harmed).toBe(0);
    expect(diff.churn).toBe(0);
  });

  it('(c) a harmed case: reviewed overturns a correct span', () => {
    const truth = projection(10, [{ start: 0, end: 10, speakerId: 'A' }]);
    const final = projection(10, [{ start: 0, end: 10, speakerId: 'A' }]);
    const reviewed = projection(10, [{ start: 0, end: 10, speakerId: 'B' }]);

    const diff = diffHelpedHarmed(final.speakerByChar, reviewed.speakerByChar, truth.speakerByChar);

    expect(diff.harmed).toBe(10);
    expect(diff.helped).toBe(0);
    expect(diff.churn).toBe(0);
  });

  it('(d) aliasMap resolves the_torment -> unknown-male so an aliased match scores correct', () => {
    const truth = projection(10, [{ start: 0, end: 10, speakerId: 'unknown-male' }]);
    const predicted = projection(10, [{ start: 0, end: 10, speakerId: 'the_torment' }]);
    const aliasMap = new Map([['the_torment', 'unknown-male']]);

    const withoutAlias = scoreCharRecall(truth, predicted);
    expect(withoutAlias.charRecall).toBe(0);

    const withAlias = scoreCharRecall(truth, predicted, aliasMap);
    expect(withAlias.charRecall).toBe(1);
  });

  it('(e) lineRecall weights a long narration span and a short dialogue line equally', () => {
    // 90-char narration span (correctly predicted) + 10-char dialogue span
    // (entirely mis-attributed).
    const truth = projection(100, [
      { start: 0, end: 90, speakerId: 'narrator' },
      { start: 90, end: 100, speakerId: 'anakin' },
    ]);
    const predicted = projection(100, [
      { start: 0, end: 90, speakerId: 'narrator' },
      { start: 90, end: 100, speakerId: 'obiwan' }, // wrong speaker for the short line
    ]);

    const score = scoreCharRecall(truth, predicted);

    expect(score.charRecall).toBe(0.9); // only 10 of 100 chars wrong
    expect(score.lineRecall).toBe(0.5); // (1.0 + 0.0) / 2 — the short line counts as much as the long one
  });

  it('(f) an interior null (inline tag) in a truth span is excluded from lineRecall, not scored as wrong', () => {
    // Mirrors the truth projection under stripTags: a span [0,10) whose chars
    // [4,6) are a stripped inline tag (null), the rest attributed to 'A'. The
    // predicted side (final/reviewed, no stripTags) paints the tag chars with a
    // real speaker. A perfectly-attributed recovered line must score 1.0, not
    // deflate to 0.8 by counting the 2 tag chars as mismatches.
    const truthSpeakerByChar: Array<string | null> = new Array(10).fill('A');
    truthSpeakerByChar[4] = null;
    truthSpeakerByChar[5] = null;
    const truth: CharProjection = {
      speakerByChar: truthSpeakerByChar,
      spans: [{ start: 0, end: 10, speakerId: 'A' }],
      dropped: 0,
    };
    const predicted = projection(10, [{ start: 0, end: 10, speakerId: 'A' }]);

    const score = scoreCharRecall(truth, predicted);
    expect(score.truthChars).toBe(8); // 2 tag chars excluded from the denominator
    expect(score.charRecall).toBe(1);
    expect(score.lineRecall).toBe(1); // the span's 8 attributed chars are all correct
  });
});
