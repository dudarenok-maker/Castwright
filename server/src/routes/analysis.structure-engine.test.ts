/* srv-59 — integration test for the dialogue-structure engine's wiring into
   attributeChapterStage2. Mocks only the analyzer's runStage2Chapter (the
   engine itself — parser/windows/aligner/cross-examine — is exercised for
   real against a small ru dash-dialogue fixture); everything downstream of
   the model call is the production code path.

   Fixture (ru dash-dialogue):
     "— Ты уверен, что это сработает, — спросил Антон.\n\nОльга кивнула и
     отвернулась."
   Paragraph 1 is a tag-anchored speech span (tag-name -> anton). Paragraph 2
   is pure narration. The mock model misattributes the speech line to 'olga'
   (proven wrong by the "спросил Антон" tag) and correctly calls the
   narration line 'narrator'. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Analyzer, StageCall } from '../analyzer/index.js';
import type {
  CharacterOutput,
  EscalationOutput,
  SentenceOutput,
  Stage1Output,
} from '../handoff/schemas.js';
import { applyNarratorDefault } from '../analyzer/narrator-default.js';
import { CONFIDENCE } from '../analyzer/dialogue-structure/cross-examine.js';
import { attributeChapterStage2, reconcileSentenceCharacterIds } from './analysis.js';

const CHAPTER_BODY =
  '— Ты уверен, что это сработает, — спросил Антон.\n\nОльга кивнула и отвернулась.';

const CHARACTERS: CharacterOutput[] = [
  { id: 'anton', name: 'Антон', role: 'lead', color: '#111111', gender: 'male' },
  { id: 'olga', name: 'Ольга', role: 'lead', color: '#222222', gender: 'female' },
];

const STAGE1: Stage1Output = {
  characters: CHARACTERS,
  chapters: [{ id: 1, title: 'Chapter One' }],
};

/* The model's fixed (wrong-on-purpose) attribution: mis-assigns the
   tag-anchored speech line to 'olga' (tag proves 'anton') and correctly
   calls the narration line 'narrator'. Confidence values are deliberately
   NOT any CONFIDENCE.* constant so a passthrough bug (engine not actually
   replacing them) shows up immediately. */
function mockSentences(): SentenceOutput[] {
  return [
    { id: 1, chapterId: 1, characterId: 'olga', confidence: 0.42, text: 'Ты уверен, что это сработает' },
    { id: 2, chapterId: 1, characterId: 'narrator', confidence: 0.33, text: 'Ольга кивнула и отвернулась' },
  ];
}

function fakeAnalyzer(sentences: SentenceOutput[]): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () => Promise.reject(new Error('not used')),
    runStage2Chapter: () => Promise.resolve({ sentences }),
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.resolve(null),
  };
}

function baseOpts(language: string, sentences: SentenceOutput[]) {
  return {
    analyzer: fakeAnalyzer(sentences),
    manuscriptId: 'm1',
    title: 'Test Book',
    stage1: STAGE1,
    chapter: { id: 1, title: 'Chapter One', body: CHAPTER_BODY },
    stageCall: { language } as StageCall,
  };
}

beforeEach(() => {
  delete process.env.STRUCTURE_ENGINE;
});
afterEach(() => {
  delete process.env.STRUCTURE_ENGINE;
});

