/* #3084 wave 2 — EngineCapacity resolution (spec §6). Ollama: context family,
   num_ctx as sent, no /api/show clamp. Gemini: request-cap family,
   perRequestInputCap = analyzer.gemini.maxInputTokensPerRequest (PR 2a keeps
   today's value; PR 2b bounds it by the model's TPM). */
import { describe, it, expect, afterEach } from 'vitest';
import { resolveCapacity, TODAY_LOCAL_CAPACITY, GEMINI_FALLBACK_MAX_OUTPUT_TOKENS } from './capacity.js';

const ENV = ['ANALYZER_NUM_CTX', 'ANALYZER_MAX_INPUT_TOKENS_PER_REQUEST', 'GEMINI_TPM_GEMINI_3_5_FLASH_LITE'];
afterEach(() => {
  for (const name of ENV) delete process.env[name];
});

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

  it("a model TPM below the cap does NOT move the cap in this PR (the TPM bound is PR 2b's)", () => {
    process.env.GEMINI_TPM_GEMINI_3_5_FLASH_LITE = '8000';
    expect(resolveCapacity({ engine: 'gemini', model: 'gemini-3.5-flash-lite' }).perRequestInputCap).toBe(12000);
  });
});
