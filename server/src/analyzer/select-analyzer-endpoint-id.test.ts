import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { selectAnalyzer } from './index.js';
import { selectAnalyzerForPhase } from './select-analyzer.js';
import { OllamaAnalyzer } from './ollama.js';
import { OpenAIAnalyzer } from './openai.js';
import { AnalyzerEndpointMissingError, AnalyzerKeyOriginError } from './errors.js';
import {
  _resetUserSettingsCache,
  _setUserSettingsCacheForTest,
} from '../workspace/user-settings.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';
import { analyzerSelectionErrorEvent } from '../routes/failure-taxonomy.js';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

describe('selectAnalyzer — endpoint-shaped model ids (#3084 PR 3a, P23)', () => {
  const ENV_KEYS = ['GEMINI_API_KEY', 'ANALYZER_PHASE0_MODEL', 'ANALYZER_PHASE1_MODEL'] as const;
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    _setUserSettingsCacheForTest({ geminiApiKey: null });
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetUserSettingsCache();
  });

  it('a saved endpoint default is refused as settings-sourced, never run on Ollama\'s default model', () => {
    _setUserSettingsCacheForTest({ geminiApiKey: null, defaultAnalysisModel: 'openai:lab::qwen3:30b' });
    const err = thrown(() => selectAnalyzer({}));
    expect(err).toBeInstanceOf(AnalyzerEndpointMissingError);
    expect(err).toMatchObject({ endpointId: 'lab', source: 'settings' });
  });

  it('still routes an Ollama tag that merely starts with "openai:" to Ollama', () => {
    const sel = selectAnalyzer({ model: 'openai:latest' });
    expect(sel.engine).toBe('local');
    expect(sel.analyzer).toBeInstanceOf(OllamaAnalyzer);
    expect(sel.model).toBe('openai:latest');
  });
});

const lab = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 32768 });

describe('selectAnalyzer — OpenAI-compatible endpoints (#3084 PR 3d)', () => {
  afterEach(() => {
    _resetUserSettingsCache();
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANALYZER_PHASE1_MODEL;
  });

  it('an endpoint id builds OpenAIAnalyzer and keeps the full id as the model', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {}, allowCloudFallback: true });
    const s = selectAnalyzer({ model: 'openai:lab::qwen3-30b' });
    expect(s.engine).toBe('openai');
    expect(s.analyzer).toBeInstanceOf(OpenAIAnalyzer);
    expect(s.model).toBe('openai:lab::qwen3-30b');
    expect(s.fallbackModel).toBeNull();
  });

  it('a saved openai engine uses defaultAnalysisModel', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {}, analysisEngine: 'openai', defaultAnalysisModel: 'openai:lab::m' });
    expect(selectAnalyzer({}).model).toBe('openai:lab::m');
  });

  it('a missing endpoint and a key bound to another host throw typed errors', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [], analyzerEndpointKeys: {} });
    expect(() => selectAnalyzer({ model: 'openai:lab::m' })).toThrow(AnalyzerEndpointMissingError);
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: { lab: { origin: 'http://10.0.0.5:8080', key: 'k' } } });
    expect(() => selectAnalyzer({ model: 'openai:lab::m' })).toThrow(AnalyzerKeyOriginError);
  });

  it('a missing endpoint names where its id came from: env, run pick, saved phase model', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {} });
    process.env.ANALYZER_PHASE1_MODEL = 'openai:gone::m';
    expect(thrown(() => selectAnalyzerForPhase({ phase: 'phase1' }))).toMatchObject({ endpointId: 'gone', source: 'env' });
    delete process.env.ANALYZER_PHASE1_MODEL;
    expect(thrown(() => selectAnalyzerForPhase({ phase: 'phase1', model: 'openai:gone::m' }))).toMatchObject({
      endpointId: 'gone',
      source: 'run-pick',
    });
    /* #3141 step 4 — a per-run phase pick is a run pick too. */
    expect(thrown(() => selectAnalyzerForPhase({ phase: 'phase1', phaseModel: 'openai:gone::m' }))).toMatchObject({
      endpointId: 'gone',
      source: 'run-pick',
    });
    /* A saved phase model is an Advanced Settings override since #3192. */
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {}, configOverrides: { 'analyzer.phase1.model': 'openai:gone::m' } });
    expect(thrown(() => selectAnalyzerForPhase({ phase: 'phase1' }))).toMatchObject({ endpointId: 'gone', source: 'settings' });
  });

  it('a direct model with no modelSource is a run pick; the saved default is settings (P23)', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {} });
    expect(thrown(() => selectAnalyzer({ model: 'openai:gone::m' }))).toMatchObject({ endpointId: 'gone', source: 'run-pick' });
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {}, analysisEngine: 'openai', defaultAnalysisModel: 'openai:gone::m' });
    expect(thrown(() => selectAnalyzer({}))).toMatchObject({ endpointId: 'gone', source: 'settings' });
  });

  it('an env phase model on an endpoint is selectable', () => {
    process.env.ANALYZER_PHASE1_MODEL = 'openai:lab::m';
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {} });
    expect(selectAnalyzerForPhase({ phase: 'phase1' }).engine).toBe('openai');
  });

  it('a missing endpoint still reaches every selection call site as analyzer-endpoint-missing (3b Task 3b.1a, P23)', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {} });
    /* The helper every 3b.1a call site sends. It codes every class and never returns null,
       so a TypeError here would not end a stream uncoded — it would go out as `unknown` at
       all six sites, which is the silent regression this case exists to catch. */
    expect(analyzerSelectionErrorEvent(thrown(() => selectAnalyzerForPhase({ phase: 'phase1', model: 'openai:gone::m' })))).toMatchObject({
      kind: 'error',
      code: 'analyzer-endpoint-missing',
    });
    expect(analyzerSelectionErrorEvent(thrown(() => selectAnalyzer({ model: 'openai:gone::m' })))).toMatchObject({
      kind: 'error',
      code: 'analyzer-endpoint-missing',
    });
  });
});