describe('attributeChapterStage2 — structure engine wiring (srv-59)', () => {
  it('(a)+(b)+(c): corrects a tag-contradicted sentence, replaces confidence with the derived constants, and populates structureReport', async () => {
    const result = await attributeChapterStage2(baseOpts('ru', mockSentences()));

    // (a) tag-contradicted sentence corrected to the tag speaker.
    expect(result.sentences[0].characterId).toBe('anton');
    // (b) confidence is the DERIVED constant, not the mock's 0.42.
    expect(result.sentences[0].confidence).toBe(CONFIDENCE.TAG_CORRECT);
    expect(result.sentences[0].confidence).not.toBe(0.42);

    // Narration line stays narrator, confidence replaced with the derived constant too.
    expect(result.sentences[1].characterId).toBe('narrator');
    expect(result.sentences[1].confidence).toBe(CONFIDENCE.NARRATION_CONFIRM);
    expect(result.sentences[1].confidence).not.toBe(0.33);

    // (c) structureReport counters populated and consistent, and the report
    // carries the language that actually ran (not the crossExamine-internal null).
    expect(result.structureReport).toMatchObject({
      language: 'ru',
      alignedPct: 100,
      confirmed: 1,
      corrected: 1,
      flagged: 0,
      lumped: 0,
    });
  });

  it('(d): engine OFF (knob false via STRUCTURE_ENGINE=0) is byte-identical to the applyNarratorDefault path', async () => {
    process.env.STRUCTURE_ENGINE = '0';
    const sentences = mockSentences();
    const result = await attributeChapterStage2(baseOpts('ru', sentences));

    const expected = applyNarratorDefault(mockSentences());
    expect(result.sentences).toEqual(expected);
    expect(result.structureReport).toBeUndefined();
  });

  it("(e): unsupported language ('xx') is identical to the engine-OFF/applyNarratorDefault path", async () => {
    // 'ja' now has a conventions table (fs-59 W3) — use a genuinely unsupported code.
    const result = await attributeChapterStage2(baseOpts('xx', mockSentences()));

    const expected = applyNarratorDefault(mockSentences());
    expect(result.sentences).toEqual(expected);
    expect(result.structureReport).toBeUndefined();
  });
});

/* srv-59 Task 9b — the escalation WIRING inside attributeChapterStage2:
   reading the `analyzer.structure.escalation` knob, routing 'off'/'local',
   calling escalateFlaggedWindows, and folding `escalated`/`escalationAccepted`
   into result.structureReport. escalateFlaggedWindows itself is unit-tested
   directly (escalation.test.ts) — this block only exercises the wiring
   around it, end-to-end through attributeChapterStage2.

   Fixture (ru dash-dialogue, one conversation window, 3 tag-anchored
   speakers so windows.ts's alternation-fill never engages -> the next two
   turns stay genuinely unanchored, not guessed):
     1: '— Ты уверен, что это сработает? — спросил Антон.'  tag-name: anton
     2: '— Да, вполне, — ответила Ольга.'                    tag-name: olga
     3: '— Тогда идём, — сказал Борис.'                       tag-name: boris
     4: '— Хорошо.'                                           UNANCHORED -> flagged
     5: '— После тебя.'                                       UNANCHORED -> flagged
   The mock model calls both unanchored turns 'narrator' (a plausible but
   unproven guess), so crossExamine flags them `unanchored-narrator` at
   CONFIDENCE.UNANCH_NARR_FLAG (0.5) — exactly the kind of window escalation
   exists to re-query. */
