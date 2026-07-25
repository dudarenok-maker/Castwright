/* fs-38 Wave 3b1 — the C1 never-substitute guard. A cloned-provenance Qwen
   group must RAISE (not reroute) when Qwen is unavailable — and provably
   render on no other voice (guard the placebo trap). */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  synthesiseChapter,
  UnresolvableClonedVoiceError,
  type CastCharacter,
} from './synthesise-chapter.js';
import type { SentenceOutput } from '../handoff/schemas.js';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from './index.js';

afterEach(() => vi.restoreAllMocks());

function makeProvider(): TtsProvider & { calls: SynthesizeInput[] } {
  const calls: SynthesizeInput[] = [];
  return {
    calls,
    async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
      calls.push(input);
      return { pcm: Buffer.alloc(4800, 0), sampleRate: 24000, mimeType: 'audio/pcm' };
    },
  };
}
function sentence(id: number, characterId = 'wren'): SentenceOutput {
  return { id, chapterId: 1, characterId, text: 'Hello, this is an English test sentence.' };
}
function multiEngine() {
  const qwen = makeProvider();
  const kokoro = makeProvider();
  const resolveForEngine = (e: string) =>
    e === 'kokoro'
      ? { provider: kokoro, modelKey: 'kokoro-v1' as const }
      : { provider: qwen, modelKey: 'qwen3-tts-0.6b' as const };
  return { qwen, kokoro, resolveForEngine };
}
const clonedCast: CastCharacter[] = [
  {
    id: 'wren',
    name: 'Wren',
    gender: 'female',
    /* M3 — `name` deliberately does NOT equal `qwen-${libraryUuid}`, so the
       voiceName assertion below can't pass by coincidence. pickVoiceForEngine
       (`../voice-mapping.ts`, ~line 338-340) resolves a library-assigned qwen
       slot to `qwen-${libraryUuid}` and ignores this `name` field entirely
       once `libraryUuid` is set — confirmed against the real code path (the
       same slot shape `synthesise-chapter-coqui-fallback.test.ts`'s designed-
       voice case uses, minus libraryUuid there). */
    overrideTtsVoices: { qwen: { name: 'Wren (display name, unused)', libraryUuid: 'lib-clone', provenance: 'cloned' } },
  },
];

describe('applyQwenFallback — cloned exemption (C1)', () => {
  it('raises UnresolvableClonedVoiceError when a cloned voice + Qwen is unavailable, rendering on NO other voice', async () => {
    const { qwen, kokoro, resolveForEngine } = multiEngine();
    await expect(
      synthesiseChapter({
        sentences: [sentence(1)],
        cast: clonedCast,
        provider: qwen,
        modelKey: 'qwen3-tts-0.6b',
        engine: 'qwen',
        resolveForEngine,
        qwenUnavailable: true,
      }),
    ).rejects.toBeInstanceOf(UnresolvableClonedVoiceError);
    expect(qwen.calls).toHaveLength(0);
    expect(kokoro.calls).toHaveLength(0); // never substituted
  });

  it('renders a cloned voice normally when Qwen is available (no throw)', async () => {
    const { qwen, kokoro, resolveForEngine } = multiEngine();
    const result = await synthesiseChapter({
      sentences: [sentence(1)],
      cast: clonedCast,
      provider: qwen,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      resolveForEngine,
      qwenUnavailable: false,
    });
    expect(qwen.calls).toHaveLength(1);
    // Derived as `qwen-${libraryUuid}` (pickVoiceForEngine), NOT the slot's `name` field.
    expect(qwen.calls[0].voiceName).toBe('qwen-lib-clone');
    expect(kokoro.calls).toHaveLength(0);
    const body = result.segments.find((s) => s.kind !== 'title');
    expect(body?.renderedFallbackEngine).toBeUndefined();
  });

  it('still reroutes a NON-cloned voice to Kokoro when Qwen is unavailable (unchanged)', async () => {
    const { qwen, kokoro, resolveForEngine } = multiEngine();
    const cast: CastCharacter[] = [
      { id: 'wren', name: 'Wren', gender: 'female', overrideTtsVoices: { qwen: { name: 'qwen-wren' } } },
    ];
    const result = await synthesiseChapter({
      sentences: [sentence(1)],
      cast,
      provider: qwen,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      resolveForEngine,
      qwenUnavailable: true,
    });
    expect(qwen.calls).toHaveLength(0);
    expect(kokoro.calls).toHaveLength(1);
    const body = result.segments.find((s) => s.kind !== 'title');
    expect(body?.renderedFallbackEngine).toBe('kokoro');
  });
});
