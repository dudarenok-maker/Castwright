import { describe, it, expect, afterEach } from 'vitest';
import { resolveAnalyzerFallbackTarget, fallbackTargetSaveError } from './fallback-target.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';

afterEach(() => {
  delete process.env.ANALYZER_FALLBACK_TARGET;
  _resetUserSettingsCache();
});

describe('resolveAnalyzerFallbackTarget (#3084 P30)', () => {
  it('defaults to gemini', () => {
    _setUserSettingsCacheForTest({});
    expect(resolveAnalyzerFallbackTarget()).toBe('gemini');
  });

  it('legacy: a saved allowCloudFallback false reads off while nothing overrides the knob', () => {
    _setUserSettingsCacheForTest({ allowCloudFallback: false });
    expect(resolveAnalyzerFallbackTarget()).toBe('off');
  });

  it('a saved override beats the legacy step', () => {
    _setUserSettingsCacheForTest({ allowCloudFallback: false, configOverrides: { 'analyzer.fallback.target': 'local' } });
    expect(resolveAnalyzerFallbackTarget()).toBe('local');
  });

  it('env beats a saved override and the legacy step', () => {
    process.env.ANALYZER_FALLBACK_TARGET = 'openai:lab::m';
    _setUserSettingsCacheForTest({ allowCloudFallback: false, configOverrides: { 'analyzer.fallback.target': 'local' } });
    expect(resolveAnalyzerFallbackTarget()).toBe('openai:lab::m');
  });
});

describe('fallbackTargetSaveError (#3084 P30)', () => {
  it('refuses gemini with no Gemini key and accepts it with one', () => {
    expect(fallbackTargetSaveError('gemini', { endpointIds: [], geminiKey: false })).toMatch(/^analyzer\.fallback\.target: gemini needs a Gemini API key/);
    expect(fallbackTargetSaveError('gemini', { endpointIds: [], geminiKey: true })).toBeNull();
  });

  it('refuses an endpoint model whose endpoint is not saved, and accepts a saved one', () => {
    expect(fallbackTargetSaveError('openai:gone::m', { endpointIds: ['lab'], geminiKey: true })).toMatch(/no analyzer endpoint "gone" is saved/);
    expect(fallbackTargetSaveError('openai:lab::m', { endpointIds: ['lab'], geminiKey: false })).toBeNull();
  });

  it('off and local need nothing', () => {
    expect(fallbackTargetSaveError('off', { endpointIds: [], geminiKey: false })).toBeNull();
    expect(fallbackTargetSaveError('local', { endpointIds: [], geminiKey: false })).toBeNull();
  });
});