describe('attributeChapterStage2 — escalation wiring (srv-59 Task 9b)', () => {
  const ESCALATION_CHARACTERS: CharacterOutput[] = [
    { id: 'anton', name: 'Антон', role: 'lead', color: '#111111', gender: 'male' },
    { id: 'olga', name: 'Ольга', role: 'lead', color: '#222222', gender: 'female' },
    { id: 'boris', name: 'Борис', role: 'lead', color: '#333333', gender: 'male' },
  ];

  const ESCALATION_STAGE1: Stage1Output = {
    characters: ESCALATION_CHARACTERS,
    chapters: [{ id: 1, title: 'Chapter One' }],
  };

  const ESCALATION_BODY = [
    '— Ты уверен, что это сработает? — спросил Антон.',
    '— Да, вполне, — ответила Ольга.',
    '— Тогда идём, — сказал Борис.',
    '— Хорошо.',
    '— После тебя.',
  ].join('\n');

  function escalationMockSentences(): SentenceOutput[] {
    return [
      { id: 1, chapterId: 1, characterId: 'anton', confidence: 0.9, text: 'Ты уверен, что это сработает' },
      { id: 2, chapterId: 1, characterId: 'olga', confidence: 0.9, text: 'Да, вполне' },
      { id: 3, chapterId: 1, characterId: 'boris', confidence: 0.9, text: 'Тогда идём' },
      { id: 4, chapterId: 1, characterId: 'narrator', confidence: 0.4, text: 'Хорошо' },
      { id: 5, chapterId: 1, characterId: 'narrator', confidence: 0.4, text: 'После тебя' },
    ];
  }

  function fakeEscalationAnalyzer(runAttributionEscalation: Analyzer['runAttributionEscalation']): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      runStage1Chapter: () => Promise.reject(new Error('not used')),
      runStage2Chapter: () => Promise.resolve({ sentences: escalationMockSentences() }),
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation,
    };
  }

  function escalationBaseOpts(analyzer: Analyzer) {
    return {
      analyzer,
      manuscriptId: 'm1',
      title: 'Test Book',
      stage1: ESCALATION_STAGE1,
      chapter: { id: 1, title: 'Chapter One', body: ESCALATION_BODY },
      stageCall: { language: 'ru' } as StageCall,
    };
  }

  beforeEach(() => {
    delete process.env.STRUCTURE_ENGINE;
    delete process.env.ATTRIBUTION_ESCALATION;
  });
  afterEach(() => {
    delete process.env.STRUCTURE_ENGINE;
    delete process.env.ATTRIBUTION_ESCALATION;
  });

  it('sanity: the fixture produces >=1 flagged window before crossExamine\'s output ever reaches escalation', async () => {
    // Run with escalation forced OFF so we observe crossExamine's raw output
    // (still flagged, untouched by any re-query) and confirm the fixture is
    // actually exercising the code path this suite depends on.
    process.env.ATTRIBUTION_ESCALATION = 'off';
    const result = await attributeChapterStage2(
      escalationBaseOpts(fakeEscalationAnalyzer(() => Promise.resolve(null))),
    );

    expect(result.structureReport?.flagged).toBeGreaterThanOrEqual(1);
    // both unanchored turns kept the model's 'narrator' guess and its
    // reduced (flagged) confidence — proves they never got corrected.
    expect(result.sentences.find((s) => s.id === 4)).toMatchObject({
      characterId: 'narrator',
      confidence: CONFIDENCE.UNANCH_NARR_FLAG,
    });
    expect(result.sentences.find((s) => s.id === 5)).toMatchObject({
      characterId: 'narrator',
      confidence: CONFIDENCE.UNANCH_NARR_FLAG,
    });
  });

  it("mode='local': routes the flagged window through the main analyzer, applies an accepted assignment, and folds escalated/escalationAccepted into structureReport", async () => {
    process.env.ATTRIBUTION_ESCALATION = 'local';
    const escalationResponse: EscalationOutput = {
      assignments: [
        { line: 4, characterId: 'boris' },
        { line: 5, characterId: 'anton' },
      ],
    };
    const runAttributionEscalation = vi.fn(() => Promise.resolve(escalationResponse));
    const analyzer = fakeEscalationAnalyzer(runAttributionEscalation);

    const result = await attributeChapterStage2(escalationBaseOpts(analyzer));

    // The escalation analyzer WAS called (the mode routing engaged it).
    expect(runAttributionEscalation).toHaveBeenCalled();

    // Both previously-flagged lines were reassigned to the escalation
    // analyzer's answer, at the escalation-applied confidence (0.8) — proof
    // the flag was resolved, not left at the pre-escalation 0.4/0.5.
    expect(result.sentences.find((s) => s.id === 4)).toMatchObject({ characterId: 'boris', confidence: 0.8 });
    expect(result.sentences.find((s) => s.id === 5)).toMatchObject({ characterId: 'anton', confidence: 0.8 });

    expect(result.structureReport?.escalated).toBeGreaterThanOrEqual(1);
    expect(result.structureReport?.escalationAccepted).toBeGreaterThanOrEqual(1);
  });

  it("mode='off': never calls the escalation analyzer, and structureReport/sentences are byte-identical to the pre-escalation crossExamine output — this is the assertion that catches an inverted mode condition", async () => {
    process.env.ATTRIBUTION_ESCALATION = 'off';
    const runAttributionEscalation = vi.fn(() => Promise.resolve({ assignments: [{ line: 4, characterId: 'boris' }] }));
    const analyzer = fakeEscalationAnalyzer(runAttributionEscalation);

    const result = await attributeChapterStage2(escalationBaseOpts(analyzer));

    expect(runAttributionEscalation).not.toHaveBeenCalled();

    // The flagged lines are UNCHANGED: still 'narrator' at the flagged
    // (not escalation-applied) confidence.
    expect(result.sentences.find((s) => s.id === 4)).toMatchObject({
      characterId: 'narrator',
      confidence: CONFIDENCE.UNANCH_NARR_FLAG,
    });
    expect(result.sentences.find((s) => s.id === 5)).toMatchObject({
      characterId: 'narrator',
      confidence: CONFIDENCE.UNANCH_NARR_FLAG,
    });

    expect(result.structureReport?.escalated).toBe(0);
    expect(result.structureReport?.escalationAccepted).toBe(0);
  });

  it('below the alignment floor (spec §5.2): escalation never runs, even in a non-off mode, because a misaligned engine must not rewrite attributions', async () => {
    process.env.ATTRIBUTION_ESCALATION = 'local';

    // Same body as the fixture above, but lines 4 and 5 carry text that
    // never appears in ESCALATION_BODY at all, so the aligner can't find a
    // match for them — they come back unaligned. 3/5 sentences aligned =
    // 60%, below the 80% floor, so crossExamine runs the whole chapter in
    // flag-only mode. The three tag-anchored lines (anton/olga/boris) still
    // align and still share a conversation window, so — absent the floor
    // gate — escalation would find that window and re-query it.
    const belowFloorSentences: SentenceOutput[] = [
      { id: 1, chapterId: 1, characterId: 'anton', confidence: 0.9, text: 'Ты уверен, что это сработает' },
      { id: 2, chapterId: 1, characterId: 'olga', confidence: 0.9, text: 'Да, вполне' },
      { id: 3, chapterId: 1, characterId: 'boris', confidence: 0.9, text: 'Тогда идём' },
      {
        id: 4,
        chapterId: 1,
        characterId: 'narrator',
        confidence: 0.4,
        text: 'Совершенно посторонний текст, которого нет в теле главы',
      },
      {
        id: 5,
        chapterId: 1,
        characterId: 'narrator',
        confidence: 0.4,
        text: 'Ещё одна строка, отсутствующая в оригинале',
      },
    ];

    const runAttributionEscalation = vi.fn(() =>
      Promise.resolve({ assignments: [{ line: 1, characterId: 'olga' }] }),
    );
    const analyzer: Analyzer = {
      runStage1: () => Promise.reject(new Error('not used')),
      runStage1Chapter: () => Promise.reject(new Error('not used')),
      runStage2Chapter: () => Promise.resolve({ sentences: belowFloorSentences }),
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation,
    };

    const result = await attributeChapterStage2(escalationBaseOpts(analyzer));

    // Sanity: the fixture actually lands below the floor before asserting
    // on the escalation behaviour that depends on it.
    expect(result.structureReport?.flagOnly).toBe(true);
    expect(result.structureReport?.alignedPct).toBeLessThan(80);

    expect(runAttributionEscalation).not.toHaveBeenCalled();
    expect(result.structureReport?.escalated).toBe(0);
    expect(result.structureReport?.escalationAccepted).toBe(0);
  });

  /* srv-59 Task 9b (review follow-up) — buildCloudEscalationAnalyzer() used
     to run fresh PER CHAPTER inside attributeChapterStage2 in 'cloud' mode:
     a throwaway GeminiAnalyzer construction (and a missing-key warn) every
     chapter. The route callers now build it ONCE per book and thread it
     through via the new `escalationAnalyzer` opt; attributeChapterStage2
     must honor an explicitly-resolved value (including `null`, "no key
     configured") without re-building. These two tests pin both halves: the
     old per-call fallback (still used by any caller that omits the field)
     re-warns every call, while a caller that threads the once-built value
     never re-warns. */
  describe('cloud mode — analyzer built once per book, not per chapter', () => {
    beforeEach(() => {
      process.env.ATTRIBUTION_ESCALATION = 'cloud';
      delete process.env.GEMINI_API_KEY;
    });
    afterEach(() => {
      delete process.env.GEMINI_API_KEY;
    });

    it('omitting escalationAnalyzer falls back to a fresh per-call build, re-warning on every chapter', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const analyzer = fakeEscalationAnalyzer(() => Promise.resolve(null));

      await attributeChapterStage2(escalationBaseOpts(analyzer)); // chapter 1
      await attributeChapterStage2(escalationBaseOpts(analyzer)); // chapter 2

      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });

    it('threading the once-built escalationAnalyzer (here: null, "no key") across chapters never re-warns/re-builds', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const analyzer = fakeEscalationAnalyzer(() => Promise.resolve(null));

      // Mirrors what the route now does once per book, then threads through
      // every chapter's call — simulated here across two chapter calls.
      await attributeChapterStage2({ ...escalationBaseOpts(analyzer), escalationAnalyzer: null });
      await attributeChapterStage2({ ...escalationBaseOpts(analyzer), escalationAnalyzer: null });

      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});

