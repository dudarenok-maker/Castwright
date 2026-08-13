import { describe, it, expect } from 'vitest';
import {
  computeAttributionMeasurement,
  type AttributionMeasurementInput,
  type CastRecordLike,
} from './attribution-health.js';
import { applyNarratorDefault } from '../analyzer/narrator-default.js';
import { conventionsFor } from '../analyzer/dialogue-structure/lang/index.js';
import type { SentenceOutput } from '../handoff/schemas.js';

/* #1984 Wave 1 Task 6 — the five owner-stated acceptance criteria, verbatim
   from #1984#issuecomment-5275487278 / #1984#issuecomment-5275507915, each
   with its own describe so a reviewer can read the five criteria and the
   five test bodies side by side. Tasks 3-5 test the parts; this file tests
   the CONTRACT. */

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

describe('criteria 1 + 3 — the F1 replay, both arms (source-anchored denominator, dash-insensitive join)', () => {
  // R-9M4: a SPEECH span the narrator takes, not only the tag half — without
  // the 4th sentence, both arms score narratorIdSpoken 0 === 0 and an
  // implementation that never tests NARRATOR_CHARACTER_IDS passes vacuously.
  const body =
    '— Ничего нет, — сказал Егор.\n' + '— Значит, ищем дальше.\n' + '— Никого здесь не было.\n';

  const withDashes: SentenceOutput[] = [
    sent('egor', '— Ничего нет,'),
    sent('narrator', '— сказал Егор.'), // TAG span, CORRECT
    sent('anton', '— Значит, ищем дальше.'),
    sent('narrator', '— Никого здесь не было.'), // SPEECH span, a DEFECT
  ];
  // The EXACT transform observed between Aug-6 and Aug-13 (#2306): the model
  // silently stripped the leading dash from its returned text.
  const stripped: SentenceOutput[] = withDashes.map((s) => ({
    ...s,
    text: s.text.replace(/^\s*[-–—]\s*/u, ''),
  }));

  it('scores identically whether or not the model returned leading dashes', () => {
    const a = compute({ body, sentences: withDashes });
    const b = compute({ body, sentences: stripped });

    expect(a.spokenTotal).toBe(3);
    expect(a.tagTotal).toBe(1);
    expect(a.narratorIdSpoken).toBe(1); // the numerator EXISTS (R-9M4)
    expect(a.tagNarratorSpan).toBe(1); // and the tag half is NOT in it

    expect(b.spokenTotal).toBe(a.spokenTotal);
    expect(b.tagTotal).toBe(a.tagTotal);
    expect(b.narratorIdSpoken).toBe(a.narratorIdSpoken);
    expect(b.tagNarratorSpan).toBe(a.tagNarratorSpan);
    expect(b.unattributedSpeech).toBe(0); // nothing fell out of the join
    expect(a.unattributedSpeech).toBe(0);
  });

  // Mutation: build the denominator from the sentence list instead of
  // ch.body, and spokenTotal collapses toward the (dash-sensitive) sentence
  // count instead of staying a fixed 3 across both arms.
  it('MUTATION CONTROL: a sentence-list denominator would move between the two arms', () => {
    const spokenTotalFromSentences = (sentences: SentenceOutput[]) =>
      sentences.filter((s) => /^\s*[-–—]/u.test(s.text)).length;
    expect(spokenTotalFromSentences(withDashes)).not.toBe(spokenTotalFromSentences(stripped));
  });
});

describe('criterion 2 — speech halves and tag halves are reported separately', () => {
  it('the correctly-narrated tag half lands in tagNarratorSpan and NEVER in narratorIdSpoken', () => {
    const body = '— Ничего нет, — сказал Егор.\n';
    const m = compute({
      body,
      sentences: [sent('egor', '— Ничего нет,'), sent('narrator', '— сказал Егор.')],
    });
    expect(m.tagNarratorSpan).toBe(1);
    expect(m.narratorIdSpoken).toBe(0);
  });

  // Mutation: fold tag spans into the denominator/numerator and this book's
  // share moves 0% -> 33% (1 narrator span / 3 total instead of 0/2).
  it('MUTATION CONTROL: folding the tag span into spokenTotal/narratorIdSpoken moves the share', () => {
    const body = '— Ничего нет, — сказал Егор.\n';
    const m = compute({
      body,
      sentences: [sent('egor', '— Ничего нет,'), sent('narrator', '— сказал Егор.')],
    });
    const correctShare = m.narratorIdSpoken / m.spokenTotal; // 0/1 = 0
    const mutatedSpoken = m.spokenTotal + m.tagTotal; // fold tag into denominator
    const mutatedNarrator = m.narratorIdSpoken + m.tagNarratorSpan; // fold tag into numerator
    expect(mutatedNarrator / mutatedSpoken).not.toBe(correctShare);
  });
});

