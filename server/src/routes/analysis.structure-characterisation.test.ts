/* #2254 §5 Phase 5 step 1 / §4.2 "Zero-behaviour-change proof" — characterisation of
   `attributeChapterStage2`, committed BEFORE the structure-engine extraction.

   Five inputs are recorded against committed golden JSON under
   `__fixtures__/structure-characterisation/`. Each golden holds `result.sentences`,
   `result.structureReport` and the three PRE-EXISTING `onStages` fields (`raw`,
   `deterministic`, `reasons`), compared by NAME with `toEqual` (deep equality, not byte
   identity), so fields later children add to `onStages` can never fail this file.

   Regenerate (only at a known-good HEAD): UPDATE_STRUCTURE_CHARACTERISATION=1. The
   normal run only reads. The ru-dash fixture, mock and coverage-guard reasoning are
   copied from analysis.structure-fixture.test.ts. */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Analyzer, StageCall } from '../analyzer/index.js';
import type { CharacterOutput, SentenceOutput, Stage1Output } from '../handoff/schemas.js';
import { MALE_BUCKET_ID, FEMALE_BUCKET_ID } from '../analyzer/fold-minor-cast.js';
import { attributeChapterStage2, runStructureEngine } from './analysis.js';
import { dedupeRosterByName, EMPTY_DEDUP_CONSTRAINTS } from '../analyzer/roster-dedup.js';
import { conventionsFor } from '../analyzer/dialogue-structure/lang/index.js';

const FIXTURE_PATH = resolve(__dirname, '..', '__fixtures__', 'the-coalfall-commission.ru-dash.md');
const GOLDEN_DIR = resolve(__dirname, '..', '__fixtures__', 'structure-characterisation');
const UPDATE = process.env.UPDATE_STRUCTURE_CHARACTERISATION === '1';

function loadChapterBody(): string {
  const raw = readFileSync(FIXTURE_PATH, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#') && !line.startsWith('*') && line.trim() !== '---')
    .join('\n')
    // One word-free separator unit (blank-line delimited) between Zone A and Zone B, so
    // `annotateSceneBreaks` has a break to bind and its removal is observable.
    .replace('\n— Идём, —', '\n\n* * *\n\n— Идём, —');
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

/* Same wrong-on-purpose attribution as the fixture test. */
function mockSentences(): SentenceOutput[] {
  return [
    { id: 1, chapterId: 1, characterId: 'narrator', confidence: 0.3, text: 'Здесь холодно' },
    { id: 2, chapterId: 1, characterId: 'narrator', confidence: 0.35, text: 'Тьма — это ещё не конец' },
    { id: 3, chapterId: 1, characterId: 'narrator', confidence: 0.3, text: 'Слушай меня внимательно' },
    { id: 4, chapterId: 1, characterId: 'narrator', confidence: 0.3, text: 'Это очень важно' },
    { id: 5, chapterId: 1, characterId: 'mairin', confidence: 0.9, text: 'Идём' },
    { id: 6, chapterId: 1, characterId: 'tobias', confidence: 0.9, text: 'Куда именно' },
    { id: 7, chapterId: 1, characterId: 'narrator', confidence: 0.4, text: 'На чердак' },
    { id: 8, chapterId: 1, characterId: 'narrator', confidence: 0.4, text: 'Хорошо' },
    { id: 9, chapterId: 1, characterId: 'narrator', confidence: 0.4, text: 'После тебя' },
    { id: 10, chapterId: 1, characterId: 'tobias', confidence: 0.9, text: 'Ты видела чужие следы' },
    { id: 11, chapterId: 1, characterId: 'mairin', confidence: 0.9, text: 'Да, у маяка' },
    { id: 12, chapterId: 1, characterId: 'gerrik', confidence: 0.9, text: 'Значит, не одни' },
    { id: 13, chapterId: 1, characterId: MALE_BUCKET_ID, confidence: 0.5, text: 'Тогда идём осторожно' },
    { id: 14, chapterId: 1, characterId: FEMALE_BUCKET_ID, confidence: 0.5, text: 'После вас' },
  ];
}

/* Mock whose text (4 of 14 lines) does not occur in the body -> alignment ~71%, below the 80% floor but above 70%. */
function misalignedSentences(): SentenceOutput[] {
  return mockSentences().map((x, i) =>
    i < 10 ? x : { ...x, text: `Совершенно посторонняя реплика номер ${x.id}` },
  );
}

type EscalationFn = Analyzer['runAttributionEscalation'];

function fakeAnalyzer(sentences: SentenceOutput[], escalate?: EscalationFn): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () => Promise.reject(new Error('not used')),
    runStage2Chapter: () => Promise.resolve({ sentences }),
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: escalate ?? (() => Promise.resolve(null)),
  };
}

