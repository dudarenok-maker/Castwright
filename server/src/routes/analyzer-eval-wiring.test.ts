import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'aew-'));
// Preserve every other paths.js export; only override telemetryDir.
vi.mock('../workspace/paths.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), telemetryDir: () => dir }));

import { attributeChapterStage2WithEval } from './analysis.js';
import { readAnalyzerEvalRecords, analyzerEvalStatsFilePath, __resetAnalyzerEvalQueueForTest } from '../analyzer/analyzer-eval-stats.js';
import type { Analyzer, StageCall } from '../analyzer/index.js';

beforeEach(() => { __resetAnalyzerEvalQueueForTest(); writeFileSync(analyzerEvalStatsFilePath(), ''); });

describe('analyzer eval-rate wiring', () => {
  it('stage-2 wrapper folds the analyzer sub-calls into ONE record', async () => {
    // Mock analyzer whose runStage2Chapter fires onEvalTiming (as OllamaAnalyzer
    // does) three times, then returns canned sentences. Mirror the mock shape in
    // analysis.structure-engine.test.ts (baseOpts/mockSentences) for the other
    // Analyzer methods — reject them (unused on this path).
    const analyzer = {
      runStage2Chapter: async (_m: string, chId: number, _p: string, call: StageCall) => {
        for (let i = 0; i < 3; i++) call.onEvalTiming?.({ model: 'qwen36-castwright', evalCount: 100, evalDuration: 2e9, promptEvalCount: 300, promptEvalDuration: 1e9, loadDuration: 0 });
        return { sentences: [{ id: 1, chapterId: chId, characterId: 1, text: 'Короткий текст.' }] };
      },
      runStage1Chapter: () => Promise.reject(new Error('unused')),
      runEmotionChapter: () => Promise.reject(new Error('unused')),
      runScriptReviewChapter: () => Promise.reject(new Error('unused')),
      runStage3Chapter: () => Promise.reject(new Error('unused')),
    } as unknown as Analyzer;

    const stage2Call: StageCall = { language: 'ru', signal: new AbortController().signal };
    await attributeChapterStage2WithEval({
      analyzer, manuscriptId: 'mid', title: 'Ночной дозор',
      stage1: { characters: [] } as never,
      chapter: { id: 6, title: 'Глава 6', body: 'Короткий текст.' },
      stageCall: stage2Call,
    });

    const recs = await readAnalyzerEvalRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ manuscriptId: 'mid', bookTitle: 'Ночной дозор', stage: 'stage2-ch', chapterId: 6, subCalls: 3, evalCount: 300 });
  });
});
