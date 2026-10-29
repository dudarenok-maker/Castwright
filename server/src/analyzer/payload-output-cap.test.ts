import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../handoff/protocol.js', async (orig) => {
  const actual = await orig<typeof import('../handoff/protocol.js')>();
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { mkdir } = await import('node:fs/promises');
  const dir = join(tmpdir(), `castwright-w5b-cap-${process.pid}`);
  await mkdir(dir, { recursive: true });
  return { ...actual, writeInbox: async () => join(dir, 'inbox.md'), outboxPath: () => join(dir, 'out.json'), errorPath: () => join(dir, 'err.json'), rawAttemptPath: () => join(dir, 'raw.txt') };
});

import { resolveCapacity, TODAY_LOCAL_CAPACITY } from './capacity.js';
import { OllamaAnalyzer } from './ollama.js';
import { OllamaTransport } from './transports/ollama-transport.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';

beforeEach(() => _resetUserSettingsCache());
afterEach(() => vi.restoreAllMocks());

describe('a payload output cap is the cap every consumer uses (#3084 wave 5, P19)', () => {
  it('options.num_predict 512: capacity reports 512, and the request the overflow rule judges carries 512', async () => {
    _setUserSettingsCacheForTest({ analyzerExtraParamsByEngine: { ollama: { options: { num_predict: 512 } } } });
    /* Chunk sizing (W2 Task 2.3) and the Test probe cap receive this EngineCapacity; the catalog's outputTokens stays the model's listed maximum (5b-D15). */
    expect(resolveCapacity({ engine: 'local', model: 'q:4b' })).toEqual({ ...TODAY_LOCAL_CAPACITY(), maxOutputTokens: 512 });
    const send = vi
      .spyOn(OllamaTransport.prototype, 'send')
      .mockResolvedValue({ text: '{}', reasoningSeen: false, finish: 'stop', receivedBytes: 2 });
    await new OllamaAnalyzer({ url: 'http://ollama.test', model: 'q:4b' }).runAttributionEscalation('m1', 1, 0, 'prompt', {});
    expect(send.mock.calls[0][0].maxOutputTokens).toBe(512);
  });

  it('an endpoint payload max_completion_tokens replaces the saved cap', () => {
    const lab = analyzerEndpointSchema.parse({
      id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8081/v1', gpu: 'none', contextTokens: 32768, maxOutputTokens: 8192,
      extraParams: { max_completion_tokens: 4096 },
    });
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab] });
    expect(resolveCapacity({ engine: 'openai', model: 'openai:lab::m' }).maxOutputTokens).toBe(4096);
  });

  it('no payload leaves capacity exactly as W2 resolves it', () => {
    _setUserSettingsCacheForTest({});
    expect(resolveCapacity({ engine: 'local', model: 'q:4b' })).toEqual(TODAY_LOCAL_CAPACITY());
  });
});
