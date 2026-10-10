import { describe, it, expect, vi } from 'vitest';
import { FallbackAnalyzer } from './index.js';
import { OpenAIAnalyzer } from './openai.js';
import type { Analyzer, StageCall } from './types.js'; // analyzer types come from the W1 leaf, never index.ts
import { AnalyzerTransportError } from './errors.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';

/* #3084 P22 rule 7 — 3b's OpenAI transport rebuilds an unrecognised failure into
   AnalyzerTransportError, which is not an AnalyzerUnreachableError. Every FallbackAnalyzer
   gate must let it through: no Gemini call, no announced switch. One row per wrapped method,
   so any single gate widened to `instanceof Error` goes red on its own row. */
describe('FallbackAnalyzer never falls back on AnalyzerTransportError (#3084 P22 rule 7)', () => {
  const lab = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 32768 });
  type Invoke = (a: Analyzer, call: StageCall) => Promise<unknown>;
  const METHODS: Array<[keyof Analyzer, Invoke]> = [
    ['runStage1', (a, call) => a.runStage1('m', 'p', call)],
    ['runStage1Chapter', (a, call) => a.runStage1Chapter('m', 1, 'p', call)],
    ['runStage2Chapter', (a, call) => a.runStage2Chapter('m', 1, 'p', call)],
    ['runEmotionChapter', (a, call) => a.runEmotionChapter('m', 1, 'p', call)],
    ['runScriptReviewChapter', (a, call) => a.runScriptReviewChapter('m', 1, 'p', call)],
    ['runStage3Chapter', (a, call) => a.runStage3Chapter('m', 1, 'p', call)],
    ['runAttributionEscalation', (a, call) => a.runAttributionEscalation('m', 1, 0, 'p', call)],
    ['runNonStoryClassification', (a, call) => a.runNonStoryClassification!('m', 1, 'p', call)],
  ];

  it.each(METHODS)('%s: the error propagates, the fallback analyzer is never called, and no onFallback fires', async (method, invoke) => {
    /* A real OpenAIAnalyzer: constructing it sends nothing. Only the method under test is
       stubbed, rejecting with the error 3b's transport would rethrow. */
    const primary = new OpenAIAnalyzer({ endpoint: lab, apiKey: null, model: 'qwen3-30b' });
    const err = new AnalyzerTransportError(
      'openai',
      'qwen3-30b',
      'Endpoint qwen3-30b request failed before a response (APIConnectionError <- TypeError).',
      undefined,
    );
    const primaryCall = vi
      .spyOn(primary as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>, method)
      .mockRejectedValue(err);
    const fallbackCall = vi.fn(async () => {
      throw new Error('the fallback analyzer must not run');
    });
    const fallback = Object.fromEntries(METHODS.map(([name]) => [name, fallbackCall])) as unknown as Analyzer;
    const onFallback = vi.fn();

    await expect(invoke(new FallbackAnalyzer(primary, fallback), { onFallback } as unknown as StageCall)).rejects.toBe(err);
    expect(primaryCall).toHaveBeenCalledTimes(1);
    expect(fallbackCall).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });
});
