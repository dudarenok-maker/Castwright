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
    const cast = [qwenChar('wren')]; // no overrideTtsVoices.qwen
    const out = computeQwenKokoroFallbackSet(cast, 'qwen');
    expect(out).toEqual([{ id: 'wren', name: 'wren' }]);
  });

  it('excludes a Qwen character WITH a designed voice', () => {
    const cast = [qwenChar('wren', { overrideTtsVoices: { qwen: { name: 'qwen-wren' } } })];
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
    const cast = [qwenChar('hart', { overrideTtsVoice: { engine: 'qwen', name: 'qwen-hart' } })];
    expect(computeQwenKokoroFallbackSet(cast, 'qwen')).toEqual([]);
  });

  it('returns a stable id-sorted list across multiple fallbacks', () => {
    const cast = [qwenChar('zelda'), qwenChar('varek'), qwenChar('edda')];
    expect(computeQwenKokoroFallbackSet(cast, 'qwen').map((c) => c.id)).toEqual([
      'edda',
      'varek',
      'zelda',
    ]);
  });

  it('is empty for an all-designed cast (the healthy case — no gate)', () => {
    const cast = [
      qwenChar('wren', { overrideTtsVoices: { qwen: { name: 'qwen-wren' } } }),
      qwenChar('marlow', { overrideTtsVoices: { qwen: { name: 'qwen-marlow' } } }),
    ];
    expect(computeQwenKokoroFallbackSet(cast, 'qwen')).toEqual([]);
  });
});
