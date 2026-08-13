import { describe, it, expect } from 'vitest';
import {
  computeAttributionMeasurement,
  attributionShare,
  type AttributionMeasurementInput,
  type CastRecordLike,
} from './attribution-health.js';
import type { SentenceOutput } from '../handoff/schemas.js';

/* #1984 Wave 1 Tasks 3-5. The metric, in one sentence: the denominator is
   the set of `speech` spans `parseChapterStructure` finds in `ch.body`; the
   numerator is those spans whose aligned model sentence resolves to a
   narrator id; the join is `alignSentences`; every count is a count of
   SOURCE SPANS, never of model sentences. */

let nextId = 1;
const sent = (
  characterId: string,
  text: string,
  extra: Partial<SentenceOutput> = {},
): SentenceOutput => ({ id: nextId++, chapterId: 1, characterId, text, ...extra }) as SentenceOutput;

const DEFAULT_CAST: CastRecordLike[] = [{ id: 'narrator' }, { id: 'egor' }, { id: 'anton' }];

function compute(
  overrides: Partial<AttributionMeasurementInput> & { body?: string } = {},
): ReturnType<typeof computeAttributionMeasurement> {
  const { body, ...rest } = overrides;
  const input: AttributionMeasurementInput = {
    language: 'ru',
    languageSource: 'declared',
    bodies: body !== undefined ? { 1: body } : { 1: '' },
    sentences: [],
    roster: [],
    cast: DEFAULT_CAST,
    cacheHasOriginField: true,
    ...rest,
  };
  return computeAttributionMeasurement(input);
}

describe('denominator (Task 3, D14) — spokenTotal / tagTotal from source prose', () => {
  const RU_BODY = '— Ничего нет, — сказал Егор.\n— Значит, ищем дальше.\n';

  it('counts source spans, not model sentences — measured 2026-08-13: speech 2, tag 1', () => {
    const m = compute({ body: RU_BODY, sentences: [] });
    expect(m.spokenTotal).toBe(2); // two speech spans
    expect(m.tagTotal).toBe(1); // one tag span
  });

  it('scores identically with an empty roster — the denominator is not model-derived (D14)', () => {
    const withRoster = compute({ body: RU_BODY, roster: [{ id: 'egor', name: 'Егор' }] });
    const withoutAny = compute({ body: RU_BODY, roster: [] });
    expect(withoutAny.spokenTotal).toBe(withRoster.spokenTotal);
    expect(withoutAny.tagTotal).toBe(withRoster.tagTotal);
  });

  it('ru (dash convention): dialogue is found via the paragraph-leading dash', () => {
    const m = compute({ body: RU_BODY });
    expect(m.spokenTotal).toBeGreaterThan(0);
    expect(m.tagTotal).toBeGreaterThan(0);
  });

  it('en (quote-only, dialogueOpen: null): dialogue is found via quote pairs, never a leading dash', () => {
    const m = compute({
      language: 'en',
      body: '"Hello," she said.\n"Goodbye."\n',
      cast: [{ id: 'narrator' }, { id: 'she' }],
    });
    expect(m.spokenTotal).toBe(2);
    expect(m.tagTotal).toBe(1);
  });

  it('de (quote-only, »…« written NATURALLY — #2245 discharged the old artificial single-turn constraint)', () => {
    // Measured directly against parseChapterStructure: two turns either side
    // of a mid-line "sagte" tag ("Komm her" / "sofort.") plus two standalone
    // turns ("Ja." / "Nein.") -> four speech spans, one tag span.
    const m = compute({
      language: 'de',
      body: '»Komm her«, sagte sie, »sofort.«\n»Ja.«\n»Nein.«\n',
      cast: [{ id: 'narrator' }, { id: 'sie' }],
    });
    expect(m.spokenTotal).toBe(4);
    expect(m.tagTotal).toBe(1);
  });

  it('ja (「…」, kana-dominant): dialogue is found via CJK quote marks, not a Latin quote pair', () => {
    const m = compute({
      language: 'ja',
      body: '彼は「おはよう」と言った。\n「こんにちは」\n',
      cast: [{ id: 'narrator' }, { id: 'kare' }],
    });
    expect(m.spokenTotal).toBe(2);
    expect(m.tagTotal).toBe(1);
  });
});

