import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { selectAnalyzer } from './index.js';
import { selectAnalyzerForPhase } from './select-analyzer.js';
import { OllamaAnalyzer } from './ollama.js';
import { AnalyzerEndpointMissingError } from './errors.js';
import {
  _resetUserSettingsCache,
  _setUserSettingsCacheForTest,
} from '../workspace/user-settings.js';

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

  it('refuses an openai:<endpoint>::<model> id instead of handing it to Ollama', () => {
    const err = thrown(() => selectAnalyzer({ model: 'openai:lab::qwen3:30b' }));
    expect(err).toBeInstanceOf(AnalyzerEndpointMissingError);
    expect(err).toMatchObject({ endpointId: 'lab', source: 'run-pick' });
  });

  it('a saved endpoint default is refused as settings-sourced, never run on Ollama\'s default model', () => {
    _setUserSettingsCacheForTest({ geminiApiKey: null, defaultAnalysisModel: 'openai:lab::qwen3:30b' });
    const err = thrown(() => selectAnalyzer({}));
    expect(err).toBeInstanceOf(AnalyzerEndpointMissingError);
    expect(err).toMatchObject({ endpointId: 'lab', source: 'settings' });
  });

  it('each phase source is named: env, run pick, saved phase model', () => {
    process.env.ANALYZER_PHASE0_MODEL = 'openai:lab::m';
    expect(thrown(() => selectAnalyzerForPhase({ phase: 'phase0' }))).toMatchObject({ endpointId: 'lab', source: 'env' });
    delete process.env.ANALYZER_PHASE0_MODEL;

    expect(thrown(() => selectAnalyzerForPhase({ phase: 'phase1', model: 'openai:pick::m' }))).toMatchObject({
      endpointId: 'pick',
      source: 'run-pick',
    });

    /* #3084 A1 (re-pin to 80be2f1d) — the NEW opts.phaseModel tier (#3141 step
       4, between env and opts.model) also reports 'run-pick': it is this
       request's own phase0Model/phase1Model, never persisted, same as
       opts.model. Beats opts.model when both would apply, though this test
       only needs to show the tier reports the right source on its own. */
    expect(thrown(() => selectAnalyzerForPhase({ phase: 'phase1', phaseModel: 'openai:runpick::m' }))).toMatchObject({
      endpointId: 'runpick',
      source: 'run-pick',
    });

    /* #3084 A1 (re-pin to 80be2f1d) — a saved phase model is a configOverrides
       entry now (the resolver reads getCachedUserSettings().configOverrides,
       user-settings.ts:1143-1144), never analyzerPhase1Model, which no longer
       exists as a settings field. */
    _setUserSettingsCacheForTest({ geminiApiKey: null, configOverrides: { 'analyzer.phase1.model': 'openai:saved::m' } });
    expect(thrown(() => selectAnalyzerForPhase({ phase: 'phase1' }))).toMatchObject({ endpointId: 'saved', source: 'settings' });
  });

  it('still routes an Ollama tag that merely starts with "openai:" to Ollama', () => {
    const sel = selectAnalyzer({ model: 'openai:latest' });
    expect(sel.engine).toBe('local');
    expect(sel.analyzer).toBeInstanceOf(OllamaAnalyzer);
    expect(sel.model).toBe('openai:latest');
  });
});
