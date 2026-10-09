import { describe, it, expect, afterEach } from 'vitest';
import { resolvePhaseModelSelection } from './select-analyzer.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';

afterEach(() => {
  delete process.env.ANALYZER_PHASE0_MODEL;
  delete process.env.ANALYZER_PHASE1_MODEL;
  _resetUserSettingsCache();
});

/* Since #3192 the saved phase model is an Advanced Settings override: `resolveKnob` reads it from
   `getCachedUserSettings().configOverrides` (`user-settings.ts:1143-1144`), so the cache is seeded. */
const savePhase0 = (model: string) => _setUserSettingsCacheForTest({ configOverrides: { 'analyzer.phase0.model': model } });

describe('resolvePhaseModelSelection (#3084) — main tiers (#3141)', () => {
  it('env wins over every other tier and is reported as env', () => {
    savePhase0('gemma-4-31b-it');
    process.env.ANALYZER_PHASE0_MODEL = ' openai:lab::m ';
    expect(resolvePhaseModelSelection({ phase: 'phase0', phaseModel: 'mistral:7b', model: 'qwen3.5:4b' })).toEqual({ modelId: 'openai:lab::m', source: 'env' });
  });
  it('then the per-run phase pick, reported as run-pick', () => {
    savePhase0('gemma-4-31b-it');
    expect(resolvePhaseModelSelection({ phase: 'phase0', phaseModel: 'mistral:7b', model: 'qwen3.5:4b' })).toEqual({ modelId: 'mistral:7b', source: 'run-pick' });
  });
  it('then the per-request model, reported as run-pick', () => {
    savePhase0('gemma-4-31b-it');
    expect(resolvePhaseModelSelection({ phase: 'phase0', model: 'qwen3.5:4b' })).toEqual({ modelId: 'qwen3.5:4b', source: 'run-pick' });
  });
  it('then the saved Advanced Settings override, reported as settings', () => {
    savePhase0('gemma-4-31b-it');
    expect(resolvePhaseModelSelection({ phase: 'phase0' })).toEqual({ modelId: 'gemma-4-31b-it', source: 'settings' });
  });
  it('then the engine default (no id)', () => {
    savePhase0('gemma-4-31b-it');
    expect(resolvePhaseModelSelection({ phase: 'phase1' })).toEqual({ modelId: null, source: 'default' });
  });
});
