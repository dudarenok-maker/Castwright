import { describe, expect, it } from 'vitest';
import { conventionsFor } from './lang/index.js';
import { buildNameIndex } from './name-matcher.js';
import { parseChapterStructure } from './parser.js';
import { alignSentences } from './aligner.js';
import { crossExamine, CONFIDENCE } from './cross-examine.js';
import type { AlignedSentence, AlignmentResult } from './aligner.js';
import type { EvidenceSource, SpanEvidence } from './types.js';
import type { SentenceOutput } from '../../handoff/schemas.js';
import { MALE_BUCKET_ID, FEMALE_BUCKET_ID } from '../fold-minor-cast.js';

/* Task 7 (spec §5.3). Table-driven test: one case per matrix row, plus the
   five invariants from the task brief. Most rows are exercised directly
   against synthetic AlignedSentence fixtures (precise control over which
   row fires); the two hard invariants additionally run the real
   parser/aligner pipeline against the brief's example text, to prove the
   wiring end to end, not just the decision table in isolation. */

let nextId = 1;
const mkSentence = (characterId: string, confidence?: number): SentenceOutput => ({
  id: nextId++,
  chapterId: 1,
  characterId,
  text: 'irrelevant to cross-examine — decisions are driven by aligned spans',
  ...(confidence !== undefined ? { confidence } : {}),
});

const speechSpan = (speaker?: { characterId: string; source: EvidenceSource }): SpanEvidence => ({
  kind: 'speech',
  start: 0,
  end: 1,
  speaker,
});
const tagSpan = (): SpanEvidence => ({ kind: 'tag', start: 0, end: 1 });
const narrationSpan = (): SpanEvidence => ({ kind: 'narration', start: 0, end: 1 });

const aligned = (sentence: SentenceOutput, spans: SpanEvidence[], lumped = false): AlignedSentence => ({
  sentence,
  spans,
  lumped,
});

const ROSTER = new Set(['anton', 'olga', 'narrator']);
const UNKNOWN = new Set([MALE_BUCKET_ID, FEMALE_BUCKET_ID]);
const BASE_OPTS = { rosterIds: ROSTER, unknownBucketIds: UNKNOWN, alignmentFloorPct: 80 };

function run(list: AlignedSentence[], alignedPct = 100, opts = BASE_OPTS) {
  const alignment: AlignmentResult = { aligned: list, alignedPct };
  return crossExamine(alignment, opts);
}