describe('criterion 5 — the demoted arm reports as demoted, not model-assigned', () => {
  // Per the owner: criterion 3's test "gets stronger for free" here — feed
  // the stripped arm through applyNarratorDefault FOR REAL (it is pure), and
  // assert both that the score does not move AND that the demoted lines
  // report demotedNarrator, not modelNarrator.
  it('running the stripped arm through the real applyNarratorDefault reports demotedNarrator, not modelNarrator', () => {
    const ru = conventionsFor('ru')!;
    const body = '— Ничего нет, — сказал Егор.\n' + '— Никого здесь не было.\n';
    // The model's raw stage-2 output for the tag half and the SPEECH half both
    // stripped of their leading dash (so isSpokenLine can't recognise either
    // as dialogue) and originally attributed to 'egor'/'anton' — the shape
    // that gets demoted to narrator by applyNarratorDefault when the
    // structure engine is off.
    const rawStage2: SentenceOutput[] = [
      sent('egor', 'Ничего нет,'), // stripped speech half -> demoted
      sent('egor', 'сказал Егор.'), // stripped tag half -> demoted (uncounted regardless — tag span)
      sent('anton', 'Никого здесь не было.'), // stripped speech half -> demoted
    ];
    const demoted = applyNarratorDefault(rawStage2, ru);
    // Sanity: the demotion actually happened and recorded priorCharacterId.
    expect(demoted.every((s) => s.characterId === 'narrator')).toBe(true);
    expect(demoted[0].priorCharacterId).toBe('egor');

    const m = compute({ body, sentences: demoted, cacheHasOriginField: true });
    expect(m.narratorIdSpoken).toBe(2); // both speech spans, now narrator
    expect(m.demotedNarrator).toBe(2);
    expect(m.modelNarrator).toBe(0); // NOT model-assigned
  });

  // Mutation: default an absent priorCharacterId to model-assigned instead
  // of engine-demoted, and this test's modelNarrator/demotedNarrator
  // assertions invert.
  it('MUTATION CONTROL: defaulting an absent priorCharacterId to modelNarrator inverts the headline number', () => {
    const ru = conventionsFor('ru')!;
    const rawStage2: SentenceOutput[] = [sent('egor', 'Ничего нет,')];
    const demoted = applyNarratorDefault(rawStage2, ru);
    const withoutOriginTracking = demoted.map((s) => ({ ...s, priorCharacterId: undefined }));
    expect(withoutOriginTracking[0].priorCharacterId).toBeUndefined();
    expect(demoted[0].priorCharacterId).toBe('egor'); // the real field the mutation would discard
  });
});

describe('criterion 4 — omission is visible as absent, not as a shrunken denominator', () => {
  it('a sentence absent from stage-2 output is unattributedSpeech, and spokenTotal does not move', () => {
    const body = '— Ничего нет, — сказал Егор.\n' + '— Значит, ищем дальше.\n';
    const allSentences: SentenceOutput[] = [
      sent('egor', '— Ничего нет,'),
      sent('narrator', '— сказал Егор.'),
      sent('anton', '— Значит, ищем дальше.'),
    ];
    const missingOne = allSentences.filter((s) => s.characterId !== 'anton');
    const m = compute({ body, sentences: missingOne });
    expect(m.spokenTotal).toBe(2); // the source still has two speech spans
    expect(m.tagTotal).toBe(1); // R-9m2 — the mechanism tell, not spokenTotal
    expect(m.unattributedSpeech).toBe(1); // one of them nobody answered
    expect(m.attributableSpoken).toBe(1); // the share speaks for half the book
  });

  // R-9m2 — the corrected mechanism: build the denominator from the
  // sentence list, and BOTH dash lines still yield one speech span each
  // (spokenTotal stays 2), but unattributedSpeech is the tell — under a
  // sentence-list denominator there is no "absent" to report at all.
  it('MUTATION CONTROL: a sentence-list denominator has no unattributedSpeech signal at all', () => {
    const allSentences: SentenceOutput[] = [
      sent('egor', '— Ничего нет,'),
      sent('narrator', '— сказал Егор.'),
      sent('anton', '— Значит, ищем дальше.'),
    ];
    const missingOne = allSentences.filter((s) => s.characterId !== 'anton');
    // A sentence-list denominator's own "spokenTotal" would just be the
    // remaining dash-opening sentence COUNT (revision-7's own conflation —
    // it counted the tag half as dialogue too, not only speech) — 2, not the
    // source's 2 speech spans — and critically has NO WAY to represent "one
    // of the source's speech spans went unanswered": drop the SPEECH half
    // (not the tag) and this count silently falls to 1 with no signal that
    // anything is missing, which is exactly the shrinkage criterion 4 forbids.
    const sentenceListSpokenTotal = missingOne.filter((s) => /^\s*[-–—]/u.test(s.text)).length;
    const missingSpeechInstead = allSentences.filter((s) => s.characterId !== 'egor');
    const sentenceListSpokenTotalOnSpeechDrop = missingSpeechInstead.filter((s) =>
      /^\s*[-–—]/u.test(s.text),
    ).length;
    expect(sentenceListSpokenTotal).toBe(2); // the anton-drop is invisible to this formula
    expect(sentenceListSpokenTotalOnSpeechDrop).toBe(2); // and so is the speech-half drop —
    // both denominators read 2, with nothing distinguishing "everything
    // answered" from "the source's real speech span went unanswered".
  });
});

