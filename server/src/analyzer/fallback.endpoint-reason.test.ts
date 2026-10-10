import { describe, it, expect, vi } from 'vitest';
import { FallbackAnalyzer, targetInputGuard } from './index.js';
import { OpenAIAnalyzer } from './openai.js';
import { resolveCapacity } from './capacity.js';
import type { Analyzer, StageCall } from './types.js'; // analyzer types come from the W1 leaf, never index.ts
import {
  AnalyzerTargetInputTooLargeError,
  AnalyzerTransportError,
  AnalyzerTruncatedError,
  AnalyzerUnreachableError,
  LocalUnreachableError,
} from './errors.js';
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

function analyzer(runStage1Chapter: Analyzer['runStage1Chapter']): Analyzer {
  const unused = () => Promise.reject(new Error('unused'));
  return {
    runStage1: unused,
    runStage1Chapter,
    runStage2Chapter: unused,
    runEmotionChapter: unused,
    runScriptReviewChapter: unused,
    runStage3Chapter: unused,
    runAttributionEscalation: unused,
    runNonStoryClassification: unused,
  } as Analyzer;
}

const INVOKE: Array<[keyof Analyzer, (a: Analyzer, call: StageCall) => Promise<unknown>]> = [
  ['runStage1', (a, call) => a.runStage1('m', 'p', call)],
  ['runStage1Chapter', (a, call) => a.runStage1Chapter('m', 1, 'p', call)],
  ['runStage2Chapter', (a, call) => a.runStage2Chapter('m', 1, 'p', call)],
  ['runEmotionChapter', (a, call) => a.runEmotionChapter('m', 1, 'p', call)],
  ['runScriptReviewChapter', (a, call) => a.runScriptReviewChapter('m', 1, 'p', call)],
  ['runStage3Chapter', (a, call) => a.runStage3Chapter('m', 1, 'p', call)],
  ['runAttributionEscalation', (a, call) => a.runAttributionEscalation('m', 1, 0, 'p', call)],
  ['runNonStoryClassification', (a, call) => a.runNonStoryClassification!('m', 1, 'p', call)],
];

describe('FallbackAnalyzer names the primary and the target (#3084 P30)', () => {
  it('an unreachable endpoint names itself and the target', async () => {
    const onFallback = vi.fn();
    await new FallbackAnalyzer(
      analyzer(() => Promise.reject(new AnalyzerUnreachableError('connect ECONNREFUSED', 'openai'))),
      analyzer(() => Promise.resolve({ characters: [] })),
      { primary: 'Lab · qwen3-30b', target: 'Ollama (qwen3.5:4b)' },
    ).runStage1Chapter('m', 1, 'p', { onFallback } as unknown as StageCall);
    /* #3284's transport wording (operator decision D1): the endpoint and its model sit inside it. */
    expect(onFallback).toHaveBeenCalledWith({ reason: 'OpenAI endpoint Lab · qwen3-30b unreachable — switched to Ollama (qwen3.5:4b)' });
  });

  it('Ollama keeps its pinned cause text, extended with both names', async () => {
    const onFallback = vi.fn();
    await new FallbackAnalyzer(
      analyzer(() => Promise.reject(new LocalUnreachableError('down'))),
      analyzer(() => Promise.resolve({ characters: [] })),
      { primary: 'qwen3.5:4b', target: 'Gemini (gemini-3.5-flash-lite)' },
    ).runStage1Chapter('m', 1, 'p', { onFallback } as unknown as StageCall);
    expect(onFallback).toHaveBeenCalledWith({ reason: 'Ollama unreachable (qwen3.5:4b) — switched to Gemini (gemini-3.5-flash-lite)' });
  });

  it('without names the reason is the bare cause, as a directly built FallbackAnalyzer always had', async () => {
    const onFallback = vi.fn();
    await new FallbackAnalyzer(analyzer(() => Promise.reject(new LocalUnreachableError('down'))), analyzer(() => Promise.resolve({ characters: [] })))
      .runStage1Chapter('m', 1, 'p', { onFallback } as unknown as StageCall);
    expect(onFallback).toHaveBeenCalledWith({ reason: 'Ollama unreachable' });
  });

  it.each(INVOKE)('%s announces the switch with both names (no method switches silently)', async (_method, invoke) => {
    const primary = Object.fromEntries(INVOKE.map(([name]) => [name, () => Promise.reject(new LocalUnreachableError('down'))])) as unknown as Analyzer;
    const fallback = Object.fromEntries(INVOKE.map(([name]) => [name, () => Promise.resolve(null)])) as unknown as Analyzer;
    const onFallback = vi.fn();
    await invoke(new FallbackAnalyzer(primary, fallback, { primary: 'qwen3.5:4b', target: 'Gemini (g)' }), { onFallback } as unknown as StageCall);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith({ reason: 'Ollama unreachable (qwen3.5:4b) — switched to Gemini (g)' });
  });

  it('a target that is also unreachable fails naming both, as the same instance, class and transport', async () => {
    const second = new AnalyzerUnreachableError('connect ECONNREFUSED 127.0.0.1:8080', 'openai');
    const run = new FallbackAnalyzer(
      analyzer(() => Promise.reject(new LocalUnreachableError('down'))),
      analyzer(() => Promise.reject(second)),
      { primary: 'qwen3.5:4b', target: 'endpoint Lab (qwen3-30b)' },
    ).runStage1Chapter('m', 1, 'p', {} as StageCall);
    await expect(run).rejects.toBe(second);
    expect(second.transport).toBe('openai');
    expect(second.message).toBe(
      'Ollama unreachable (qwen3.5:4b) — switched to endpoint Lab (qwen3-30b); the fallback is unreachable too: connect ECONNREFUSED 127.0.0.1:8080',
    );
  });
});

