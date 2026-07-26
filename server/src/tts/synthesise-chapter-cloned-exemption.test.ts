/* fs-38 Wave 3b1 — the C1 never-substitute guard: a cloned-provenance Qwen
   group must RAISE (not reroute) when Qwen is unavailable — and provably
   render on no other voice (guard the placebo trap).

   fs-38 Wave 3b2 note: `synthesiseChapter` now runs an async cloned-voice
   resolver pre-pass (clone-voice-resolver.ts) before any synth call. Left
   unfed, that pre-pass would try to `readEntry('lib-clone')` against the
   REAL on-disk voice library (which has no such entry in this worktree) and
   fail every cloned-voice test here with 'misconfigured' regardless of what
   they're actually testing. `cloneResolverDepsOverride` fakes a HEALTHY
   'lib-clone' entry so cases 2 and 3 below keep exercising exactly the
   behaviour they were written for — see `synthesise-chapter-cloned-resolver
   .test.ts` for the resolver pre-pass's own dedicated coverage
   (revoked/readiness-gate/repairable/orphan-narrator).

   Task-6-review correction (IMPORTANT-2): case 1 ("raises … when a cloned
   voice + Qwen is unavailable") no longer exercises `applyQwenFallback`'s C1
   throw — it now rejects at the pre-pass `await` instead, because the
   pre-pass's `engineUnavailable` input (`routedEngine !== 'qwen' ||
   qwenUnavailable`) is a strict superset of C1's own trigger condition and
   `classifyClonedVoice` treats it as broken unconditionally, regardless of
   the "healthy" entry `fakeCloneResolverDeps` feeds it. The assertions
   (rejects with `UnresolvableClonedVoiceError`, zero synth calls on either
   provider) still hold and are still worth pinning — they just now prove
   the pre-pass's `engine-unavailable` classification produces the same
   never-substitute outcome, not `applyQwenFallback`'s own branch. See the
   defence-in-depth comment on that branch in `synthesise-chapter.ts` (C1,
   `applyQwenFallback`) for why it's retained as an now-unreachable-in-
   production backstop, and `synthesise-chapter-cloned-resolver.test.ts`'s
   orphaned-narrator case for the test that actually pins the pre-pass
   catching this. */
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

/* Review I-3 — `applyQwenFallback`'s cloned exemption used to trigger ONLY
   on `qwenUnavailable`, not on the OTHER reason `needsFallback` can fire
   (`!voiceName`). The voice-mapping.ts half of this same review fix (moving
   the `libraryUuid` check ahead of the empty-`designedName` early-return)
   closes the one known way a cloned+libraryUuid slot could resolve to an
   empty voiceName today — which means, with BOTH halves of the fix applied,
   this branch is no longer reachable via the real `pickVoiceForEngine`
   (mirrors the sibling `qwenUnavailable` branch above, which the file header
   already documents as a "now unreachable in production" backstop once the
   resolver pre-pass fully subsumed it).

   To still prove THIS half's own logic in isolation — independent of
   whether the voice-mapping.ts half holds — this test substitutes
   `pickVoiceForEngine` itself (`vi.doMock` + a fresh dynamic import, the same
   pattern `ensure-sidecar-loaded.test.ts`'s withGpuLoad-gate suite uses) so a
   cloned character's voiceName resolves empty NO MATTER what
   `overrideTtsVoices.qwen` actually contains — simulating a future
   regression that reopens the empty-voiceName gap some other way. Before the
   `synthesise-chapter.ts` half of the I-3 fix, this scenario (cloned +
   healthy Qwen + empty voiceName) fell through the `qwenUnavailable`-only
   guard and rendered silently on Kokoro; this test fails before that fix. */
describe('review I-3 — applyQwenFallback throws for a cloned slot on EITHER needsFallback reason, not just qwenUnavailable', () => {
  afterEach(() => {
    vi.doUnmock('./voice-mapping.js');
    vi.resetModules();
  });

  it('a cloned character whose voiceName resolves empty (Qwen otherwise HEALTHY) still raises UnresolvableClonedVoiceError, never silently renders on Kokoro', async () => {
    vi.resetModules();
    vi.doMock('./voice-mapping.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./voice-mapping.js')>();
      return {
        ...actual,
        // Simulate a future regression re-opening the empty-voiceName gap
        // for a cloned qwen slot, regardless of what the real picker would
        // do today — everything else (kokoro/coqui picks, emotion variants)
        // stays real.
        pickVoiceForEngine: (engine: string, voice: unknown, hint?: unknown) =>
          engine === 'qwen' ? '' : actual.pickVoiceForEngine(engine as never, voice as never, hint as never),
      };
    });
    const {
      synthesiseChapter: synthesiseChapterFresh,
      UnresolvableClonedVoiceError: UnresolvableClonedVoiceErrorFresh,
    } = await import('./synthesise-chapter.js');

    const { qwen, kokoro, resolveForEngine } = multiEngine();
    await expect(
      synthesiseChapterFresh({
        sentences: [sentence(1)],
        cast: clonedCast,
        provider: qwen,
        modelKey: 'qwen3-tts-0.6b',
        engine: 'qwen',
        resolveForEngine,
        qwenUnavailable: false, // Qwen is HEALTHY — the old guard's only trigger
        cloneResolverDepsOverride: fakeCloneResolverDeps('lib-clone'),
      }),
    ).rejects.toBeInstanceOf(UnresolvableClonedVoiceErrorFresh);
    expect(qwen.calls).toHaveLength(0);
    expect(kokoro.calls).toHaveLength(0); // never silently substituted
  });
});