describe('the punctuation-invariance property (spec criterion 16) — two tiers', () => {
  const ANCHOR_MIN_LEN = 24;

  const stripDashes = (s: SentenceOutput): SentenceOutput => ({
    ...s,
    text: s.text.replace(/^\s*[-–—]\s*/u, ''),
  });
  const addDashes = (s: SentenceOutput): SentenceOutput => ({
    ...s,
    text: /^\s*[-–—]/u.test(s.text) ? s.text : `— ${s.text}`,
  });
  const emToHyphen = (s: SentenceOutput): SentenceOutput => ({
    ...s,
    text: s.text.replace(/—/gu, '-'), // length-preserving: 1 char -> 1 char
  });

  // Well away from the 24-char anchor boundary on EITHER side of every
  // transform, so Tier B's join-dependent fields are asserted EXACT here —
  // this is the "no crossers" case.
  const body =
    '— Ничего нет, — сказал Егор.\n' + '— Значит, ищем дальше.\n' + '— Никого здесь не было.\n';
  const base: SentenceOutput[] = [
    sent('egor', '— Ничего нет,'),
    sent('narrator', '— сказал Егор.'),
    sent('anton', '— Значит, ищем дальше.'),
    sent('narrator', '— Никого здесь не было.'),
  ];

  it('Tier A — denominator fields are byte-identical under ALL THREE transforms (they never read model text)', () => {
    const baseM = compute({ body, sentences: base });
    for (const t of [stripDashes, addDashes, emToHyphen]) {
      const m = compute({ body, sentences: base.map(t) });
      expect(m.spokenTotal).toBe(baseM.spokenTotal);
      expect(m.tagTotal).toBe(baseM.tagTotal);
    }
  });

  it('Tier B — join-dependent fields are EXACT under the length-preserving transform', () => {
    const baseM = compute({ body, sentences: base });
    const m = compute({ body, sentences: base.map(emToHyphen) });
    expect(m).toEqual(baseM);
  });

  it('Tier B — join-dependent fields are bounded (never exact-blind) under the length-changing transforms', () => {
    const baseM = compute({ body, sentences: base });
    // crossers: sentences whose normalised length crosses ANCHOR_MIN_LEN when
    // transformed — none of this fixture's needles are anywhere near the
    // 24-char boundary either before or after stripDashes (they are all well
    // under it), so crossers === 0 and the assertion is EXACT equality, not
    // a blind tolerance.
    const crossesFloor = (text: string, transform: (s: SentenceOutput) => SentenceOutput) => {
      const before = text.trim().length;
      const after = transform({ ...sent('x', text) }).text.trim().length;
      return (before >= ANCHOR_MIN_LEN) !== (after >= ANCHOR_MIN_LEN);
    };
    for (const t of [stripDashes, addDashes]) {
      const crossers = base.filter((s) => crossesFloor(s.text, t)).length;
      const m = compute({ body, sentences: base.map(t) });
      expect(crossers).toBe(0); // this fixture is deliberately well clear of the boundary
      expect(Math.abs(m.narratorIdSpoken - baseM.narratorIdSpoken)).toBeLessThanOrEqual(crossers);
      expect(Math.abs(m.unattributedSpeech - baseM.unattributedSpeech)).toBeLessThanOrEqual(crossers);
    }
  });

  // One book per convention family — a property test locks only what its
  // fixture reaches, and a dash-only corpus proves nothing about the quote
  // languages the same transform is a no-op on.
  for (const [lang, langBody, langSentences, cast] of [
    [
      'es',
      '—Un momento, dijo Ana.\n',
      [sent('ana', '—Un momento,'), sent('narrator', 'dijo Ana.')],
      [{ id: 'narrator' }, { id: 'ana' }],
    ],
    [
      'fr',
      '—Un instant, dit Léa.\n',
      [sent('lea', '—Un instant,'), sent('narrator', 'dit Léa.')],
      [{ id: 'narrator' }, { id: 'lea' }],
    ],
    [
      'en',
      '"Hello," she said.\n',
      [sent('she', '"Hello,"'), sent('narrator', 'she said.')],
      [{ id: 'narrator' }, { id: 'she' }],
    ],
    [
      'de',
      '»Komm her«, sagte sie.\n',
      [sent('sie', '»Komm her«'), sent('narrator', 'sagte sie.')],
      [{ id: 'narrator' }, { id: 'sie' }],
    ],
  ] as const) {
    it(`${lang} — the length-preserving transform is exact (a quote-only language's dash-transforms are a no-op)`, () => {
      const m1 = compute({
        language: lang,
        body: langBody,
        sentences: langSentences as unknown as SentenceOutput[],
        cast: cast as unknown as CastRecordLike[],
      });
      const m2 = compute({
        language: lang,
        body: langBody,
        sentences: (langSentences as unknown as SentenceOutput[]).map(emToHyphen),
        cast: cast as unknown as CastRecordLike[],
      });
      expect(m2.spokenTotal).toBe(m1.spokenTotal);
      expect(m2.tagTotal).toBe(m1.tagTotal);
    });
  }
});