/* #1679 — annotateSceneBreaks is wired at the single universal exit of
   attributeChapterStage2 (after BOTH the conventions/structure-engine branch
   and the applyNarratorDefault/else branch converge), so scene-break flags
   populate on every chapter regardless of language or structure-engine
   state. The annotator itself (marker location, offset math) is unit-tested
   directly in scene-breaks.test.ts — this only pins the wiring. */
describe('attributeChapterStage2 — scene-break annotation (#1679)', () => {
  const SCENE_BODY =
    'Первая сцена заканчивается тут.\n\n* * *\n\nВторая сцена начинается тут.';

  function sceneSentences(): SentenceOutput[] {
    return [
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'Первая сцена заканчивается тут' },
      { id: 2, chapterId: 1, characterId: 'narrator', text: 'Вторая сцена начинается тут' },
    ];
  }

  function sceneOpts(language: string) {
    return {
      analyzer: fakeAnalyzer(sceneSentences()),
      manuscriptId: 'm1',
      title: 'Test Book',
      stage1: STAGE1,
      chapter: { id: 1, title: 'Chapter One', body: SCENE_BODY },
      stageCall: { language } as StageCall,
    };
  }

  it('flags the post-separator sentence on the structure-engine (conventions) branch', async () => {
    const result = await attributeChapterStage2(sceneOpts('ru'));
    expect(result.sentences[0].sceneBreakBefore).toBeUndefined();
    expect(result.sentences[1].sceneBreakBefore).toBe(true);
  });

  it('flags the post-separator sentence on the applyNarratorDefault (else) branch too', async () => {
    const result = await attributeChapterStage2(sceneOpts('xx')); // unsupported language
    expect(result.sentences[0].sceneBreakBefore).toBeUndefined();
    expect(result.sentences[1].sceneBreakBefore).toBe(true);
  });
});