describe('the join (Task 4, D16/D17) — what alignSentences cannot reach', () => {
  // Short tier — every needle under aligner.ts's ANCHOR_MIN_LEN (24 normalised
  // chars), so Pass B (interval-bounded infill with no anchors) resolves
  // every sentence. This is where real dash dialogue actually lives. Measured
  // via parseChapterStructure directly: speech spans "Ничего нет," / "Значит,
  // ищем дальше." / "Никого здесь не было.", one tag span " — сказал Егор."
  const SHORT_BODY =
    '— Ничего нет, — сказал Егор.\n' + '— Значит, ищем дальше.\n' + '— Никого здесь не было.\n';
  const SHORT_TAIL_TEXT = 'Никого здесь не было.';

  // Anchored tier — every speech/tag half rewritten well over 24 normalised
  // characters, so Pass A anchors and Pass B infills BETWEEN anchors. A
  // single-tier suite cannot distinguish "the join works" from "Pass B
  // guessed right on a short chapter" (spec R-9C3). Measured the same way:
  // speech spans "Ничего здесь совсем нет вообще," / "Значит, будем искать
  // значительно дальше по коридору." / "Здесь совершенно никого не было уже
  // очень давно.", one tag span.
  const ANCHORED_BODY =
    '— Ничего здесь совсем нет вообще, — негромко сказал Егор, не оборачиваясь назад.\n' +
    '— Значит, будем искать значительно дальше по коридору.\n' +
    '— Здесь совершенно никого не было уже очень давно.\n';
  const ANCHORED_TAIL_TEXT = 'Здесь совершенно никого не было уже очень давно.';

  for (const [tier, body, tailText] of [
    ['short', SHORT_BODY, SHORT_TAIL_TEXT],
    ['anchored', ANCHORED_BODY, ANCHORED_TAIL_TEXT],
  ] as const) {
    it(`${tier} tier — reports a stage-2 omission as unattributed, not as a shrunken denominator`, () => {
      // Sentences for the first speech span and the tag span, plus the tail
      // speech span — the MIDDLE speech span ("Значит, ...") is omitted
      // entirely, simulating a stage-2 omission.
      const sentences: SentenceOutput[] = [
        sent('narrator', body.split('\n')[0].split(' — ')[0].replace(/^—\s*/, '')), // first speech
        sent('narrator', 'сказал Егор.'), // tag half
        // middle speech span omitted on purpose
        sent('narrator', tailText), // tail speech
      ];

      const m = compute({ body, sentences });
      expect(m.spokenTotal).toBe(3); // the source still has three speech spans
      expect(m.tagTotal).toBe(1);
      expect(m.unattributedSpeech).toBe(1); // one of them nobody answered
      expect(m.attributableSpoken).toBe(2); // the other two are still attributable
    });
  }

  it('never double-subtracts, and never goes negative (attributableSpoken is a direct count, R-9C5)', () => {
    // Four dash paragraphs -> four speech spans (measured, no tag spans):
    //   1. unattributed  — no sentence aligns
    //   2. split         — two sentences disagree
    //   3. orphan        — one sentence, unresolvable id
    //   4. attributable  — one sentence, resolvable, non-narrator
    // Span 2's disagreement is built so ONE of the two disagreeing ids is
    // ALSO unresolvable — R-9C5's own overlap shape ("a span with two
    // disagreeing sentences, one unresolvable, is BOTH"). This is what gives
    // the mutation control real teeth: spokenTotal(4) - unattributed(1) -
    // split(1) - orphan(2) = 0, but the direct count is 1 (span 4) — a
    // subtraction formula would UNDER-count here, not merely coincide.
    const body =
      '— Первая строка совсем без ответа модели вообще никак.\n' +
      '— Вторая строка с разногласием между двумя моделями точно.\n' +
      '— Третья строка с совершенно неразрешимым идентификатором персонажа.\n' +
      '— Четвёртая строка с нормальным разрешимым персонажем точно.\n';
    const line3 = 'Третья строка с совершенно неразрешимым идентификатором персонажа.';
    const line4 = 'Четвёртая строка с нормальным разрешимым персонажем точно.';
    const sentences: SentenceOutput[] = [
      // line 1 — nobody aligns (omitted entirely)
      // line 2's SPAN split into two DIFFERENT sentence texts, both
      // overlapping the same span, disagreeing on characterId -> split, and
      // one of the two ('dropped-in-split') is itself unresolvable -> orphan too.
      // (Two identical-text sentences don't exercise this: the aligner's
      // monotonic cursor only ever finds the single real occurrence once.)
      sent('egor', 'Вторая строка'),
      sent('dropped-in-split', 'с разногласием между двумя моделями точно.'),
      sent('dropped-char', line3), // unresolvable -> orphan (span 3, no disagreement)
      sent('egor', line4), // resolvable -> attributable
    ];
    const m = compute({ body, sentences });
    expect(m.spokenTotal).toBe(4);
    expect(m.unattributedSpeech).toBe(1);
    expect(m.splitSpeech).toBe(1);
    expect(m.orphanSpoken).toBe(2); // one from the split-overlap (span 2), one from span 3
    expect(m.attributableSpoken).toBe(1); // only line 4 — counted directly
    expect(m.attributableSpoken).toBeGreaterThanOrEqual(0);
    // The subtraction shape this criterion forbids would compute
    // spokenTotal - unattributed - split - orphan = 4 - 1 - 1 - 2 = 0, not 1.
    expect(m.spokenTotal - m.unattributedSpeech - m.splitSpeech - m.orphanSpoken).not.toBe(
      m.attributableSpoken,
    );
  });

  it('orphanSpoken counts SOURCE SPANS, not model ids — a span with TWO disagreeing unresolvable ids counts once (finding 1)', () => {
    // One dash paragraph -> one speech span (no tag). Split into two pieces
    // that both overlap that same span, with two DIFFERENT unresolvable
    // ids. Before the fix, orphanSpoken incremented once PER unresolvable
    // id in the disagreeing set, so this single span would score 2 — moving
    // with how many bogus ids the model happened to emit, not with the
    // source. `splitSpeech` already counts the span once (unaffected);
    // `orphanSpoken` must too.
    const body = '— Первая часть совсем неразрешимая, вторая часть тоже неразрешимая.\n';
    const sentences: SentenceOutput[] = [
      sent('ghost-a', 'Первая часть совсем неразрешимая,'),
      sent('ghost-b', 'вторая часть тоже неразрешимая.'),
    ];
    const m = compute({ body, sentences });
    expect(m.spokenTotal).toBe(1);
    expect(m.splitSpeech).toBe(1);
    expect(m.orphanSpoken).toBe(1); // ONE span — not one per bogus id
    expect(m.orphanIds).toEqual(['ghost-a', 'ghost-b']); // both still reported
  });
});

