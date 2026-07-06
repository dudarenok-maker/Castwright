import { describe, it, expect } from 'vitest';
import { resolveCharacterEngine, computeUsedQwenTiers } from './per-character-engine.js';

describe('resolveCharacterEngine (plan 108)', () => {
  it('uses the character ttsEngine when set', () => {
    expect(resolveCharacterEngine({ ttsEngine: 'qwen' }, 'kokoro')).toBe('qwen');
  });

  it('falls back to the run default when ttsEngine is absent (back-compat)', () => {
    expect(resolveCharacterEngine({}, 'kokoro')).toBe('kokoro');
    expect(resolveCharacterEngine({ ttsEngine: null }, 'coqui')).toBe('coqui');
  });
});

describe('computeUsedQwenTiers — run-start VRAM hygiene precompute (side-11 follow-up)', () => {
  it('never reports a downgraded tier: a run started at 1.7B with stale-0.6B characters still keeps only 1.7B', () => {
    const cast = [
      { ttsEngine: 'qwen' as const, ttsModelKey: 'qwen3-tts-0.6b' as const },
      { ttsEngine: 'qwen' as const, ttsModelKey: 'qwen3-tts-0.6b' as const },
    ];
    // Regenerating at 1.7B (higherQwenTier elevates both characters), so the
    // precompute must NOT evict the 1.7B tier routeFor is about to request.
    expect(computeUsedQwenTiers(cast, 'qwen', 'qwen3-tts-1.7b')).toEqual({
      keep06: false,
      keep17: true,
    });
  });

  it('keeps both tiers for a genuinely mixed-tier cast', () => {
    const cast = [
      { ttsEngine: 'qwen' as const, ttsModelKey: 'qwen3-tts-1.7b' as const }, // elevated
      { ttsEngine: 'qwen' as const }, // no override → stays on the run default
    ];
    expect(computeUsedQwenTiers(cast, 'qwen', 'qwen3-tts-0.6b')).toEqual({
      keep06: true,
      keep17: true,
    });
  });

  it('ignores non-Qwen characters entirely', () => {
    const cast = [{ ttsEngine: 'kokoro' as const, ttsModelKey: 'qwen3-tts-1.7b' as const }];
    expect(computeUsedQwenTiers(cast, 'qwen', 'qwen3-tts-0.6b')).toEqual({
      keep06: false,
      keep17: false,
    });
  });
});
