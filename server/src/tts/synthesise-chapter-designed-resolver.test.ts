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
import {
  UnresolvableClonedVoiceError,
  type ResolveChapterDeps,
  type ResolveDesignedVoiceDeps,
} from './clone-voice-resolver.js';
import { COQUI_PROFILE_VOICES } from './voice-mapping.js';
import type { SentenceOutput } from '../handoff/schemas.js';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from './index.js';

afterEach(() => vi.restoreAllMocks());

const COQUI_CATALOG_NAMES = new Set(Object.values(COQUI_PROFILE_VOICES).flat());

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
    expect(readDesignedMasterPcm).toHaveBeenCalledWith('lib-designed', 'qwen');
    expect(deriveEngineArtifact).toHaveBeenCalledTimes(1);
    expect(deriveEngineArtifact).toHaveBeenCalledWith(
      'lib-designed',
      'qwen',
      {
        masterPcm: expect.any(Buffer),
        sampleRate: 24000,
        refText: 'A retained calibration clip.',
        // Review I1 — the self-heal derive discards previewPcm, so it must
        // never voice the full retained ref_text on the GPU hot path.
        auditionText: expect.any(String),
      },
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

    expect(readDesignedMasterPcm).toHaveBeenCalledWith('lib-designed', 'qwen');
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

/* fs-38 Wave 3c, Task 20a — the coqui arm: designed voices derive on Coqui
   too, but fail SOFT (D-B/D-F), never loud like the cloned resolver. Every
   test here drives the REAL `synthesiseChapter`, asserting on the RENDERED
   voiceName (not merely "no error"), per this branch's own lesson: a
   fail-soft path's placebo trap is "nothing bad happened" reading as green
   even when the fix never ran (the fake `TtsProvider` here happily
   "renders" ANY voiceName it's handed, including a dangling
   `xtts-<uuid>` — so the assertion that actually distinguishes fixed from
   reverted is the voiceName itself, not the absence of a thrown error). */
describe('synthesiseChapter — designed-voice coqui self-heal, fail-SOFT (fs-38 Wave 3c, Task 20a)', () => {
  function designedEntry() {
    return {
      voiceUuid: 'lib-designed',
      name: 'Orin',
      provenance: 'designed' as const,
      tags: [],
      pinned: false,
      engines: {},
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
  }

  const coquiDesignedCast: CastCharacter[] = [
    {
      id: 'orin',
      name: 'Orin',
      gender: 'male',
      overrideTtsVoices: {
        coqui: { name: 'xtts-lib-designed', libraryUuid: 'lib-designed', provenance: 'designed' },
      },
    },
  ];

  it('missing xtts .pt but a retained clip present -> derives once, renders as xtts-<uuid>', async () => {
    const provider = makeProvider();
    const entry = designedEntry();
    const readEntry = vi.fn(async (uuid: string) => (uuid === 'lib-designed' ? entry : null));
    const ptExists = vi.fn(async () => false);
    const readDesignedMasterPcm = vi.fn(async () => ({
      pcm: Buffer.alloc(1000),
      sampleRate: 24000,
      refText: '',
      manifest: {},
    }));
    const deriveEngineArtifact = vi.fn(async (..._args: unknown[]) => ({
      previewPcm: Buffer.alloc(10),
      sampleRate: 24000,
      coquiVersion: 'v2.0.5',
      modelId: 'tts_models/multilingual/multi-dataset/xtts_v2',
    }));
    const writeEntry = vi.fn(async () => {});

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'orin')],
      cast: coquiDesignedCast,
      provider,
      modelKey: 'coqui-xtts-v2',
      engine: 'coqui',
      designedResolverDepsOverride: {
        readEntry: readEntry as unknown as ResolveDesignedVoiceDeps['readEntry'],
        ptExists,
        readDesignedMasterPcm,
        deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveDesignedVoiceDeps['deriveEngineArtifact'],
        writeEntry,
      },
    });

    expect(ptExists).toHaveBeenCalledWith('xtts-lib-designed');
    expect(deriveEngineArtifact).toHaveBeenCalledTimes(1);
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(provider.calls[0].voiceName).toBe('xtts-lib-designed');
    expect(result.segments.length).toBeGreaterThan(0);
  });

  /* The load-bearing case (brief's own words). */
  it('a derive failure never surfaces as a chapter error: the chapter completes, rendering a stock COQUI_PROFILE_VOICES catalogue name instead of the never-derived clone', async () => {
    const provider = makeProvider();
    const entry = designedEntry();
    const readEntry = vi.fn(async () => entry);
    const ptExists = vi.fn(async () => false);
    const readDesignedMasterPcm = vi.fn(async () => ({
      pcm: Buffer.alloc(10),
      sampleRate: 24000,
      refText: '',
      manifest: {},
    }));
    const deriveEngineArtifact = vi.fn(async () => {
      throw Object.assign(new Error('sidecar rejected the clip'), { status: 422 });
    });

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'orin')],
      cast: coquiDesignedCast,
      provider,
      modelKey: 'coqui-xtts-v2',
      engine: 'coqui',
      designedResolverDepsOverride: {
        readEntry: readEntry as unknown as ResolveDesignedVoiceDeps['readEntry'],
        ptExists,
        readDesignedMasterPcm,
        deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveDesignedVoiceDeps['deriveEngineArtifact'],
      },
    });

    expect(provider.calls.length).toBeGreaterThan(0); // the chapter completed — no exception escaped.
    // The load-bearing assertion — NOT "no error", but the RENDERED voice:
    // a revert that stops removing the slot still renders fine here (the
    // fake provider accepts any voiceName), so only this line distinguishes
    // fixed from reverted.
    expect(provider.calls[0].voiceName).not.toBe('xtts-lib-designed');
    expect(COQUI_CATALOG_NAMES.has(provider.calls[0].voiceName)).toBe(true);
    expect(result.segments.length).toBeGreaterThan(0);
  });

  it('no retained clip -> no derive attempted, the coqui slot is removed, and the chapter renders on a catalogue voice', async () => {
    const provider = makeProvider();
    const entry = designedEntry();
    const readEntry = vi.fn(async () => entry);
    const ptExists = vi.fn(async () => false);
    const readDesignedMasterPcm = vi.fn(async () => null); // no retained clip at all.
    const deriveEngineArtifact = vi.fn();

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'orin')],
      cast: coquiDesignedCast,
      provider,
      modelKey: 'coqui-xtts-v2',
      engine: 'coqui',
      designedResolverDepsOverride: {
        readEntry: readEntry as unknown as ResolveDesignedVoiceDeps['readEntry'],
        ptExists,
        readDesignedMasterPcm,
        deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveDesignedVoiceDeps['deriveEngineArtifact'],
      },
    });

    expect(deriveEngineArtifact).not.toHaveBeenCalled();
    expect(provider.calls[0].voiceName).not.toBe('xtts-lib-designed');
    expect(COQUI_CATALOG_NAMES.has(provider.calls[0].voiceName)).toBe(true);
    expect(result.segments.length).toBeGreaterThan(0);
  });

  /* [DELTA-C2] vector 1 — fs-60's Qwen->Coqui fallback reroutes a
     QWEN-ROUTED character onto coqui. This character has NO qwen slot at
     all (voiceName resolves empty), so `applyQwenFallback`'s `needsFallback`
     fires; with `forbidKokoroFallback` + `coquiEligible`, it reroutes to
     coqui and calls `pickVoiceForEngine('coqui', …)`. A `routeFor`-based
     selection (the qwen arm's own filter) would never have queued this
     character's coqui slot for self-heal, because `routeFor(c).engine` is
     'qwen' here, not 'coqui'. */
  it('[DELTA-C2] vector 1 — fs-60 Qwen->Coqui reroute: a qwen-routed character with no qwen slot is still self-healed on coqui before the reroute renders it', async () => {
    const qwenProvider = makeProvider();
    const coquiProvider = makeProvider();
    const entry = designedEntry();
    const readEntry = vi.fn(async () => entry);
    const ptExists = vi.fn(async () => true); // present + current — healthy, no derive needed for this vector.
    const resolveForEngine = (e: string) =>
      e === 'coqui'
        ? { provider: coquiProvider, modelKey: 'coqui-xtts-v2' as const }
        : { provider: qwenProvider, modelKey: 'qwen3-tts-0.6b' as const };

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'orin')],
      cast: coquiDesignedCast, // no qwen slot at all.
      provider: qwenProvider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      resolveForEngine,
      forbidKokoroFallback: true,
      coquiEligible: true,
      bookLanguage: 'ru',
      designedResolverDepsOverride: {
        readEntry: readEntry as unknown as ResolveDesignedVoiceDeps['readEntry'],
        ptExists,
      },
    });

    expect(ptExists).toHaveBeenCalledWith('xtts-lib-designed'); // the coqui arm DID queue this character.
    expect(coquiProvider.calls.length).toBeGreaterThan(0);
    expect(coquiProvider.calls[0].voiceName).toBe('xtts-lib-designed'); // rendered via the reroute, on her own clone.
    expect(qwenProvider.calls).toHaveLength(0);
    expect(result.segments.length).toBeGreaterThan(0);
  });

  /* [DELTA-C2] vector 2 — `qwenUnavailable` has nothing to do with whether
     COQUI is usable. This character HAS a healthy qwen slot too, but Qwen
     is globally unavailable this run, so `applyQwenFallback` reroutes her
     anyway (forbidKokoroFallback+coquiEligible). A selection gated on
     `!qwenUnavailable` (the qwen arm's own filter) would skip her coqui
     self-heal entirely, on every run where Qwen merely happens to be off. */
  it('[DELTA-C2] vector 2 — qwenUnavailable: the coqui self-heal still runs (and the reroute still renders the clone) even though the qwen arm is skipped', async () => {
    const qwenProvider = makeProvider();
    const coquiProvider = makeProvider();
    const entry = designedEntry();
    const ptExists = vi.fn(async (_key: string) => true);
    const qwenPtExists = vi.fn(async (_key: string) => false); // the qwen arm must never even be queued.
    const resolveForEngine = (e: string) =>
      e === 'coqui'
        ? { provider: coquiProvider, modelKey: 'coqui-xtts-v2' as const }
        : { provider: qwenProvider, modelKey: 'qwen3-tts-0.6b' as const };
    const castWithBothSlots: CastCharacter[] = [
      {
        id: 'orin',
        name: 'Orin',
        gender: 'male',
        overrideTtsVoices: {
          qwen: { name: 'qwen-lib-qwen', libraryUuid: 'lib-qwen', provenance: 'designed' },
          coqui: { name: 'xtts-lib-designed', libraryUuid: 'lib-designed', provenance: 'designed' },
        },
      },
    ];

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'orin')],
      cast: castWithBothSlots,
      provider: qwenProvider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenUnavailable: true,
      resolveForEngine,
      forbidKokoroFallback: true,
      coquiEligible: true,
      bookLanguage: 'ru',
      designedResolverDepsOverride: {
        readEntry: ((uuid: string) =>
          uuid === 'lib-designed' ? Promise.resolve(entry) : Promise.resolve(null)) as unknown as ResolveDesignedVoiceDeps['readEntry'],
        ptExists: (async (key: string) => (key === 'xtts-lib-designed' ? ptExists(key) : qwenPtExists(key))) as unknown as ResolveDesignedVoiceDeps['ptExists'],
      },
    });

    expect(ptExists).toHaveBeenCalledWith('xtts-lib-designed');
    expect(qwenPtExists).not.toHaveBeenCalled(); // qwen arm skipped — `!qwenUnavailable` filter, unchanged.
    expect(coquiProvider.calls.length).toBeGreaterThan(0);
    expect(coquiProvider.calls[0].voiceName).toBe('xtts-lib-designed');
    expect(result.segments.length).toBeGreaterThan(0);
  });

  /* [DELTA-C2] vector 3 — the aftermath of `clearMismatchedDesignedVoices`
     (verify-designed-voice-language.ts), which deletes only `overrideTtsVoices
     .qwen` on a language mismatch, leaving a stranded coqui slot behind with
     NO qwen slot at all. This cast fixture IS that aftermath directly —
     proving the selection set never depends on a qwen slot's presence. */
  it('[DELTA-C2] vector 3 — post-clearMismatchedDesignedVoices: a character with ONLY a coqui slot (qwen slot already gone) still self-heals and renders', async () => {
    const provider = makeProvider();
    const entry = designedEntry();
    const readEntry = vi.fn(async () => entry);
    const ptExists = vi.fn(async () => true);

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'orin')],
      cast: coquiDesignedCast, // no overrideTtsVoices.qwen at all.
      provider,
      modelKey: 'coqui-xtts-v2',
      engine: 'coqui', // the book's own default, post-retarget — no reroute needed for this vector.
      designedResolverDepsOverride: {
        readEntry: readEntry as unknown as ResolveDesignedVoiceDeps['readEntry'],
        ptExists,
      },
    });

    expect(ptExists).toHaveBeenCalledWith('xtts-lib-designed');
    expect(provider.calls[0].voiceName).toBe('xtts-lib-designed');
    expect(result.segments.length).toBeGreaterThan(0);
  });

  /* Placebo-proof, half 2 (half 1 — UnresolvableClonedVoiceError is never
     constructed on the designed path — is pinned above by every test in
     this describe block completing without a rejection). This is the
     "two policies coexisting" regression this task exists to guard: a
     cloned voice in the SAME codebase (a different chapter, since a
     REVOKED cloned voice aborts a chapter before the designed pre-pass
     ever runs) must still fail loud, unaffected by this task's fail-soft
     additions to the sibling function. */
  it('placebo-proof — a cloned voice still fails loud (UnresolvableClonedVoiceError), unaffected by the designed resolver\'s new fail-soft coqui arm', async () => {
    const provider = makeProvider();
    const revokedEntry = {
      voiceUuid: 'lib-clone',
      name: 'Wren clone',
      provenance: 'cloned' as const,
      tags: [],
      pinned: false,
      engines: {},
      consent: {
        personName: 'Real Person',
        relationship: 'self' as const,
        permittedUse: 'personal' as const,
        attestedAt: '2026-01-01T00:00:00.000Z',
        attestedBy: 'Real Person',
        revokedAt: '2026-02-01T00:00:00.000Z',
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const readEntry = vi.fn(async (uuid: string) => (uuid === 'lib-clone' ? revokedEntry : null));
    const clonedCast: CastCharacter[] = [
      {
        id: 'wren',
        name: 'Wren',
        overrideTtsVoices: {
          qwen: { name: 'Wren (unused)', libraryUuid: 'lib-clone', provenance: 'cloned' },
        },
      },
    ];

    await expect(
      synthesiseChapter({
        sentences: [sentence(1, 'wren')],
        cast: clonedCast,
        provider,
        modelKey: 'qwen3-tts-0.6b',
        engine: 'qwen',
        cloneResolverDepsOverride: {
          readEntry: readEntry as unknown as ResolveChapterDeps['readEntry'],
        },
      }),
    ).rejects.toBeInstanceOf(UnresolvableClonedVoiceError);

    expect(provider.calls).toHaveLength(0); // fail-fast — the loud policy is untouched.
  });

  /* [D-I2] — scope the drop to the chapter, not the run. A soft failure in
     chapter 1 must not silently downgrade the SAME character's voice for
     the rest of the book: chapter 2 (the SAME `cast` array reference, a
     fresh `synthesiseChapter` call — mirroring how generation.ts reuses one
     `cast` across every chapter) must see the coqui slot exactly as it was
     handed in, not the chapter-1-mutated version. */
  it('[D-I2] a soft failure in chapter 1 does not persist into chapter 2 — the same cast array, reused, is untouched', async () => {
    const entry = designedEntry();
    const readEntry = vi.fn(async () => entry);
    const sharedCast = coquiDesignedCast; // the SAME array reference across both calls.

    // Chapter 1 — derive fails -> catalogue voice this chapter only.
    const ch1Provider = makeProvider();
    const ch1Result = await synthesiseChapter({
      sentences: [sentence(1, 'orin')],
      cast: sharedCast,
      provider: ch1Provider,
      modelKey: 'coqui-xtts-v2',
      engine: 'coqui',
      designedResolverDepsOverride: {
        readEntry: readEntry as unknown as ResolveDesignedVoiceDeps['readEntry'],
        ptExists: vi.fn(async () => false),
        readDesignedMasterPcm: vi.fn(async () => null), // no retained clip -> soft fail.
      },
    });
    expect(ch1Provider.calls[0].voiceName).not.toBe('xtts-lib-designed');
    expect(ch1Result.segments.length).toBeGreaterThan(0);

    // Chapter 2 — the SAME cast array, a fresh call, this time healthy.
    // If chapter 1 had mutated `sharedCast[0].overrideTtsVoices` in place,
    // this chapter would ALSO render a catalogue voice — it doesn't.
    const ch2Provider = makeProvider();
    const ch2ReadEntry = vi.fn(async () => entry);
    const ch2Result = await synthesiseChapter({
      sentences: [sentence(1, 'orin')],
      cast: sharedCast,
      provider: ch2Provider,
      modelKey: 'coqui-xtts-v2',
      engine: 'coqui',
      designedResolverDepsOverride: {
        readEntry: ch2ReadEntry as unknown as ResolveDesignedVoiceDeps['readEntry'],
        ptExists: vi.fn(async () => true), // healthy this time.
      },
    });
    expect(ch2Provider.calls[0].voiceName).toBe('xtts-lib-designed');
    expect(ch2Result.segments.length).toBeGreaterThan(0);
    // The original array's character object is unchanged too — proof this
    // task never mutates `c.overrideTtsVoices` in place.
    expect(sharedCast[0].overrideTtsVoices?.coqui?.libraryUuid).toBe('lib-designed');
  });
});
