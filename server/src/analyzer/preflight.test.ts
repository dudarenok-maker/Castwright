import { describe, it, expect, afterEach } from 'vitest';
import { runAnalyzerPreflight, preflightTargets, resolvePreflightDigests } from './preflight.js';
import { AnalyzerCapabilityRejectedError, AnalyzerEndpointMissingError, AnalyzerKeyOriginError } from './errors.js';
import { DEFAULT_USER_SETTINGS, _resetUserSettingsCache, _setUserSettingsCacheForTest, type UserSettings } from '../workspace/user-settings.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';

const lab = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab server', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 32768 });
const rejectedSchema = {
  serverUrl: 'http://127.0.0.1:8080/v1', testedAt: '2026-09-11T10:00:00.000Z', control: { ok: true as const },
  structuredOutput: { schema: { 'model-default': 'rejected' as const } }, reasoning: {},
};
const settings = (over: Partial<UserSettings> = {}): UserSettings => ({
  ...DEFAULT_USER_SETTINGS, analyzerEndpoints: [lab], analyzerEndpointKeys: {}, analyzerCapabilitiesByModel: {}, ...over,
});

function thrown(fn: () => void): unknown {
  try { fn(); } catch (err) { return err; }
  return undefined;
}

afterEach(() => {
  delete process.env.ANALYZER_PHASE1_MODEL;
  _resetUserSettingsCache();
});

