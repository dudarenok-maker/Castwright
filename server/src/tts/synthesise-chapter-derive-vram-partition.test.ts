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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { synthesiseChapter, type CastCharacter } from './synthesise-chapter.js';
import {
  UnresolvableClonedVoiceError,
  type ResolveChapterDeps,
  type ResolveDesignedVoiceDeps,
} from './clone-voice-resolver.js';
import type { SentenceOutput } from '../handoff/schemas.js';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from './index.js';
import { setLastKnownCoquiInstallState, _resetUserSettingsCache } from '../workspace/user-settings.js';

/* The phase-evict POST to the sidecar's /unload uses undici's fetch, not the
   global one — it needs a dispatcher so a legitimate 600s queue behind another
   book's synth isn't cut off at undici's hidden 300s headersTimeout (see
   EVICT_DISPATCHER in synthesise-chapter.ts). A global-fetch spy therefore no
   longer observes it. `importOriginal` keeps the real `Agent`, which the
   module constructs at import time. */
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: fetchMock };
});


/* This file exercises BOTH transports and must mock both with the same fn:
   the phase-evict `/unload` goes through undici's fetch (it needs
   EVICT_DISPATCHER so a legitimate 600s queue isn't cut at undici's hidden
   300s cap), while `/qwen/evict-voice` — issued by routes/qwen-voice.ts on a
   3s budget where that cap can never bite — correctly stays on the global
   one. Assertions here span both, so one shared mock keeps them meaningful. */
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
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

/* #1951 — this suite is about ENGINE RESIDENCY: which model is loaded when,
   and the invariant that Qwen and Coqui are never simultaneously resident. It
   asserts exact `callOrder` sequences, so it must only record the calls that
   change residency, i.e. `POST /unload`.

   `global.fetch` is no longer hit solely by `/unload`: the designed self-heal
   now also calls `POST /qwen/evict-voice` after restoring a manifest, to drop
   the sidecar's warm prompt-CACHE entry for one voice. That is a different
   kind of call — it frees no VRAM and unloads no model — and it carries
   `{voiceId}`, not `{engine}`, so an unfiltered mock recorded it as a
   meaningless `evict:undefined` in the middle of these residency sequences.
   Filter on the URL so the sequences keep meaning what they say. The
   prompt-cache evict has its own dedicated coverage in
   `synthesise-chapter-designed-resolver.test.ts`. */
function isEngineUnload(url: unknown): boolean {
  return String(url).endsWith('/unload');
}

/** Tags every sidecar `/unload` call with the engine it targeted. Non-`/unload`
    sidecar traffic (the per-voice prompt-cache evict) is answered 200 and
    deliberately NOT recorded — see the note above. */
