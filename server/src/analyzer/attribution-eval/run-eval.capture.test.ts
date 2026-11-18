/* #2254 §4.3 — captureChapterStages, the capture half of evalFixture extracted
   rather than copied. evalFixture's own scoring stays pinned by run-eval.test.ts. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { captureChapterStages } from './run-eval.js';
import { attributeChapterStage2 } from '../../routes/analysis.js';
import type { RosterSnapshot } from './roster-schema.js';
import type { SentenceOutput } from '../../handoff/schemas.js';
import type { Analyzer, StageCall } from '../index.js';
import type { EngineCapacity } from '../capacity.js';

const CAPACITY: EngineCapacity = { family: 'context', contextTokens: 32768, maxOutputTokens: null };

function analyzerWith(
  stage2: Analyzer['runStage2Chapter'],
  escalation: Analyzer['runAttributionEscalation'] = () => Promise.resolve(null),
): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () => Promise.reject(new Error('not used')),
    runStage2Chapter: stage2,
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: escalation,
  };
}

const savedEnv = {
  esc: process.env.ATTRIBUTION_ESCALATION,
  cov: process.env.STAGE2_COVERAGE_RETRIES,
  eng: process.env.STRUCTURE_ENGINE,
};
function restore(key: string, v: string | undefined) {
  if (v === undefined) delete process.env[key];
  else process.env[key] = v;
}
beforeEach(() => {
  delete process.env.STRUCTURE_ENGINE;
  process.env.ATTRIBUTION_ESCALATION = 'local';
  process.env.STAGE2_COVERAGE_RETRIES = '0';
});
afterEach(() => {
  restore('ATTRIBUTION_ESCALATION', savedEnv.esc);
  restore('STAGE2_COVERAGE_RETRIES', savedEnv.cov);
  restore('STRUCTURE_ENGINE', savedEnv.eng);
});

/* ru dash fixture with one window the engine cannot resolve (escalation consumes a window). */
const ESC_ROSTER: RosterSnapshot = {
  characters: [
    { id: 'anton', name: 'Антон', gender: 'male' },
    { id: 'olga', name: 'Ольга', gender: 'female' },
    { id: 'boris', name: 'Борис', gender: 'male' },
  ],
};
const ESC_BODY = [
  '— Ты уверен, что это сработает? — спросил Антон.',
  '— Да, вполне, — ответила Ольга.',
  '— Тогда идём, — сказал Борис.',
  '— Хорошо.',
  '— После тебя.',
].join('\n');
function escSentences(): SentenceOutput[] {
  return [
    { id: 1, chapterId: 1, characterId: 'anton', confidence: 0.9, text: 'Ты уверен, что это сработает' },
    { id: 2, chapterId: 1, characterId: 'olga', confidence: 0.9, text: 'Да, вполне' },
    { id: 3, chapterId: 1, characterId: 'boris', confidence: 0.9, text: 'Тогда идём' },
    { id: 4, chapterId: 1, characterId: 'narrator', confidence: 0.4, text: 'Хорошо' },
    { id: 5, chapterId: 1, characterId: 'narrator', confidence: 0.4, text: 'После тебя' },
  ];
}
function escOpts(analyzer: Analyzer) {
  return {
    analyzer,
    manuscriptId: 'm1',
    title: 'Test Book',
    chapterId: 1,
    chapterText: ESC_BODY,
    roster: ESC_ROSTER,
    stageCall: { language: 'ru' } as StageCall,
    capacity: CAPACITY,
  };
}

describe('captureChapterStages: returned shape', () => {
  it('returns every field, and final equals the call result.sentences', async () => {
    const analyzer = analyzerWith(() => Promise.resolve({ sentences: escSentences() }));
    const out = await captureChapterStages(escOpts(analyzer));

    expect(out.raw).toHaveLength(5);
    expect(out.deterministic).toHaveLength(5);
    expect(out.final).toHaveLength(5);
    expect(out.reasons.length).toBeGreaterThan(0);
    expect(out.flags?.length).toBeGreaterThan(0);
    expect(out.paras?.length).toBeGreaterThan(0);
    expect(out.alignment).toBeDefined();
    expect(out.structureReport?.alignedPct).toBe(100);
    expect(out.stage1.characters.map((c) => c.id)).toEqual(['anton', 'olga', 'boris']);
    expect(out.stage1.characters.every((c) => c.role === 'character')).toBe(true);
    expect(out.chunks).toEqual({
      chunkCount: expect.any(Number),
      coverageRetries: 0,
      coverageExhausted: 0,
      deterministicSplits: 0,
    });

    // The same inputs straight through attributeChapterStage2: `final` is its result.sentences.
    const direct = await attributeChapterStage2({
      analyzer,
      manuscriptId: 'm1',
      title: 'Test Book',
      stage1: out.stage1,
      chapter: { id: 1, title: 'Chapter 1', body: ESC_BODY },
      stageCall: { language: 'ru' } as StageCall,
      escalationAnalyzer: null,
      capacity: CAPACITY,
    });
    expect(out.final).toEqual(direct.sentences);
  });
});

