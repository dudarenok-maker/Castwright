/* fs-38 Wave 3c, Task 22 [AC-C4][FAB-I2] — VRAM co-residency guard for the
   cloned/designed-voice resolver pre-pass. `generation.ts` warms the run's
   default engine BEFORE `synthesiseChapter` is ever called, so Qwen is
   typically already resident the moment this pre-pass starts; a coqui
   derive issued from the pre-pass (either the cloned resolver's repair or
   Task 20a's designed-voice self-heal) used to load XTTS with NO cross-
   engine admission at all, risking the plan-108 OOM class on an 8 GB card.

   These tests drive the REAL `synthesiseChapter`, tracking the ORDER of
   every load-bearing side effect — a coqui/qwen derive call
   (`deriveEngineArtifact`, injected via `cloneResolverDepsOverride`/
   `designedResolverDepsOverride` so no real disk/sidecar I/O happens) and a
   sidecar `/unload` evict call (`global.fetch`, the only thing either evict
   helper touches) — in one shared `callOrder` array, so the assertions can
   pin the SEQUENCE, not merely which calls eventually happened.

   This distinction is the whole point of the suite: an implementation that
   merely reorders "run the coqui derives before the qwen ones" (a previous
   draft of this task) produces the same END state (only Qwen resident when
   the pre-pass returns) as the fix below, but during the run itself Coqui
   still loads on top of a still-warm Qwen — the exact co-residency window
   this task exists to close. An end-state-only assertion cannot see that;
   a call-ORDER assertion can and does (see the second test below). */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { synthesiseChapter, type CastCharacter } from './synthesise-chapter.js';
import {
  UnresolvableClonedVoiceError,
  type ResolveChapterDeps,
  type ResolveDesignedVoiceDeps,
} from './clone-voice-resolver.js';
import type { SentenceOutput } from '../handoff/schemas.js';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from './index.js';
import { setLastKnownCoquiInstallState, _resetUserSettingsCache } from '../workspace/user-settings.js';

afterEach(() => {
  vi.restoreAllMocks();
  _resetUserSettingsCache();
});

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

/** Tags every sidecar `/unload` call with the engine it targeted (the ONLY
    thing `global.fetch` is hit for anywhere in this suite — both providers
    and `deriveEngineArtifact` are plain mocks that never touch `fetch`). */
function mockEvictFetch(callOrder: string[]): void {
  vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')) as {
      engine?: string;
    };
    callOrder.push(`evict:${body.engine}`);
    return new Response(null, { status: 200 });
  });
}

/** A `deriveEngineArtifact` stand-in shared by BOTH the cloned resolver's
    repair path and the designed resolver's self-heal path — every derive
    call, whichever arm issued it, lands in the same `callOrder` sequence
    tagged with its engine. */
function mockDeriveEngineArtifact(callOrder: string[]) {
  return vi.fn(async (_uuid: string, engine: string) => {
    callOrder.push(`derive:${engine}`);
    return engine === 'qwen'
      ? { previewPcm: Buffer.alloc(10), sampleRate: 24000, baseModel: 'qwen3-tts-0.6b' }
      : { previewPcm: Buffer.alloc(10), sampleRate: 24000, coquiVersion: 'v2.0.5', modelId: 'xtts_v2' };
  });
}

/** Mixed-chapter harness shared by the first two tests: 'nova' is cloned on
    Coqui (repairable — missing .pt, retained master.wav) and is ALSO the
    chapter's anchor group (renders standalone, never through
    synthGroupsSerialized); 'orin' is designed on Qwen (repairable —
    missing .pt, retained calibration clip) and routes to Qwen via the run's
    default engine. With exactly these two sentences, `groups.slice(1)`
    (what actually reaches synthGroupsSerialized) is Orin ALONE — a single
    engine — so the render phase itself never triggers another evict; every
    'evict'/'derive' entry in `callOrder` comes from the PRE-PASS this task
    changes, not from downstream render-phase serialization. */