describe('FallbackAnalyzer checks a prompt against the target before sending it (#3084 P30)', () => {
  const HUGE = 'x'.repeat(5_000);
  const guard = vi.fn((_pass: string, prompt: string, body?: string) => {
    if ((body ?? prompt).length > 1_000) throw new AnalyzerTruncatedError('ollama', 'input-over-target-budget', 0);
  });
  const unreachable = () => Promise.reject(new LocalUnreachableError('down'));
  const build = (target: Record<string, unknown>) =>
    new FallbackAnalyzer(
      Object.fromEntries(INVOKE.map(([name]) => [name, unreachable])) as unknown as Analyzer,
      target as unknown as Analyzer,
      { primary: 'qwen3.5:4b', target: 'Ollama (qwen3.5:4b)' },
      guard,
    );

  it.each([
    ['runStage1Chapter', 'stage1'],
    ['runStage2Chapter', 'stage2'],
    ['runScriptReviewChapter', 'script-review'],
  ] as const)('%s: an oversized prompt throws AnalyzerTruncatedError and the target never runs', async (method, pass) => {
    guard.mockClear();
    const targetCall = vi.fn(() => Promise.resolve(null));
    await expect((build({ [method]: targetCall }) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]('m', 1, HUGE, { inputBody: HUGE } as StageCall)).rejects.toBeInstanceOf(AnalyzerTruncatedError);
    expect(guard).toHaveBeenCalledWith(pass, HUGE, HUGE);
    expect(targetCall).not.toHaveBeenCalled();
  });

  it("measures the call's inputBody, not the whole prompt: a small chunk in a long prompt reaches the target", async () => {
    guard.mockClear();
    const stage1 = vi.fn(() => Promise.resolve({ characters: [] }));
    await build({ runStage1Chapter: stage1 }).runStage1Chapter('m', 1, HUGE, { inputBody: 'short' } as StageCall);
    expect(guard).toHaveBeenCalledWith('stage1', HUGE, 'short');
    expect(stage1).toHaveBeenCalledTimes(1);
  });

  it('a prompt within budget reaches the target, for a splitting and a non-splitting pass alike', async () => {
    guard.mockClear();
    const stage1 = vi.fn(() => Promise.resolve({ characters: [] }));
    const emotion = vi.fn(() => Promise.resolve({ sentences: [] }));
    const fa = build({ runStage1Chapter: stage1, runEmotionChapter: emotion });
    await fa.runStage1Chapter('m', 1, 'short', {} as StageCall);
    await fa.runEmotionChapter('m', 1, 'short', {} as StageCall);
    expect(stage1).toHaveBeenCalledTimes(1);
    expect(emotion).toHaveBeenCalledTimes(1);
    expect(guard.mock.calls).toEqual([['stage1', 'short', undefined], ['emotion', 'short', undefined]]);
  });
});

/* Task 3d.4b part 2/4 lands the refusal itself. The classification assertions of this describe
   (classifyAnalysisFailure → analyzer-request-rejected with its own copy) land with the
   failure-taxonomy branch in part 3/4 (#3606). */
describe('non-splitting passes refuse an over-budget prompt with a coded failure naming the target, and send nothing (#3084 P30)', () => {
  const context = () => resolveCapacity({ engine: 'local', model: 'qwen3.5:4b' }).contextTokens;
  const tooBig = () => 'a'.repeat(context() * 4 + 8_000);
  const PASSES: Array<[keyof Analyzer, (a: Analyzer, prompt: string, call: StageCall) => Promise<unknown>]> = [
    ['runEmotionChapter', (a, p, call) => a.runEmotionChapter('m', 1, p, call)],
    ['runStage3Chapter', (a, p, call) => a.runStage3Chapter('m', 1, p, call)],
    ['runAttributionEscalation', (a, p, call) => a.runAttributionEscalation('m', 1, 0, p, call)],
    ['runNonStoryClassification', (a, p, call) => a.runNonStoryClassification!('m', 1, p, call)],
    ['runStage1', (a, p, call) => a.runStage1('m', p, call)],
  ];

  it.each(PASSES)('%s: AnalyzerTargetInputTooLargeError naming the target and its context, with no HTTP status; the target never runs', async (method, invoke) => {
    const targetCall = vi.fn(() => Promise.resolve(null));
    const primary = Object.fromEntries(
      INVOKE.map(([name]) => [name, () => Promise.reject(new AnalyzerUnreachableError('connect ECONNREFUSED 127.0.0.1:8080', 'openai'))]),
    ) as unknown as Analyzer;
    const fa = new FallbackAnalyzer(primary, { [method]: targetCall } as unknown as Analyzer, { primary: 'Lab · qwen3-30b', target: 'Ollama (qwen3.5:4b)' }, targetInputGuard({ engine: 'local', model: 'qwen3.5:4b' }));
    const err = await invoke(fa, tooBig(), {} as StageCall).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerTargetInputTooLargeError);
    expect(err).not.toBeInstanceOf(AnalyzerTruncatedError);
    expect(err).toMatchObject({ targetLabel: 'Ollama (qwen3.5:4b)', limitTokens: context(), family: 'context' });
    expect((err as Error).message).toBe(`prompt is larger than the fallback target Ollama (qwen3.5:4b) can take (context ${context()} tokens)`);
    expect((err as Error).message).not.toMatch(/\(400\)|rejected the request/);
    expect(targetCall).not.toHaveBeenCalled();
  });
});
