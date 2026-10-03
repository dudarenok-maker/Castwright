import { describe, it, expect, afterEach } from 'vitest';
import { getResolvedOllamaModel } from './ollama-resolved.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';
import { inferEngineFromModelId } from '../analyzer/model-id.js';

describe('getResolvedOllamaModel — endpoint ids never reach Ollama (#3084 PR 3a, re-pin A3)', () => {
  const saved = process.env.OLLAMA_MODEL;
  afterEach(() => {
    if (saved === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = saved;
    _resetUserSettingsCache();
  });

  /* This resolver also feeds Ollama health, inventory and persona probes, so it
     never returns an endpoint id. It is NOT what a run falls back to: selection
     refuses a saved endpoint default as analyzer-endpoint-missing before it
     reads this resolver (Task 3a.2, `a saved endpoint default is refused…`). */
  it('never returns a saved openai:<endpoint>::<model> default as the Ollama tag (the "step 1" tier)', () => {
    delete process.env.OLLAMA_MODEL;
    _setUserSettingsCacheForTest({ defaultAnalysisModel: 'openai:lab::qwen3:30b' });
    expect(inferEngineFromModelId(getResolvedOllamaModel())).not.toBe('openai');
  });

  it('keeps a saved Ollama tag named openai:latest (the "step 1" tier)', () => {
    _setUserSettingsCacheForTest({ defaultAnalysisModel: 'openai:latest' });
    expect(getResolvedOllamaModel()).toBe('openai:latest');
  });

  it('ignores an endpoint id in OLLAMA_MODEL (env), falling back to the registry default (#3084 P23)', () => {
    /* #3084 A3 review — main's own "step 2" (configValue('analyzer.ollama.model'),
       env OLLAMA_MODEL -> saved Advanced override -> registry default) has the
       SAME bug this task exists to fix, in a different shape: it never
       checks whether the RESOLVED value is an endpoint id at all. This test
       drives the env tier; the next drives the override tier — A3 explicitly
       calls out that the override tier needs its own test, not just env.

       _resetUserSettingsCache (cached=null) simulates "no saved settings yet"
       so getCachedDefaultAnalysisModelIfSet() returns undefined and step 1
       (defaultAnalysisModel) doesn't shadow the env tier at step 2. */
    _resetUserSettingsCache();
    delete process.env.OLLAMA_MODEL;
    const unset = getResolvedOllamaModel();
    process.env.OLLAMA_MODEL = 'openai:lab::qwen3:30b';
    expect(getResolvedOllamaModel()).toBe(unset);
    process.env.OLLAMA_MODEL = 'openai:latest';
    expect(getResolvedOllamaModel()).toBe('openai:latest');
  });

  it('ignores an endpoint id in the saved Advanced Settings override (analyzer.ollama.model), falling back to the registry default (#3084 A3)', () => {
    delete process.env.OLLAMA_MODEL;
    /* defaultAnalysisModel:'' keeps step 1 from shadowing the override tier
       at step 2 — the point of this test is that the override IS reached but
       refused when it holds an endpoint id. */
    _setUserSettingsCacheForTest({ defaultAnalysisModel: '', configOverrides: { 'analyzer.ollama.model': 'openai:lab::qwen3:30b' } });
    const withEndpointOverride = getResolvedOllamaModel();
    expect(inferEngineFromModelId(withEndpointOverride)).not.toBe('openai');
    _setUserSettingsCacheForTest({});
    expect(withEndpointOverride).toBe(getResolvedOllamaModel()); // same as the registry default, unset
    _setUserSettingsCacheForTest({ defaultAnalysisModel: '', configOverrides: { 'analyzer.ollama.model': 'llama2' } });
    expect(getResolvedOllamaModel()).toBe('llama2'); // a real Ollama tag override still works
  });
});
