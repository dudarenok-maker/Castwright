import { describe, it, expect } from 'vitest';
import { evalFixture, rosterToStage1, familyBreakdown, aggStage, aggregateFixture, rosterAliasMap, scoreStage, type StageScore, type ReviewScore, type FixtureResult } from './run-eval.js';
import type { LabelledChapter } from './schema.js';
import type { RosterSnapshot } from './roster-schema.js';
import type { SentenceOutput } from '../../handoff/schemas.js';

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

describe('rosterAliasMap', () => {
  it('rosterAliasMap maps canonicalId', () => {
    const map = rosterAliasMap({ characters: [
      { id: 'the_torment', name: 'Torment', canonicalId: 'unknown-male' },
      { id: 'unknown-male', name: 'Unknown male' },
    ]});
    expect(map.get('the_torment')).toBe('unknown-male');
    expect(map.has('unknown-male')).toBe(false);
  });
});

describe('scoreStage aliasMap threading', () => {
  it('threads aliasMap into scoreAttribution: aliased predicted id scores as a true positive', () => {
    const truth: LabelledChapter = {
      chapterText: '"There it is," said the shape.',
      lines: [{ text: 'There it is,', speakerId: 'unknown-male' }],
    };
    const sentences: SentenceOutput[] = [
      { id: 1, chapterId: 1, characterId: 'the_torment', text: 'There it is,' },
    ];
    const aliasMap = new Map([['the_torment', 'unknown-male']]);

    const withAlias = scoreStage(truth, sentences, undefined, aliasMap);
    expect(withAlias.recall).toBeCloseTo(1);
    expect(withAlias.total).toBe(1);

    // Without the aliasMap, `the_torment` and `unknown-male` are treated as
    // distinct ids — same call scores a false negative (recall 0). This is
    // what proves the threading (not just the map construction) matters:
    // dropping the aliasMap argument from scoreStage's scoreAttribution call
    // would make `withAlias` regress to this same result.
    const withoutAlias = scoreStage(truth, sentences, undefined);
    expect(withoutAlias.recall).toBeCloseTo(0);
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

  it('populates raw.byFamily so the per-family gate has data (Target C)', async () => {
    const res = await evalFixture({
      analyzer: fakeAnalyzer,
      manuscriptId: 'm', title: 'T', truth, roster, chapterId: 44,
      stageCall: { language: 'en' } as never,
    });
    // Before Target C this was {} (raw scored without reasons).
    expect(Object.keys(res.raw.byFamily).length).toBeGreaterThan(0);
    // Same family set as deterministic, since evidence family is a property of the text.
    expect(Object.keys(res.raw.byFamily).sort()).toEqual(
      Object.keys(res.deterministic.byFamily).sort(),
    );
  });

  it('review:false (default) leaves raw/det/final byte-identical and omits reviewed', async () => {
    const res = await evalFixture({
      analyzer: fakeAnalyzer,
      manuscriptId: 'm', title: 'T', truth, roster, chapterId: 44,
      stageCall: { language: 'en' } as never,
    });
    // The non-review result shape is exactly the four existing keys.
    expect(Object.keys(res).sort()).toEqual(['deterministic', 'final', 'fixture', 'raw']);
    expect('reviewed' in res).toBe(false);
    expect(res.final.recall).toBeCloseTo(1);
  });
});

describe('evalFixture — reviewed char-stage (opt-in)', () => {
  // Analyzer whose review pass emits one on-roster reattribute that HARMS the
  // (correct) narration span id:2 by pointing it at alice — a deterministic way
  // to exercise applyOpsToCharArray + diffHelpedHarmed through the char adapter.
  const reviewAnalyzer: any = {
    ...fakeAnalyzer,
    runScriptReviewChapter: () =>
      Promise.resolve({
        ops: [{ id: 2, op: 'reattribute', characterId: 'alice', rationale: 'test harm' }],
      }),
  };

  it('populates reviewed with char/line recalls, helped/harmed, drops, opsByClass and a scored (non-dumped) op', async () => {
    const res = await evalFixture({
      analyzer: reviewAnalyzer,
      manuscriptId: 'm', title: 'T', truth, roster, chapterId: 44,
      stageCall: { language: 'en' } as never,
      review: true,
      engine: 'qwen',
    });
    expect(res.reviewed).toBeDefined();
    const rv = res.reviewed!;
    // char adapter (characterId → speakerId) works: final matches truth → charFinal > 0.
    expect(rv.charFinal).toBeGreaterThan(0);
    expect(typeof rv.lineFinal).toBe('number');
    expect(typeof rv.lineReviewed).toBe('number');
    // The reattribute on the (correct) narration span is a harm → reviewed drops below final.
    expect(rv.charReviewed).toBeLessThan(rv.charFinal);
    expect(rv.harmed).toBeGreaterThan(0);
    expect(rv.helped).toBe(0);
    expect(rv.churn).toBe(0);
    // Verbatim final/truth text → nothing drops out of the projection.
    expect(rv.predictedDropped).toBe(0);
    expect(rv.truthDropped).toBe(0);
    // opsByClass counts ALL ops; the accepted char-affecting reattribute is SCORED, so not dumped.
    expect(rv.opsByClass.reattribute).toBe(1);
    expect(rv.dump).toEqual([]);
  });
});

describe('aggregateFixture — reviewed aggregation (aggReview)', () => {
  const mkReviewed = (over: Partial<ReviewScore>): ReviewScore => ({
    charFinal: 1, charReviewed: 1, lineFinal: 1, lineReviewed: 1,
    helped: 0, harmed: 0, churn: 0, predictedDropped: 0, truthDropped: 0, droppedChunks: 0,
    opsByClass: {}, dump: [], ...over,
  });
  const mkResult = (reviewed?: ReviewScore): FixtureResult => ({
    fixture: 'c', raw: mkStage(1, {}), deterministic: mkStage(1, {}), final: mkStage(1, {}),
    ...(reviewed ? { reviewed } : {}),
  });

  it('averages per-run reviewed into a ReviewAgg with Stat fields and run-0 dump', () => {
    const r0 = mkResult(mkReviewed({ helped: 2, harmed: 1, droppedChunks: 1, opsByClass: { reattribute: 1 }, dump: [{ id: 1, op: 'strip_tag', rationale: 'r0' }] }));
    const r1 = mkResult(mkReviewed({ helped: 4, harmed: 3, droppedChunks: 0, opsByClass: { reattribute: 3, split: 1 }, dump: [{ id: 2, op: 'merge', rationale: 'r1' }] }));
    const agg = aggregateFixture([r0, r1]);
    expect(agg.reviewed).toBeDefined();
    expect(agg.reviewed!.helped).toEqual({ mean: 3, min: 2, max: 4 });
    expect(agg.reviewed!.harmed).toEqual({ mean: 2, min: 1, max: 3 });
    expect(agg.reviewed!.droppedChunks).toEqual({ mean: 0.5, min: 0, max: 1 });
    // mean count per class across runs (split absent in run-0 counts as 0).
    expect(agg.reviewed!.opsByClass.reattribute).toBeCloseTo(2);
    expect(agg.reviewed!.opsByClass.split).toBeCloseTo(0.5);
    // dump is representative: run-0's.
    expect(agg.reviewed!.dump).toEqual(r0.reviewed!.dump);
  });

  it('leaves reviewed undefined when no run carries a reviewed score', () => {
    const agg = aggregateFixture([mkResult(), mkResult()]);
    expect(agg.reviewed).toBeUndefined();
  });
});
