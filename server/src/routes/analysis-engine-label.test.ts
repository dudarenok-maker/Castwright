import { describe, it, expect, afterEach } from 'vitest';
import { engineLabel, engineFallbackMsPerChar } from './analysis.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';

afterEach(() => _resetUserSettingsCache());

describe('engineLabel (#3084 PR 3d)', () => {
  it('labels an endpoint by its saved name and model', () => {
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab server', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 8192 })],
    });
    expect(engineLabel('openai', 'openai:lab::qwen3:30b')).toBe('Lab server (qwen3:30b)');
  });
  it('falls back to the endpoint id when the endpoint is not saved', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [] });
    expect(engineLabel('openai', 'openai:lab::qwen3:30b')).toBe('Endpoint lab (qwen3:30b)');
  });
  it('keeps the Ollama and Gemini labels', () => {
    expect(engineLabel('local', 'qwen3.5:4b')).toBe('Ollama (qwen3.5:4b)');
    expect(engineLabel('gemini', 'no-such-model-id')).toBe('no-such-model-id');
  });
});

describe('engineFallbackMsPerChar (#3084 PR 3d)', () => {
  it('an endpoint on a GPU seeds with the local rate; gpu none with the cloud rate', () => {
    expect(engineFallbackMsPerChar('openai', 'cuda', 'cuda:1')).toBe(engineFallbackMsPerChar('local', 'cuda'));
    expect(engineFallbackMsPerChar('openai', 'cuda', 'any')).toBe(engineFallbackMsPerChar('local', 'cuda'));
    expect(engineFallbackMsPerChar('openai', 'cuda', 'none')).toBe(engineFallbackMsPerChar('gemini', 'cuda'));
  });
});
