/* srv-59 Task 12 — dash-dialogue ru fixture + full-pipeline integration test.
   Runs the REAL dialogue-structure engine (parser -> windows -> aligner ->
   crossExamine, all wired through the production `attributeChapterStage2`)
   against a realistic, ~40-paragraph, Castwright-owned ORIGINAL Russian
   dash-dialogue scene (`the-coalfall-commission.ru-dash.md`). Only the
   analyzer's `runStage2Chapter` is mocked, and its mock output is
   DELIBERATELY WRONG on every line under test — tag-contradicted lines are
   attributed to 'narrator', ambiguous-window lines are attributed to the
   unknown-gender minor-cast buckets — so a passing assertion proves the
   engine actually did the correcting/flagging work, not a passthrough.

   Fixture structure inventory (paragraph order in the .md file):
     - Zone A (window 1, all tag-name-anchored, no fill needed):
       "Здесь холодно, — сказала Майрин."                    tag-name mairin
       "Тьма — это ещё не конец, — сказал Тобиас."            tag-name tobias
                                                               (interior dash
                                                               must NOT toggle)
       "Слушай меня внимательно. Это очень важно, — сказал
        Тобиас."                                              tag-name tobias,
                                                               ONE speech span
                                                               covering BOTH
                                                               sentences (multi-
                                                               sentence utterance
                                                               + continuation
                                                               exemption)
     - Zone B (window 2, clean two-hander): Майрин/Тобиас tag-anchored turns,
       a pronoun-only tag ("— ответила она.") resolved by window (only female
       participant is Майрин), then two untagged turns filled by alternation.
     - Zone C (window 3, three-party): Тобиас/Майрин/Геррик all tag-name
       anchored (a third, minor, one-scene character) -> alternation must NOT
       fire (anchoredIds.size === 3) -> the two trailing untagged turns stay
       genuinely unanchored -> flagged.

   Originality: every line of prose in the fixture is newly written for this
   task; nothing is copied or paraphrased from a published work (same
   all-rights-reserved-original convention as the other coalfall fixtures). */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { Analyzer, StageCall } from '../analyzer/index.js';
import type { CharacterOutput, SentenceOutput, Stage1Output } from '../handoff/schemas.js';
import { CONFIDENCE } from '../analyzer/dialogue-structure/cross-examine.js';
import { MALE_BUCKET_ID, FEMALE_BUCKET_ID } from '../analyzer/fold-minor-cast.js';
import { attributeChapterStage2 } from './analysis.js';

const FIXTURE_PATH = resolve(__dirname, '..', '__fixtures__', 'the-coalfall-commission.ru-dash.md');

/** Strip the fixture's markdown decoration (title / italic note / rule /
    chapter heading) down to the raw scene prose, one paragraph per line —
    exactly the shape `parseChapterStructure` expects (paragraph = line). */