async function runMixedCoquiQwenChapter(): Promise<string[]> {
  const callOrder: string[] = [];
  setLastKnownCoquiInstallState('ready'); // Task 19 signal — coqui usable this run

  const qwenProvider = makeProvider();
  const coquiProvider = makeProvider();
  const resolveForEngine = (e: string) =>
    e === 'coqui'
      ? { provider: coquiProvider, modelKey: 'coqui-xtts-v2' as const }
      : { provider: qwenProvider, modelKey: 'qwen3-tts-0.6b' as const };

  const cast: CastCharacter[] = [
    {
      id: 'nova',
      name: 'Nova',
      gender: 'female',
      ttsEngine: 'coqui',
      overrideTtsVoices: {
        coqui: { name: 'Nova (unused)', libraryUuid: 'lib-nova', provenance: 'cloned' },
      },
    },
    {
      id: 'orin',
      name: 'Orin',
      gender: 'male',
      overrideTtsVoices: {
        qwen: { name: 'Orin (unused)', libraryUuid: 'lib-orin', provenance: 'designed' },
      },
    },
  ];

  const clonedEntry = {
    voiceUuid: 'lib-nova',
    name: 'Nova clone',
    provenance: 'cloned' as const,
    tags: [],
    pinned: false,
    engines: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    master: {
      clipFile: 'master.wav',
      sampleRate: 24000,
      durationSeconds: 8,
      transcript: 'A retained reference clip.',
      transcriptSource: 'whisper' as const,
      captureMethod: 'upload' as const,
    },
  };

  const deriveEngineArtifact = mockDeriveEngineArtifact(callOrder);
  mockEvictFetch(callOrder);

  await synthesiseChapter({
    sentences: [sentence(1, 'nova'), sentence(2, 'orin')],
    cast,
    provider: qwenProvider,
    modelKey: 'qwen3-tts-0.6b',
    engine: 'qwen',
    resolveForEngine,
    cloneResolverDepsOverride: {
      readEntry: async (uuid: string) => (uuid === 'lib-nova' ? clonedEntry : null),
      writeEntry: async () => {},
      ptExists: async () => false, // missing — triggers repairable, not healthy
      readMasterPcm: async () => ({
        pcm: Buffer.alloc(1000),
        sampleRate: 24000,
        refText: 'A retained reference clip.',
      }),
      deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveChapterDeps['deriveEngineArtifact'],
      currentArtifactVersion: () => 'v2.0.5',
    },
    designedResolverDepsOverride: {
      ptExists: async () => false, // missing — triggers the self-heal
      readDesignedMasterPcm: async () => ({
        pcm: Buffer.alloc(1000),
        sampleRate: 24000,
        refText: 'A retained calibration clip.',
        manifest: {},
      }),
      deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveDesignedVoiceDeps['deriveEngineArtifact'],
      writeSidecarManifest: async () => {},
      readEntry: async () => null,
      writeEntry: async () => {},
    },
  });

  return callOrder;
}

