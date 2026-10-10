import { describe, it, expect, afterEach, vi } from 'vitest';
import { selectAnalyzer, fallbackSelectionFor, fallbackNames, targetInputGuard, FallbackAnalyzer, type AnalyzerSelection } from './index.js';
import { OllamaAnalyzer } from './ollama.js';
import { GeminiAnalyzer } from './gemini.js';
import { OpenAIAnalyzer } from './openai.js';
import { resolveCapacity } from './capacity.js';
import { resolveStage1ChunkCharBudget } from './stage1-chunk.js';
import { resolveStage2ChunkCharBudget } from './stage2-chunk.js';
import { estimateInputTokens } from './runner/prompt.js';
import {
  AnalyzerCapabilityRejectedError,
  AnalyzerKeyOriginError,
  AnalyzerTargetInputTooLargeError,
  AnalyzerTruncatedError,
  AnalyzerUnreachableError,
  LocalUnreachableError,
  TargetInputOverBudgetError,
} from './errors.js';

/* The local target's first call reads the installed digest (fail-open); no daemon in unit tests. */
vi.mock('./ollama-digest.js', () => ({ ollamaModelDigest: vi.fn().mockResolvedValue(undefined) }));
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';

const lab = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'cuda:0', contextTokens: 32768 });
const target = (t: string) => ({ configOverrides: { 'analyzer.fallback.target': t } });
const sel = (engine: AnalyzerSelection['engine'], model: string) => ({ analyzer: {} as never, engine, model, fallbackModel: null }) as AnalyzerSelection;

afterEach(() => {
  _resetUserSettingsCache();
  delete process.env.GEMINI_API_KEY;
  delete process.env.OLLAMA_MODEL;
  vi.restoreAllMocks();
});

