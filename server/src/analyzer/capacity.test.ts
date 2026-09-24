/* #3084 wave 2 — EngineCapacity resolution (spec §6). Ollama: context family,
   num_ctx as sent, no /api/show clamp. Gemini: request-cap family,
   perRequestInputCap = min(analyzer.gemini.maxInputTokensPerRequest, model TPM)
   (#3084 wave 2b). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveCapacity, resolveGeminiMaxOutputTokens, TODAY_LOCAL_CAPACITY, GEMINI_FALLBACK_MAX_OUTPUT_TOKENS } from './capacity.js';
import { resolveStage1ChunkCharBudget } from './stage1-chunk.js';
import { listGeminiModels, _resetGeminiCatalogForTest, type GeminiModelsClient } from './catalog/gemini-catalog.js';
import { allKnobs } from '../config/registry.js';
import { coerceAndValidate } from '../config/resolver.js';

const ENV = ['ANALYZER_NUM_CTX', 'ANALYZER_MAX_INPUT_TOKENS_PER_REQUEST', 'GEMINI_TPM_GEMINI_3_5_FLASH_LITE', 'GEMINI_TPM_GEMMA_4_31B_IT'];
afterEach(() => {
  for (const name of ENV) delete process.env[name];
});

const catalogClient = (models: object[]): GeminiModelsClient =>
  ({
    models: {
      list: vi.fn(async () =>
        (async function* () {
          yield* models;
        })(),
      ),
    },
  }) as unknown as GeminiModelsClient;
const FLASH = { name: 'models/gemini-3.6-flash', supportedActions: ['generateContent'], inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, thinking: true };

describe('resolveCapacity — Ollama', () => {
  it('is the context family with num_ctx exactly as sent and no output limit', () => {
    expect(resolveCapacity({ engine: 'local', model: 'qwen3.5:4b' })).toEqual({
      family: 'context',
      contextTokens: 32768,
      maxOutputTokens: null,
    });
  });

  it('follows analyzer.ollama.numCtx (no clamp to a model native context)', () => {
    process.env.ANALYZER_NUM_CTX = '8192';
    expect(resolveCapacity({ engine: 'local', model: 'qwen3.5:4b' }).contextTokens).toBe(8192);
  });

  it('TODAY_LOCAL_CAPACITY defaults to the live knob and accepts an explicit num_ctx', () => {
    expect(TODAY_LOCAL_CAPACITY()).toEqual(resolveCapacity({ engine: 'local', model: 'qwen3.5:4b' }));
    expect(TODAY_LOCAL_CAPACITY(16384).contextTokens).toBe(16384);
  });
});

describe('resolveCapacity — Gemini', () => {
  it('is the request-cap family at the 12000 default cap', () => {
    expect(resolveCapacity({ engine: 'gemini', model: 'gemini-3.5-flash-lite' })).toEqual({
      family: 'requestCap',
      contextTokens: 12000,
      maxOutputTokens: GEMINI_FALLBACK_MAX_OUTPUT_TOKENS,
      perRequestInputCap: 12000,
    });
  });

  it('every model gets the 12000 default cap', () => {
    for (const model of [
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3-flash-preview',
      'gemini-2.5-flash',
      'gemma-4-31b-it',
      'gemma-4-26b-a4b-it',
      'some-unlisted-model',
    ]) {
      expect(resolveCapacity({ engine: 'gemini', model }).perRequestInputCap, model).toBe(12000);
    }
  });

  it('follows analyzer.gemini.maxInputTokensPerRequest', () => {
    process.env.ANALYZER_MAX_INPUT_TOKENS_PER_REQUEST = '6000';
    expect(resolveCapacity({ engine: 'gemini', model: 'gemini-3.5-flash-lite' }).perRequestInputCap).toBe(6000);
  });

  it('a model TPM below the cap binds the per-request input cap (min, not the cap alone)', () => {
    process.env.GEMINI_TPM_GEMMA_4_31B_IT = '8000';
    expect(resolveCapacity({ engine: 'gemini', model: 'gemma-4-31b-it' }).perRequestInputCap).toBe(8000);
  });

  it('an unlimited TPM (0) leaves the cap in charge', () => {
    process.env.GEMINI_TPM_GEMMA_4_31B_IT = '0';
    expect(resolveCapacity({ engine: 'gemini', model: 'gemma-4-31b-it' }).perRequestInputCap).toBe(12000);
  });

  it('the TPM bound reaches the stage-1 body budget', () => {
    const body = 'a'.repeat(200_000);
    const atCap = resolveStage1ChunkCharBudget(resolveCapacity({ engine: 'gemini', model: 'gemma-4-31b-it' }), body);
    process.env.GEMINI_TPM_GEMMA_4_31B_IT = '8000';
    const atTpm = resolveStage1ChunkCharBudget(resolveCapacity({ engine: 'gemini', model: 'gemma-4-31b-it' }), body);
    expect(atTpm).toBeLessThan(atCap);
  });
});

describe('analyzer.gemini.maxOutputTokens knob (#3084 wave 2b)', () => {
  it('defaults to 0 = Auto, accepts 0, and lifts the max to 1048576', () => {
    const knob = allKnobs().find((k) => k.key === 'analyzer.gemini.maxOutputTokens')!;
    expect(knob).toMatchObject({ env: 'ANALYZER_MAX_OUTPUT_TOKENS', type: 'integer', min: 0, max: 1_048_576, default: 0 });
    expect(coerceAndValidate(knob, '0').ok).toBe(true);
    expect(coerceAndValidate(knob, '65536').ok).toBe(true);
  });
});

describe('analyzer.gemini.maxInputTokensPerRequest knob — max lifted for the TPM bound (#3084 wave 2b, F1)', () => {
  afterEach(() => {
    delete process.env.ANALYZER_MAX_INPUT_TOKENS_PER_REQUEST;
  });

  it('keeps its 12000 default and 1000 minimum, but now accepts up to 1000000', () => {
    const knob = allKnobs().find((k) => k.key === 'analyzer.gemini.maxInputTokensPerRequest')!;
    expect(knob).toMatchObject({
      env: 'ANALYZER_MAX_INPUT_TOKENS_PER_REQUEST',
      type: 'integer',
      min: 1000,
      max: 1_000_000,
      default: 12000,
    });
    expect(coerceAndValidate(knob, '1000000').ok).toBe(true);
    expect(coerceAndValidate(knob, '1000001').ok).toBe(false);
  });

  it('a saved value above the OLD 60000 ceiling is accepted, and is still bounded by the model TPM', () => {
    /* F1: lifting the registry max alone would let an operator size bodies
       past a model's real per-minute limit. This pins that the NEW ceiling
       cannot bypass the TPM bound Task 2.6 just added: a saved value of
       200000 on a model whose TPM is 16000 still yields the smaller cap. */
    process.env.ANALYZER_MAX_INPUT_TOKENS_PER_REQUEST = '200000';
    expect(resolveCapacity({ engine: 'gemini', model: 'gemma-4-31b-it' }).perRequestInputCap).toBe(16_000);
  });
});