describe('synthesiseChapter — engine-partitioned derive pre-pass (fs-38 Wave 3c, Task 22)', () => {
  it('a mixed chapter evicts Qwen BEFORE the first coqui derive (ordering)', async () => {
    const callOrder = await runMixedCoquiQwenChapter();

    const evictQwenIndex = callOrder.indexOf('evict:qwen');
    const firstCoquiDeriveIndex = callOrder.indexOf('derive:coqui');
    expect(evictQwenIndex).toBeGreaterThan(-1);
    expect(firstCoquiDeriveIndex).toBeGreaterThan(-1);
    /* The trap this pins: an implementation that only reorders "coqui block
       before qwen block" WITHOUT evicting Qwen first would call
       derive:coqui with Qwen still resident from generation.ts's own
       warm-up — evict:qwen would only ever land later (right before the
       qwen-derive block, or not at all), so this ordering check fails on
       that shape even though its FINAL state (qwen resident, coqui not)
       looks identical to the fix. */
    expect(evictQwenIndex).toBeLessThan(firstCoquiDeriveIndex);
  });

  it('both engines are never simultaneously resident at any point — the full call sequence, not just the end state', async () => {
    const callOrder = await runMixedCoquiQwenChapter();

    /* The exact bracket the brief's decision specifies: evict qwen -> coqui
       derives -> evict coqui (gated on chapterHasQwenGroups, true here
       since Orin routes to Qwen) -> qwen derives. This is the assertion
       an end-state-only test (the previous draft's mistake) cannot make:
       a "coqui block first, no leading evict" implementation produces
       ['derive:coqui', 'evict:qwen', 'derive:qwen'] — Coqui loaded on a
       still-warm Qwen, then Qwen evicted only afterward — which reaches
       the SAME end state (qwen resident) as this exact-sequence check, but
       fails it because Coqui was never absent while Qwen was present. A
       leading-evict-but-no-trailing-evict implementation produces
       ['evict:qwen', 'derive:coqui', 'derive:qwen'] (missing 'evict:coqui')
       — Coqui stays resident THROUGH the qwen derive, also failing this
       exact match, and also proving the "never both resident" half of the
       invariant, not merely the "ends with qwen resident" half. */
    expect(callOrder).toEqual(['evict:qwen', 'derive:coqui', 'evict:coqui', 'derive:qwen']);
  });

  it('a coqui-only chapter\'s designed-voice self-heal does NOT evict coqui afterwards (DELTA-I7 — the performance-cliff guard)', async () => {
    const callOrder: string[] = [];
    const coquiProvider = makeProvider();

    const cast: CastCharacter[] = [
      {
        id: 'mira',
        name: 'Mira',
        gender: 'female',
        overrideTtsVoices: {
          coqui: { name: 'xtts-lib-mira', libraryUuid: 'lib-mira', provenance: 'designed' },
        },
      },
    ];
    const entry = {
      voiceUuid: 'lib-mira',
      name: 'Mira',
      provenance: 'designed' as const,
      tags: [],
      pinned: false,
      engines: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const deriveEngineArtifact = mockDeriveEngineArtifact(callOrder);
    mockEvictFetch(callOrder);

    await synthesiseChapter({
      sentences: [sentence(1, 'mira')],
      cast,
      provider: coquiProvider,
      modelKey: 'coqui-xtts-v2',
      engine: 'coqui', // the WHOLE chapter is coqui — no qwen anywhere
      designedResolverDepsOverride: {
        readEntry: async (uuid: string) =>
          uuid === 'lib-mira' ? entry : null,
        ptExists: async () => false, // missing — triggers the self-heal
        readDesignedMasterPcm: async () => ({
          pcm: Buffer.alloc(1000),
          sampleRate: 24000,
          refText: '',
          manifest: {},
        }),
        deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveDesignedVoiceDeps['deriveEngineArtifact'],
        writeEntry: async () => {},
      },
    });

    // Derive DID happen (the self-heal ran) — this isn't a "nothing fired" placebo.
    expect(deriveEngineArtifact).toHaveBeenCalledTimes(1);
    expect(deriveEngineArtifact).toHaveBeenCalledWith('lib-mira', 'coqui', expect.anything(), expect.anything());
    /* Exactly ONE fetch call for the whole chapter: the leading evict-qwen
       (fired because a coqui derive block ran at all — Qwen may already be
       resident from generation.ts's own warm-up regardless of this run's
       engine), followed by the coqui derive itself. A wrongly-unconditional
       trailing evict would push a SECOND, 'evict:coqui' entry here — the
       performance-cliff bug this gate exists to prevent (Task 11's
       `_latents_cache` would be cleared, forcing coquiProvider's own render
       right after to reload from scratch instead of the just-derived
       latents). */
    expect(callOrder).toEqual(['evict:qwen', 'derive:coqui']);
  });

  it('a qwen-only chapter issues no coqui load at all (no regression for the common existing book)', async () => {
    const callOrder: string[] = [];
    const qwenProvider = makeProvider();
    const coquiProvider = makeProvider();

    const cast: CastCharacter[] = [
      {
        id: 'orin',
        name: 'Orin',
        gender: 'male',
        overrideTtsVoices: {
          qwen: { name: 'Orin (unused)', libraryUuid: 'lib-orin', provenance: 'designed' },
        },
      },
    ];

    const deriveEngineArtifact = mockDeriveEngineArtifact(callOrder);
    const fetchSpy = mockFetchSpy();

    await synthesiseChapter({
      sentences: [sentence(1, 'orin')],
      cast,
      provider: qwenProvider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      designedResolverDepsOverride: {
        ptExists: async () => false, // missing — triggers the self-heal
        readDesignedMasterPcm: async () => ({
          pcm: Buffer.alloc(1000),
          sampleRate: 24000,
          refText: 'A retained calibration clip.',
          manifest: {},
        }),
        deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveDesignedVoiceDeps['deriveEngineArtifact'],
        writeSidecarManifest: async () => {},
        readEntry: async () => null,
        writeEntry: async () => {},
      },
    });

    // The qwen self-heal DID run (proving the harness is live, not a placebo)…
    expect(deriveEngineArtifact).toHaveBeenCalledTimes(1);
    expect(deriveEngineArtifact).toHaveBeenCalledWith('lib-orin', 'qwen', expect.anything(), expect.anything());
    // …but NOTHING ever touched Coqui: no /unload call at all (a
    // qwen-only derive block never enters the coqui-gated branch), and the
    // coqui provider was never invoked either.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['derive:qwen']);
    expect(coquiProvider.calls).toHaveLength(0);
  });
});

/* fs-38 Wave 3c, Task 22 fix round 1 — review findings F1 (Critical), F2 and
   F3 (Important). */
describe('synthesiseChapter — engine-partitioned derive pre-pass, fix round 1 (fs-38 Wave 3c, Task 22)', () => {
  it('F1: designed-only chapter + a failed evict stays fail-SOFT — the chapter still completes', async () => {
    const provider = makeProvider();
    const cast: CastCharacter[] = [
      {
        id: 'mira',
        name: 'Mira',
        gender: 'female',
        overrideTtsVoices: {
          coqui: { name: 'xtts-lib-mira', libraryUuid: 'lib-mira', provenance: 'designed' },
        },
      },
    ];
    const entry = {
      voiceUuid: 'lib-mira',
      name: 'Mira',
      provenance: 'designed' as const,
      tags: [],
      pinned: false,
      engines: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const deriveEngineArtifact = vi.fn();
    // Simulates "the sidecar is in a recycle window and /unload returns 502" (F1's own scenario).
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 502, statusText: 'Bad Gateway' }));

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'mira')],
      cast,
      provider,
      modelKey: 'coqui-xtts-v2',
      engine: 'coqui',
      designedResolverDepsOverride: {
        readEntry: async (uuid: string) => (uuid === 'lib-mira' ? entry : null),
        ptExists: async () => false, // missing — triggers the self-heal
        readDesignedMasterPcm: async () => ({
          pcm: Buffer.alloc(1000),
          sampleRate: 24000,
          refText: '',
          manifest: {},
        }),
        deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveDesignedVoiceDeps['deriveEngineArtifact'],
        writeEntry: async () => {},
      },
    });

    // The evict failure is caught inside the resolver's OWN fail-soft catch
    // — deriveEngineArtifact is never reached (the hook throws first)...
    expect(deriveEngineArtifact).not.toHaveBeenCalled();
    // ...and the chapter completes anyway, rendering Mira on SOME voice
    // (never the never-derived xtts-lib-mira slot) rather than aborting.
    // Pre-fix (an eager, unguarded evict in front of the whole coqui block)
    // this `synthesiseChapter` call rejects instead of resolving.
    expect(provider.calls[0]?.voiceName).not.toBe('xtts-lib-mira');
    expect(result.segments.length).toBeGreaterThan(0);
  });

  it('F1: a cloned voice present + a failed evict still raises (fail-loud policy unchanged)', async () => {
    const provider = makeProvider();
    const cast: CastCharacter[] = [
      {
        id: 'nova',
        name: 'Nova',
        gender: 'female',
        overrideTtsVoices: {
          coqui: { name: 'Nova (unused)', libraryUuid: 'lib-nova', provenance: 'cloned' },
        },
      },
    ];
    const clonedEntry = {
      voiceUuid: 'lib-nova',
      name: 'Nova clone',
      provenance: 'cloned' as const,
      tags: [],
      pinned: false,
      engines: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      master: {
        clipFile: 'master.wav',
        sampleRate: 24000,
        durationSeconds: 8,
        transcript: 'A retained reference clip.',
        transcriptSource: 'whisper' as const,
        captureMethod: 'upload' as const,
      },
    };
    const deriveEngineArtifact = vi.fn();
    setLastKnownCoquiInstallState('ready');
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 502, statusText: 'Bad Gateway' }));

    let thrown: unknown;
    try {
      await synthesiseChapter({
        sentences: [sentence(1, 'nova')],
        cast,
        provider,
        modelKey: 'coqui-xtts-v2',
        engine: 'coqui',
        cloneResolverDepsOverride: {
          readEntry: async (uuid: string) => (uuid === 'lib-nova' ? clonedEntry : null),
          writeEntry: async () => {},
          ptExists: async () => false,
          readMasterPcm: async () => ({
            pcm: Buffer.alloc(1000),
            sampleRate: 24000,
            refText: 'A retained reference clip.',
          }),
          deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveChapterDeps['deriveEngineArtifact'],
          currentArtifactVersion: () => 'v2.0.5',
        },
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(UnresolvableClonedVoiceError);
    expect((thrown as InstanceType<typeof UnresolvableClonedVoiceError>).broken).toEqual([
      { name: 'Nova', reason: 'derive-failed' },
    ]);
    expect(deriveEngineArtifact).not.toHaveBeenCalled();
    expect(provider.calls).toHaveLength(0);
  });

  it('F2: a coqui-only-BODY chapter still evicts coqui before a qwen-routed TITLE narrator self-heal (a qwen load about to happen is not just about body groups)', async () => {
    const callOrder: string[] = [];
    const coquiProvider = makeProvider();
    const qwenProvider = makeProvider();
    const resolveForEngine = (e: string) =>
      e === 'qwen'
        ? { provider: qwenProvider, modelKey: 'qwen3-tts-0.6b' as const }
        : { provider: coquiProvider, modelKey: 'coqui-xtts-v2' as const };

    const cast: CastCharacter[] = [
      {
        id: 'mira',
        name: 'Mira',
        gender: 'female',
        overrideTtsVoices: {
          coqui: { name: 'xtts-lib-mira', libraryUuid: 'lib-mira', provenance: 'designed' },
        },
      },
      {
        id: 'narrator',
        name: 'Narrator',
        ttsEngine: 'qwen', // pinned off the book's coqui default — the whole point of this test
        overrideTtsVoices: {
          qwen: { name: 'Narrator (unused)', libraryUuid: 'lib-narrator', provenance: 'designed' },
        },
      },
    ];
    const miraEntry = {
      voiceUuid: 'lib-mira',
      name: 'Mira',
      provenance: 'designed' as const,
      tags: [],
      pinned: false,
      engines: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const deriveEngineArtifact = mockDeriveEngineArtifact(callOrder);
    mockEvictFetch(callOrder);

    const result = await synthesiseChapter({
      // Only Mira (coqui) speaks a BODY line — chapterHasQwenGroups reads
      // false on `groups` alone. The narrator only enters via the TITLE
      // beat (chapterTitleNarration below), never a SentenceGroup.
      sentences: [sentence(1, 'mira')],
      cast,
      provider: coquiProvider,
      modelKey: 'coqui-xtts-v2',
      engine: 'coqui',
      resolveForEngine,
      chapterTitleNarration: 'Chapter One',
      designedResolverDepsOverride: {
        readEntry: async (uuid: string) => (uuid === 'lib-mira' ? miraEntry : null),
        ptExists: async () => false, // both Mira's coqui slot and the narrator's qwen slot are missing
        readDesignedMasterPcm: async () => ({
          pcm: Buffer.alloc(1000),
          sampleRate: 24000,
          refText: 'A retained calibration clip.',
          manifest: {},
        }),
        deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveDesignedVoiceDeps['deriveEngineArtifact'],
        writeSidecarManifest: async () => {},
        writeEntry: async () => {},
      },
    });

    /* The exact bracket, proving the trailing coqui evict fired even though
       chapterHasQwenGroups is false: evict qwen -> Mira's coqui derive ->
       evict coqui (ONLY reachable via the F2 OR-condition here) -> the
       narrator's qwen derive. Pre-fix (gate = chapterHasQwenGroups alone)
       this reads ['evict:qwen', 'derive:coqui', 'derive:qwen'] — no
       'evict:coqui' — Coqui would still be resident when the narrator's
       qwen derive/render runs right after. */
    expect(callOrder).toEqual(['evict:qwen', 'derive:coqui', 'evict:coqui', 'derive:qwen']);
    expect(result.segments.length).toBeGreaterThan(0);
  });

  it('F3: a HEALTHY coqui-cloned voice (no derive needed) issues NO evict at all', async () => {
    setLastKnownCoquiInstallState('ready');
    const provider = makeProvider();
    const cast: CastCharacter[] = [
      {
        id: 'wren',
        name: 'Wren',
        gender: 'female',
        overrideTtsVoices: {
          coqui: { name: 'Wren (unused)', libraryUuid: 'lib-wren', provenance: 'cloned' },
        },
      },
    ];
    const entry = {
      voiceUuid: 'lib-wren',
      name: 'Wren clone',
      provenance: 'cloned' as const,
      tags: [],
      pinned: false,
      engines: {}, // no stored version at all -> never reads stale (isArtifactVersionStale's own contract)
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const deriveEngineArtifact = vi.fn();
    const fetchSpy = mockFetchSpy();

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'wren')],
      cast,
      provider,
      modelKey: 'coqui-xtts-v2',
      engine: 'coqui',
      cloneResolverDepsOverride: {
        readEntry: async (uuid: string) => (uuid === 'lib-wren' ? entry : null),
        ptExists: async () => true, // present -> healthy, no derive
        deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveChapterDeps['deriveEngineArtifact'],
      },
    });

    // Placebo-proof: the resolver DID look up and validate the voice
    // (healthy, not skipped) and the chapter DID render on it...
    expect(provider.calls[0]?.voiceName).toBe('xtts-lib-wren');
    expect(result.segments.length).toBeGreaterThan(0);
    // ...but since nothing needed deriving, NOTHING touched the sidecar's
    // /unload — the exact "healthy → no evict" case F3 was about. Pre-fix
    // (evict gated on request EXISTENCE, not derive NECESSITY) this fetch
    // spy would have recorded exactly one 'qwen' unload call here.
    expect(deriveEngineArtifact).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

function mockFetchSpy() {
  return vi.spyOn(global, 'fetch').mockImplementation(async () => new Response(null, { status: 200 }));
}
