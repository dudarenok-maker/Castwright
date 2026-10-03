import { describe, it, expect, vi } from 'vitest';

vi.stubEnv('VITE_USE_MOCKS', 'true');
const { api } = await import('./api');

describe('mock PUT user settings — endpoint model ids (#3084 P23)', () => {
  /* #3084 A5 (re-pin to 80be2f1d) — only defaultAnalysisModel is a settings
     field any more; the two phase fields don't exist on the schema at all. */
  it('refuses an endpoint id in defaultAnalysisModel, as the server does', async () => {
    const before = (await api.getUserSettings()).defaultAnalysisModel;
    await expect(api.putUserSettings({ defaultAnalysisModel: 'openai:lab::m' })).rejects.toThrow(/\(400\).*Invalid user settings/);
    expect((await api.getUserSettings()).defaultAnalysisModel).toBe(before);
  });

  it('still saves an Ollama tag named openai:latest', async () => {
    const res = await api.putUserSettings({ configOverrides: { 'analyzer.phase1.model': 'openai:latest' } } as never);
    expect(((res as Record<string, unknown>).configOverrides as Record<string, unknown>)?.['analyzer.phase1.model']).toBe('openai:latest');
  });

  it('refuses an endpoint id in a configOverrides knob, as the server does', async () => {
    await expect(
      api.putUserSettings({ configOverrides: { 'analyzer.ollama.model': 'openai:lab::m' } } as never),
    ).rejects.toThrow(/\(400\).*Invalid user settings/);
  });

  it('replaces the whole configOverrides map wholesale, like the server does (does not deep-merge)', async () => {
    await api.putUserSettings({ configOverrides: { 'analyzer.phase0.model': 'llama2' } } as never);
    const res = await api.putUserSettings({ configOverrides: { 'analyzer.phase1.model': 'gemma3' } } as never);
    const overrides = (res as Record<string, unknown>).configOverrides as Record<string, unknown>;
    expect(overrides['analyzer.phase1.model']).toBe('gemma3');
    expect(overrides['analyzer.phase0.model']).toBeUndefined();
  });
});