describe('resolveGeminiMaxOutputTokens (#3084 wave 2b)', () => {
  beforeEach(() => {
    _resetGeminiCatalogForTest();
    delete process.env.ANALYZER_MAX_OUTPUT_TOKENS;
  });
  afterEach(() => {
    delete process.env.ANALYZER_MAX_OUTPUT_TOKENS;
  });

  it('Auto with no catalog entry → 8192', () => {
    expect(resolveGeminiMaxOutputTokens('gemini-3.6-flash')).toBe(8192);
  });

  it('Auto → the listed outputTokenLimit', async () => {
    await listGeminiModels('k', { client: catalogClient([FLASH]) });
    expect(resolveGeminiMaxOutputTokens('gemini-3.6-flash')).toBe(65_536);
  });

  it('an explicit value keeps its meaning', async () => {
    await listGeminiModels('k', { client: catalogClient([FLASH]) });
    process.env.ANALYZER_MAX_OUTPUT_TOKENS = '8192';
    expect(resolveGeminiMaxOutputTokens('gemini-3.6-flash')).toBe(8192);
  });

  it('an explicit value above the listed limit is clamped to it', async () => {
    await listGeminiModels('k', { client: catalogClient([FLASH]) });
    process.env.ANALYZER_MAX_OUTPUT_TOKENS = '100000';
    expect(resolveGeminiMaxOutputTokens('gemini-3.6-flash')).toBe(65_536);
  });

  it('an explicit value passes through when the limit is unknown', () => {
    process.env.ANALYZER_MAX_OUTPUT_TOKENS = '100000';
    expect(resolveGeminiMaxOutputTokens('gemini-3.6-flash')).toBe(100_000);
  });

  it('resolveCapacity reports the listed limits but keeps sizing bodies to the request cap', async () => {
    await listGeminiModels('k', { client: catalogClient([FLASH]) });
    expect(resolveCapacity({ engine: 'gemini', model: 'gemini-3.6-flash' })).toEqual({
      family: 'requestCap',
      contextTokens: 1_048_576,
      maxOutputTokens: 65_536,
      perRequestInputCap: 12000,
    });
  });
});
