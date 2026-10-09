import { describe, it, expect, afterEach } from 'vitest';
import { resolveCapacity, TODAY_LOCAL_CAPACITY } from './capacity.js';
import { resolveStage1ChunkCharBudget } from './stage1-chunk.js';
import { resolveStage2ChunkCharBudget } from './stage2-chunk.js';
import { chapterChunkBudget } from './chapter-chunker.js';
import { cloudBodyCharBudget, cloudBodyCharBudgetForCap, resolveMaxInputTokensPerRequest } from './token-budget.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';
import { AnalyzerEndpointMissingError } from './errors.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';
import { _resetEndpointServedLimitsForTest } from './catalog/endpoint-served-limits.js';

const LATIN = 'The lamp guttered while Hart counted the coal sacks by the door. '.repeat(400);
const CYRILLIC = 'Фонарь мигал, пока Харт считал мешки с углём у двери. '.repeat(400);
const CJK = '灯火摇曳，哈特在门边数着煤袋。'.repeat(900);

function endpoint(over: Record<string, unknown> = {}) {
  return analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 32768, ...over });
}

afterEach(() => {
  _resetUserSettingsCache();
  _resetEndpointServedLimitsForTest();
});

describe('resolveCapacity — endpoint branch (#3084 W3)', () => {
  it('context family, the endpoint context, no cap and no known output limit by default', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [endpoint()], analyzerRateLimitsByModel: {} });
    expect(resolveCapacity({ engine: 'openai', model: 'openai:lab::qwen3-30b' })).toEqual({
      family: 'context',
      contextTokens: 32768,
      maxOutputTokens: null,
    });
  });

  it('perRequestInputCap is the min of maxInputTokensPerRequest and the saved TPM', () => {
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [endpoint({ maxInputTokensPerRequest: 8000 })],
      analyzerRateLimitsByModel: { 'openai:lab::qwen3-30b': { tpm: 6000 } },
    });
    expect(resolveCapacity({ engine: 'openai', model: 'openai:lab::qwen3-30b' }).perRequestInputCap).toBe(6000);
  });

  it('only the set cap counts (unset TPM is unlimited for endpoints)', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [endpoint({ maxInputTokensPerRequest: 8000 })], analyzerRateLimitsByModel: {} });
    expect(resolveCapacity({ engine: 'openai', model: 'openai:lab::qwen3-30b' }).perRequestInputCap).toBe(8000);
  });

  it('accepts a bare model with an explicit endpoint', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [], analyzerRateLimitsByModel: {} });
    expect(resolveCapacity({ engine: 'openai', model: 'qwen3-30b', endpoint: endpoint({ contextTokens: 4096 }) }).contextTokens).toBe(4096);
  });

  it('a manual max output is kept when no served limit is known', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [endpoint({ maxOutputTokens: 2048 })], analyzerRateLimitsByModel: {} });
    expect(resolveCapacity({ engine: 'openai', model: 'openai:lab::qwen3-30b' }).maxOutputTokens).toBe(2048);
  });

  it('a missing endpoint throws AnalyzerEndpointMissingError', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [], analyzerRateLimitsByModel: {} });
    expect(() => resolveCapacity({ engine: 'openai', model: 'openai:gone::m' })).toThrow(AnalyzerEndpointMissingError);
  });
});

describe('budgets for an endpoint capacity', () => {
  it.each([['Latin', LATIN], ['Cyrillic', CYRILLIC], ['CJK', CJK]])(
    'without a cap, %s budgets equal the Ollama formula at the same context',
    (_script, body) => {
      const ep = { family: 'context' as const, contextTokens: 32768, maxOutputTokens: null };
      const ollama = TODAY_LOCAL_CAPACITY(32768);
      expect(resolveStage1ChunkCharBudget(ep, body)).toBe(resolveStage1ChunkCharBudget(ollama, body));
      expect(resolveStage2ChunkCharBudget(ep, body)).toBe(resolveStage2ChunkCharBudget(ollama, body));
      expect(chapterChunkBudget(ep, 500, body, 4000)).toBe(chapterChunkBudget(ollama, 500, body, 4000));
    },
  );

  it('a binding cap lowers the stage-2 budget to cloudBodyCharBudget at that cap', () => {
    const uncapped = { family: 'context' as const, contextTokens: 131072, maxOutputTokens: null };
    const capped = { ...uncapped, perRequestInputCap: 1500 };
    const expectedAtCap = cloudBodyCharBudgetForCap(1500, LATIN);
    expect(expectedAtCap).toBeLessThan(resolveStage2ChunkCharBudget(uncapped, LATIN));
    expect(resolveStage2ChunkCharBudget(capped, LATIN)).toBe(expectedAtCap);
  });

  it('a binding cap lowers stage 1 using stage 1 reservations, and chapter passes using the caller reservations', () => {
    const uncapped = { family: 'context' as const, contextTokens: 131072, maxOutputTokens: null };
    const capped = { ...uncapped, perRequestInputCap: 9000 };
    expect(resolveStage1ChunkCharBudget(capped, LATIN)).toBe(
      Math.min(resolveStage1ChunkCharBudget(uncapped, LATIN), cloudBodyCharBudgetForCap(9000, LATIN, 0, 7000)),
    );
    expect(resolveStage1ChunkCharBudget(capped, LATIN)).toBeLessThan(resolveStage1ChunkCharBudget(uncapped, LATIN));
    expect(chapterChunkBudget(capped, 1200, LATIN, 4000)).toBe(
      Math.min(chapterChunkBudget(uncapped, 1200, LATIN, 4000), cloudBodyCharBudgetForCap(9000, LATIN, 1200, 4000)),
    );
  });

  it.each([['Latin', LATIN], ['Cyrillic', CYRILLIC], ['CJK', CJK]])(
    'cloudBodyCharBudget is byte-identical to cloudBodyCharBudgetForCap at the knob cap (%s)',
    (_script, body) => {
      expect(cloudBodyCharBudget(body, 300, 7000)).toBe(cloudBodyCharBudgetForCap(resolveMaxInputTokensPerRequest(), body, 300, 7000));
    },
  );
});
