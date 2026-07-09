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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Analyzer, StageCall } from '../analyzer/index.js';
import type { CharacterOutput, SentenceOutput, Stage1Output } from '../handoff/schemas.js';
import { applyNarratorDefault } from '../analyzer/narrator-default.js';
import { CONFIDENCE } from '../analyzer/dialogue-structure/cross-examine.js';
import { attributeChapterStage2 } from './analysis.js';

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

  it("(e): unsupported language ('ja') is identical to the engine-OFF/applyNarratorDefault path", async () => {
    const result = await attributeChapterStage2(baseOpts('ja', mockSentences()));

    const expected = applyNarratorDefault(mockSentences());
    expect(result.sentences).toEqual(expected);
    expect(result.structureReport).toBeUndefined();
  });
});