describe('crossExamine — §5.3 decision matrix (one case per row)', () => {
  it('row 1: tag-name -> X, model says X -> confirm at TAG_CONFIRM', () => {
    const s = mkSentence('anton', 0.4);
    const result = run([aligned(s, [speechSpan({ characterId: 'anton', source: 'tag-name' })])]);
    expect(result.sentences[0].characterId).toBe('anton');
    expect(result.sentences[0].confidence).toBe(CONFIDENCE.TAG_CONFIRM);
    expect(result.flags).toEqual([]);
    expect(result.report.confirmed).toBe(1);
  });

  it('row 2: tag-name -> X, model says other -> auto-correct at TAG_CORRECT, no flag', () => {
    const s = mkSentence('narrator');
    const result = run([aligned(s, [speechSpan({ characterId: 'anton', source: 'tag-name' })])]);
    expect(result.sentences[0].characterId).toBe('anton');
    expect(result.sentences[0].confidence).toBe(CONFIDENCE.TAG_CORRECT);
    expect(result.flags).toEqual([]);
    expect(result.report.corrected).toBe(1);
  });

  it('row 3: tag/beat span itself, any character -> demote to narrator at TAG_SPAN', () => {
    const s = mkSentence('anton');
    const result = run([aligned(s, [tagSpan()])]);
    expect(result.sentences[0].characterId).toBe('narrator');
    expect(result.sentences[0].confidence).toBe(CONFIDENCE.TAG_SPAN);
    expect(result.flags).toEqual([]);
    expect(result.report.corrected).toBe(1);
  });

  it('row 4: tag-pronoun -> X, model says X -> confirm at PRONOUN_CONFIRM', () => {
    const s = mkSentence('anton');
    const result = run([aligned(s, [speechSpan({ characterId: 'anton', source: 'tag-pronoun' })])]);
    expect(result.sentences[0].characterId).toBe('anton');
    expect(result.sentences[0].confidence).toBe(CONFIDENCE.PRONOUN_CONFIRM);
    expect(result.flags).toEqual([]);
  });

  it('row 5a: tag-pronoun -> X, model says narrator -> auto-correct at PRONOUN_CORRECT, no flag', () => {
    const s = mkSentence('narrator');
    const result = run([aligned(s, [speechSpan({ characterId: 'anton', source: 'tag-pronoun' })])]);
    expect(result.sentences[0].characterId).toBe('anton');
    expect(result.sentences[0].confidence).toBe(CONFIDENCE.PRONOUN_CORRECT);
    expect(result.flags).toEqual([]);
    expect(result.report.corrected).toBe(1);
  });

  it('row 5b: tag-pronoun -> X, model says another named char -> keep model, flag at PRONOUN_KEEP_FLAG', () => {
    const s = mkSentence('olga');
    const result = run([aligned(s, [speechSpan({ characterId: 'anton', source: 'tag-pronoun' })])]);
    expect(result.sentences[0].characterId).toBe('olga'); // kept, not overridden
    expect(result.sentences[0].confidence).toBe(CONFIDENCE.PRONOUN_KEEP_FLAG);
    expect(result.flags).toEqual([{ index: 0, reason: 'pronoun-keep-flag:olga-vs-anton' }]);
    expect(result.report.flagged).toBe(1);
  });

  it('row 6: alternation -> X, model says X -> confirm at ALT_CONFIRM', () => {
    const s = mkSentence('anton');
    const result = run([aligned(s, [speechSpan({ characterId: 'anton', source: 'alternation' })])]);
    expect(result.sentences[0].characterId).toBe('anton');
    expect(result.sentences[0].confidence).toBe(CONFIDENCE.ALT_CONFIRM);
    expect(result.flags).toEqual([]);
  });

  it('row 7: alternation -> X, model says narrator/unknown-bucket -> correct + flag at ALT_CORRECT_FLAG', () => {
    const s = mkSentence(MALE_BUCKET_ID);
    const result = run([aligned(s, [speechSpan({ characterId: 'anton', source: 'alternation' })])]);
    expect(result.sentences[0].characterId).toBe('anton');
    expect(result.sentences[0].confidence).toBe(CONFIDENCE.ALT_CORRECT_FLAG);
    expect(result.flags).toEqual([{ index: 0, reason: `alt-correct-flag:anton` }]);
    expect(result.report.corrected).toBe(1);
  });

  it('row 8: alternation -> X, model says another named char -> keep model, flag at ALT_KEEP_FLAG', () => {
    const s = mkSentence('olga');
    const result = run([aligned(s, [speechSpan({ characterId: 'anton', source: 'alternation' })])]);
    expect(result.sentences[0].characterId).toBe('olga'); // kept, may know something structure doesn't
    expect(result.sentences[0].confidence).toBe(CONFIDENCE.ALT_KEEP_FLAG);
    expect(result.flags).toEqual([{ index: 0, reason: 'alt-keep-flag:olga-vs-anton' }]);
    expect(result.report.flagged).toBe(1);
  });

  it('row 9: unanchored speech, model says a named roster char -> keep, flag at UNANCH_NAMED_FLAG', () => {
    const s = mkSentence('anton');
    const result = run([aligned(s, [speechSpan(undefined)])]);
    expect(result.sentences[0].characterId).toBe('anton');
    expect(result.sentences[0].confidence).toBe(CONFIDENCE.UNANCH_NAMED_FLAG);
    expect(result.flags).toEqual([{ index: 0, reason: 'unanchored-named:anton' }]);
  });

  it('row 10: unanchored speech, model says narrator/unknown-bucket -> keep, flag hard at UNANCH_NARR_FLAG', () => {
    const s = mkSentence('narrator');
    const result = run([aligned(s, [speechSpan(undefined)])]);
    expect(result.sentences[0].characterId).toBe('narrator');
    expect(result.sentences[0].confidence).toBe(CONFIDENCE.UNANCH_NARR_FLAG);
    expect(result.flags).toEqual([{ index: 0, reason: 'unanchored-narrator' }]);
  });

  it('row 11: narration span, model says narrator -> confirm at NARRATION_CONFIRM', () => {
    const s = mkSentence('narrator');
    const result = run([aligned(s, [narrationSpan()])]);
    expect(result.sentences[0].characterId).toBe('narrator');
    expect(result.sentences[0].confidence).toBe(CONFIDENCE.NARRATION_CONFIRM);
    expect(result.flags).toEqual([]);
    expect(result.report.confirmed).toBe(1);
  });

  it('row 12: narration span, model says named char -> demote; first of a contiguous run is clamped <=0.5 and flagged, the rest are not', () => {
    const first = mkSentence('anton');
    const second = mkSentence('olga');
    const result = run([aligned(first, [narrationSpan()]), aligned(second, [narrationSpan()])]);

    expect(result.sentences[0].characterId).toBe('narrator');
    expect(result.sentences[0].confidence).toBeLessThanOrEqual(0.5);
    expect(result.sentences[1].characterId).toBe('narrator');
    expect(result.sentences[1].confidence).toBe(CONFIDENCE.NARRATION_DEMOTE);

    expect(result.flags).toEqual([{ index: 0, reason: 'narration-demote:first' }]);
    expect(result.report.corrected).toBe(2);
  });

  it('row 13: lumped entry -> keep model id, never correct, flag at LUMPED_FLAG', () => {
    const s = mkSentence('anton');
    const result = run([aligned(s, [speechSpan({ characterId: 'olga', source: 'tag-name' }), tagSpan()], true)]);
    expect(result.sentences[0].characterId).toBe('anton'); // kept, NOT retagged to the tag-name speaker
    expect(result.sentences[0].confidence).toBe(CONFIDENCE.LUMPED_FLAG);
    expect(result.flags).toEqual([{ index: 0, reason: 'lumped' }]);
    expect(result.report.lumped).toBe(1);
    expect(result.report.corrected).toBe(0);
  });

  it('row 14: unaligned sentence -> pass through, never correct, confidence capped at UNALIGNED_CAP', () => {
    const s = mkSentence('anton', 0.99);
    const result = run([aligned(s, [])]);
    expect(result.sentences[0].characterId).toBe('anton');
    expect(result.sentences[0].confidence).toBe(CONFIDENCE.UNALIGNED_CAP);
    expect(result.flags).toEqual([{ index: 0, reason: 'unaligned' }]);
  });
});