function loadChapterBody(): string {
  const raw = readFileSync(FIXTURE_PATH, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#') && !line.startsWith('*') && line.trim() !== '---')
    .join('\n');
}

const CHAPTER_BODY = loadChapterBody();

const CHARACTERS: CharacterOutput[] = [
  { id: 'mairin', name: 'Майрин', role: 'lead', color: '#111111', gender: 'female' },
  { id: 'tobias', name: 'Тобиас', role: 'lead', color: '#222222', gender: 'male' },
  { id: 'gerrik', name: 'Геррик', role: 'minor', color: '#333333', gender: 'male' },
];

const STAGE1: Stage1Output = {
  characters: CHARACTERS,
  chapters: [{ id: 1, title: 'Маяк на Холодном мысу' }],
};

/* The model's fixed (wrong-on-purpose) attribution. Every entry below is
   deliberately wrong versus the structural evidence the real engine derives
   from the fixture text — see the file-header inventory for which rule each
   line is meant to exercise. */
function mockSentences(): SentenceOutput[] {
  return [
    // Zone A — tag-name, straightforward corrections off 'narrator'.
    { id: 1, chapterId: 1, characterId: 'narrator', confidence: 0.3, text: 'Здесь холодно' },
    { id: 2, chapterId: 1, characterId: 'narrator', confidence: 0.35, text: 'Тьма — это ещё не конец' },
    // Multi-sentence utterance, tag AFTER both sentences: 1st sentence...
    { id: 3, chapterId: 1, characterId: 'narrator', confidence: 0.3, text: 'Слушай меня внимательно' },
    // ...and the continuation (2nd sentence, no dash of its own) — the model
    // wrongly calls it 'narrator', which is exactly the old demotion trap
    // the continuation exemption exists to close.
    { id: 4, chapterId: 1, characterId: 'narrator', confidence: 0.3, text: 'Это очень важно' },

    // Zone B — clean two-hander window.
    { id: 5, chapterId: 1, characterId: 'mairin', confidence: 0.9, text: 'Идём' },
    { id: 6, chapterId: 1, characterId: 'tobias', confidence: 0.9, text: 'Куда именно' },
    // Pronoun-only tag ("— ответила она.") — model wrongly says 'narrator';
    // structurally resolvable to mairin (the window's only female participant).
    { id: 7, chapterId: 1, characterId: 'narrator', confidence: 0.4, text: 'На чердак' },
    // Untagged turns — alternation should fill these (tobias, then mairin).
    { id: 8, chapterId: 1, characterId: 'narrator', confidence: 0.4, text: 'Хорошо' },
    { id: 9, chapterId: 1, characterId: 'narrator', confidence: 0.4, text: 'После тебя' },

    // Zone C — three-party window (Тобиас/Майрин/Геррик all tag-anchored).
    { id: 10, chapterId: 1, characterId: 'tobias', confidence: 0.9, text: 'Ты видела чужие следы' },
    { id: 11, chapterId: 1, characterId: 'mairin', confidence: 0.9, text: 'Да, у маяка' },
    { id: 12, chapterId: 1, characterId: 'gerrik', confidence: 0.9, text: 'Значит, не одни' },
    // Untagged turns in a 3-speaker window — alternation must NOT fire, so
    // these stay whatever the model guessed: the unknown-gender minor-cast
    // buckets, a plausible-looking but unproven guess.
    { id: 13, chapterId: 1, characterId: MALE_BUCKET_ID, confidence: 0.5, text: 'Тогда идём осторожно' },
    { id: 14, chapterId: 1, characterId: FEMALE_BUCKET_ID, confidence: 0.5, text: 'После вас' },
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

function baseOpts(sentences: SentenceOutput[]) {
  return {
    analyzer: fakeAnalyzer(sentences),
    manuscriptId: 'm1',
    title: 'The Coalfall Commission',
    stage1: STAGE1,
    chapter: { id: 1, title: 'Маяк на Холодном мысу', body: CHAPTER_BODY },
    stageCall: { language: 'ru' } as StageCall,
  };
}

describe('attributeChapterStage2 — dash-dialogue ru fixture (srv-59 Task 12)', () => {
  it('fixture sanity: 100% of the mocked sentences align against the real body (proves the fixture text matches verbatim)', async () => {
    const result = await attributeChapterStage2(baseOpts(mockSentences()));
    expect(result.structureReport?.alignedPct).toBe(100);
  });

  it('Zone A: tag-proven lines are corrected off the wrong model guess, at TAG_CORRECT confidence, source tag-name', async () => {
    const result = await attributeChapterStage2(baseOpts(mockSentences()));

    expect(result.sentences.find((s) => s.id === 1)).toMatchObject({
      characterId: 'mairin',
      confidence: CONFIDENCE.TAG_CORRECT,
    });
    expect(result.sentences.find((s) => s.id === 2)).toMatchObject({
      characterId: 'tobias',
      confidence: CONFIDENCE.TAG_CORRECT,
    });
  });

  it('Zone A: a multi-sentence tag-anchored utterance corrects BOTH sentences, and the continuation (2nd sentence) is NOT demoted to narrator', async () => {
    const result = await attributeChapterStage2(baseOpts(mockSentences()));

    const first = result.sentences.find((s) => s.id === 3);
    const continuation = result.sentences.find((s) => s.id === 4);

    expect(first).toMatchObject({ characterId: 'tobias', confidence: CONFIDENCE.TAG_CORRECT });
    // The continuation-exemption assertion: this line has no dash of its own,
    // so the old isSpokenLine-style heuristic would have demoted it to
    // narrator. It must instead inherit the span's tag-name speaker.
    expect(continuation?.characterId).toBe('tobias');
    expect(continuation?.characterId).not.toBe('narrator');
    expect(continuation?.confidence).toBe(CONFIDENCE.TAG_CORRECT);
  });

  it('Zone B: tag-pronoun ("— ответила она.") resolves to the window\'s only female participant and corrects the wrong model guess', async () => {
    const result = await attributeChapterStage2(baseOpts(mockSentences()));

    expect(result.sentences.find((s) => s.id === 7)).toMatchObject({
      characterId: 'mairin',
      confidence: CONFIDENCE.PRONOUN_CORRECT,
    });
  });

  it("Zone B: the clean two-hander window fills BOTH untagged turns by alternation (confidence ALT_CORRECT_FLAG, unique to that path)", async () => {
    const result = await attributeChapterStage2(baseOpts(mockSentences()));

    expect(result.sentences.find((s) => s.id === 8)).toMatchObject({
      characterId: 'tobias',
      confidence: CONFIDENCE.ALT_CORRECT_FLAG,
    });
    expect(result.sentences.find((s) => s.id === 9)).toMatchObject({
      characterId: 'mairin',
      confidence: CONFIDENCE.ALT_CORRECT_FLAG,
    });
  });

  it('Zone C: all three tag-anchored speakers (Тобиас/Майрин/Геррик) confirm cleanly', async () => {
    const result = await attributeChapterStage2(baseOpts(mockSentences()));

    expect(result.sentences.find((s) => s.id === 10)).toMatchObject({
      characterId: 'tobias',
      confidence: CONFIDENCE.TAG_CONFIRM,
    });
    expect(result.sentences.find((s) => s.id === 11)).toMatchObject({
      characterId: 'mairin',
      confidence: CONFIDENCE.TAG_CONFIRM,
    });
    expect(result.sentences.find((s) => s.id === 12)).toMatchObject({
      characterId: 'gerrik',
      confidence: CONFIDENCE.TAG_CONFIRM,
    });
  });

  it('Zone C: with 3 anchored speakers in the window, alternation must NOT fire — the two trailing untagged turns stay flagged, NOT corrected', async () => {
    const result = await attributeChapterStage2(baseOpts(mockSentences()));

    const line13 = result.sentences.find((s) => s.id === 13);
    const line14 = result.sentences.find((s) => s.id === 14);

    // Kept AS THE MODEL GUESSED (the unknown-gender buckets) — proof this is
    // the "keep + flag" unanchored path, not a fabricated alternation guess.
    expect(line13?.characterId).toBe(MALE_BUCKET_ID);
    expect(line14?.characterId).toBe(FEMALE_BUCKET_ID);
    expect(line13?.confidence).toBe(CONFIDENCE.UNANCH_NARR_FLAG);
    expect(line14?.confidence).toBe(CONFIDENCE.UNANCH_NARR_FLAG);
    expect(line13!.confidence).toBeLessThan(0.75);
    expect(line14!.confidence).toBeLessThan(0.75);
  });

  it('structureReport: corrected > 0 and flagged > 0, with the exact bucket tally the fixture is designed to produce', async () => {
    const result = await attributeChapterStage2(baseOpts(mockSentences()));

    expect(result.structureReport?.corrected).toBeGreaterThan(0);
    expect(result.structureReport?.flagged).toBeGreaterThan(0);
    expect(result.structureReport).toMatchObject({
      language: 'ru',
      alignedPct: 100,
      confirmed: 5,
      corrected: 7,
      flagged: 2,
      lumped: 0,
    });
  });
});