describe('runAnalyzerPreflight (#3084)', () => {
  it('passes a configured endpoint with no key and no record', () => {
    const s = settings();
    expect(() => runAnalyzerPreflight(preflightTargets(['phase0', 'phase1'], 'openai:lab::qwen3-30b', s), s)).not.toThrow();
  });

  it('targets carry the engine selection will build: inferred from an explicit id', () => {
    const s = settings();
    expect(preflightTargets(['phase0'], 'openai:lab::qwen3-30b', s)).toEqual([{ modelId: 'openai:lab::qwen3-30b', source: 'run-pick', engine: 'openai' }]);
    expect(preflightTargets(['phase0'], 'qwen3.5:4b', s)).toEqual([{ modelId: 'qwen3.5:4b', source: 'run-pick', engine: 'local' }]);
  });

  it('a deleted endpoint from the per-run pick → AnalyzerEndpointMissingError source run-pick', () => {
    const s = settings({ analyzerEndpoints: [] });
    const err = thrown(() => runAnalyzerPreflight(preflightTargets(['phase0'], 'openai:lab::qwen3-30b', s), s));
    expect(err).toBeInstanceOf(AnalyzerEndpointMissingError);
    expect(err).toMatchObject({ endpointId: 'lab', source: 'run-pick' });
  });

  it('a deleted endpoint named by env → source env', () => {
    process.env.ANALYZER_PHASE1_MODEL = 'openai:gone::m';
    const s = settings();
    expect(thrown(() => runAnalyzerPreflight(preflightTargets(['phase1'], undefined, s), s))).toMatchObject({ endpointId: 'gone', source: 'env' });
  });

  it('a deleted endpoint saved as the phase model → source settings', () => {
    /* A saved phase model is an Advanced Settings override since #3192, read from the cache. */
    _setUserSettingsCacheForTest({ configOverrides: { 'analyzer.phase0.model': 'openai:gone::m' } });
    const s = settings();
    expect(thrown(() => runAnalyzerPreflight(preflightTargets(['phase0'], undefined, s), s))).toMatchObject({ endpointId: 'gone', source: 'settings' });
  });

  it('a per-run phase pick is a run-pick target for its own phase only, and beats the run model (#3141)', () => {
    const s = settings();
    expect(preflightTargets(['phase0', 'phase1'], 'qwen3.5:4b', s, { phase1: 'openai:lab::m' })).toEqual([
      { modelId: 'qwen3.5:4b', source: 'run-pick', engine: 'local' },
      { modelId: 'openai:lab::m', source: 'run-pick', engine: 'openai' },
    ]);
  });

  it('an unsaved endpoint named by a per-run phase pick → AnalyzerEndpointMissingError source run-pick', () => {
    const s = settings();
    const err = thrown(() => runAnalyzerPreflight(preflightTargets(['phase1'], undefined, s, { phase1: 'openai:gone::m' }), s));
    expect(err).toBeInstanceOf(AnalyzerEndpointMissingError);
    expect(err).toMatchObject({ endpointId: 'gone', source: 'run-pick' });
  });

  it('a stored key for another host → AnalyzerKeyOriginError', () => {
    const s = settings({ analyzerEndpointKeys: { lab: { origin: 'http://10.0.0.5:8080', key: 'k' } } });
    expect(thrown(() => runAnalyzerPreflight(preflightTargets(['phase0'], 'openai:lab::m', s), s))).toBeInstanceOf(AnalyzerKeyOriginError);
  });

  it('a Test record that rejected the configured mode at the level the run sends refuses the run', () => {
    const s = settings({ analyzerCapabilitiesByModel: { 'openai:lab::m': rejectedSchema } });
    expect(thrown(() => runAnalyzerPreflight(preflightTargets(['phase0'], 'openai:lab::m', s), s))).toBeInstanceOf(AnalyzerCapabilityRejectedError);
  });

  it('a rejection recorded against an old base URL is discarded', () => {
    const s = settings({ analyzerCapabilitiesByModel: { 'openai:lab::m': { ...rejectedSchema, serverUrl: 'http://10.0.0.5:8080/v1' } } });
    expect(() => runAnalyzerPreflight(preflightTargets(['phase0'], 'openai:lab::m', s), s)).not.toThrow();
  });

  it('a Gemini model whose configured mode was rejected at the level Gemini sends is refused — changing the "gemini" serverUrl literal in runAnalyzerPreflight to any other string reddens this (#3084)', () => {
    const s = settings({
      analyzerCapabilitiesByModel: {
        'gemini-3.5-flash-lite': { ...rejectedSchema, serverUrl: 'gemini', structuredOutput: { json: { 'model-default': 'rejected' as const } } },
      },
    });
    expect(thrown(() => runAnalyzerPreflight(preflightTargets(['phase0'], 'gemini-3.5-flash-lite', s), s))).toBeInstanceOf(AnalyzerCapabilityRejectedError);
  });

  it('an Ollama model whose schema mode was rejected at off (the level Ollama sends) at the Ollama URL is refused', () => {
    const s = settings({
      analyzerCapabilitiesByModel: {
        'qwen3.5:4b': { ...rejectedSchema, serverUrl: 'http://localhost:11434', structuredOutput: { schema: { off: 'rejected' as const } } },
      },
    });
    expect(thrown(() => runAnalyzerPreflight(preflightTargets(['phase0'], 'qwen3.5:4b', s), s))).toBeInstanceOf(AnalyzerCapabilityRejectedError);
  });

  it('A3 — an Ollama rejection recorded for another installed digest no longer refuses; the same digest, or an unknown one, still does', () => {
    const rec = { ...rejectedSchema, serverUrl: 'http://localhost:11434', structuredOutput: { schema: { off: 'rejected' as const } }, digest: 'sha256:old' };
    const s = settings({ analyzerCapabilitiesByModel: { 'qwen3.5:4b': rec } });
    const targets = preflightTargets(['phase0'], 'qwen3.5:4b', s);
    expect(() => runAnalyzerPreflight(targets, s, new Map([['qwen3.5:4b', 'sha256:new']]))).not.toThrow();
    expect(thrown(() => runAnalyzerPreflight(targets, s, new Map([['qwen3.5:4b', 'sha256:old']])))).toBeInstanceOf(AnalyzerCapabilityRejectedError);
    expect(thrown(() => runAnalyzerPreflight(targets, s))).toBeInstanceOf(AnalyzerCapabilityRejectedError);
  });
});

describe('resolvePreflightDigests (#3084 A3)', () => {
  it('asks once per distinct Ollama model, never for Gemini or endpoint targets, and maps a failure to undefined', async () => {
    const s = settings();
    const asked: string[] = [];
    const targets = [
      ...preflightTargets(['phase0', 'phase1'], 'qwen3.5:4b', s),
      ...preflightTargets(['phase0'], 'gemini-3.6-flash', s),
      ...preflightTargets(['phase0'], 'openai:lab::m', s),
      ...preflightTargets(['phase0'], 'mistral:7b', s),
    ];
    const out = await resolvePreflightDigests(targets, {
      ollamaUrl: () => 'http://localhost:11434',
      modelDigest: async (_url, model) => {
        asked.push(model);
        if (model === 'mistral:7b') throw new Error('boom');
        return 'sha256:q';
      },
    });
    expect(asked.sort()).toEqual(['mistral:7b', 'qwen3.5:4b']);
    expect(Object.fromEntries(out)).toEqual({ 'qwen3.5:4b': 'sha256:q', 'mistral:7b': undefined });
  });
});
