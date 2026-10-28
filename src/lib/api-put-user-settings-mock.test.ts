/* Task 6 (per-model-keepalive plan) — analyzerKeepAliveByModel round-trip.

   mockPutUserSettings enforces an explicit whitelist of patchable fields
   (both a destructure block and an Object.entries block); a new field
   dropped from either one is silently discarded rather than persisted.
   This test exercises the mock path directly (VITE_USE_MOCKS=true) so a
   whitelist miss fails loudly instead of only surfacing once the real
   Model Manager UI (Task 7) tries to save a keep-alive override. */

import { describe, it, expect, vi } from 'vitest';

// Force mock mode so `api` resolves to the mock object (not the real fetch-based one).
vi.stubEnv('VITE_USE_MOCKS', 'true');

// Must be a dynamic import AFTER stubEnv so the module sees the stubbed env.
const { api, _setMockUserSettingsForTest } = await import('./api');

describe('mockPutUserSettings — analyzerKeepAliveByModel', () => {
  it('persists analyzerKeepAliveByModel', async () => {
    const out = await api.putUserSettings({
      analyzerKeepAliveByModel: { 'qwen36-castwright:latest': 300 },
    });
    // analyzerKeepAliveByModel is optional on the generated UserSettings type
    // (not in the schema's `required` list); the mock always seeds it to {}.
    expect(out.analyzerKeepAliveByModel!['qwen36-castwright:latest']).toBe(300);
  });
});

describe('mockPutUserSettings — analyzerRateLimitsByModel (#3084)', () => {
  it('persists the whole map', async () => {
    const out = await api.putUserSettings({
      analyzerRateLimitsByModel: { 'gemini-3.6-flash': { rpm: 2, rpd: 10 } },
    });
    expect(out.analyzerRateLimitsByModel).toEqual({ 'gemini-3.6-flash': { rpm: 2, rpd: 10 } });
  });
});

describe('mockPutUserSettings — analyzerReasoningByEngine (#3084)', () => {
  const reset = () => _setMockUserSettingsForTest({ analyzerReasoningByEngine: {}, analyzerCapabilitiesByModel: {} });
  const record = (reasoning: Record<string, 'accepted' | 'rejected'>) => ({
    serverUrl: 'http://localhost:11434',
    testedAt: '2026-09-11T10:00:00.000Z',
    control: { ok: true },
    structuredOutput: {},
    reasoning,
  });

  it('persists the whole map', async () => {
    reset();
    const out = await api.putUserSettings({
      analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'on' }, gemini: { 'gemini-3.5-flash-lite': 'low' } },
    });
    expect(out.analyzerReasoningByEngine).toEqual({ ollama: { 'qwen3.5:4b': 'on' }, gemini: { 'gemini-3.5-flash-lite': 'low' } });
  });

  it('refuses a named Ollama level with no Test record, and saves it once a record accepted it', async () => {
    reset();
    await expect(api.putUserSettings({ analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'low' } } })).rejects.toThrow(/400.*needs a Test of that model that accepted it/);
    _setMockUserSettingsForTest({ analyzerCapabilitiesByModel: { 'qwen3.5:4b': record({ low: 'accepted' }) } as never });
    const out = await api.putUserSettings({ analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'low' } } });
    expect(out.analyzerReasoningByEngine?.ollama).toEqual({ 'qwen3.5:4b': 'low' });
  });

  it('refuses a Gemini level the model does not offer', async () => {
    reset();
    await expect(api.putUserSettings({ analyzerReasoningByEngine: { gemini: { 'gemini-3.5-flash-lite': 'high', 'gemini-3.8-flash': 'low' } } })).rejects.toThrow(
      /is not available for gemini-3.8-flash \(offered: model-default\)/,
    );
  });

  it('saves back an unchanged stale entry beside a changed one (N6)', async () => {
    reset();
    _setMockUserSettingsForTest({ analyzerReasoningByEngine: { ollama: { 'q:9b': 'high' } } });
    const out = await api.putUserSettings({
      analyzerReasoningByEngine: { ollama: { 'q:9b': 'high' }, gemini: { 'gemini-3.5-flash-lite': 'low' } },
    });
    expect(out.analyzerReasoningByEngine).toEqual({ ollama: { 'q:9b': 'high' }, gemini: { 'gemini-3.5-flash-lite': 'low' } });
  });

  it('stores an Ollama key under the normalised tag (N7)', async () => {
    reset();
    const out = await api.putUserSettings({ analyzerReasoningByEngine: { ollama: { 'qwen3:latest': 'on' } } });
    expect(out.analyzerReasoningByEngine).toEqual({ ollama: { qwen3: 'on' } });
  });
});

describe('mockPutUserSettings — analyzer.fallback.target refusal, as the server does (#3084 P30)', () => {
  const endpoint = { id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8081/v1', gpu: 'any', contextTokens: 32768, reasoningStyle: 'not_controllable', reasoning: 'model-default' };
  const put = (target: string) => api.putUserSettings({ configOverrides: { 'analyzer.fallback.target': target } } as never);

  it('refuses an unsaved endpoint target, accepts a saved one, and accepts an unchanged value', async () => {
    _setMockUserSettingsForTest({ analyzerEndpoints: [], configOverrides: {} });
    await expect(put('openai:lab::m')).rejects.toThrow(/400.*no analyzer endpoint \\"lab\\" is saved/);
    _setMockUserSettingsForTest({ analyzerEndpoints: [endpoint as never] });
    await expect(put('openai:lab::m')).resolves.toBeDefined();
    /* The endpoint is deleted later; re-sending the unchanged stored target still saves. */
    _setMockUserSettingsForTest({ analyzerEndpoints: [] });
    await expect(put('openai:lab::m')).resolves.toBeDefined();
  });

  it('refuses gemini without a saved key', async () => {
    _setMockUserSettingsForTest({ configOverrides: {}, apiKeyStatus: 'unset' } as never);
    await expect(put('gemini')).rejects.toThrow(/gemini needs a Gemini API key/);
  });
});