describe('captureChapterStages: structureBudget', () => {
  it('a shared budget is shared: the second call sees what the first left', async () => {
    const escalation = vi.fn(() => Promise.resolve(null));
    const analyzer = analyzerWith(() => Promise.resolve({ sentences: escSentences() }), escalation);
    const budget = { remainingWindows: 5 };

    await captureChapterStages({ ...escOpts(analyzer), structureBudget: budget });
    expect(escalation).toHaveBeenCalledTimes(1);
    expect(budget.remainingWindows).toBe(4);

    await captureChapterStages({ ...escOpts(analyzer), structureBudget: budget });
    expect(escalation).toHaveBeenCalledTimes(2);
    expect(budget.remainingWindows).toBe(3); // N minus both calls' use
  });

  it('an exhausted shared budget stops escalation on the next call', async () => {
    const escalation = vi.fn(() => Promise.resolve(null));
    const analyzer = analyzerWith(() => Promise.resolve({ sentences: escSentences() }), escalation);
    const budget = { remainingWindows: 0 };
    await captureChapterStages({ ...escOpts(analyzer), structureBudget: budget });
    expect(escalation).not.toHaveBeenCalled();
    expect(budget.remainingWindows).toBe(0);
  });
});

describe('captureChapterStages: chunk counters', () => {
  it('counts a coverage retry and a forced deterministic re-split', async () => {
    process.env.STAGE2_COVERAGE_RETRIES = '3';
    // The whole body always comes back as one sentence (a deterministic truncation);
    // each smaller span is answered in full, so the re-split recovers coverage.
    const stage2: Analyzer['runStage2Chapter'] = (_m, _c, _prompt, call) => {
      const sub = call.inputBody ?? ESC_BODY;
      const lines = sub.split('\n').filter(Boolean);
      const all = lines.map((text, i) => ({ id: i + 1, chapterId: 1, characterId: 'narrator', text }));
      return Promise.resolve({ sentences: sub.length >= ESC_BODY.length ? all.slice(0, 1) : all });
    };
    const out = await captureChapterStages(escOpts(analyzerWith(stage2)));
    expect(out.chunks.coverageRetries).toBeGreaterThan(0);
    expect(out.chunks.coverageExhausted).toBeGreaterThan(0);
    expect(out.chunks.deterministicSplits).toBeGreaterThan(0);
  });
});

describe('captureChapterStages: structureOptions', () => {
  const FIXTURE = resolve(__dirname, '..', '..', '__fixtures__', 'the-coalfall-commission.ru-dash.md');
  const CHAPTER_BODY = readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('*') && l.trim() !== '---')
    .join('\n');
  // The same construction as MERGED_NARRATION_BODY in routes/analysis.structure-fixture.test.ts.
  const MERGED_NARRATION_BODY = CHAPTER_BODY.split('\n').join(' ');
  const roster: RosterSnapshot = {
    characters: [
      { id: 'mairin', name: 'Майрин', gender: 'female' },
      { id: 'tobias', name: 'Тобиас', gender: 'male' },
      { id: 'gerrik', name: 'Геррик', gender: 'male' },
    ],
  };
  const merged: SentenceOutput[] = [
    { id: 1, chapterId: 1, characterId: 'mairin', confidence: 0.6, text: '— Здесь холодно' },
    { id: 2, chapterId: 1, characterId: 'tobias', confidence: 0.6, text: '— Тьма — это ещё не конец' },
    { id: 3, chapterId: 1, characterId: 'mairin', confidence: 0.6, text: '— Идём' },
  ];

  it('structureOptions recoverMidParagraphTurns:false changes deterministic on a merged body', async () => {
    const run = (structureOptions?: { recoverMidParagraphTurns: boolean }) =>
      captureChapterStages({
        analyzer: analyzerWith(() => Promise.resolve({ sentences: merged.map((s) => ({ ...s })) })),
        manuscriptId: 'm1',
        title: 'The Coalfall Commission',
        chapterId: 1,
        chapterText: MERGED_NARRATION_BODY,
        roster,
        stageCall: { language: 'ru' } as StageCall,
        capacity: CAPACITY,
        structureOptions,
      });
    const withRecovery = await run();
    const withoutRecovery = await run({ recoverMidParagraphTurns: false });
    expect(withRecovery.deterministic.length).toBeGreaterThan(0);
    expect(withoutRecovery.deterministic).not.toEqual(withRecovery.deterministic);
  });
});
