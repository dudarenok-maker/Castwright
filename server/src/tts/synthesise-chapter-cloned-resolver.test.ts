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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synthesiseChapter, type CastCharacter } from './synthesise-chapter.js';
import { UnresolvableClonedVoiceError, type ResolveChapterDeps } from './clone-voice-resolver.js';
import type { VoiceLibraryEntry } from '../workspace/voice-library.js';
import type { SentenceOutput } from '../handoff/schemas.js';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from './index.js';
import {
  setLastKnownCoquiInstallState,
  _resetUserSettingsCache,
} from '../workspace/user-settings.js';

afterEach(() => {
  vi.restoreAllMocks();
  // fs-38 Wave 3c, Task 20 — several cases below flip the module-level coqui
  // install-state singleton (Task 19's store) so `engineUnavailableFor('coqui')`
  // reads 'ready'; reset it so that never leaks into a later test/file.
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
        currentArtifactVersion: () => 'qwen3-tts-0.6b',
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

  it('Task 6b: a cloned character routed to a non-qwen engine (book default) rejects as wrong-engine, with ZERO synth calls', async () => {
    // 'wren' carries no per-character `ttsEngine`, so she rides the run's
    // default engine — here that's 'kokoro', NOT 'qwen'. Her cloned qwen
    // slot therefore can never actually render: the character simply isn't
    // routed to Qwen this run. Qwen itself is untouched (qwenUnavailable is
    // left at its default false) — this must be diagnosed as 'wrong-engine',
    // not 'engine-unavailable', which would misleadingly suggest Qwen is down.
    const provider = makeProvider();
    const readEntry = vi.fn(async (uuid: string) =>
      uuid === 'lib-clone' ? baseEntry() : null,
    );
    const deriveEngineArtifact = vi.fn();

    let thrown: UnresolvableClonedVoiceError | undefined;
    try {
      await synthesiseChapter({
        sentences: [sentence(1, 'wren')],
        cast: clonedCast,
        provider,
        modelKey: 'kokoro-v1',
        engine: 'kokoro',
        cloneResolverDepsOverride: {
          readEntry,
          deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveChapterDeps['deriveEngineArtifact'],
        },
      });
    } catch (e) {
      thrown = e as UnresolvableClonedVoiceError;
    }

    expect(thrown).toBeInstanceOf(UnresolvableClonedVoiceError);
    expect(thrown?.broken).toEqual([{ name: 'Wren', reason: 'wrong-engine' }]);
    expect(provider.calls).toHaveLength(0);
    expect(deriveEngineArtifact).not.toHaveBeenCalled();
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

/* fs-38 Wave 3c, Task 20 [ADV-C1] — the load-bearing generalisation: the
   pre-pass filter above (`clonedVoiceRequests` in synthesise-chapter.ts) was,
   until this task, a literal `engine: 'qwen'` — every coqui code path this
   whole wave built (Tasks 7-19) was capable but UNREACHABLE from
   `synthesiseChapter`. This suite proves the coqui arm is now live: a healthy
   coqui clone validates and renders; a coqui-routed clone with no coqui slot
   fails loud (never a stock catalogue voice); an all-non-cloned chapter never
   touches the resolver at all; and — the brief's explicit ask — one test per
   Phase-0 upstream mutator (Tasks 3/4/5/6) proving a clone marker those tasks
   preserve actually reaches (and is correctly classified by) this pre-pass. */
describe('synthesiseChapter — cloned-voice resolver pre-pass, coqui generalisation (fs-38 Wave 3c Task 20)', () => {
  it('a cloned coqui slot is validated by the pre-pass and renders normally (healthy, no derive)', async () => {
    setLastKnownCoquiInstallState('ready'); // Task 19 signal — coqui usable this run
    const provider = makeProvider();
    const coquiCloned: CastCharacter[] = [
      {
        id: 'wren',
        name: 'Wren',
        gender: 'female',
        overrideTtsVoices: {
          coqui: { name: 'Wren (unused)', libraryUuid: 'lib-coqui-1', provenance: 'cloned' },
        },
      },
    ];
    const entry = baseEntry({ voiceUuid: 'lib-coqui-1' });
    const readEntry = vi.fn(async (uuid: string) => (uuid === 'lib-coqui-1' ? entry : null));

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'wren')],
      cast: coquiCloned,
      provider,
      modelKey: 'coqui-xtts-v2',
      engine: 'coqui',
      cloneResolverDepsOverride: { readEntry, ptExists: async () => true },
    });

    // Placebo-proof: the resolver DID look up the coqui uuid (the union
    // filter reached it), the voice resolved to the storage key (never the
    // display `name`, never a catalog pick — pickVoiceForEngine's coqui
    // branch), and the chapter actually rendered.
    expect(readEntry).toHaveBeenCalledWith('lib-coqui-1');
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(provider.calls[0].voiceName).toBe('xtts-lib-coqui-1');
    expect(result.segments.length).toBeGreaterThan(0);
  });

  /* fs-38 Wave 3c, Task 20 fix round 1 (MINOR-2) — split from a single `for`
     loop into `it.each` so a whole-feature revert (or any other regression)
     reports EACH malformed-uuid sub-case's pass/fail independently instead
     of the suite stopping at the first failing iteration and leaving the
     other two unproven for that run. Under the pre-Task-20 baseline all
     three fail — a coqui-only-cloned character never even entered the old
     qwen-only filter (`c.overrideTtsVoices?.qwen?.provenance === 'cloned'`),
     so the specific malformation of `.coqui.libraryUuid` was never reached
     regardless of shape — confirmed by running each case individually
     against that baseline (task-20-report.md, "Fix round 1"). */
  it.each([
    ['empty', { name: 'Real Person Clone', libraryUuid: '', provenance: 'cloned' as const }],
    ['missing', { name: 'Real Person Clone', provenance: 'cloned' as const }],
    [
      'truthy non-string (data corruption)',
      {
        name: 'Real Person Clone',
        libraryUuid: 12345 as unknown as string,
        provenance: 'cloned' as const,
      },
    ],
  ])(
    'Property-1 hole (Task 16 review) — a cloned coqui slot with a malformed libraryUuid (%s) hard-fails loud, never falls through to a stock catalogue voice',
    async (_label, malformed) => {
      // Task 16's pinning test (voice-mapping.test.ts) proves pickVoiceForEngine
      // itself — a pure, synchronous function with no way to check whether an
      // artifact exists — still falls through to the human-readable `name` for
      // a malformed libraryUuid; that is unchanged and by design. What Task 20
      // closes is that `synthesiseChapter`'s pre-pass now hard-fails the WHOLE
      // chapter BEFORE pickVoiceForEngine('coqui', ...) is ever reached for
      // such a character in production: `libraryUuid` is extracted here via
      // `libraryVoiceForEngine` (the same RESOLUTION predicate pickVoiceForEngine
      // gates on), so a malformed uuid resolves to `undefined` and
      // `resolveClonedVoicesForChapter`'s existing `!libraryUuid` guard reports
      // 'misconfigured' — never silently rendering the catalogue pick.
      //
      // The 'truthy non-string' case is the one that actually distinguishes
      // this fix from the pre-existing `!libraryUuid` check alone: `''`/missing
      // are already falsy and would hard-fail even via a raw `.libraryUuid`
      // read; a truthy non-string (the type system declares `libraryUuid?:
      // string`, but nothing enforces that on disk) is NOT falsy, so a raw
      // read would sail straight through to `readEntry(<garbage>)`. Only
      // routing extraction through `libraryVoiceForEngine`'s `typeof
      // libraryUuid !== 'string'` check catches it.
      const provider = makeProvider();
      const cast: CastCharacter[] = [
        { id: 'wren', name: 'Wren', overrideTtsVoices: { coqui: malformed } },
      ];
      const readEntry = vi.fn();

      let thrown: UnresolvableClonedVoiceError | undefined;
      try {
        await synthesiseChapter({
          sentences: [sentence(1, 'wren')],
          cast,
          provider,
          modelKey: 'coqui-xtts-v2',
          engine: 'coqui',
          cloneResolverDepsOverride: { readEntry: readEntry as unknown as ResolveChapterDeps['readEntry'] },
        });
      } catch (e) {
        thrown = e as UnresolvableClonedVoiceError;
      }

      expect(thrown).toBeInstanceOf(UnresolvableClonedVoiceError);
      expect(thrown?.broken).toEqual([{ name: 'Wren', reason: 'misconfigured' }]);
      // Never even reaches the voice-library lookup, and never a stock voice.
      expect(readEntry).not.toHaveBeenCalled();
      expect(provider.calls).toHaveLength(0);
    },
  );

  it('a coqui-routed clone with no coqui slot fails loud as wrong-engine — never a catalog voice', async () => {
    // 'wren' is cloned on QWEN only, but THIS run's book default is 'coqui'
    // (no per-character ttsEngine override, so she rides it). Before Task 20
    // this character never entered the pre-pass at all (the old filter only
    // recognised a qwen-cloned+qwen-routed slot); now the union filter picks
    // her up, resolves to her qwen entry (for the revoked check), and must
    // still hard-fail — a coqui-routed render must NEVER fall through
    // pickVoiceForEngine('coqui', ...) to a stock catalogue pick just because
    // her clone lives on the other engine.
    const provider = makeProvider();
    const cast: CastCharacter[] = [
      {
        id: 'wren',
        name: 'Wren',
        overrideTtsVoices: {
          qwen: { name: 'Wren (unused)', libraryUuid: 'lib-clone', provenance: 'cloned' },
        },
      },
    ];
    const readEntry = vi.fn(async (uuid: string) => (uuid === 'lib-clone' ? baseEntry() : null));
    const deriveEngineArtifact = vi.fn();

    let thrown: UnresolvableClonedVoiceError | undefined;
    try {
      await synthesiseChapter({
        sentences: [sentence(1, 'wren')],
        cast,
        provider,
        modelKey: 'coqui-xtts-v2',
        engine: 'coqui',
        cloneResolverDepsOverride: {
          readEntry,
          deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveChapterDeps['deriveEngineArtifact'],
        },
      });
    } catch (e) {
      thrown = e as UnresolvableClonedVoiceError;
    }

    expect(thrown).toBeInstanceOf(UnresolvableClonedVoiceError);
    expect(thrown?.broken).toEqual([{ name: 'Wren', reason: 'wrong-engine' }]);
    expect(provider.calls).toHaveLength(0); // never a catalog voice
    expect(deriveEngineArtifact).not.toHaveBeenCalled();
  });

  it('a chapter with no clones at all runs the resolver pre-pass zero times', async () => {
    const provider = makeProvider();
    const cast: CastCharacter[] = [
      { id: 'wren', name: 'Wren', gender: 'female' },
      { id: 'other', name: 'Other', gender: 'male' },
    ];
    const readEntry = vi.fn(async () => {
      throw new Error('resolver must not run when nothing in the cast is cloned');
    });

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'wren'), sentence(2, 'other')],
      cast,
      provider,
      modelKey: 'coqui-xtts-v2',
      engine: 'coqui',
      cloneResolverDepsOverride: { readEntry: readEntry as unknown as ResolveChapterDeps['readEntry'] },
    });

    expect(readEntry).not.toHaveBeenCalled();
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(result.segments.length).toBeGreaterThan(0);
  });

  /* --- one test per Phase-0 upstream mutator (Tasks 3/4/5/6) ------------
     Each proves TWO things in one test: (1) the real, unmodified mutator
     function this branch shipped earlier in the wave genuinely preserves a
     clone marker in the scenario its own fix protects (calling the actual
     exported function, not a re-implementation of its guard), and (2) the
     SURVIVING character then reaches and is correctly classified by THIS
     task's (now coqui-capable) pre-pass — the specific continuity Task 20
     closes, since before it a preserved coqui marker still had nowhere to
     go. */

  it('Task 3 (verify-designed-voice-language.clearMismatchedDesignedVoices) — a qwen-cloned marker survives the language-clear sweep and still validates in the pre-pass', async () => {
    const { clearMismatchedDesignedVoices } = await import('./verify-designed-voice-language.js');
    const cast: CastCharacter[] = [
      {
        id: 'wren',
        name: 'Wren',
        overrideTtsVoices: {
          qwen: { name: 'Wren (unused)', libraryUuid: 'lib-qwen-t3', provenance: 'cloned' },
        },
      },
    ];

    // Task 3's own bug: pre-fix, this deleted `overrideTtsVoices.qwen` on any
    // language mismatch because it resolved the wrong manifest path for a
    // cloned voice. Real call, real mutation-in-place.
    const cleared = await clearMismatchedDesignedVoices(cast, 'russian', 'ru');
    expect(cleared).toEqual([]);
    expect(cast[0].overrideTtsVoices?.qwen).toEqual({
      name: 'Wren (unused)',
      libraryUuid: 'lib-qwen-t3',
      provenance: 'cloned',
    });

    const provider = makeProvider();
    const entry = baseEntry({ voiceUuid: 'lib-qwen-t3' });
    const readEntry = vi.fn(async (uuid: string) => (uuid === 'lib-qwen-t3' ? entry : null));
    const result = await synthesiseChapter({
      sentences: [sentence(1, 'wren')],
      cast,
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      cloneResolverDepsOverride: { readEntry, ptExists: async () => true },
    });
    expect(readEntry).toHaveBeenCalledWith('lib-qwen-t3');
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(provider.calls[0].voiceName).toBe('qwen-lib-qwen-t3');
    expect(result.segments.length).toBeGreaterThan(0);
  });

  it('Task 4 (voice-override-linked.applyToBook, driven for real) — a coqui-cloned character blocks BOTH the SET and the CLEAR rebaseline write, and the untouched-on-disk marker still validates in the pre-pass', async () => {
    // fs-38 Wave 3c, Task 20 fix round 1 (MINOR-1) — the earlier version of
    // this test re-stated applyToBook's own predicates
    // (characterHasClonedSlot/hasClonedProvenance) next to a fixture built
    // one line earlier: a tautology that would stay green even if the route
    // collapsed onto the uuid-validating clonedSlotForEngine (the exact
    // substitution-bug regression 5 reviewers have proposed on this branch).
    // This drives the REAL exported applyToBook (voice-override-linked.ts)
    // against a real temp bookDir + cast.json on disk — the same mutator
    // Tasks 3/5/6's tests drive for their own guards.
    const { applyToBook } = await import('../routes/voice-override-linked.js');
    const bookDir = mkdtempSync(join(tmpdir(), 'task20-fixround1-task4-'));
    const castPath = join(bookDir, '.audiobook', 'cast.json');
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
    const clonedSlot = { name: 'Wren (unused)', libraryUuid: 'lib-coqui-t4', provenance: 'cloned' as const };
    writeFileSync(
      castPath,
      JSON.stringify({
        characters: [{ id: 'wren', name: 'Wren', overrideTtsVoices: { coqui: clonedSlot } }],
      }),
    );

    try {
      // CLEAR path (override === null) refuses.
      await expect(applyToBook(bookDir, ['wren'], 'canonical-voice-id', undefined, null)).rejects.toThrow(
        /consented cloned voice/,
      );
      // SET path (override.engine === 'coqui') refuses too.
      await expect(
        applyToBook(bookDir, ['wren'], 'canonical-voice-id', undefined, {
          engine: 'coqui',
          name: 'Someone Else',
        }),
      ).rejects.toThrow(/consented cloned voice/);

      // Both refusals happen BEFORE any write (applyToBook checks every
      // targeted character up front) — cast.json on disk must be
      // byte-identical to what was written above.
      const onDisk = JSON.parse(readFileSync(castPath, 'utf8')) as {
        characters: Array<{ overrideTtsVoices?: { coqui?: typeof clonedSlot } }>;
      };
      expect(onDisk.characters[0].overrideTtsVoices?.coqui).toEqual(clonedSlot);

      setLastKnownCoquiInstallState('ready');
      const provider = makeProvider();
      const entry = baseEntry({ voiceUuid: 'lib-coqui-t4' });
      const readEntry = vi.fn(async (uuid: string) => (uuid === 'lib-coqui-t4' ? entry : null));
      const cast: CastCharacter[] = [
        { id: 'wren', name: 'Wren', overrideTtsVoices: onDisk.characters[0].overrideTtsVoices },
      ];
      const result = await synthesiseChapter({
        sentences: [sentence(1, 'wren')],
        cast,
        provider,
        modelKey: 'coqui-xtts-v2',
        engine: 'coqui',
        cloneResolverDepsOverride: { readEntry, ptExists: async () => true },
      });
      expect(readEntry).toHaveBeenCalledWith('lib-coqui-t4');
      expect(provider.calls.length).toBeGreaterThan(0);
      expect(provider.calls[0].voiceName).toBe('xtts-lib-coqui-t4');
      expect(result.segments.length).toBeGreaterThan(0);
    } finally {
      rmSync(bookDir, { recursive: true, force: true });
    }
  });

  it('Task 4, malformed-libraryUuid case — the SET/CLEAR guard still refuses a cloned slot with NO usable uuid (closes the M2 gap; the one input that actually distinguishes the fail-safe guard from the collapse onto clonedSlotForEngine)', async () => {
    // The prior test's fixture uses a WELL-FORMED libraryUuid, so it can't
    // tell characterHasClonedSlot/hasClonedProvenance (provenance-only, fail
    // safe) apart from clonedSlotForEngine (uuid-validating) — both agree on
    // a well-formed uuid. This is the one input where they diverge: a
    // malformed (missing) libraryUuid still counts as cloned for the
    // fail-safe pair, but clonedSlotForEngine would return undefined for it,
    // making `blocked` false and letting the write through — the exact
    // silent-substitution regression the M2 minor-roll-up flagged as
    // untested on this route's SET path.
    const { applyToBook } = await import('../routes/voice-override-linked.js');
    const bookDir = mkdtempSync(join(tmpdir(), 'task20-fixround1-task4-malformed-'));
    const castPath = join(bookDir, '.audiobook', 'cast.json');
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
    const malformedClonedSlot = { name: 'Wren (unused)', provenance: 'cloned' as const }; // no libraryUuid
    writeFileSync(
      castPath,
      JSON.stringify({
        characters: [{ id: 'wren', name: 'Wren', overrideTtsVoices: { coqui: malformedClonedSlot } }],
      }),
    );

    try {
      await expect(applyToBook(bookDir, ['wren'], 'canonical-voice-id', undefined, null)).rejects.toThrow(
        /consented cloned voice/,
      );
      await expect(
        applyToBook(bookDir, ['wren'], 'canonical-voice-id', undefined, {
          engine: 'coqui',
          name: 'Someone Else',
        }),
      ).rejects.toThrow(/consented cloned voice/);

      const onDisk = JSON.parse(readFileSync(castPath, 'utf8')) as {
        characters: Array<{ overrideTtsVoices?: { coqui?: typeof malformedClonedSlot } }>;
      };
      expect(onDisk.characters[0].overrideTtsVoices?.coqui).toEqual(malformedClonedSlot);
    } finally {
      rmSync(bookDir, { recursive: true, force: true });
    }
  });

  it('Task 5 (hydrate-reused-voice.hydrateCharacterVoice) — a coqui-cloned reused character is not rerouted onto the source’s qwen slot, and still validates in the pre-pass', async () => {
    const { hydrateCharacterVoice } = await import('./hydrate-reused-voice.js');
    const character = {
      id: 'wren',
      name: 'Wren',
      matchedFrom: { bookId: 'book-a', characterId: 'wren-a' },
      overrideTtsVoices: {
        coqui: { name: 'Wren (unused)', libraryUuid: 'lib-coqui-t5', provenance: 'cloned' as const },
      },
    };
    const load = vi.fn(async (bookId: string) =>
      bookId === 'book-a'
        ? [
            {
              id: 'wren-a',
              ttsEngine: 'qwen' as const,
              overrideTtsVoices: { qwen: { name: 'qwen-source-designed-voice' } },
            },
          ]
        : null,
    );

    // Real call: resolveReusedVoiceFields's characterHasClonedSlot guard must
    // return the character UNCHANGED — never inheriting/defaulting the
    // source's qwen engine or slot onto a character that already owns a
    // coqui clone (that would launder a foreign designed voice onto a real
    // person's likeness).
    const hydrated = await hydrateCharacterVoice(character, load);
    expect(hydrated.ttsEngine).toBeUndefined();
    expect(hydrated.overrideTtsVoices?.qwen).toBeUndefined();
    expect(hydrated.overrideTtsVoices?.coqui).toEqual({
      name: 'Wren (unused)',
      libraryUuid: 'lib-coqui-t5',
      provenance: 'cloned',
    });

    setLastKnownCoquiInstallState('ready');
    const provider = makeProvider();
    const entry = baseEntry({ voiceUuid: 'lib-coqui-t5' });
    const readEntry = vi.fn(async (uuid: string) => (uuid === 'lib-coqui-t5' ? entry : null));
    const cast: CastCharacter[] = [
      { id: 'wren', name: 'Wren', overrideTtsVoices: hydrated.overrideTtsVoices },
    ];
    const result = await synthesiseChapter({
      sentences: [sentence(1, 'wren')],
      cast,
      provider,
      modelKey: 'coqui-xtts-v2',
      engine: 'coqui',
      cloneResolverDepsOverride: { readEntry, ptExists: async () => true },
    });
    expect(readEntry).toHaveBeenCalledWith('lib-coqui-t5');
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(provider.calls[0].voiceName).toBe('xtts-lib-coqui-t5');
    expect(result.segments.length).toBeGreaterThan(0);
  });

  it('Task 6 (clone-engines.resolveClonedRetargetEngine) — a coqui-cloned character is RETARGETED (not skipped) off a non-owning book default, and renders via her own clone', async () => {
    const { resolveClonedRetargetEngine } = await import('./clone-engines.js');
    const c: CastCharacter = {
      id: 'wren',
      name: 'Wren',
      overrideTtsVoices: {
        coqui: { name: 'Wren (unused)', libraryUuid: 'lib-coqui-t6', provenance: 'cloned' },
      },
    };

    // Mirrors the force-loop's own call shape (generation.ts/chapter-splice.ts/
    // chapter-qa-repair.ts): the book's request-default engine is 'kokoro'
    // (fs-2's non-English enforcement runs regardless of what the account
    // default happens to be), and 'coqui' is eligible for this book's
    // language. Task 6's fix: SET ttsEngine to the eligible clone-capable
    // engine that actually carries the clone — never skip (which would leave
    // ttsEngine unset and strand her on the request default).
    const retarget = resolveClonedRetargetEngine(c, ['qwen', 'coqui'], 'kokoro');
    expect(retarget).toBe('coqui');
    c.ttsEngine = retarget ?? 'qwen'; // the exact assignment the three mutators perform

    setLastKnownCoquiInstallState('ready');
    const kokoroProvider = makeProvider();
    const coquiProvider = makeProvider();
    const resolveForEngine = (e: string) =>
      e === 'coqui'
        ? { provider: coquiProvider, modelKey: 'coqui-xtts-v2' as const }
        : { provider: kokoroProvider, modelKey: 'kokoro-v1' as const };
    const entry = baseEntry({ voiceUuid: 'lib-coqui-t6' });
    const readEntry = vi.fn(async (uuid: string) => (uuid === 'lib-coqui-t6' ? entry : null));

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'wren')],
      cast: [c],
      provider: kokoroProvider,
      modelKey: 'kokoro-v1',
      engine: 'kokoro',
      resolveForEngine,
      cloneResolverDepsOverride: { readEntry, ptExists: async () => true },
    });

    // Not wrong-engine: her own ttsEngine ('coqui', from the retarget) is
    // the engine her clone actually lives on, so wrongEngine is false and
    // she renders on her OWN provider, never the book-default Kokoro one.
    expect(readEntry).toHaveBeenCalledWith('lib-coqui-t6');
    expect(coquiProvider.calls.length).toBeGreaterThan(0);
    expect(coquiProvider.calls[0].voiceName).toBe('xtts-lib-coqui-t6');
    expect(kokoroProvider.calls).toHaveLength(0);
    expect(result.segments.length).toBeGreaterThan(0);
  });
});