/* #1679 round-4 review follow-up — `attributeChapterStage2`'s return value is
   NOT the persisted array: sentences pass through several more spread-based
   transforms (dedupAndPrepare, stripThirdPartyFrontMatter, foldMinorCast,
   remapCjkHonorificIds, reconcileSentenceCharacterIds) before landing in
   manuscript-edits.json. Those transforms build their output via object
   SPREAD (`{ ...s, characterId: ... }`), which carries any additive field
   forward untouched — but nothing tested that. This pins it against the real
   `reconcileSentenceCharacterIds` (exported, cheaply callable in isolation):
   an id NOT in `validIds` takes the spread-rewrite path (demoted to the
   fallback id), and the flag must survive that rewrite; an id already valid
   passes through unchanged and must keep the flag's absence. */
it('sceneBreakBefore survives the spread-based reconcileSentenceCharacterIds rewrite', () => {
  const flagged: SentenceOutput[] = [
    { id: 1, chapterId: 1, characterId: 'narrator', text: 'Scene one.' },
    { id: 2, chapterId: 1, characterId: 'ghost', text: 'Scene two.', sceneBreakBefore: true },
  ];
  const validIds = new Set(['narrator']);

  const { sentences: out, demotedCount } = reconcileSentenceCharacterIds(flagged, validIds);

  expect(demotedCount).toBe(1); // sanity: id 2 actually took the spread-rewrite path
  expect(out.find((s) => s.id === 2)).toMatchObject({
    characterId: 'narrator', // demoted from the invalid 'ghost'
    sceneBreakBefore: true, // survived the spread
  });
  expect(out.find((s) => s.id === 1)?.sceneBreakBefore).toBeUndefined();
});
