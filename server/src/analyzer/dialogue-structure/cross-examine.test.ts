import { describe, expect, it } from 'vitest';
import { conventionsFor } from './lang/index.js';
import { buildNameIndex } from './name-matcher.js';
import { parseChapterStructure } from './parser.js';
import { alignSentences } from './aligner.js';
import { crossExamine, CONFIDENCE } from './cross-examine.js';
import type { CrossExamineOpts } from './cross-examine.js';
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
const BASE_OPTS: CrossExamineOpts = { rosterIds: ROSTER, unknownBucketIds: UNKNOWN, alignmentFloorPct: 80 };

function run(list: AlignedSentence[], alignedPct = 100, opts: CrossExamineOpts = BASE_OPTS) {
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

  it('row 3: tag/beat span itself, model already says narrator -> same flat TAG_SPAN row, no 0.95 confirm sub-case', () => {
    const s = mkSentence('narrator');
    const result = run([aligned(s, [tagSpan()])]);
    expect(result.sentences[0].characterId).toBe('narrator');
    expect(result.sentences[0].confidence).toBe(CONFIDENCE.TAG_SPAN);
    expect(result.flags).toEqual([]);
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

describe('crossExamine — priorCharacterId (#1984 D18)', () => {
  it('records the overwritten id when a tag span demotes a named character to narrator', () => {
    const s = mkSentence('anton');
    const result = run([aligned(s, [tagSpan()])]);
    expect(result.sentences[0].characterId).toBe('narrator');
    expect(result.sentences[0].priorCharacterId).toBe('anton');
  });

  it('records nothing when a narration span RE-AFFIRMS a sentence already narrator (not an overwrite)', () => {
    // The trap: keying on `bucket === 'corrected'` would mislabel this. This
    // is decideNarrationOnly returning NARRATOR_ID for a sentence whose
    // incoming id is already narrator — the bucket can read 'corrected' with
    // no actual change, and this is exactly that case.
    const s = mkSentence('narrator');
    const result = run([aligned(s, [narrationSpan()])]);
    expect(result.sentences[0].characterId).toBe('narrator');
    expect(result.sentences[0].priorCharacterId).toBeUndefined();
  });

  it('records the overwritten id when a tag-name correction moves the id off narrator', () => {
    const s = mkSentence('narrator');
    const result = run([aligned(s, [speechSpan({ characterId: 'anton', source: 'tag-name' })])]);
    expect(result.sentences[0].characterId).toBe('anton');
    expect(result.sentences[0].priorCharacterId).toBe('narrator');
  });

  it('records nothing when the id is confirmed, unchanged (row 1)', () => {
    const s = mkSentence('anton', 0.4);
    const result = run([aligned(s, [speechSpan({ characterId: 'anton', source: 'tag-name' })])]);
    expect(result.sentences[0].characterId).toBe('anton');
    expect(result.sentences[0].priorCharacterId).toBeUndefined();
  });

  it('a stale incoming priorCharacterId is overwritten rather than retained when the id changes again', () => {
    const stale: SentenceOutput = { ...mkSentence('anton'), priorCharacterId: 'someone-else' };
    const result = run([aligned(stale, [tagSpan()])]);
    expect(result.sentences[0].characterId).toBe('narrator');
    expect(result.sentences[0].priorCharacterId).toBe('anton'); // NOT 'someone-else'
  });

  it('records nothing when a tag span RE-AFFIRMS a sentence already narrator — the discriminating case the narration-only trap above cannot catch (finding 3)', () => {
    // decideTagSpanOnly() returns bucket: 'corrected' UNCONDITIONALLY (unlike
    // decideNarrationOnly, which returns 'confirmed' for an already-narrator
    // sentence). A `decision.bucket === 'corrected'` mutant is indistinguishable
    // from the correct `characterId !==` check on every OTHER fixture in this
    // block, including the narration-span trap at :207 — only a tag-only span
    // on an already-narrator sentence tells them apart.
    const s = mkSentence('narrator');
    const result = run([aligned(s, [tagSpan()])]);
    expect(result.sentences[0].characterId).toBe('narrator');
    expect(result.sentences[0].priorCharacterId).toBeUndefined();
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

  it('below the alignment floor -> speech/tag corrections suppressed, but pure-narration still demotes (Wave A parity)', () => {
    const list = [
      aligned(mkSentence('narrator'), [speechSpan({ characterId: 'anton', source: 'tag-name' })]), // tag-name correction SUPPRESSED below floor
      aligned(mkSentence('olga', 0.9), [narrationSpan()]), // pure narration STILL demotes to narrator (Wave A parity)
      aligned(mkSentence('anton'), []), // unaligned
    ];
    const result = run(list, 50); // 50% < 80% floor

    expect(result.report.flagOnly).toBe(true);
    // the tag-name-contradicting speech line is NOT corrected below floor; only the narration demote is
    expect(result.sentences.map((s) => s.characterId)).toEqual(['narrator', 'narrator', 'anton']);
    expect(result.report.corrected).toBe(1);
    for (const s of result.sentences) expect(s.confidence).toBeLessThanOrEqual(CONFIDENCE.UNALIGNED_CAP);
  });

  it('(RC2) below the alignment floor, still demotes pure-narration off a named char to narrator', () => {
    const as = {
      sentence: mkSentence('егор'),
      spans: [{ kind: 'narration', start: 0, end: 12 } as SpanEvidence],
      lumped: false,
    };
    const result = crossExamine(
      { alignedPct: 60, aligned: [as] } as any,
      { rosterIds: new Set(['егор', 'narrator']), unknownBucketIds: new Set(), alignmentFloorPct: 80 },
    );
    expect(result.sentences[0].characterId).toBe('narrator');
    expect(result.sentences[0].confidence).toBeLessThanOrEqual(0.5);
  });

  it('DEFENSIVE GUARD: an anchored speech span with an unexpected EvidenceSource (neither tag-name, tag-pronoun, nor alternation) keeps the model id and flags it — never auto-corrects to the span speaker', () => {
    // `unanchored` is a real EvidenceSource member, but windows.ts never
    // actually stamps it on a span that HAS a `speaker` (it just leaves
    // `speaker` undefined instead). This fixture forces that combination
    // anyway to prove decideAnchoredSpeech's defensive fallback: it must
    // not silently fabricate a correction just because some future producer
    // stamps a source this matrix doesn't otherwise recognise.
    const s = mkSentence('olga');
    const result = run([aligned(s, [speechSpan({ characterId: 'anton', source: 'unanchored' })])]);
    expect(result.sentences[0].characterId).toBe('olga'); // kept, NOT corrected to 'anton'
    expect(result.sentences[0].confidence).toBeLessThan(0.75);
    expect(result.flags).toEqual([{ index: 0, reason: 'unexpected-source:unanchored' }]);
    expect(result.report.flagged).toBe(1);
    expect(result.report.corrected).toBe(0);
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

describe('A2 — weak tag-name is contestable', () => {
  const opts = {
    rosterIds: new Set(['anton', 'olga', 'narrator']),
    unknownBucketIds: new Set([MALE_BUCKET_ID, FEMALE_BUCKET_ID]),
    alignmentFloorPct: 80,
  };
  const alignedWith = (id: string, spans: SpanEvidence[]) => aligned(mkSentence(id), spans);
  const weakSpeechSpan: SpanEvidence = { kind: 'speech', start: 0, end: 5, speaker: { characterId: 'anton', source: 'tag-name' as const, strength: 'weak' as const } };

  it('a weak tag the model DISAGREES with keeps the model id and flags (no force-correct)', () => {
    const aligned = alignedWith('olga', [weakSpeechSpan]); // model said olga, weak tag says anton
    const res = crossExamine({ alignedPct: 100, aligned: [aligned] } as any, opts);
    expect(res.sentences[0].characterId).toBe('olga');
    expect(res.flags).toContainEqual({ index: 0, reason: 'tag-weak-keep-flag:olga-vs-anton' });
  });

  it('a weak tag the model AGREES with still confirms to the right speaker (correct-beat guard)', () => {
    const aligned = alignedWith('anton', [weakSpeechSpan]);
    const res = crossExamine({ alignedPct: 100, aligned: [aligned] } as any, opts);
    expect(res.sentences[0].characterId).toBe('anton');
    expect(res.flags).toEqual([]); // confirmed, not flagged
  });

  it('a STRONG tag disagreement still force-corrects (unchanged invariant)', () => {
    const strong = { ...weakSpeechSpan, speaker: { characterId: 'anton', source: 'tag-name' as const } };
    const aligned = alignedWith('olga', [strong]);
    const res = crossExamine({ alignedPct: 100, aligned: [aligned] } as any, opts);
    expect(res.sentences[0].characterId).toBe('anton'); // strong tag wins
    expect(res.flags).toEqual([]);
  });
});

/* #2253 — the dialogue-convention invariant. A sentence that OPENS with the
   language's dialogue marker is speech by that language's own convention;
   tag-only or narration-only structural evidence means the parser failed to
   segment a merged paragraph (#2254), NOT that the line is narration.

   These cases drive the sentence TEXT (not just spans), because the invariant
   is the one rule in this file that reads the text at all. */
describe('#2253 — dialogue-convention invariant (decideSentence)', () => {
  const RU_DASH = /^\s*(?:&mdash;|&ndash;|[-–—])\s*/iu;
  const DASH_OPTS = { ...BASE_OPTS, dialogueOpen: RU_DASH };

  const mkText = (characterId: string, text: string): SentenceOutput => ({
    id: nextId++,
    chapterId: 1,
    characterId,
    text,
  });

  it('tag-only spans: a dash-opening line keeps the model speaker and flags', () => {
    const s = mkText('anton', '— Не стоит');
    const res = run([aligned(s, [tagSpan()])], 100, DASH_OPTS);
    expect(res.sentences[0].characterId).toBe('anton');
    expect(res.sentences[0].confidence).toBe(CONFIDENCE.TAG_WEAK_KEEP_FLAG);
    expect(res.sentences[0].confidence).toBeLessThan(0.75); // the UI must highlight it
    expect(res.flags).toContainEqual({ index: 0, reason: 'dash-line-keep-flag:anton' });
  });

  it('narration-only spans: the SECOND demote route is closed too', () => {
    // decideNarrationOnly reaches `narrator` without any tag span at all —
    // fixing only the tag route would reroute, not fix (this is why a
    // tag-span length bound measured 879 -> 879).
    const s = mkText('anton', '— Не стоит');
    const res = run([aligned(s, [narrationSpan()])], 100, DASH_OPTS);
    expect(res.sentences[0].characterId).toBe('anton');
    expect(res.flags).toContainEqual({ index: 0, reason: 'dash-line-keep-flag:anton' });
  });

  it('a dash-opening line the model already calls narrator is untouched', () => {
    const s = mkText('narrator', '— Не стоит');
    const res = run([aligned(s, [tagSpan()])], 100, DASH_OPTS);
    expect(res.sentences[0].characterId).toBe('narrator');
    expect(res.sentences[0].confidence).toBe(CONFIDENCE.TAG_SPAN);
    expect(res.flags).toEqual([]);
  });

  it('a dash-opening line attributed to an unknown-gender bucket is untouched', () => {
    const s = mkText(MALE_BUCKET_ID, '— Не стоит');
    const res = run([aligned(s, [tagSpan()])], 100, DASH_OPTS);
    expect(res.sentences[0].characterId).toBe('narrator');
    expect(res.flags).toEqual([]);
  });

  // #2253 review findings 1+2 — the two call sites (above/below the alignment
  // floor) must ask the SAME rescue question. Below the floor, an
  // unknown-gender-bucket id is not a speaker to keep: it must demote to
  // narrator exactly like the above-floor case just above, not survive as
  // `flag-only-floor`.
  it('below the floor, a dash-opening line attributed to an unknown-gender bucket demotes to narrator (not kept)', () => {
    const s = mkText(MALE_BUCKET_ID, '— Не стоит');
    const res = run([aligned(s, [tagSpan()])], 50, DASH_OPTS);
    expect(res.sentences[0].characterId).toBe('narrator');
    expect(res.flags).toContainEqual({ index: 0, reason: 'narration-demote:first' });
  });

  // Roster membership: an id absent from stage1.characters is one
  // `reconcileSentenceCharacterIds` demotes downstream anyway — keeping it
  // here rescues nothing and only inflates `demotedCount`.
  it('below the floor, a dash-opening line with an off-roster id demotes to narrator (not kept)', () => {
    const s = mkText('борис-игнатьевич', '— Не стоит');
    const res = run([aligned(s, [tagSpan()])], 50, DASH_OPTS);
    expect(res.sentences[0].characterId).toBe('narrator');
    expect(res.flags).toContainEqual({ index: 0, reason: 'narration-demote:first' });
  });

  it('above the floor, a dash-opening line with an off-roster id demotes to narrator (not kept)', () => {
    const s = mkText('борис-игнатьевич', '— Не стоит');
    const res = run([aligned(s, [tagSpan()])], 100, DASH_OPTS);
    expect(res.sentences[0].characterId).toBe('narrator');
    expect(res.sentences[0].confidence).toBe(CONFIDENCE.TAG_SPAN);
    expect(res.flags).toEqual([]);
  });

  it('a NON-dash sentence with tag-only spans still demotes (unchanged)', () => {
    const s = mkText('anton', 'сказал Антон, не поднимая головы');
    const res = run([aligned(s, [tagSpan()])], 100, DASH_OPTS);
    expect(res.sentences[0].characterId).toBe('narrator');
    expect(res.sentences[0].confidence).toBe(CONFIDENCE.TAG_SPAN);
  });

  it('a quote-only language (dialogueOpen null) is byte-identical to today', () => {
    // en/de/ja/zh all carry `dialogueOpen: null`, so the invariant is inert.
    const NULL_OPTS = { ...BASE_OPTS, dialogueOpen: null };
    const withOpt = run([aligned(mkText('anton', '— Не стоит'), [tagSpan()])], 100, NULL_OPTS);
    const without = run([aligned(mkText('anton', '— Не стоит'), [tagSpan()])], 100, BASE_OPTS);
    expect(withOpt.sentences[0].characterId).toBe('narrator');
    expect(without.sentences[0].characterId).toBe('narrator');
  });

  it('es/fr get the same behaviour from their own marker', () => {
    // The invariant activates for THREE languages. es/fr have no book in the
    // workspace corpus and no fixture, so this unit case is their ONLY
    // coverage — see Global Constraints.
    const ES_OPTS = { ...BASE_OPTS, dialogueOpen: conventionsFor('es')!.dialogueOpen };
    const res = run([aligned(mkText('anton', '—No vale la pena'), [tagSpan()])], 100, ES_OPTS);
    expect(res.sentences[0].characterId).toBe('anton');
    expect(res.flags).toContainEqual({ index: 0, reason: 'dash-line-keep-flag:anton' });

    // #2289: &ndash; must be rescued the same way as the literal dash glyph.
    const resNdash = run(
      [aligned(mkText('anton', '&ndash; No vale la pena'), [tagSpan()])],
      100,
      ES_OPTS,
    );
    expect(resNdash.sentences[0].characterId).toBe('anton');
    expect(resNdash.flags).toContainEqual({ index: 0, reason: 'dash-line-keep-flag:anton' });
  });

  it('a speech span still wins — the invariant never overrides real evidence', () => {
    const s = mkText('olga', '— Не стоит');
    const res = run([aligned(s, [speechSpan({ characterId: 'anton', source: 'tag-name' })])], 100, DASH_OPTS);
    expect(res.sentences[0].characterId).toBe('anton'); // strong tag-name still force-corrects
  });

  it('a rescued line has no speech span, so escalation drops it at grouping', () => {
    // This adds ~879 entries to `flags` on the reference book, and `flags` is
    // escalation's input. escalateFlaggedWindows groups via
    //   const span = as?.spans.find((s) => s.kind === 'speech');
    //   if (!span || span.windowId === undefined) continue;
    // so a flag whose sentence has NO speech span never becomes a window and
    // consumes ZERO budget. The absence of a speech span is precisely WHY the
    // line was being demoted, so this is structural, not incidental — pin it
    // here rather than relying on `isFillEligible` one layer further down.
    const as = aligned(mkText('anton', '— Не стоит'), [tagSpan()]);
    const res = run([as], 100, DASH_OPTS);
    expect(res.flags).toContainEqual({ index: 0, reason: 'dash-line-keep-flag:anton' });
    expect(as.spans.some((s) => s.kind === 'speech')).toBe(false);
  });
});

describe('#2253 — the invariant also holds BELOW the alignment floor', () => {
  const RU_DASH = /^\s*(?:&mdash;|&ndash;|[-–—])\s*/iu;
  const DASH_OPTS = { ...BASE_OPTS, dialogueOpen: RU_DASH };
  const mkText = (characterId: string, text: string): SentenceOutput => ({
    id: nextId++, chapterId: 1, characterId, text,
  });

  it('flagOnly: a dash-opening narration-aligned line is NOT demoted', () => {
    const s = mkText('anton', '— Не стоит');
    // alignedPct 10 < floor 80 -> flagOnly, which bypasses decideSentence.
    const res = run([aligned(s, [narrationSpan()])], 10, DASH_OPTS);
    expect(res.report.flagOnly).toBe(true); // the branch under test really ran
    expect(res.sentences[0].characterId).toBe('anton');
    expect(res.sentences[0].confidence).toBeLessThan(0.75);
    // Below the floor the line falls through to the flag-only pass-through, NOT
    // to `dash-line-keep-flag`. Assert the REASON, which is stable; the bucket
    // is not (Task 5 moves `flag-only-floor` to `unresolved`).
    expect(res.flags).toEqual([{ index: 0, reason: 'flag-only-floor' }]);
  });

  it('flagOnly: a NON-dash narration-aligned line still demotes (unchanged)', () => {
    const s = mkText('anton', 'он молча поднялся по лестнице');
    const res = run([aligned(s, [narrationSpan()])], 10, DASH_OPTS);
    expect(res.report.flagOnly).toBe(true);
    expect(res.sentences[0].characterId).toBe('narrator');
  });

  it('flagOnly: with no dialogueOpen the floor behaviour is unchanged', () => {
    const s = mkText('anton', '— Не стоит');
    const res = run([aligned(s, [narrationSpan()])], 10, BASE_OPTS);
    expect(res.sentences[0].characterId).toBe('narrator');
  });
});

describe('#2253 — flagged splits into flagged (conflict) and unresolved (no verdict)', () => {
  const RU_DASH = /^\s*(?:&mdash;|&ndash;|[-–—])\s*/iu;
  const mkText = (characterId: string, text: string): SentenceOutput => ({
    id: nextId++, chapterId: 1, characterId, text,
  });

  it('unanchored speech is unresolved, not flagged', () => {
    const res = run([aligned(mkSentence('anton'), [speechSpan()])]);
    expect(res.report.unresolved).toBe(1);
    expect(res.report.flagged).toBe(0);
  });

  it('an unaligned sentence is unresolved', () => {
    const res = run([aligned(mkSentence('anton'), [])]);
    expect(res.report.unresolved).toBe(1);
    expect(res.report.flagged).toBe(0);
  });

  it('below the floor, flag-only pass-through is unresolved', () => {
    const res = run([aligned(mkSentence('anton'), [speechSpan()])], 10);
    expect(res.report.flagOnly).toBe(true);
    expect(res.report.unresolved).toBe(1);
    expect(res.report.flagged).toBe(0);
  });

  it('a genuine conflict stays flagged', () => {
    const res = run([
      aligned(mkSentence('olga'), [speechSpan({ characterId: 'anton', source: 'tag-pronoun' })]),
    ]);
    expect(res.report.flagged).toBe(1);
    expect(res.report.unresolved).toBe(0);
  });

  it('the convention invariant lands in flagged, not unresolved', () => {
    const res = run([aligned(mkText('anton', '— Не стоит'), [tagSpan()])], 100, {
      ...BASE_OPTS,
      dialogueOpen: RU_DASH,
    });
    expect(res.report.flagged).toBe(1);
    expect(res.report.unresolved).toBe(0);
  });

  it('the flags array — escalation input — is unchanged by the split', () => {
    // isFillEligible keys on the REASON string, so escalation must see exactly
    // the same entries it saw before the buckets moved.
    const res = run([
      aligned(mkSentence('narrator'), [speechSpan()]),
      aligned(mkSentence('anton'), []),
    ]);
    expect(res.flags).toEqual([
      { index: 0, reason: 'unanchored-narrator' },
      { index: 1, reason: 'unaligned' },
    ]);
  });
});
