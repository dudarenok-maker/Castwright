import { describe, it, expect, vi, beforeEach } from 'vitest';

const captured: Array<Record<string, unknown>> = [];
vi.mock('@google/genai', async (orig) => {
  const actual = await orig<typeof import('@google/genai')>();
  class FakeGoogleGenAI {
    models = {
      generateContentStream: async (params: Record<string, unknown>) => {
        captured.push(params);
        return (async function* () {
          yield { text: '{}', candidates: [{ finishReason: 'STOP' }] };
        })();
      },
    };
  }
  return { ...actual, GoogleGenAI: FakeGoogleGenAI };
});
vi.mock('../handoff/protocol.js', async (orig) => {
  const actual = await orig<typeof import('../handoff/protocol.js')>();
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { mkdir } = await import('node:fs/promises');
  const dir = join(tmpdir(), `castwright-w5b-allowlist-${process.pid}`);
  await mkdir(dir, { recursive: true });
  return { ...actual, writeInbox: async () => join(dir, 'inbox.md'), outboxPath: () => join(dir, 'out.json'), errorPath: () => join(dir, 'err.json'), rawAttemptPath: () => join(dir, 'raw.txt') };
});

import { GeminiAnalyzer } from './gemini.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';
import { geminiRateLimiter } from './rate-limit.js';

beforeEach(() => {
  captured.length = 0;
  geminiRateLimiter._reset();
  _resetUserSettingsCache();
});

describe('a stored Gemini httpOptions payload never reaches generateContentStream (#3084 wave 5, P16)', () => {
  it('is dropped at merge when injected straight into settings, while allowlisted keys still apply', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    _setUserSettingsCacheForTest({
      analyzerExtraParamsByEngine: { gemini: { config: { httpOptions: { baseUrl: 'http://evil', headers: { 'x-evil': '1' } }, topK: 40 } } },
    });
    await new GeminiAnalyzer({ apiKey: 'k', model: 'gemini-3.6-flash' }).runAttributionEscalation('m1', 1, 0, 'prompt', {});
    const params = captured[0] as { config: Record<string, unknown> };
    expect(params.config).not.toHaveProperty('httpOptions');
    expect(params.config.topK).toBe(40);
    expect(JSON.stringify(params)).not.toContain('evil');
    expect(warn.mock.calls.some(([m]) => String(m).includes('config.httpOptions'))).toBe(true);
    warn.mockRestore();
  });
});
