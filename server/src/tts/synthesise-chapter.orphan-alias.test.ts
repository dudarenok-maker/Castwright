/* #2040 — the four `synthesise-chapter.ts` render-path join sites now resolve
   a group's `characterId` through `buildCastResolver` (Task 3) instead of a
   raw `castById.get`/`castById.has` lookup, so a sentence group carrying a
   superseded/encoding-drifted character id renders in the right voice
   instead of silently falling back to the narrator.

   `synthesiseChapter` itself has no book-directory parameter, so it cannot
   load `cast-id-history.json` (Task 2) directly — callers that DO have a
   bookDir (generation.ts, chapter-splice.ts, chapter-qa-repair.ts) load it
   once via `loadCastIdHistory(bookDir)` and pass `.supersededBy` through as
   the new `castIdHistory` option, defaulting to `{}`. The first test below
   is the headline regression case (Заказ Коалфолла: `mayrin` vs `mairin`,
   letter-level drift only the history tier can recover); the second pins
   the NORMALISED-id tier (case/separator drift, e.g. cast-create's
   `the_torment` vs the analyzer's `the-torment` — see `character-id.ts`'s
   own docstring example), which recovers even with the default `{}` — the
   two tiers are independent and both need coverage.

   Fourth case is the safety-gate regression guard: before this fix, converting
   `:1526`'s `rendersNarrator` alone (without also converting `:1519`'s
   `inChapterCharacterIds`) would have made a resolvable group's ORIGINAL raw
   id fail to appear in the cloned-voice pre-pass's validated set — see the
   `IMPORTANT-1 (Task 6 review)` comment beside `:1519` in synthesise-chapter.ts
   and spec §4.3. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { synthesiseChapter, type CastCharacter } from './synthesise-chapter.js';
import { UnresolvableClonedVoiceError, type ResolveChapterDeps } from './clone-voice-resolver.js';
import type { VoiceLibraryEntry } from '../workspace/voice-library.js';
import type { SentenceOutput } from '../handoff/schemas.js';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from './index.js';

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
  return { id, chapterId: 1, characterId, text: 'Line.' };
}

function baseEntry(overrides: Partial<VoiceLibraryEntry> = {}): VoiceLibraryEntry {
  return {
    voiceUuid: 'lib-torment',
    name: 'The Torment clone',
    provenance: 'cloned',
    tags: [],
    pinned: false,
    engines: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#2040 orphaned characterId resolves through the cast resolver', () => {
  it('renders in the aliased character voice, not the narrator (history tier: castIdHistory)', async () => {
    // The headline regression case (Заказ Коалфолла): cast holds the
    // CANONICAL id 'mairin'; the sentence group's raw attribution is
    // 'mayrin' — a genuine letter-level typo/drift, NOT recoverable by the
    // normalised-id tier (normaliseIdKey never merges ids whose letters
    // differ — see character-id.ts's own docstring). Only resolvable via a
    // real `castIdHistory` map, exactly as generation.ts/chapter-splice.ts/
    // chapter-qa-repair.ts thread it in from `loadCastIdHistory(bookDir)`.
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator' },
      {
        id: 'mairin',
        name: 'Мэйрин',
        gender: 'female',
        overrideTtsVoices: { kokoro: { name: 'kokoro-mairin' } },
      },
    ];
    const provider = makeProvider();

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'mayrin')],
      cast,
      castIdHistory: { supersededBy: { mayrin: 'mairin' } },
      provider,
      modelKey: 'kokoro-v1',
      engine: 'kokoro',
    });

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].voiceName).toBe('kokoro-mairin');
    const body = result.segments.find((s) => s.kind !== 'title');
    // The raw attribution is preserved on the segment (existing contract —
    // revisions.ts's drift detector and srv-36 anchors key off it)…
    expect(body?.characterId).toBe('mayrin');
    // …but this was a REAL resolution, not an orphan substitution: the
    // #2023 fallback-stamp field must stay unset.
    expect(body?.renderedFallbackCharacterId).toBeUndefined();
  });

  it('renders in the resolved character voice, not the narrator (normalised-id tier, no history needed)', async () => {
    // Cast carries the CANONICAL id 'mairin'; the sentence group's raw
    // attribution is 'Mairin' (case drift — the exact shape the
    // normalised-id tier exists to recover, per character-id.ts's own
    // docstring). Deliberately passes NO `castIdHistory` — proving the
    // default `{}` still recovers this tier on its own.
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator' },
      {
        id: 'mairin',
        name: 'Мэйрин',
        gender: 'female',
        overrideTtsVoices: { kokoro: { name: 'kokoro-mairin' } },
      },
    ];
    const provider = makeProvider();

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'Mairin')],
      cast,
      provider,
      modelKey: 'kokoro-v1',
      engine: 'kokoro',
    });

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].voiceName).toBe('kokoro-mairin');
    const body = result.segments.find((s) => s.kind !== 'title');
    // The raw attribution is preserved on the segment (existing contract —
    // revisions.ts's drift detector and srv-36 anchors key off it)…
    expect(body?.characterId).toBe('Mairin');
    // …but this was a REAL resolution, not an orphan substitution: the
    // #2023 fallback-stamp field must stay unset.
    expect(body?.renderedFallbackCharacterId).toBeUndefined();
  });

  it('still records the #2023 orphan stamp on a genuine miss', async () => {
    const cast: CastCharacter[] = [{ id: 'narrator', name: 'Alice', gender: 'female' }];
    const provider = makeProvider();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'nobody-at-all')],
      cast,
      provider,
      modelKey: 'kokoro-v1',
      engine: 'kokoro',
    });

    expect(provider.calls).toHaveLength(1);
    const body = result.segments.find((s) => s.kind !== 'title');
    expect(body?.characterId).toBe('nobody-at-all');
    expect(body?.renderedFallbackCharacterId).toBe('narrator');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('nobody-at-all');
  });

  it('#2040 Task 17 fix round 1 — a rejected alias renders as an orphan (narrator fallback), not the aliased voice', async () => {
    // Identical fixture to the first test above ('mayrin' -> 'mairin' via
    // history), except the user has rejected this exact reconciliation.
    // Before fix round 1, `synthesiseChapter` — the actual render path —
    // only ever received `.supersededBy`, never `rejected`, so a rejected
    // match still rendered in the aliased character's voice: the ONE
    // outcome the reject button exists to prevent. This is the headline
    // regression the coordinator's fix-round-1 brief called out.
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator', gender: 'female' },
      {
        id: 'mairin',
        name: 'Мэйрин',
        gender: 'female',
        overrideTtsVoices: { kokoro: { name: 'kokoro-mairin' } },
      },
    ];
    const provider = makeProvider();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await synthesiseChapter({
      sentences: [sentence(1, 'mayrin')],
      cast,
      castIdHistory: { supersededBy: { mayrin: 'mairin' }, rejected: ['mayrin'] },
      provider,
      modelKey: 'kokoro-v1',
      engine: 'kokoro',
    });

    expect(provider.calls).toHaveLength(1);
    // NOT the aliased character's voice — it fell back to the narrator.
    expect(provider.calls[0].voiceName).not.toBe('kokoro-mairin');
    const body = result.segments.find((s) => s.kind !== 'title');
    expect(body?.characterId).toBe('mayrin');
    expect(body?.renderedFallbackCharacterId).toBe('narrator');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('puts the RESOLVED character into the cloned-voice pre-pass set (:1519 regression guard)', async () => {
    // 'the_torment' carries a BROKEN (revoked) cloned Qwen voice. The
    // sentence group's raw attribution is 'the-torment' — resolvable only
    // through the normalised-id tier, exactly like cast-create's
    // underscore/analyzer's-dash drift documented in character-id.ts.
    //
    // Before this fix, `inChapterCharacterIds` (:1519) was built from RAW
    // group ids, so 'the-torment' (not 'the_torment') was the only id it
    // ever contained; the pre-pass filters candidates by
    // `inChapterCharacterIds.has(c.id)`, so the cloned 'the_torment' row
    // never matched and its broken clone was never validated — the chapter
    // would render past the gate untouched. Converting :1519 to contribute
    // the RESOLVED id closes that hole: the broken clone must now be caught
    // BEFORE any synth call fires.
    const cast: CastCharacter[] = [
      { id: 'narrator', name: 'Narrator' },
      {
        id: 'the_torment',
        name: 'The Torment',
        overrideTtsVoices: {
          qwen: { name: 'Torment (unused)', libraryUuid: 'lib-torment', provenance: 'cloned' },
        },
      },
    ];
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
    const readEntry = vi.fn(async (uuid: string) => (uuid === 'lib-torment' ? revokedEntry : null));
    const writeEntry = vi.fn();
    const deriveEngineArtifact = vi.fn();
    const deps: Partial<ResolveChapterDeps> = {
      readEntry,
      writeEntry,
      ptExists: async () => true,
      deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveChapterDeps['deriveEngineArtifact'],
    };

    await expect(
      synthesiseChapter({
        sentences: [sentence(1, 'the-torment')],
        cast,
        provider,
        modelKey: 'qwen3-tts-0.6b',
        engine: 'qwen',
        cloneResolverDepsOverride: deps,
      }),
    ).rejects.toBeInstanceOf(UnresolvableClonedVoiceError);

    // Placebo-proof: NO synth call fired at all, and the resolver looked up
    // the RESOLVED character's cloned entry — proving the pre-pass (not
    // some unrelated path) caught this before any GPU work.
    expect(provider.calls).toHaveLength(0);
    expect(readEntry).toHaveBeenCalledWith('lib-torment');
    expect(deriveEngineArtifact).not.toHaveBeenCalled();
  });
});
