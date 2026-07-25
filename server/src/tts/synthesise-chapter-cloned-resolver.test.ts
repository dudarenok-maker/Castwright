/* fs-38 Wave 3b2, Task 6 — the async cloned-voice resolver pre-pass wired
   into `synthesiseChapter`. Drives the REAL `synthesiseChapter` with a fake
   synth backend (records every call) and a fake resolver dep set (no real
   disk/sidecar), proving three invariants:

     1. fail-fast: a Broken (revoked) cloned voice aborts the WHOLE chapter
        BEFORE any synth call fires — never a silent substitution.
     2. readiness gate: a cloned voice whose character doesn't speak in this
        chapter (not in `groups`, no title beat) is never even looked at.
     3. repairable: a cloned voice with a stale/missing `.pt` but a retained
        `master.wav` re-derives once, then the chapter synthesises normally.
     4. readiness gate, orphaned-characterId narrator path (Task 6 review,
        IMPORTANT-1): the gate also catches a cloned narrator that only
        renders via the orphaned-characterId safety net (resolveGroup's
        `resolveNarratorChar()` fallback) — not just the title-beat trigger.

   See `synthesise-chapter-cloned-exemption.test.ts` for the sibling 3b1 C1
   coverage (Qwen-unavailable exemption), which this pre-pass sits in front
   of but does not replace — except that, per the Task 6 review, the pre-pass
   now fully subsumes C1 for every character `applyQwenFallback` sees (case 4
   above pins the last gap that let C1 stay reachable). */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { synthesiseChapter, type CastCharacter } from './synthesise-chapter.js';
import { UnresolvableClonedVoiceError, type ResolveChapterDeps } from './clone-voice-resolver.js';
import type { VoiceLibraryEntry } from '../workspace/voice-library.js';
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

function sentence(id: number, characterId: string): SentenceOutput {
  return { id, chapterId: 1, characterId, text: 'Hello, this is an English test sentence.' };
}

const clonedCast: CastCharacter[] = [
  {
    id: 'wren',
    name: 'Wren',
    gender: 'female',
    overrideTtsVoices: {
      qwen: { name: 'Wren (unused)', libraryUuid: 'lib-clone', provenance: 'cloned' },
    },
  },
];