type Captured = {
  raw: SentenceOutput[];
  deterministic: SentenceOutput[];
  reasons: unknown[];
};

/* Runs the chapter and records exactly the pre-existing observable surface. */
async function record(
  sentences: SentenceOutput[],
  language: string,
  escalate?: EscalationFn,
): Promise<{ recorded: Record<string, unknown>; deterministic: SentenceOutput[]; sentences: SentenceOutput[] }> {
  let captured: Captured | undefined;
  const result = await attributeChapterStage2({
    analyzer: fakeAnalyzer(sentences, escalate),
    manuscriptId: 'm1',
    title: 'The Coalfall Commission',
    stage1: STAGE1,
    chapter: { id: 1, title: 'Маяк на Холодном мысу', body: CHAPTER_BODY },
    stageCall: { language } as StageCall,
    onStages: (stages) => {
      // By name: only the three pre-existing fields (later children add more).
      captured = { raw: stages.raw, deterministic: stages.deterministic, reasons: stages.reasons };
    },
  });
  if (!captured) throw new Error('onStages was not called');
  const recorded = JSON.parse(
    JSON.stringify({
      sentences: result.sentences,
      structureReport: result.structureReport ?? null,
      raw: captured.raw,
      deterministic: captured.deterministic,
      reasons: captured.reasons,
    }),
  ) as Record<string, unknown>;
  return { recorded, deterministic: captured.deterministic, sentences: result.sentences };
}

function checkGolden(name: string, recorded: Record<string, unknown>): void {
  const path = resolve(GOLDEN_DIR, `${name}.json`);
  if (UPDATE) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify(recorded, null, 2) + '\n', 'utf8');
  }
  const golden = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  expect(recorded).toEqual(golden);
}

/* Coverage guard off — see analysis.structure-fixture.test.ts for the full reasoning:
   the mock covers only dialogue lines, so a live guard would re-attribute smaller
   spans and measure chunking instead of the engine. */
const prevCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
beforeAll(() => {
  process.env.STAGE2_COVERAGE_RETRIES = '0';
});
afterAll(() => {
  if (prevCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
  else process.env.STAGE2_COVERAGE_RETRIES = prevCoverageRetries;
});
beforeEach(() => {
  delete process.env.STRUCTURE_ENGINE;
  process.env.ATTRIBUTION_ESCALATION = 'off';
});
afterEach(() => {
  delete process.env.STRUCTURE_ENGINE;
  delete process.env.ATTRIBUTION_ESCALATION;
});

describe('attributeChapterStage2 — characterisation before the structure-engine extraction (#2254)', () => {
  it('1. engine on (ru-dash fixture, escalation off)', async () => {
    const { recorded, sentences } = await record(mockSentences(), 'ru');
    // The scene separator must bind to the sentence that opens Zone B (id 5).
    expect(sentences.find((s) => s.id === 5)?.sceneBreakBefore).toBe(true);
    checkGolden('engine-on', recorded);
  });

  it('2. flagOnly: alignment below the 80% floor, engine on', async () => {
    const { recorded } = await record(misalignedSentences(), 'ru');
    expect((recorded.structureReport as { flagOnly?: boolean }).flagOnly).toBe(true);
    checkGolden('flag-only', recorded);
  });

  it('3. knob off (STRUCTURE_ENGINE=0)', async () => {
    process.env.STRUCTURE_ENGINE = '0';
    const { recorded } = await record(mockSentences(), 'ru');
    checkGolden('knob-off', recorded);
  });

  it('4. a language with no conventions, engine on', async () => {
    const { recorded } = await record(mockSentences(), 'xx');
    checkGolden('no-conventions', recorded);
  });

  it('5. engine on, escalation fills a flagged line', async () => {
    process.env.ATTRIBUTION_ESCALATION = 'local';
    const { recorded, deterministic, sentences } = await record(mockSentences(), 'ru', () =>
      Promise.resolve({ assignments: [{ line: 13, characterId: 'tobias' }] }),
    );
    // The input must really fill a line, so it cannot silently degrade into input 1.
    const idx = sentences.findIndex((s) => s.id === 13);
    expect(sentences[idx].characterId).toBe('tobias');
    expect(deterministic[idx].characterId).not.toBe('tobias');
    checkGolden('escalation-fill', recorded);
  });
});

/* #2254 §4.2 — the four fields onStages gained. Separate from the five golden cases
   above (those compare raw/deterministic/reasons by name and must stay untouched). */
type FullStages = Parameters<NonNullable<Parameters<typeof attributeChapterStage2>[0]['onStages']>>[0];

async function captureStages(
  sentences: SentenceOutput[],
  language: string,
  escalate?: EscalationFn,
): Promise<{ stages: FullStages; sentences: SentenceOutput[] }> {
  let stages: FullStages | undefined;
  const result = await attributeChapterStage2({
    analyzer: fakeAnalyzer(sentences, escalate),
    manuscriptId: 'm1',
    title: 'The Coalfall Commission',
    stage1: STAGE1,
    chapter: { id: 1, title: 'Маяк на Холодном мысу', body: CHAPTER_BODY },
    stageCall: { language } as StageCall,
    onStages: (s) => { stages = s; },
  });
  if (!stages) throw new Error('onStages was not called');
  return { stages, sentences: result.sentences };
}

describe('onStages exposes stage1, paras, alignment and flags (#2254)', () => {
  const expectedRoster = dedupeRosterByName(STAGE1.characters, [], {
    language: 'ru',
    constraints: EMPTY_DEDUP_CONSTRAINTS,
  }).characters;

  it('stage1 is the deduplicated roster in all five inputs', async () => {
    process.env.ATTRIBUTION_ESCALATION = 'local';
    const fill = () => Promise.resolve({ assignments: [{ line: 13, characterId: 'tobias' }] });
    const runs = [
      await captureStages(mockSentences(), 'ru'),
      await captureStages(misalignedSentences(), 'ru'),
      await captureStages(mockSentences(), 'xx'),
      await captureStages(mockSentences(), 'ru', fill),
    ];
    process.env.STRUCTURE_ENGINE = '0';
    runs.push(await captureStages(mockSentences(), 'ru'));
    expect(runs).toHaveLength(5);
    for (const r of runs) expect(r.stages.stage1.characters).toEqual(expectedRoster);
  });

  it('paras, alignment and flags are present for engine on, flagOnly and escalation fill', async () => {
    process.env.ATTRIBUTION_ESCALATION = 'local';
    const fill = () => Promise.resolve({ assignments: [{ line: 13, characterId: 'tobias' }] });
    for (const { stages } of [
      await captureStages(mockSentences(), 'ru'),
      await captureStages(misalignedSentences(), 'ru'),
      await captureStages(mockSentences(), 'ru', fill),
    ]) {
      expect(stages.paras).toBeDefined();
      expect(stages.alignment).toBeDefined();
      expect(stages.flags).toBeDefined();
    }
  });

  it('paras, alignment and flags are absent for knob off and no conventions', async () => {
    process.env.STRUCTURE_ENGINE = '0';
    const off = await captureStages(mockSentences(), 'ru');
    delete process.env.STRUCTURE_ENGINE;
    const none = await captureStages(mockSentences(), 'xx');
    for (const { stages } of [off, none]) {
      expect(stages.paras).toBeUndefined();
      expect(stages.alignment).toBeUndefined();
      expect(stages.flags).toBeUndefined();
    }
  });

  it('flags equals examined.flags as crossExamine returned it', async () => {
    const { stages } = await captureStages(mockSentences(), 'ru');
    const conventions = conventionsFor('ru')!;
    const direct = runStructureEngine({
      sentences: stages.raw,
      body: CHAPTER_BODY,
      stage1: stages.stage1,
      conventions,
    });
    expect(stages.flags).toEqual(direct.examined.flags);
    expect(stages.flags!.length).toBeGreaterThan(0);
  });

  it('on escalation fill, flags still holds the filled line while the sentence carries the escalated id', async () => {
    process.env.ATTRIBUTION_ESCALATION = 'local';
    const { stages, sentences } = await captureStages(mockSentences(), 'ru', () =>
      Promise.resolve({ assignments: [{ line: 13, characterId: 'tobias' }] }),
    );
    const idx = sentences.findIndex((s) => s.id === 13);
    expect(sentences[idx].characterId).toBe('tobias');
    expect(stages.flags!.map((f) => f.index)).toContain(idx);
  });
});
