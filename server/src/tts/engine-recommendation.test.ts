import { describe, it, expect } from 'vitest';
import { recommendEngines, isMultilingualEngine } from './engine-recommendation.js';

describe('isMultilingualEngine', () => {
  it('derives multilingual from ENGINE_LANGUAGE_SUPPORT', () => {
    expect(isMultilingualEngine('qwen')).toBe(true); // support '*'
    expect(isMultilingualEngine('coqui')).toBe(true); // ['en','ru',…]
    expect(isMultilingualEngine('kokoro')).toBe(false); // ['en'] only
  });
});

describe('recommendEngines', () => {
  it('simple-english → Kokoro always, no caveat, regardless of VRAM', () => {
    for (const vram of [null, 512, 8192, 24576]) {
      const r = recommendEngines(vram).simpleEnglish;
      expect(r.engine).toBe('kokoro');
      expect(r.modelKey).toBe('kokoro-v1');
      expect(r.caveat).toBeNull();
      expect(r.alternate).toBeNull();
    }
  });

  it('need + adequate VRAM (>= Qwen floor) → Qwen, Coqui alternate, no caveat', () => {
    const r = recommendEngines(8192).expressiveOrMultilingual;
    expect(r.engine).toBe('qwen');
    expect(r.modelKey).toBe('qwen3-tts-0.6b');
    expect(r.alternate).toBe('coqui');
    expect(r.caveat).toBeNull();
  });

  it('need + low VRAM (< Qwen floor) → Qwen with CPU caveat (never downgraded to Kokoro)', () => {
    const r = recommendEngines(4096).expressiveOrMultilingual;
    expect(r.engine).toBe('qwen');
    expect(r.caveat).toMatch(/may not fit/i);
    expect(r.caveat).toMatch(/CPU/i); // caveat offers the CPU-mode escape hatch
  });

  it('need + CPU-only (vram null) → Qwen with CPU caveat, still not Kokoro (deliberate case-4 revision)', () => {
    const r = recommendEngines(null).expressiveOrMultilingual;
    expect(r.engine).toBe('qwen');
    expect(r.caveat).toMatch(/may not fit/i);
  });

  it('need + VRAM exactly at Qwen floor (6144) → fits, no caveat (>= boundary is inclusive)', () => {
    const r = recommendEngines(6144).expressiveOrMultilingual;
    expect(r.engine).toBe('qwen');
    expect(r.caveat).toBeNull();
  });
});
