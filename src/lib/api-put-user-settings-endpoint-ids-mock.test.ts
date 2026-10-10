import { describe, it, expect, vi } from 'vitest';

vi.stubEnv('VITE_USE_MOCKS', 'true');
const { api } = await import('./api');

describe('mock PUT user settings — endpoint model ids (#3084 PR 3d)', () => {
  it('accepts an endpoint id in defaultAnalysisModel, as the server does', async () => {
    expect((await api.putUserSettings({ defaultAnalysisModel: 'openai:lab::m' })).defaultAnalysisModel).toBe('openai:lab::m');
    expect((await api.getUserSettings()).defaultAnalysisModel).toBe('openai:lab::m');
  });

  it('accepts an endpoint id in a phase-model override, as the server does', async () => {
    const res = await api.putUserSettings({ configOverrides: { 'analyzer.phase0.model': 'openai:lab::m' } } as never);
    expect(((res as Record<string, unknown>).configOverrides as Record<string, unknown>)?.['analyzer.phase0.model']).toBe('openai:lab::m');
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
