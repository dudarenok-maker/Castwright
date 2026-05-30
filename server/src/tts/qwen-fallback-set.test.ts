/* Per-chapter Qwen→Kokoro undesigned-voice fallback detection (loud fallback
 * gate). Pins the exact predicate the generation worker uses to decide whether
 * a chapter must pause for confirmation. */
import { describe, it, expect } from 'vitest';
import { computeQwenKokoroFallbackSet } from './qwen-fallback-set.js';
import type { CastCharacter } from './synthesise-chapter.js';

const qwenChar = (id: string, over: Partial<CastCharacter> = {}): CastCharacter => ({
  id,
  name: id,
  ttsEngine: 'qwen',
  ...over,
});

describe('computeQwenKokoroFallbackSet', () => {
  it('includes a Qwen character with NO designed voice', () => {
    const cast = [qwenChar('sophie')]; // no overrideTtsVoices.qwen
    const out = computeQwenKokoroFallbackSet(cast, 'qwen');
    expect(out).toEqual([{ id: 'sophie', name: 'sophie' }]);
  });

  it('excludes a Qwen character WITH a designed voice', () => {
    const cast = [qwenChar('sophie', { overrideTtsVoices: { qwen: { name: 'qwen-sophie' } } })];
    expect(computeQwenKokoroFallbackSet(cast, 'qwen')).toEqual([]);
  });

  it('excludes a non-Qwen character even with no voice', () => {
    const cast = [qwenChar('narrator', { ttsEngine: 'kokoro' })];
    expect(computeQwenKokoroFallbackSet(cast, 'qwen')).toEqual([]);
  });

  it('uses the run default engine for characters with no ttsEngine', () => {
    // default qwen + no per-char engine + no designed voice → falls back
    const cast: CastCharacter[] = [{ id: 'amy', name: 'Amy' }];
    expect(computeQwenKokoroFallbackSet(cast, 'qwen')).toEqual([{ id: 'amy', name: 'Amy' }]);
    // default kokoro → not a Qwen route at all
    expect(computeQwenKokoroFallbackSet(cast, 'kokoro')).toEqual([]);
  });

  it('honours the legacy singular overrideTtsVoice field', () => {
    const cast = [qwenChar('dex', { overrideTtsVoice: { engine: 'qwen', name: 'qwen-dex' } })];
    expect(computeQwenKokoroFallbackSet(cast, 'qwen')).toEqual([]);
  });

  it('returns a stable id-sorted list across multiple fallbacks', () => {
    const cast = [qwenChar('zelda'), qwenChar('alvar'), qwenChar('marella')];
    expect(computeQwenKokoroFallbackSet(cast, 'qwen').map((c) => c.id)).toEqual([
      'alvar',
      'marella',
      'zelda',
    ]);
  });

  it('is empty for an all-designed cast (the healthy case — no gate)', () => {
    const cast = [
      qwenChar('sophie', { overrideTtsVoices: { qwen: { name: 'qwen-sophie' } } }),
      qwenChar('keefe', { overrideTtsVoices: { qwen: { name: 'qwen-keefe' } } }),
    ];
    expect(computeQwenKokoroFallbackSet(cast, 'qwen')).toEqual([]);
  });
});
