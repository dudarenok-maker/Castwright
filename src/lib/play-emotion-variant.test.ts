/* fe-31 (#506) — the manuscript-chip emotion-variant preview helper. Verifies
   the cache scope it auditions: the variant's own scope when designed, the base
   scope (with a fellBackToBase flag) when not. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const playSampleWithAutoLoad = vi.fn().mockResolvedValue({ analyzerEvicted: false });
vi.mock('./play-sample-with-auto-load', () => ({
  playSampleWithAutoLoad: (...args: unknown[]) => playSampleWithAutoLoad(...args),
}));

import { playEmotionVariantSample, variantVoiceIdFor } from './play-emotion-variant';
import type { Character } from './types';

const baseChar = {
  id: 'marrow',
  name: 'Marrow Todd',
  role: 'PoV',
  color: 'narrator',
  voiceId: 'marrow',
  ttsEngine: 'qwen',
  overrideTtsVoices: { qwen: { name: 'qwen-marrow' } },
} as unknown as Character;

const playback = { play: vi.fn().mockResolvedValue(undefined) };

beforeEach(() => {
  vi.clearAllMocks();
  playSampleWithAutoLoad.mockResolvedValue({ analyzerEvicted: false });
});

describe('variantVoiceIdFor', () => {
  it('returns the designed variant voiceId for an emotion', () => {
    const c = {
      ...baseChar,
      overrideTtsVoices: {
        qwen: { name: 'qwen-marrow', variants: { angry: { name: 'qwen-marrow-angry' } } },
      },
    } as unknown as Character;
    expect(variantVoiceIdFor(c, 'angry')).toBe('qwen-marrow-angry');
    expect(variantVoiceIdFor(c, 'sad')).toBeUndefined();
  });

  it('returns undefined when no variants exist', () => {
    expect(variantVoiceIdFor(baseChar, 'angry')).toBeUndefined();
  });
});

describe('playEmotionVariantSample', () => {
  it('plays the variant scope when the emotion variant exists', async () => {
    const c = {
      ...baseChar,
      overrideTtsVoices: {
        qwen: { name: 'qwen-marrow', variants: { angry: { name: 'qwen-marrow-angry' } } },
      },
    } as unknown as Character;

    const res = await playEmotionVariantSample(c, 'angry', playback);

    expect(res.fellBackToBase).toBe(false);
    const args = playSampleWithAutoLoad.mock.calls[0][0].args;
    /* Scope is the variant cache key the design route wrote. */
    expect(args.voiceId).toBe('marrow__angry');
    expect(args.voice.overrideTtsVoices.qwen.name).toBe('qwen-marrow-angry');
    expect(args.modelKey).toBe('qwen3-tts-0.6b');
  });

  it('falls back to the base scope + voice when the emotion variant is missing', async () => {
    const res = await playEmotionVariantSample(baseChar, 'sad', playback);

    expect(res.fellBackToBase).toBe(true);
    const args = playSampleWithAutoLoad.mock.calls[0][0].args;
    /* Base scope (no __emotion suffix) + the base designed voice. */
    expect(args.voiceId).toBe('marrow');
    expect(args.voice.overrideTtsVoices.qwen.name).toBe('qwen-marrow');
  });
});
