import { describe, it, expect } from 'vitest';
import { evalFixture, rosterToStage1, familyBreakdown, aggStage, type StageScore } from './run-eval.js';
import type { LabelledChapter } from './schema.js';
import type { RosterSnapshot } from './roster-schema.js';

const roster: RosterSnapshot = { characters: [
  { id: 'narrator', name: 'Narrator' },
  { id: 'alice', name: 'Alice', gender: 'female' },
] };

const truth: LabelledChapter = {
  chapterText: '"Hi," Alice said.',
  lines: [
    { text: 'Hi,', speakerId: 'alice' },
    { text: 'Alice said.', speakerId: 'narrator' },
  ],
};

// Full Analyzer stub (runAttributionEscalation → null so escalation is a no-op).
const fakeAnalyzer: any = {
  runStage1: () => Promise.reject(new Error('not used')),
  runStage1Chapter: () => Promise.reject(new Error('not used')),
  runStage2Chapter: () => Promise.resolve({ sentences: [
    { id: 1, chapterId: 44, characterId: 'alice', text: 'Hi,' },
    { id: 2, chapterId: 44, characterId: 'narrator', text: 'Alice said.' },
  ] }),
  runEmotionChapter: () => Promise.reject(new Error('not used')),
  runScriptReviewChapter: () => Promise.reject(new Error('not used')),
  runStage3Chapter: () => Promise.reject(new Error('not used')),
  runAttributionEscalation: () => Promise.resolve(null),
};

describe('rosterToStage1', () => {
  it('pins roster ids and satisfies characterSchema required fields', () => {
    const s1 = rosterToStage1(roster, 44);
    expect(s1.characters.map((c) => c.id)).toEqual(['narrator', 'alice']);
    expect(s1.characters[1].role).toBeTruthy();
    expect(s1.characters[1].color).toBeTruthy();
  });
});

describe('familyBreakdown', () => {
  it('excludes a drift line (truth === null) from attributed, counts it as drift', () => {
    // 3 tag lines: one correct, one wrong, one drift (segmentation split).
    const perLine = [
      { truth: 'alice', correct: true },
      { truth: 'bob', correct: false },
      { truth: null, correct: false },
    ];
    const reasons = [
      { reason: 'tag-confirm:alice' },
      { reason: 'tag-correct:bob' },
      { reason: 'tag-confirm:alice' },
    ];
    const fam = familyBreakdown(perLine, reasons, 3);
    expect(fam.tag).toEqual({ correct: 1, attributed: 2, drift: 1 });
  });

  it('buckets by evidence family and tolerates a missing reason (→ other)', () => {
    const perLine = [{ truth: 'x', correct: true }, { truth: 'y', correct: true }];
    const reasons = [{ reason: 'unanchored-narrator' }];
    const fam = familyBreakdown(perLine, reasons, 2);
    expect(fam.unanchored).toEqual({ correct: 1, attributed: 1, drift: 0 });
    expect(fam.other).toEqual({ correct: 1, attributed: 1, drift: 0 });
  });
});

const mkStage = (recall: number, byFamily: StageScore['byFamily'], seg = 0): StageScore => ({
  recall, precision: 1, segMismatch: seg, total: 10, byFamily,
});

describe('aggStage (multi-run averaging)', () => {
  it('averages per-run recall and reports the range', () => {
    const agg = aggStage([mkStage(0.60, {}), mkStage(0.66, {}), mkStage(0.63, {})]);
    expect(agg.recall.mean).toBeCloseTo(0.63);
    expect(agg.recall.min).toBeCloseTo(0.60);
    expect(agg.recall.max).toBeCloseTo(0.66);
  });

  it('averages per-run family accuracy; a family absent in a run contributes NO sample', () => {
    // Run 1: tag 1/2. Run 2: tag has no lines at all (family absent).
    const agg = aggStage([
      mkStage(0.5, { tag: { correct: 1, attributed: 2, drift: 0 } }),
      mkStage(0.5, {}),
    ]);
    // mean over the ONE run that had tag samples = 0.5, from 1 sampling run (not 0.25 over 2).
    expect(agg.byFamily.tag.acc.mean).toBeCloseTo(0.5);
    expect(agg.byFamily.tag.sampleRuns).toBe(1);
  });

  it('a family present but with 0 attributed (all drift) contributes NO accuracy sample', () => {
    const agg = aggStage([mkStage(0.5, { tag: { correct: 0, attributed: 0, drift: 3 } })]);
    expect(agg.byFamily.tag.sampleRuns).toBe(0);
    expect(agg.byFamily.tag.driftMean).toBeCloseTo(3);
  });
});

describe('evalFixture', () => {
  it('scores three stages against the real structure engine (en)', async () => {
    // en is a supported language → the structure branch runs for real; the fake's
    // runAttributionEscalation → null makes escalation a no-op. No config override needed.
    const res = await evalFixture({
      analyzer: fakeAnalyzer,
      manuscriptId: 'm', title: 'T', truth, roster, chapterId: 44,
      stageCall: { language: 'en' } as never,
    });
    expect(res.raw.recall).toBeCloseTo(1);
    expect(res.final.recall).toBeCloseTo(1);
    expect(res.final.total).toBe(2);
  });
});