describe('numerator, origin split, and id drift (Task 5, D9/D18)', () => {
  it('narratorIdSpoken counts BOTH narrator and char-narrator (#1895)', () => {
    const body = '— Реплика первая тут.\n';
    const m1 = compute({ body, sentences: [sent('narrator', 'Реплика первая тут.')] });
    const m2 = compute({
      body,
      sentences: [sent('char-narrator', 'Реплика первая тут.')],
      cast: [{ id: 'char-narrator' }],
    });
    expect(m1.narratorIdSpoken).toBe(1);
    expect(m2.narratorIdSpoken).toBe(1);
  });

  it('splits the narrator numerator three ways, and the tag half never enters it (R-9C1/R-9M4)', () => {
    const body =
      '— Ничего нет, — сказал Егор.\n' + '— Значит, ищем дальше.\n' + '— Никого здесь не было.\n';
    const m = compute({
      body,
      cacheHasOriginField: true,
      sentences: [
        sent('narrator', '— Ничего нет,', { priorCharacterId: 'egor' }), // SPEECH span, demoted
        sent('narrator', '— сказал Егор.'), // TAG span — NOT counted in narratorIdSpoken
        sent('anton', '— Значит, ищем дальше.'),
        sent('narrator', '— Никого здесь не было.'), // SPEECH span, model said narrator directly
      ],
    });
    expect(m.demotedNarrator).toBe(1);
    expect(m.modelNarrator).toBe(1); // the 4th sentence, NOT the 2nd (tag)
    expect(m.unknownOriginNarrator).toBe(0);
    expect(m.tagNarratorSpan).toBe(1); // the 2nd, in its own column
    expect(m.narratorIdSpoken).toBe(m.modelNarrator + m.demotedNarrator + m.unknownOriginNarrator);
  });

  it('a cache written before priorCharacterId existed reports unknownOriginNarrator, NEVER modelNarrator (the D18 trap)', () => {
    const body =
      '— Ничего нет, — сказал Егор.\n' + '— Значит, ищем дальше.\n' + '— Никого здесь не было.\n';
    const legacyCacheSentences: SentenceOutput[] = [
      sent('narrator', '— Ничего нет,'), // no priorCharacterId — cache predates D18
      sent('narrator', '— сказал Егор.'), // tag half, uncounted regardless
      sent('anton', '— Значит, ищем дальше.'),
      sent('narrator', '— Никого здесь не было.'), // no priorCharacterId either
    ];
    const m = compute({ body, sentences: legacyCacheSentences, cacheHasOriginField: false });
    expect(m.unknownOriginNarrator).toBe(m.narratorIdSpoken);
    expect(m.unknownOriginNarrator).toBe(2);
    expect(m.modelNarrator).toBe(0); // NOT folded in
    expect(m.demotedNarrator).toBe(0);
  });

  it('resolves a retired id through buildCastResolver (char-narrator -> narrator) and folds it into narratorIdSpoken', () => {
    const body = '— Реплика тут вот эта.\n';
    const m = compute({
      body,
      sentences: [sent('char-narrator', 'Реплика тут вот эта.')],
      cast: [{ id: 'narrator' }],
      history: { supersededBy: { 'char-narrator': 'narrator' } },
    });
    expect(m.narratorIdSpoken).toBe(1);
    expect(m.orphanSpoken).toBe(0);
  });

  it('an id buildCastResolver cannot resolve is reported as orphanSpoken/orphanIds, NEVER summed into narratorIdSpoken (D9)', () => {
    const body = '— Реплика первая тут вот.\n— Реплика вторая тоже вот.\n';
    const m = compute({
      body,
      sentences: [sent('dropped-char', 'Реплика первая тут вот.'), sent('egor', 'Реплика вторая тоже вот.')],
    });
    expect(m.orphanSpoken).toBe(1);
    expect(m.orphanIds).toEqual(['dropped-char']);
    expect(m.narratorIdSpoken).toBe(0); // the orphan is not summed in
    expect(m.attributableSpoken).toBe(1); // only the resolvable line
  });

  it('a wholly-orphaned book: attributableSpoken and narratorIdSpoken are both 0, so the share is null (never 0%)', () => {
    const body = '— Реплика первая тут вот.\n— Реплика вторая тоже вот.\n';
    const m = compute({
      body,
      sentences: [sent('dropped-1', 'Реплика первая тут вот.'), sent('dropped-2', 'Реплика вторая тоже вот.')],
    });
    expect(m.attributableSpoken).toBe(0);
    expect(m.narratorIdSpoken).toBe(0);
    expect(attributionShare(m)).toBeNull(); // NOT 0
  });

  it('attributionShare divides narratorIdSpoken by attributableSpoken when there is something to divide', () => {
    const body = '— Реплика раз тут вот.\n— Реплика два тоже вот.\n';
    const m = compute({
      body,
      sentences: [sent('narrator', 'Реплика раз тут вот.'), sent('egor', 'Реплика два тоже вот.')],
    });
    expect(m.attributableSpoken).toBe(2);
    expect(m.narratorIdSpoken).toBe(1);
    expect(attributionShare(m)).toBeCloseTo(0.5);
  });
});
