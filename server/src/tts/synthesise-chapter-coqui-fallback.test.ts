/* fs-60 — Qwen → Coqui graceful fallback for non-English books. Mirrors the
   structure of the existing "Qwen→Kokoro graceful fallback" and
   "forbidKokoroFallback" describe blocks in synthesise-chapter.test.ts — this
   is the Coqui-eligible-language counterpart to the still-unsupported-language
   fail-loud case those blocks already pin. */
import { describe, it, expect } from 'vitest';
import { synthesiseChapter, MissingDesignedVoiceError, type CastCharacter } from './synthesise-chapter.js';
import type { SentenceOutput } from '../handoff/schemas.js';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from './index.js';

const COQUI_VOICE_RE = /^[A-Z][a-z]+ [A-Z][a-z]+$/; // "Claribel Dervla"-shaped catalog names

function makeProvider(): TtsProvider & { calls: SynthesizeInput[] } {
  const calls: SynthesizeInput[] = [];
  return {
    calls,
    async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
      calls.push(input);
      return { pcm: Buffer.alloc(2), sampleRate: 24000, mimeType: 'audio/pcm' };
    },
  };
}

function sentence(id: number, characterId = 'wren'): SentenceOutput {
  return { id, chapterId: 1, characterId, text: 'Привет, это тестовое предложение для проверки.' };
}

function multiEngine() {
  const qwen = makeProvider();
  const coqui = makeProvider();
  const resolveForEngine = (e: string) =>
    e === 'coqui'
      ? { provider: coqui, modelKey: 'coqui-xtts-v2' as const }
      : { provider: qwen, modelKey: 'qwen3-tts-0.6b' as const };
  return { qwen, coqui, resolveForEngine };
}

describe('synthesiseChapter — Qwen→Coqui fallback (fs-60)', () => {
  it('falls an undesigned Qwen character back to Coqui when coquiEligible + forbidKokoroFallback', async () => {
    const cast: CastCharacter[] = [{ id: 'wren', name: 'Wren', gender: 'female' }];
    const { qwen, coqui, resolveForEngine } = multiEngine();

    const result = await synthesiseChapter({
      sentences: [sentence(1)],
      cast,
      provider: qwen,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      resolveForEngine,
      forbidKokoroFallback: true,
      coquiEligible: true,
      bookLanguage: 'ru',
    });

    expect(qwen.calls).toHaveLength(0);
    expect(coqui.calls).toHaveLength(1);
    expect(coqui.calls[0].voiceName).toMatch(COQUI_VOICE_RE);
    expect(coqui.calls[0].language).toBe('ru');
    const body = result.segments.find((s) => s.kind !== 'title');
    expect(body?.renderedFallbackEngine).toBe('coqui');
  });

  it('still throws MissingDesignedVoiceError when coquiEligible is false (still-unsupported language)', async () => {
    const cast: CastCharacter[] = [{ id: 'wren', name: 'Wren', gender: 'female' }];
    const { qwen, coqui, resolveForEngine } = multiEngine();

    await expect(
      synthesiseChapter({
        sentences: [sentence(1)],
        cast,
        provider: qwen,
        modelKey: 'qwen3-tts-0.6b',
        engine: 'qwen',
        resolveForEngine,
        forbidKokoroFallback: true,
        coquiEligible: false,
        bookLanguage: 'zh',
      }),
    ).rejects.toBeInstanceOf(MissingDesignedVoiceError);

    expect(qwen.calls).toHaveLength(0);
    expect(coqui.calls).toHaveLength(0);
  });

  it('does NOT fall back a designed Qwen voice when the engine is available, even if coquiEligible', async () => {
    const cast: CastCharacter[] = [
      { id: 'marlow', name: 'Marlow', gender: 'male', overrideTtsVoices: { qwen: { name: 'qwen-marlow' } } },
    ];
    const { qwen, coqui, resolveForEngine } = multiEngine();

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'marlow')],
      cast,
      provider: qwen,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      resolveForEngine,
      forbidKokoroFallback: true,
      coquiEligible: true,
      bookLanguage: 'ru',
    });

    expect(qwen.calls).toHaveLength(1);
    expect(coqui.calls).toHaveLength(0);
    const body = result.segments.find((s) => s.kind !== 'title');
    expect(body?.renderedFallbackEngine).toBeUndefined();
  });
});