describe('selectAnalyzer — the configured fallback target (#3084 P30)', () => {
  it('an endpoint primary falls back to gemini by default when a key is set', () => {
    process.env.GEMINI_API_KEY = 'k';
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {} });
    const s = selectAnalyzer({ model: 'openai:lab::qwen3-30b' });
    expect(s.analyzer).toBeInstanceOf(FallbackAnalyzer);
    expect(s).toMatchObject({ engine: 'openai', model: 'openai:lab::qwen3-30b', fallbackModel: 'gemini-3.5-flash-lite' });
  });

  it('an endpoint primary falls back to the Ollama model a local selection resolves to when the target is local', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {}, defaultAnalysisModel: 'qwen3.5:9b', ...target('local') });
    const s = selectAnalyzer({ model: 'openai:lab::qwen3-30b' });
    expect(s.analyzer).toBeInstanceOf(FallbackAnalyzer);
    expect(s.fallbackModel).toBe('qwen3.5:9b');
  });

  it('with an endpoint id as the saved default, local is OLLAMA_MODEL, else the analyzer.ollama.model override, else the shipped default — never the endpoint id', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {}, defaultAnalysisModel: 'openai:lab::qwen3-30b', ...target('local') });
    expect(selectAnalyzer({ model: 'openai:lab::qwen3-30b' }).fallbackModel).toBe('qwen3.5:4b');
    /* #3192 — the Advanced Settings override is the tier between env and the shipped default. */
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [lab],
      analyzerEndpointKeys: {},
      defaultAnalysisModel: 'openai:lab::qwen3-30b',
      configOverrides: { 'analyzer.fallback.target': 'local', 'analyzer.ollama.model': 'mistral:7b' },
    });
    expect(selectAnalyzer({ model: 'openai:lab::qwen3-30b' }).fallbackModel).toBe('mistral:7b');
    process.env.OLLAMA_MODEL = 'llama3.1:8b';
    expect(selectAnalyzer({ model: 'openai:lab::qwen3-30b' }).fallbackModel).toBe('llama3.1:8b');
  });

  it('an Ollama primary falls back to an endpoint model', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {}, ...target('openai:lab::qwen3-30b') });
    const s = selectAnalyzer({ model: 'qwen3.5:4b' });
    expect(s.engine).toBe('local');
    expect(s.analyzer).toBeInstanceOf(FallbackAnalyzer);
    expect(s.fallbackModel).toBe('openai:lab::qwen3-30b');
  });

  it.each([
    ['off', target('off'), 'openai:lab::qwen3-30b'],
    /* A saved Gemini key, so only the legacy step (not a keyless gemini) can leave this unwrapped. */
    ['legacy allowCloudFallback false', { allowCloudFallback: false, geminiApiKey: 'k' }, 'openai:lab::qwen3-30b'],
    ['gemini with no key', {}, 'openai:lab::qwen3-30b'],
    ['the same endpoint model', target('openai:lab::qwen3-30b'), 'openai:lab::qwen3-30b'],
    ['the same Ollama model', { defaultAnalysisModel: 'qwen3.5:4b', ...target('local') }, 'qwen3.5:4b'],
    ['local behind a local primary on another model (one daemon)', { defaultAnalysisModel: 'qwen3.5:4b', ...target('local') }, 'qwen3.5:9b'],
  ])('no wrap when the target is %s', (_name, over, model) => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {}, ...over });
    const s = selectAnalyzer({ model });
    expect(s.analyzer).not.toBeInstanceOf(FallbackAnalyzer);
    expect(s.fallbackModel).toBeNull();
  });

  it('a target naming an endpoint that is not saved is skipped, with a warning naming it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {}, ...target('openai:gone::m') });
    expect(selectAnalyzer({ model: 'qwen3.5:4b' }).analyzer).toBeInstanceOf(OllamaAnalyzer);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"gone"'));
  });

  it('a Gemini primary never falls back, whatever the target', () => {
    process.env.GEMINI_API_KEY = 'k';
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {}, ...target('openai:lab::qwen3-30b') });
    const s = selectAnalyzer({ model: 'gemini-3.5-flash-lite' });
    expect(s.analyzer).toBeInstanceOf(GeminiAnalyzer);
    expect(fallbackSelectionFor(s)).toBeNull();
  });

  it('one hop, through the real selection: the fallback analyzer is not a FallbackAnalyzer, and primary and target are each called once', async () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {}, defaultAnalysisModel: 'qwen3.5:4b', ...target('local') });
    const primaryCall = vi
      .spyOn(OpenAIAnalyzer.prototype, 'runStage1Chapter')
      .mockRejectedValue(new AnalyzerUnreachableError('connect ECONNREFUSED 127.0.0.1:8080', 'openai'));
    const targetCall = vi.spyOn(OllamaAnalyzer.prototype, 'runStage1Chapter').mockRejectedValue(new LocalUnreachableError('down'));
    const s = selectAnalyzer({ model: 'openai:lab::qwen3-30b' });
    expect(s.analyzer).toBeInstanceOf(FallbackAnalyzer);
    expect((s.analyzer as unknown as { fallback: unknown }).fallback).not.toBeInstanceOf(FallbackAnalyzer);
    expect(fallbackSelectionFor(s)!.fallbackModel).toBeNull();
    await expect(s.analyzer.runStage1Chapter('m', 1, 'p', {} as never)).rejects.toBeInstanceOf(LocalUnreachableError);
    expect(primaryCall).toHaveBeenCalledTimes(1);
    expect(targetCall).toHaveBeenCalledTimes(1);
  });

  it('targetInputGuard measures the chunk body against the target pass budget, not the raw context', () => {
    _setUserSettingsCacheForTest({ configOverrides: { 'analyzer.ollama.numCtx': 32_768 } });
    const capacity = resolveCapacity({ engine: 'local', model: 'qwen3.5:4b' });
    const guard = targetInputGuard({ engine: 'local', model: 'qwen3.5:4b' });
    const stage1Budget = resolveStage1ChunkCharBudget(capacity, 'a');
    /* A chunk sized for the target passes, even inside a prompt longer than the budget. */
    const sized = 'a'.repeat(stage1Budget);
    expect(() => guard('stage1', `# Chapter inbox\n\n${sized}`, sized)).not.toThrow();
    /* One over the pass budget but far under the raw context is split, not sent. */
    const over = 'a'.repeat(stage1Budget + 1);
    expect(estimateInputTokens('', [{ role: 'user', parts: [{ text: over }] }])).toBeLessThan(capacity.contextTokens);
    expect(() => guard('stage1', over, over)).toThrow(TargetInputOverBudgetError);
    /* Each pass has its own budget: a body within stage 1's is over stage 2's. */
    const stage2Over = 'a'.repeat(resolveStage2ChunkCharBudget(capacity, 'a') + 1);
    expect(stage2Over.length).toBeLessThanOrEqual(stage1Budget);
    expect(() => guard('stage1', stage2Over, stage2Over)).not.toThrow();
    expect(() => guard('stage2', stage2Over, stage2Over)).toThrow(AnalyzerTruncatedError);
    /* No body (a pass with no chunker): the whole prompt is measured. A non-splitting pass is refused, naming the target. */
    expect(() => guard('emotion', over)).toThrow(AnalyzerTargetInputTooLargeError);
    expect(() => guard('emotion', over)).toThrow(`(context ${capacity.contextTokens} tokens)`);
    /* The truncation a splitting pass gets carries that same refusal. */
    const err = (() => {
      try {
        guard('stage1', over, over);
      } catch (e) {
        return e;
      }
    })();
    expect((err as TargetInputOverBudgetError).refusal).toBeInstanceOf(AnalyzerTargetInputTooLargeError);
    expect((err as AnalyzerTruncatedError).reason).toBe('input-over-target-budget');
  });

  it("selectAnalyzer's local target refuses a prompt over its stage-1 budget as a truncation, before the target runs", async () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {}, defaultAnalysisModel: 'qwen3.5:4b', ...target('local') });
    vi.spyOn(OpenAIAnalyzer.prototype, 'runStage1Chapter').mockRejectedValue(new AnalyzerUnreachableError('connect ECONNREFUSED 127.0.0.1:8080', 'openai'));
    const targetCall = vi.spyOn(OllamaAnalyzer.prototype, 'runStage1Chapter').mockResolvedValue({ characters: [] } as never);
    const budget = resolveStage1ChunkCharBudget(resolveCapacity({ engine: 'local', model: 'qwen3.5:4b' }), 'a');
    const s = selectAnalyzer({ model: 'openai:lab::qwen3-30b' });
    await expect(s.analyzer.runStage1Chapter('m', 1, 'a'.repeat(budget + 1), {} as never)).rejects.toBeInstanceOf(AnalyzerTruncatedError);
    expect(targetCall).not.toHaveBeenCalled();
  });

  it('a target whose key is bound to another host still selects; its first call fails with the key-origin error', async () => {
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [lab],
      analyzerEndpointKeys: { lab: { origin: 'http://10.0.0.5:8080', key: 'k' } },
      ...target('openai:lab::qwen3-30b'),
    });
    const t = fallbackSelectionFor(sel('local', 'qwen3.5:4b'));
    expect(t).not.toBeNull();
    await expect(t!.analyzer.runStage1Chapter('m', 1, 'p', {} as never)).rejects.toBeInstanceOf(AnalyzerKeyOriginError);
  });

  it('a target whose configured mode was recorded rejected fails its first call with a capability refusal naming the target', async () => {
    process.env.GEMINI_API_KEY = 'k';
    _setUserSettingsCacheForTest({
      analyzerCapabilitiesByModel: {
        'gemini-3.5-flash-lite': {
          serverUrl: 'gemini',
          testedAt: '2026-09-11T10:00:00.000Z',
          control: { ok: true },
          structuredOutput: { json: { 'model-default': 'rejected' } },
          reasoning: {},
        },
      },
      configOverrides: { 'analyzer.gemini.structuredOutput': 'json' },
    });
    const t = fallbackSelectionFor(sel('local', 'qwen3.5:4b'))!;
    const run = t.analyzer.runStage1Chapter('m', 1, 'p', {} as never);
    await expect(run).rejects.toBeInstanceOf(AnalyzerCapabilityRejectedError);
    await expect(run).rejects.toThrow('gemini-3.5-flash-lite');
  });

  it('fallbackNames: the bare primary model (endpoint name · model for an endpoint) and an engine-named target', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {} });
    expect(fallbackNames(sel('openai', 'openai:lab::qwen3-30b'), sel('local', 'qwen3.5:4b'))).toEqual({ primary: 'Lab · qwen3-30b', target: 'Ollama (qwen3.5:4b)' });
    expect(fallbackNames(sel('local', 'qwen3.5:4b'), sel('openai', 'openai:lab::qwen3-30b'))).toEqual({ primary: 'qwen3.5:4b', target: 'endpoint Lab (qwen3-30b)' });
    expect(fallbackNames(sel('local', 'qwen3.5:4b'), sel('gemini', 'gemini-3.5-flash-lite')).target).toBe('Gemini (gemini-3.5-flash-lite)');
  });
});