function baseEntry(overrides: Partial<VoiceLibraryEntry> = {}): VoiceLibraryEntry {
  return {
    voiceUuid: 'lib-clone',
    name: 'Wren clone',
    provenance: 'cloned',
    tags: [],
    pinned: false,
    engines: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('synthesiseChapter — cloned-voice resolver pre-pass (fs-38 Wave 3b2)', () => {
  it('fail-fast: a revoked cloned voice aborts the chapter BEFORE any synth call', async () => {
    const provider = makeProvider();
    const revokedEntry = baseEntry({
      consent: {
        personName: 'Real Person',
        relationship: 'self',
        permittedUse: 'personal',
        attestedAt: '2026-01-01T00:00:00.000Z',
        attestedBy: 'Real Person',
        revokedAt: '2026-02-01T00:00:00.000Z', // revoked — must fail-fast
      },
    });
    const readEntry = vi.fn(async (uuid: string) => (uuid === 'lib-clone' ? revokedEntry : null));
    const deriveEngineArtifact = vi.fn();
    const writeEntry = vi.fn();
    const deps: Partial<ResolveChapterDeps> = {
      readEntry,
      writeEntry,
      ptExists: async () => true,
      deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveChapterDeps['deriveEngineArtifact'],
    };

    await expect(
      synthesiseChapter({
        sentences: [sentence(1, 'wren')],
        cast: clonedCast,
        provider,
        modelKey: 'qwen3-tts-0.6b',
        engine: 'qwen',
        cloneResolverDepsOverride: deps,
      }),
    ).rejects.toBeInstanceOf(UnresolvableClonedVoiceError);

    // The invariant, directly: NO synth call fired at all — no title beat,
    // no body-group synth. Placebo-proof: if the pre-pass were deleted, this
    // chapter would render normally on a stale-but-present provider call
    // count > 0 instead of rejecting.
    expect(provider.calls).toHaveLength(0);
    expect(readEntry).toHaveBeenCalledWith('lib-clone');
    expect(deriveEngineArtifact).not.toHaveBeenCalled();
  });

  it('readiness gate: a cloned voice whose character does not speak this chapter is never resolved', async () => {
    const provider = makeProvider();
    // Cast carries the SAME revoked voice as above, but this chapter's only
    // sentence belongs to 'other', not 'wren' — and there's no title beat,
    // so 'wren' never enters the pre-pass's in-chapter set. If the readiness
    // gate were removed, this readEntry would be called and throw,
    // deterministically failing the test differently (still failing) —
    // proving the gate is load-bearing, not merely untested.
    const readEntry = vi.fn(async () => {
      throw new Error('resolver must not run for a cloned voice absent from this chapter');
    });
    const cast: CastCharacter[] = [
      ...clonedCast,
      { id: 'other', name: 'Other', gender: 'male' },
    ];

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'other')],
      cast,
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      cloneResolverDepsOverride: { readEntry: readEntry as unknown as ResolveChapterDeps['readEntry'] },
    });

    expect(readEntry).not.toHaveBeenCalled();
    expect(provider.calls.length).toBeGreaterThan(0); // the chapter rendered normally
    expect(result.segments.length).toBeGreaterThan(0);
  });

  it('repairable: a cloned voice with a missing .pt but a retained master.wav re-derives once, then renders', async () => {
    const provider = makeProvider();
    const repairableEntry = baseEntry({
      master: {
        clipFile: 'master.wav',
        sampleRate: 24000,
        durationSeconds: 8,
        transcript: 'A retained reference clip.',
        transcriptSource: 'whisper',
        captureMethod: 'upload',
      },
    });
    const readEntry = vi.fn(async (uuid: string) => (uuid === 'lib-clone' ? repairableEntry : null));
    const writeEntry = vi.fn(async (_entry: VoiceLibraryEntry) => {});
    const readMasterPcm = vi.fn(async (_uuid: string, _entry: VoiceLibraryEntry) => ({
      pcm: Buffer.alloc(1000),
      sampleRate: 24000,
      refText: 'A retained reference clip.',
    }));
    const deriveEngineArtifact = vi.fn(async (..._args: unknown[]) => ({
      previewPcm: Buffer.alloc(10),
      sampleRate: 24000,
      baseModel: 'qwen3-tts-0.6b',
    }));

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'wren')],
      cast: clonedCast,
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      cloneResolverDepsOverride: {
        readEntry,
        writeEntry,
        ptExists: async () => false, // missing — triggers repairable, not healthy
        readMasterPcm,
        deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveChapterDeps['deriveEngineArtifact'],
        currentBaseModel: () => 'qwen3-tts-0.6b',
      },
    });

    expect(deriveEngineArtifact).toHaveBeenCalledTimes(1);
    expect(readMasterPcm).toHaveBeenCalledWith('lib-clone', repairableEntry);
    expect(writeEntry).toHaveBeenCalledTimes(1);
    const written = writeEntry.mock.calls[0][0] as VoiceLibraryEntry;
    expect(written.engines.qwen?.status).toBe('ready');
    expect(provider.calls.length).toBeGreaterThan(0); // then the chapter synthesises normally
    expect(result.segments.length).toBeGreaterThan(0);
  });

  it('IMPORTANT-1 (Task 6 review): an orphaned-characterId sentence pulls a cloned narrator into the readiness gate even with no title beat', async () => {
    // 'ghost' is deliberately absent from `cast` — the orphaned-characterId
    // safety net in resolveGroup() substitutes resolveNarratorChar() for
    // this line. There is NO chapterTitleNarration, so before the
    // IMPORTANT-1 fix the narrator's characterId was never added to the
    // pre-pass's in-chapter set for this chapter, and a cloned-but-stale
    // narrator voice would render past the gate untouched.
    const provider = makeProvider();
    const narratorCast: CastCharacter[] = [
      {
        id: 'narrator',
        name: 'Narrator',
        overrideTtsVoices: {
          qwen: { name: 'Narrator (unused)', libraryUuid: 'lib-narrator-clone', provenance: 'cloned' },
        },
      },
    ];
    const readEntry = vi.fn(async (uuid: string) =>
      uuid === 'lib-narrator-clone' ? baseEntry({ voiceUuid: 'lib-narrator-clone' }) : null,
    );
    const deriveEngineArtifact = vi.fn();

    await expect(
      synthesiseChapter({
        sentences: [sentence(1, 'ghost')],
        cast: narratorCast,
        provider,
        modelKey: 'qwen3-tts-0.6b',
        engine: 'qwen',
        // Global Qwen-unavailable, same as the C1 exemption tests — this is
        // the condition that must reach EITHER the pre-pass's
        // 'engine-unavailable' classification OR (pre-fix)
        // applyQwenFallback's C1 throw. It must reach one of the two, never
        // silently render.
        qwenUnavailable: true,
        cloneResolverDepsOverride: {
          readEntry,
          deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveChapterDeps['deriveEngineArtifact'],
        },
      }),
    ).rejects.toBeInstanceOf(UnresolvableClonedVoiceError);

    // Placebo-proof: NO synth call at all, and the resolver DID look up the
    // narrator's cloned entry — proving the gate (not some unrelated path)
    // caught this. Reverting the IMPORTANT-1 fix makes this test fail: the
    // chapter renders the 'ghost' line on the narrator's stale cloned voice
    // via applyQwenFallback instead of rejecting (see task report for the
    // revert-and-confirm-fail verification).
    expect(provider.calls).toHaveLength(0);
    expect(readEntry).toHaveBeenCalledWith('lib-narrator-clone');
    expect(deriveEngineArtifact).not.toHaveBeenCalled();
  });
});