describe('crossExamine — hard invariants', () => {
  it('INVARIANT: tag-name evidence is never overridden — model disagreement auto-corrects (real parser pipeline)', () => {
    const ru = conventionsFor('ru')!;
    const idx = buildNameIndex([{ id: 'anton', name: 'Антон' }], ru);
    const body = '— Привет, — сказал Антон.';
    const paras = parseChapterStructure(body, idx);

    const sentence = mkSentence('narrator'); // model wrongly attributed the speech to narrator
    const alignment = alignSentences([{ ...sentence, text: 'Привет,' }], paras, body);
    expect(alignment.aligned[0].spans.some((s) => s.kind === 'speech' && s.speaker?.source === 'tag-name')).toBe(true);

    const result = crossExamine(alignment, { rosterIds: new Set(['anton', 'narrator']), unknownBucketIds: new Set(), alignmentFloorPct: 80 });
    expect(result.sentences[0].characterId).toBe('anton');
    expect(result.sentences[0].confidence).toBe(CONFIDENCE.TAG_CORRECT);
    expect(result.report.corrected).toBe(1);
  });

  it('INVARIANT: a continuation sentence inside a speech span is NOT demoted to narrator', () => {
    // No dash/quote of its own on the second sentence — old applyNarratorDefault
    // (text-heuristic isSpokenLine) would force it to narrator. The structural
    // engine must inherit the span's (unanchored) speech evidence instead and
    // keep the model's "anton" attribution (flagged, not silently discarded).
    const ru = conventionsFor('ru')!;
    const idx = buildNameIndex([{ id: 'anton', name: 'Антон' }], ru);
    const body = '— Привет. Давно не виделись.';
    const paras = parseChapterStructure(body, idx);

    const sentences = [
      { ...mkSentence('anton'), text: 'Привет.' },
      { ...mkSentence('anton'), text: 'Давно не виделись.' },
    ];
    const alignment = alignSentences(sentences, paras, body);
    expect(alignment.aligned).toHaveLength(2);
    // Both sentences land in the SAME speech span (continuation), not narration.
    expect(alignment.aligned[1].spans.every((s) => s.kind === 'speech')).toBe(true);

    const result = crossExamine(alignment, { rosterIds: new Set(['anton', 'narrator']), unknownBucketIds: new Set(), alignmentFloorPct: 80 });
    expect(result.sentences[1].characterId).toBe('anton'); // kept, NOT demoted to narrator
  });

  it('INVARIANT: lumped entries are flagged, never corrected', () => {
    const s = mkSentence('anton');
    const result = run([aligned(s, [speechSpan({ characterId: 'olga', source: 'tag-name' }), tagSpan()], true)]);
    expect(result.sentences[0].characterId).toBe('anton');
    expect(result.report.corrected).toBe(0);
    expect(result.report.lumped).toBe(1);
    expect(result.flags).toEqual([{ index: 0, reason: 'lumped' }]);
  });

  it('INVARIANT: below the alignment floor -> flagOnly, zero corrections, only the unaligned caps applied', () => {
    const list = [
      aligned(mkSentence('narrator'), [speechSpan({ characterId: 'anton', source: 'tag-name' })]), // would normally auto-correct
      aligned(mkSentence('olga', 0.9), [narrationSpan()]), // would normally demote
      aligned(mkSentence('anton'), []), // unaligned
    ];
    const result = run(list, 50); // 50% < 80% floor

    expect(result.report.flagOnly).toBe(true);
    expect(result.report.corrected).toBe(0);
    // model ids pass through completely unchanged, even the tag-name-contradicting one
    expect(result.sentences.map((s) => s.characterId)).toEqual(['narrator', 'olga', 'anton']);
    for (const s of result.sentences) expect(s.confidence).toBeLessThanOrEqual(CONFIDENCE.UNALIGNED_CAP);
  });

  it('INVARIANT: derived confidence REPLACES model confidence on every sentence', () => {
    // A "confirm" row (tag-name -> X, model says X) still overwrites a wildly
    // different model-reported confidence with the derived constant.
    const s = mkSentence('anton', 0.01);
    const result = run([aligned(s, [speechSpan({ characterId: 'anton', source: 'tag-name' })])]);
    expect(result.sentences[0].confidence).toBe(CONFIDENCE.TAG_CONFIRM);
    expect(result.sentences[0].confidence).not.toBe(0.01);
  });
});
