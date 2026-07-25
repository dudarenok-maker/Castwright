/* fs-38 Wave 3b1 — the C1 never-substitute guard. A cloned-provenance Qwen
   group must RAISE (not reroute) when Qwen is unavailable — and provably
   render on no other voice (guard the placebo trap).

   fs-38 Wave 3b2 note: `synthesiseChapter` now runs an async cloned-voice
   resolver pre-pass (clone-voice-resolver.ts) before any synth call. Left
   unfed, that pre-pass would try to `readEntry('lib-clone')` against the
   REAL on-disk voice library (which has no such entry in this worktree) and
   fail every cloned-voice test here with 'misconfigured' regardless of what
   they're actually testing. `cloneResolverDepsOverride` fakes a HEALTHY
   'lib-clone' entry so these tests keep exercising exactly the C1 exemption
   behaviour they were written for — see
   `synthesise-chapter-cloned-resolver.test.ts` for the resolver pre-pass's
   own dedicated coverage (revoked/readiness-gate/repairable). */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  synthesiseChapter,
  UnresolvableClonedVoiceError,
  type CastCharacter,
} from './synthesise-chapter.js';
import type { ResolveChapterDeps } from './clone-voice-resolver.js';
import type { VoiceLibraryEntry } from '../workspace/voice-library.js';
import type { SentenceOutput } from '../handoff/schemas.js';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from './index.js';

afterEach(() => vi.restoreAllMocks());

/** A healthy cloned voice-library entry for 'lib-clone' — no consent
    revocation, and (paired with `ptExists: async () => true` below) no
    derive needed, so `classifyClonedVoice` resolves it to 'healthy' and the
    pre-pass is a no-op for these tests. */
function healthyClonedEntry(uuid: string): VoiceLibraryEntry {
  return {
    voiceUuid: uuid,
    name: 'Wren clone',
    provenance: 'cloned',
    tags: [],
    pinned: false,
    engines: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function fakeCloneResolverDeps(uuid: string): Partial<ResolveChapterDeps> {
  return {
    readEntry: async (u) => (u === uuid ? healthyClonedEntry(uuid) : null),
    ptExists: async () => true,
  };
}

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
        cloneResolverDepsOverride: fakeCloneResolverDeps('lib-clone'),
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
      cloneResolverDepsOverride: fakeCloneResolverDeps('lib-clone'),
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