function mockEvictFetch(callOrder: string[]): void {
  fetchMock.mockImplementation(async (url, init) => {
    if (!isEngineUnload(url)) return new Response(null, { status: 200 });
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

  it('a qwen-only chapter (NO coqui presence anywhere) issues no coqui load — and no defensive evict either', async () => {
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
    // …but NOTHING ever touched Coqui: no /unload call at all, and the
    // coqui provider is never invoked. Fix round 2's "Important" gate fix
    // (drop `coquiEvict.ok`) is deliberately scoped to books that touch
    // Coqui somewhere (`clonedCoquiRequests`/`designedCoquiRequests` non-
    // empty) — NOT to "any chapter about to use Qwen", which is nearly
    // every chapter in this project (Qwen is the default engine): an
    // unscoped version of that fix broke a plain zero-coqui Qwen chapter
    // (a real regression caught by synthesise-chapter.test.ts's fake-timer
    // batching suite while implementing this round) by issuing a real
    // sidecar round-trip on every single one.
    /* #1951 — narrowed from `expect(fetchSpy).not.toHaveBeenCalled()`, which
       is no longer the right expression of the intent above. That intent is
       "no ENGINE round-trip": no `/unload`, defensive or otherwise, on a
       chapter that never touches Coqui. It is specifically guarding against a
       PER-CHAPTER cost on what is nearly every chapter in this project.

       The designed self-heal now also issues `POST /qwen/evict-voice` to drop
       the sidecar's warm prompt-cache entry for the voice it just re-derived,
       so the manifest it restored is what the next synth reads. That is not
       the cost this test exists to prevent: it is per-SELF-HEAL, not
       per-chapter, and it only happens because `derive:qwen` above actually
       ran. A chapter with no derive still makes no sidecar call at all.

       So: assert no `/unload` reached the sidecar (the real invariant), and
       pin that the only call made is the evict belonging to that one derive —
       which also keeps this test failing if the evict ever becomes
       unconditional. */
    const unloadCalls = fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/unload'));
    expect(unloadCalls).toHaveLength(0);
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
      'http://localhost:9000/qwen/evict-voice',
    ]);
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
    fetchMock.mockResolvedValue(new Response(null, { status: 502, statusText: 'Bad Gateway' }));

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
    fetchMock.mockResolvedValue(new Response(null, { status: 502, statusText: 'Bad Gateway' }));

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
      { name: 'Nova', reason: 'derive-failed', engine: 'coqui' },
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

/* fs-38 Wave 3c, Task 22 fix round 2 — review findings: a NEW-CRITICAL
   (the trailing evict, `evictCoquiForQwenPhase`, had no enclosing try/catch
   ANYWHERE in the function — the exact mirror of round 1's F1, just on the
   qwen side) and an Important gate fix (dropped the `coquiEvict.ok`-only
   condition, which under-covered the cross-chapter "prior chapter left
   Coqui resident, this chapter only has HEALTHY coqui clones" case). */
function mockFailingCoquiUnloadFetch(callOrder: string[]) {
  return fetchMock.mockImplementation(async (url, init) => {
    /* #1951 — same URL filter as mockEvictFetch: only `/unload` changes
       residency, and only `/unload` should fail here. */
    if (!isEngineUnload(url)) return new Response(null, { status: 200 });
    const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')) as {
      engine?: string;
    };
    if (body.engine === 'coqui') {
      callOrder.push('evict:coqui:FAILED');
      return new Response(null, { status: 502, statusText: 'Bad Gateway' });
    }
    callOrder.push(`evict:${body.engine}`);
    return new Response(null, { status: 200 });
  });
}

describe('synthesiseChapter — engine-partitioned derive pre-pass, fix round 2 (fs-38 Wave 3c, Task 22)', () => {
  it('NEW-CRITICAL: a failed TRAILING evict stays fail-SOFT for a designed qwen derive — the chapter still completes', async () => {
    const provider = makeProvider();
    const callOrder: string[] = [];
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
        id: 'orin',
        name: 'Orin',
        gender: 'male',
        ttsEngine: 'qwen', // pinned off the book's coqui default, so she actually routes to qwen
        overrideTtsVoices: {
          qwen: { name: 'Orin (unused)', libraryUuid: 'lib-orin', provenance: 'designed' },
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
    mockFailingCoquiUnloadFetch(callOrder); // leading (qwen) evict succeeds; TRAILING (coqui) evict 502s.

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'mira'), sentence(2, 'orin')],
      cast,
      provider,
      modelKey: 'coqui-xtts-v2',
      engine: 'coqui',
      resolveForEngine: (e) =>
        e === 'qwen'
          ? { provider, modelKey: 'qwen3-tts-0.6b' as const }
          : { provider, modelKey: 'coqui-xtts-v2' as const },
      designedResolverDepsOverride: {
        readEntry: async (uuid: string) => (uuid === 'lib-mira' ? miraEntry : null),
        ptExists: async () => false, // both Mira's coqui slot and Orin's qwen slot are missing
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

    // Mira's coqui derive DID happen (we got past the leading evict fine —
    // this pins the TRAILING evict specifically, not a repeat of F1).
    expect(deriveEngineArtifact).toHaveBeenCalledWith('lib-mira', 'coqui', expect.anything(), expect.anything());
    // Orin's qwen derive never ran: the trailing evict's failure is caught
    // by the designed resolver's own fail-soft catch (never rethrown) —
    // pre-fix, the bare unguarded `await evictCoquiForQwenPhase()` would
    // have thrown straight out of `synthesiseChapter` here instead.
    expect(deriveEngineArtifact).not.toHaveBeenCalledWith('lib-orin', 'qwen', expect.anything(), expect.anything());
    expect(callOrder).toContain('evict:coqui:FAILED');
    expect(result.segments.length).toBeGreaterThan(0);
  });

  it('NEW-CRITICAL: a failed TRAILING evict still raises for a cloned qwen derive (fail-loud policy unchanged)', async () => {
    const provider = makeProvider();
    const callOrder: string[] = [];
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
        id: 'nova',
        name: 'Nova',
        gender: 'female',
        ttsEngine: 'qwen', // pinned off the book's coqui default, so she actually routes to qwen
        overrideTtsVoices: {
          qwen: { name: 'Nova (unused)', libraryUuid: 'lib-nova', provenance: 'cloned' },
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
    const novaEntry = {
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
    mockFailingCoquiUnloadFetch(callOrder);

    let thrown: unknown;
    try {
      await synthesiseChapter({
        sentences: [sentence(1, 'mira'), sentence(2, 'nova')],
        cast,
        provider,
        modelKey: 'coqui-xtts-v2',
        engine: 'coqui',
        resolveForEngine: (e) =>
          e === 'qwen'
            ? { provider, modelKey: 'qwen3-tts-0.6b' as const }
            : { provider, modelKey: 'coqui-xtts-v2' as const },
        designedResolverDepsOverride: {
          readEntry: async (uuid: string) => (uuid === 'lib-mira' ? miraEntry : null),
          ptExists: async () => false,
          readDesignedMasterPcm: async () => ({
            pcm: Buffer.alloc(1000),
            sampleRate: 24000,
            refText: '',
            manifest: {},
          }),
          deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveDesignedVoiceDeps['deriveEngineArtifact'],
          writeEntry: async () => {},
        },
        cloneResolverDepsOverride: {
          readEntry: async (uuid: string) => (uuid === 'lib-nova' ? novaEntry : null),
          writeEntry: async () => {},
          ptExists: async () => false,
          readMasterPcm: async () => ({
            pcm: Buffer.alloc(1000),
            sampleRate: 24000,
            refText: 'A retained reference clip.',
          }),
          deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveChapterDeps['deriveEngineArtifact'],
          currentArtifactVersion: () => 'qwen3-tts-0.6b',
        },
      });
    } catch (e) {
      thrown = e;
    }

    // Mira's coqui derive DID happen — the failure pins the TRAILING evict.
    expect(deriveEngineArtifact).toHaveBeenCalledWith('lib-mira', 'coqui', expect.anything(), expect.anything());
    expect(thrown).toBeInstanceOf(UnresolvableClonedVoiceError);
    expect((thrown as InstanceType<typeof UnresolvableClonedVoiceError>).broken).toEqual([
      { name: 'Nova', reason: 'derive-failed', engine: 'qwen' },
    ]);
    expect(deriveEngineArtifact).not.toHaveBeenCalledWith('lib-nova', 'qwen', expect.anything(), expect.anything());
  });

  it('Important: a chapter with only HEALTHY coqui clones + a qwen derive still evicts Coqui (the cross-chapter gap coquiEvict.ok left open)', async () => {
    setLastKnownCoquiInstallState('ready');
    const provider = makeProvider();
    const callOrder: string[] = [];
    const cast: CastCharacter[] = [
      {
        id: 'wren',
        name: 'Wren',
        gender: 'female',
        overrideTtsVoices: {
          coqui: { name: 'Wren (unused)', libraryUuid: 'lib-wren', provenance: 'cloned' },
        },
      },
      {
        id: 'orin',
        name: 'Orin',
        gender: 'male',
        ttsEngine: 'qwen', // pinned off the book's coqui default, so she actually routes to qwen
        overrideTtsVoices: {
          qwen: { name: 'Orin (unused)', libraryUuid: 'lib-orin', provenance: 'designed' },
        },
      },
    ];
    const wrenEntry = {
      voiceUuid: 'lib-wren',
      name: 'Wren clone',
      provenance: 'cloned' as const,
      tags: [],
      pinned: false,
      engines: {}, // no stored version -> never stale; ptExists true below -> healthy.
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const cloneDeriveEngineArtifact = vi.fn(); // must NEVER be called — Wren is healthy.
    const deriveEngineArtifact = mockDeriveEngineArtifact(callOrder); // Orin's qwen self-heal only.
    mockEvictFetch(callOrder);

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'wren'), sentence(2, 'orin')],
      cast,
      provider,
      modelKey: 'coqui-xtts-v2',
      engine: 'coqui',
      resolveForEngine: (e) =>
        e === 'qwen'
          ? { provider, modelKey: 'qwen3-tts-0.6b' as const }
          : { provider, modelKey: 'coqui-xtts-v2' as const },
      cloneResolverDepsOverride: {
        readEntry: async (uuid: string) => (uuid === 'lib-wren' ? wrenEntry : null),
        ptExists: async () => true, // HEALTHY — no derive, no leading evict either.
        deriveEngineArtifact: cloneDeriveEngineArtifact as unknown as ResolveChapterDeps['deriveEngineArtifact'],
      },
      designedResolverDepsOverride: {
        ptExists: async () => false,
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

    // Wren really was healthy — no derive, proving the evict below is NOT
    // explained by a same-chapter coqui derive (the `coquiEvict.ok` case
    // round 1 already covered); this pins the gap round 1 left open.
    expect(cloneDeriveEngineArtifact).not.toHaveBeenCalled();
    // Coqui STILL gets evicted ahead of Orin's qwen derive, because Wren's
    // request proves this chapter has coqui presence at all — pre-fix
    // (`coquiEvict.ok` required a real derive to have SUCCEEDED THIS
    // chapter) this would read ['derive:qwen'] with no 'evict:coqui' at
    // all, leaving XTTS-if-resident-from-a-prior-chapter unevicted.
    expect(callOrder).toEqual(['evict:coqui', 'derive:qwen']);
    expect(result.segments.length).toBeGreaterThan(0);
  });

  it('Test gap: TWO designed coqui derives in one chapter cost exactly ONE evict:qwen, not two', async () => {
    const provider = makeProvider();
    const callOrder: string[] = [];
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
        id: 'luca',
        name: 'Luca',
        gender: 'male',
        overrideTtsVoices: {
          coqui: { name: 'xtts-lib-luca', libraryUuid: 'lib-luca', provenance: 'designed' },
        },
      },
    ];
    const entryFor = (uuid: string, name: string) => ({
      voiceUuid: uuid,
      name,
      provenance: 'designed' as const,
      tags: [],
      pinned: false,
      engines: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const deriveEngineArtifact = mockDeriveEngineArtifact(callOrder);
    mockEvictFetch(callOrder);

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'mira'), sentence(2, 'luca')],
      cast,
      provider,
      modelKey: 'coqui-xtts-v2',
      engine: 'coqui',
      designedResolverDepsOverride: {
        readEntry: async (uuid: string) =>
          uuid === 'lib-mira' ? entryFor('lib-mira', 'Mira') : uuid === 'lib-luca' ? entryFor('lib-luca', 'Luca') : null,
        ptExists: async () => false, // both missing — both repairable
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

    // Placebo-proof against deleting the memoisation: BOTH voices really
    // derived (2 derive:coqui entries) — a naive `beforeFirstCoquiDerive =
    // () => evictQwenForCoquiPhase()` (no memoisation at all) would ALSO
    // pass a test that only checks "at least one evict" — the exact-count
    // check below is what only the memoised version satisfies.
    expect(callOrder.filter((c) => c === 'derive:coqui')).toHaveLength(2);
    expect(callOrder.filter((c) => c === 'evict:qwen')).toHaveLength(1);
    expect(result.segments.length).toBeGreaterThan(0);
  });

  it('Test gap: a cloned + a designed coqui derive in one chapter still cost exactly ONE evict:qwen (cross-arm reuse)', async () => {
    setLastKnownCoquiInstallState('ready');
    const provider = makeProvider();
    const callOrder: string[] = [];
    const cast: CastCharacter[] = [
      {
        id: 'nova',
        name: 'Nova',
        gender: 'female',
        overrideTtsVoices: {
          coqui: { name: 'Nova (unused)', libraryUuid: 'lib-nova', provenance: 'cloned' },
        },
      },
      {
        id: 'mira',
        name: 'Mira',
        gender: 'female',
        overrideTtsVoices: {
          coqui: { name: 'xtts-lib-mira', libraryUuid: 'lib-mira', provenance: 'designed' },
        },
      },
    ];
    const novaEntry = {
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
      sentences: [sentence(1, 'nova'), sentence(2, 'mira')],
      cast,
      provider,
      modelKey: 'coqui-xtts-v2',
      engine: 'coqui',
      cloneResolverDepsOverride: {
        readEntry: async (uuid: string) => (uuid === 'lib-nova' ? novaEntry : null),
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
      designedResolverDepsOverride: {
        readEntry: async (uuid: string) => (uuid === 'lib-mira' ? miraEntry : null),
        ptExists: async () => false,
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

    // Cloned resolver runs FIRST (clonedCoquiRequests before
    // designedCoquiRequests) — Nova's derive pays for the evict; Mira's
    // designed derive (a DIFFERENT resolver call) reuses the SAME memoised
    // promise instead of issuing a second one.
    expect(callOrder).toEqual(['evict:qwen', 'derive:coqui', 'derive:coqui']);
    expect(result.segments.length).toBeGreaterThan(0);
  });
});

/* [#1894] — the RENDER-phase half of the eviction symmetry.
   `synthGroupsSerialized` evicted Qwen for the Coqui phase but never the
   reverse, so XTTS (~3.5 GB) stayed resident for the rest of the render.

   Asserted as a SEQUENCE, in the same shared `callOrder` array the rest of
   this file uses, for the reason the file header already gives: an
   end-state assertion ("fetch was eventually called with engine coqui")
   passes for an implementation that evicts at the WRONG moment — before the
   Coqui groups, say, which would unload the model those groups need. Only
   the ordering distinguishes correct from merely-present. Synth calls are
   tagged into the same array so the evict's position relative to the LAST
   Coqui synth is visible, not just its position relative to the other
   evict. */
describe('[#1894] render phase evicts Coqui once its groups are done', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _resetUserSettingsCache();
  });

  /** A provider that tags every synth into the shared `callOrder`. No clone
      or library voices anywhere in this chapter — the pre-pass issues zero
      derives and zero evicts, so every entry below comes from the render
      path this test is about. */
  function taggingProvider(callOrder: string[], engine: string): TtsProvider {
    return {
      async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
        callOrder.push(`synth:${engine}`);
        void input;
        return { pcm: Buffer.alloc(4800, 0), sampleRate: 24000, mimeType: 'audio/pcm' };
      },
    };
  }

  /* Orin carries a plain DESIGNED qwen name (no libraryUuid, no
     provenance) so `pickVoiceForEngine('qwen', …)` resolves non-empty.
     Without it `applyQwenFallback`'s `needsFallback` fires on the empty
     voiceName and reroutes him to Kokoro — the chapter then mixes
     coqui+kokoro, `synthGroupsSerialized` short-circuits, and this suite
     would silently test nothing. Neither character touches the voice
     library, so the pre-pass issues zero derives and zero evicts: every
     entry in `callOrder` comes from the render path. */
  const mixedCast: CastCharacter[] = [
    { id: 'nova', name: 'Nova', gender: 'female', ttsEngine: 'coqui' },
    {
      id: 'orin',
      name: 'Orin',
      gender: 'male',
      ttsEngine: 'qwen',
      overrideTtsVoices: { qwen: { name: 'Orin Designed' } },
    },
  ];

  it('a mixed qwen+coqui chapter ends its Coqui phase with an `evict:coqui`, AFTER the last coqui synth', async () => {
    const callOrder: string[] = [];
    mockEvictFetch(callOrder);
    const qwenProvider = taggingProvider(callOrder, 'qwen');
    const coquiProvider = taggingProvider(callOrder, 'coqui');
    const resolveForEngine = (e: string) =>
      e === 'coqui'
        ? { provider: coquiProvider, modelKey: 'coqui-xtts-v2' as const }
        : { provider: qwenProvider, modelKey: 'qwen3-tts-0.6b' as const };

    await synthesiseChapter({
      // groups[0] (Nova) is the standalone anchor — it renders BEFORE
      // synthGroupsSerialized is reached, so `groups.slice(1)` is
      // [orin(qwen), nova(coqui), orin(qwen)]: genuinely mixed.
      sentences: [sentence(1, 'nova'), sentence(2, 'orin'), sentence(3, 'nova'), sentence(4, 'orin')],
      cast: mixedCast,
      provider: qwenProvider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      resolveForEngine,
    });

    // The anchor renders first, outside the wrapper. Then the wrapper:
    // pre-evict (qwen) groups, evict qwen, coqui groups, evict coqui.
    expect(callOrder).toEqual([
      'synth:coqui', // anchor
      'synth:qwen',
      'synth:qwen',
      'evict:qwen',
      'synth:coqui',
      'evict:coqui',
    ]);
  });

  it('a failed trailing evict never destroys the finished chapter (fail-soft)', async () => {
    const callOrder: string[] = [];
    /* Only the TRAILING evict fails — a sidecar recycle landing between the
       two. Every group is already synthesised at that point, so a throw here
       would discard completed work purely to free VRAM. */
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')) as {
        engine?: string;
      };
      callOrder.push(`evict:${body.engine}`);
      if (body.engine === 'coqui') throw new Error('ECONNREFUSED');
      return new Response(null, { status: 200 });
    });
    const qwenProvider = taggingProvider(callOrder, 'qwen');
    const coquiProvider = taggingProvider(callOrder, 'coqui');
    const resolveForEngine = (e: string) =>
      e === 'coqui'
        ? { provider: coquiProvider, modelKey: 'coqui-xtts-v2' as const }
        : { provider: qwenProvider, modelKey: 'qwen3-tts-0.6b' as const };

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'nova'), sentence(2, 'orin'), sentence(3, 'nova'), sentence(4, 'orin')],
      cast: mixedCast,
      provider: qwenProvider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      resolveForEngine,
    });

    expect(callOrder).toContain('evict:coqui'); // it was attempted…
    expect(result.segments).toHaveLength(4); // …and every segment survived it.
  });

  it('a single-engine chapter still never evicts at all (the over-trigger guard #1894 warns about)', async () => {
    const callOrder: string[] = [];
    mockEvictFetch(callOrder);
    const qwenProvider = taggingProvider(callOrder, 'qwen');

    await synthesiseChapter({
      sentences: [sentence(1, 'orin'), sentence(2, 'orin'), sentence(3, 'orin')],
      cast: mixedCast,
      provider: qwenProvider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
    });

    expect(callOrder.filter((c) => c.startsWith('evict:'))).toEqual([]);
  });
});

function mockFetchSpy() {
  return fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
}
