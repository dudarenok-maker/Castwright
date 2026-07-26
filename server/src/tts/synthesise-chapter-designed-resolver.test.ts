/* fs-38 Wave 3b2, Task 12 (§2.3) — the designed-voice orphan self-heal
   pre-pass wired into `synthesiseChapter`, mirroring
   `synthesise-chapter-cloned-resolver.test.ts`'s wiring-level coverage.
   Drives the REAL `synthesiseChapter` with a fake synth backend (records
   every call) and a fake designed-resolver dep set (no real disk/sidecar),
   proving:

     1. .pt missing + a retained clip present -> the resolver re-derives ONCE
        before any synth call, then the chapter renders normally.
     2. .pt present -> no re-derive attempted, no needless GPU work.
     3. .pt missing + NO retained clip -> no crash, no re-derive; the chapter
        still renders (today's behaviour, unchanged — this test's fake
        provider doesn't care whether the real .pt exists, so it stands in
        for "whatever the sidecar does today for a missing designed voice").
     4. a stale-baseModel designed entry (.pt present) -> no re-derive; the
        pre-pass never even reads a VoiceLibraryEntry, so this is provably
        the same code path as case 2 — pinned here too so nobody widens the
        wiring to cover the stale case without a conscious test change.
     5. readiness gate: a designed voice whose character doesn't speak this
        chapter is never resolved.
     6. skipped entirely when the character doesn't route to Qwen this run
        (book default engine != qwen) — no wasted self-heal attempt. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { synthesiseChapter, type CastCharacter } from './synthesise-chapter.js';
import type { ResolveDesignedVoiceDeps } from './clone-voice-resolver.js';
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

const designedCast: CastCharacter[] = [
  {
    id: 'orin',
    name: 'Orin',
    gender: 'male',
    overrideTtsVoices: {
      qwen: { name: 'Orin (unused)', libraryUuid: 'lib-designed', provenance: 'designed' },
    },
  },
];

describe('synthesiseChapter — designed-voice orphan self-heal pre-pass (fs-38 Wave 3b2, Task 12)', () => {
  it('repairable: a designed voice with a missing .pt but a retained clip re-derives once, then renders', async () => {
    const provider = makeProvider();
    const ptExists = vi.fn(async () => false);
    const readDesignedMasterPcm = vi.fn(async (uuid: string) =>
      uuid === 'lib-designed'
        ? {
            pcm: Buffer.alloc(1000),
            sampleRate: 24000,
            refText: 'A retained calibration clip.',
            manifest: { refText: 'A retained calibration clip.' },
          }
        : null,
    );
    const deriveEngineArtifact = vi.fn(async (..._args: unknown[]) => ({
      previewPcm: Buffer.alloc(10),
      sampleRate: 24000,
      baseModel: 'qwen3-tts-0.6b',
    }));
    // C-1/I-2 (review) — a successful derive now also restores the sidecar
    // manifest and stamps the voice-library entry ready. Mock these too so
    // this wiring test doesn't hit the real on-disk workspace.
    const writeSidecarManifest = vi.fn(async () => {});
    const readEntry = vi.fn(async () => null);
    const writeEntry = vi.fn(async () => {});

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'orin')],
      cast: designedCast,
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      designedResolverDepsOverride: {
        ptExists,
        readDesignedMasterPcm,
        deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveDesignedVoiceDeps['deriveEngineArtifact'],
        writeSidecarManifest,
        readEntry: readEntry as unknown as ResolveDesignedVoiceDeps['readEntry'],
        writeEntry,
      },
    });

    expect(ptExists).toHaveBeenCalledWith('qwen-lib-designed');
    expect(readDesignedMasterPcm).toHaveBeenCalledWith('lib-designed');
    expect(deriveEngineArtifact).toHaveBeenCalledTimes(1);
    expect(deriveEngineArtifact).toHaveBeenCalledWith(
      'lib-designed',
      'qwen',
      { masterPcm: expect.any(Buffer), sampleRate: 24000, refText: 'A retained calibration clip.' },
      expect.objectContaining({}),
    );
    expect(writeSidecarManifest).toHaveBeenCalledTimes(1);
    expect(provider.calls.length).toBeGreaterThan(0); // the chapter synthesises normally
    expect(result.segments.length).toBeGreaterThan(0);
  });

  it('.pt present -> no re-derive attempted (no needless GPU work), chapter renders normally', async () => {
    const provider = makeProvider();
    const ptExists = vi.fn(async () => true);
    const readDesignedMasterPcm = vi.fn(async () => null);
    const deriveEngineArtifact = vi.fn();

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'orin')],
      cast: designedCast,
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      designedResolverDepsOverride: {
        ptExists,
        readDesignedMasterPcm,
        deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveDesignedVoiceDeps['deriveEngineArtifact'],
      },
    });

    expect(ptExists).toHaveBeenCalledWith('qwen-lib-designed');
    expect(readDesignedMasterPcm).not.toHaveBeenCalled();
    expect(deriveEngineArtifact).not.toHaveBeenCalled();
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(result.segments.length).toBeGreaterThan(0);
  });

  it('.pt missing + NO retained clip -> no crash, no re-derive, chapter still renders (today\'s behaviour unchanged)', async () => {
    const provider = makeProvider();
    const ptExists = vi.fn(async () => false);
    const readDesignedMasterPcm = vi.fn(async () => null); // no retained clip at all
    const deriveEngineArtifact = vi.fn();

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'orin')],
      cast: designedCast,
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      designedResolverDepsOverride: {
        ptExists,
        readDesignedMasterPcm,
        deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveDesignedVoiceDeps['deriveEngineArtifact'],
      },
    });

    expect(readDesignedMasterPcm).toHaveBeenCalledWith('lib-designed');
    expect(deriveEngineArtifact).not.toHaveBeenCalled();
    expect(provider.calls.length).toBeGreaterThan(0); // never a new failure mode
    expect(result.segments.length).toBeGreaterThan(0);
  });

  it('a stale-baseModel designed entry (.pt present) -> NO re-derive — explicitly out of scope', async () => {
    // Same wiring as the ".pt present" case above — the pre-pass never reads
    // a VoiceLibraryEntry's baseModel/status at all, so a "stale" designed
    // voice is indistinguishable from a healthy one to this pass by design.
    const provider = makeProvider();
    const ptExists = vi.fn(async () => true); // present, even though "conceptually stale"
    const deriveEngineArtifact = vi.fn();

    await synthesiseChapter({
      sentences: [sentence(1, 'orin')],
      cast: designedCast,
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      designedResolverDepsOverride: {
        ptExists,
        deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveDesignedVoiceDeps['deriveEngineArtifact'],
      },
    });

    expect(deriveEngineArtifact).not.toHaveBeenCalled();
  });

  it('readiness gate: a designed voice whose character does not speak this chapter is never resolved', async () => {
    const provider = makeProvider();
    const ptExists = vi.fn(async () => {
      throw new Error('resolver must not run for a designed voice absent from this chapter');
    });
    const cast: CastCharacter[] = [...designedCast, { id: 'other', name: 'Other', gender: 'female' }];

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'other')],
      cast,
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      designedResolverDepsOverride: { ptExists: ptExists as unknown as ResolveDesignedVoiceDeps['ptExists'] },
    });

    expect(ptExists).not.toHaveBeenCalled();
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(result.segments.length).toBeGreaterThan(0);
  });

  it('skipped when the character does not route to Qwen this run (book default engine != qwen)', async () => {
    const provider = makeProvider();
    const ptExists = vi.fn(async () => false);
    const readDesignedMasterPcm = vi.fn();
    const deriveEngineArtifact = vi.fn();

    // 'orin' carries no per-character ttsEngine override, so he rides the
    // run's default engine — here 'kokoro', not 'qwen'. His designed qwen
    // slot is irrelevant this render; self-healing it would be pure waste.
    await synthesiseChapter({
      sentences: [sentence(1, 'orin')],
      cast: designedCast,
      provider,
      modelKey: 'kokoro-v1',
      engine: 'kokoro',
      designedResolverDepsOverride: {
        ptExists,
        readDesignedMasterPcm,
        deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveDesignedVoiceDeps['deriveEngineArtifact'],
      },
    });

    expect(ptExists).not.toHaveBeenCalled();
    expect(readDesignedMasterPcm).not.toHaveBeenCalled();
    expect(deriveEngineArtifact).not.toHaveBeenCalled();
  });
});
