/* fs-38 Wave 3b2 (T4) — UnresolvableClonedVoiceError now lives here (moved
   from synthesise-chapter.ts to avoid an import cycle with the resolver) and
   carries a structured `broken: BrokenClonedVoice[]` list. The legacy
   single-name constructor is the 3b1 applyQwenFallback backstop and must
   keep producing byte-identical messages — this pins that contract before
   T5 adds the classifier/orchestrator on top. */
import { describe, it, expect, vi } from 'vitest';
import {
  UnresolvableClonedVoiceError,
  classifyClonedVoice,
  resolveClonedVoicesForChapter,
  resolveDesignedVoicesForChapter,
  REPAIR_AUDITION_TEXT,
  type ClassifyInput,
  type ResolveChapterDeps,
  type ResolveDesignedVoiceDeps,
} from './clone-voice-resolver.js';
import type { VoiceLibraryEntry } from '../workspace/voice-library.js';
import { currentQwenBaseModel } from './model-paths.js';

describe('UnresolvableClonedVoiceError', () => {
  it('fromList carries the structured broken voices and a readable message', () => {
    const e = UnresolvableClonedVoiceError.fromList([
      { name: 'Marlow', reason: 'revoked' },
      { name: 'Reeve', reason: 'missing-master' },
    ]);
    expect(e).toBeInstanceOf(UnresolvableClonedVoiceError);
    expect(e.broken).toHaveLength(2);
    expect(e.message).toContain('Marlow');
    expect(e.message).toContain('Reeve');
    expect(e.message).toContain('revoked');
    expect(e.message).toContain('missing-master');
    expect(e.name).toBe('UnresolvableClonedVoiceError');
  });

  it('fromList gives wrong-engine its own accurate remedy copy, distinct from the Qwen-availability wording', () => {
    const e = UnresolvableClonedVoiceError.fromList([{ name: 'Wren', reason: 'wrong-engine' }]);
    expect(e.message).toContain('Wren');
    expect(e.message).toContain('wrong-engine');
    expect(e.message).toContain('switch the book to Qwen');
    // The Qwen-availability remedy (misleading here — Qwen may be fine) must
    // NOT appear when every broken reason is wrong-engine.
    expect(e.message).not.toContain('Re-enable Qwen');
  });

  it('fromList keeps the Qwen-availability remedy for a mixed list, alongside the wrong-engine one', () => {
    const e = UnresolvableClonedVoiceError.fromList([
      { name: 'Marlow', reason: 'engine-unavailable' },
      { name: 'Wren', reason: 'wrong-engine' },
    ]);
    expect(e.message).toContain('Re-enable Qwen');
    expect(e.message).toContain('switch the book to Qwen');
  });

  it('the legacy single-name constructor still works (3b1 backstop)', () => {
    const e = new UnresolvableClonedVoiceError('Marlow');
    expect(e.broken).toEqual([{ name: 'Marlow', reason: 'engine-unavailable' }]);
    expect(e.message).toBe(
      `Cloned voice for "Marlow" is unavailable — the Qwen engine is not available this ` +
        `run, and a cloned voice must never be substituted with another. Re-enable Qwen or reassign ` +
        `the character.`,
    );
  });

  it('the legacy constructor still supports an optional detail suffix', () => {
    const e = new UnresolvableClonedVoiceError('Marlow', 'sidecar offline');
    expect(e.message).toBe(
      `Cloned voice for "Marlow" is unavailable — the Qwen engine is not available this ` +
        `run, and a cloned voice must never be substituted with another. Re-enable Qwen or reassign ` +
        `the character. sidecar offline`,
    );
  });
});

/* --- T5: classifier ------------------------------------------------------- */

function baseEntry(overrides: Partial<VoiceLibraryEntry> = {}): VoiceLibraryEntry {
  return {
    voiceUuid: 'u1',
    name: 'Marlow',
    provenance: 'cloned',
    tags: [],
    pinned: false,
    engines: {},
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function classifyInput(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    entry: baseEntry(),
    engine: 'qwen',
    wrongEngine: false,
    engineUnavailable: false,
    ptExists: true,
    currentArtifactVersion: 'qwen3-0.6b',
    ...overrides,
  };
}

describe('classifyClonedVoice', () => {
  it('revoked consent -> broken/revoked, even with a missing .pt (revoked beats derive-needed)', () => {
    const result = classifyClonedVoice(
      classifyInput({
        entry: baseEntry({
          consent: {
            personName: 'x',
            relationship: 'self',
            permittedUse: 'personal',
            attestedAt: '2026-01-01T00:00:00Z',
            attestedBy: 'x',
            revokedAt: '2026-02-01T00:00:00Z',
          },
        }),
        ptExists: false,
      }),
    );
    expect(result).toEqual({ state: 'broken', reason: 'revoked' });
  });

  it('engine unavailable -> broken/engine-unavailable', () => {
    const result = classifyClonedVoice(classifyInput({ engineUnavailable: true }));
    expect(result).toEqual({ state: 'broken', reason: 'engine-unavailable' });
  });

  it('wrong engine (character does not route to qwen) -> broken/wrong-engine', () => {
    const result = classifyClonedVoice(classifyInput({ wrongEngine: true }));
    expect(result).toEqual({ state: 'broken', reason: 'wrong-engine' });
  });

  it('wrong engine takes precedence over engine-unavailable when both are true', () => {
    const result = classifyClonedVoice(
      classifyInput({ wrongEngine: true, engineUnavailable: true }),
    );
    expect(result).toEqual({ state: 'broken', reason: 'wrong-engine' });
  });

  it('revoked consent beats wrong-engine (rule-1 precedence preserved)', () => {
    const result = classifyClonedVoice(
      classifyInput({
        entry: baseEntry({
          consent: {
            personName: 'x',
            relationship: 'self',
            permittedUse: 'personal',
            attestedAt: '2026-01-01T00:00:00Z',
            attestedBy: 'x',
            revokedAt: '2026-02-01T00:00:00Z',
          },
        }),
        wrongEngine: true,
      }),
    );
    expect(result).toEqual({ state: 'broken', reason: 'revoked' });
  });

  it('persisted failed status -> broken/derive-failed', () => {
    const result = classifyClonedVoice(
      classifyInput({ entry: baseEntry({ engines: { qwen: { status: 'failed' } } }) }),
    );
    expect(result).toEqual({ state: 'broken', reason: 'derive-failed' });
  });

  it('.pt missing + master present -> repairable', () => {
    const result = classifyClonedVoice(
      classifyInput({
        entry: baseEntry({
          master: {
            clipFile: 'master.wav',
            sampleRate: 24000,
            durationSeconds: 5,
            transcript: 'hi',
            transcriptSource: 'user',
            captureMethod: 'upload',
          },
        }),
        ptExists: false,
      }),
    );
    expect(result).toEqual({ state: 'repairable' });
  });

  it('.pt missing + no master -> broken/missing-master', () => {
    const result = classifyClonedVoice(classifyInput({ ptExists: false }));
    expect(result).toEqual({ state: 'broken', reason: 'missing-master' });
  });

  it('stale baseModel + master present -> repairable', () => {
    const result = classifyClonedVoice(
      classifyInput({
        entry: baseEntry({
          engines: { qwen: { status: 'ready', baseModel: 'qwen3-old' } },
          master: {
            clipFile: 'master.wav',
            sampleRate: 24000,
            durationSeconds: 5,
            transcript: 'hi',
            transcriptSource: 'user',
            captureMethod: 'upload',
          },
        }),
        currentArtifactVersion: 'qwen3-0.6b',
      }),
    );
    expect(result).toEqual({ state: 'repairable' });
  });

  it('status stale + master present -> repairable', () => {
    const result = classifyClonedVoice(
      classifyInput({
        entry: baseEntry({
          engines: { qwen: { status: 'stale' } },
          master: {
            clipFile: 'master.wav',
            sampleRate: 24000,
            durationSeconds: 5,
            transcript: 'hi',
            transcriptSource: 'user',
            captureMethod: 'upload',
          },
        }),
      }),
    );
    expect(result).toEqual({ state: 'repairable' });
  });

  it('everything current -> healthy', () => {
    const result = classifyClonedVoice(
      classifyInput({
        entry: baseEntry({ engines: { qwen: { status: 'ready', baseModel: 'qwen3-0.6b' } } }),
      }),
    );
    expect(result).toEqual({ state: 'healthy' });
  });

  /* --- fs-38 Wave 3c, Task 18 — the coqui column: the SAME classifier
     table above, on the `xtts` manifest slot / `coquiVersion` comparand
     instead of `qwen`/`baseModel`. */
  describe('the coqui column', () => {
    it('coqui engine unavailable -> broken/engine-unavailable', () => {
      const result = classifyClonedVoice(
        classifyInput({ engine: 'coqui', engineUnavailable: true }),
      );
      expect(result).toEqual({ state: 'broken', reason: 'engine-unavailable' });
    });

    it('coqui persisted failed status -> broken/derive-failed', () => {
      const result = classifyClonedVoice(
        classifyInput({
          engine: 'coqui',
          entry: baseEntry({ engines: { xtts: { status: 'failed' } } }),
        }),
      );
      expect(result).toEqual({ state: 'broken', reason: 'derive-failed' });
    });

    it('coqui .pt missing + master present -> repairable', () => {
      const result = classifyClonedVoice(
        classifyInput({
          engine: 'coqui',
          entry: baseEntry({
            master: {
              clipFile: 'master.wav',
              sampleRate: 24000,
              durationSeconds: 5,
              transcript: 'hi',
              transcriptSource: 'user',
              captureMethod: 'upload',
            },
          }),
          ptExists: false,
        }),
      );
      expect(result).toEqual({ state: 'repairable' });
    });

    it('coqui .pt missing + no master -> broken/missing-master', () => {
      const result = classifyClonedVoice(
        classifyInput({ engine: 'coqui', ptExists: false }),
      );
      expect(result).toEqual({ state: 'broken', reason: 'missing-master' });
    });

    it('coqui coquiVersion mismatch + master present -> repairable', () => {
      const result = classifyClonedVoice(
        classifyInput({
          engine: 'coqui',
          entry: baseEntry({
            engines: { xtts: { status: 'ready', coquiVersion: 'v2.0.3' } },
            master: {
              clipFile: 'master.wav',
              sampleRate: 24000,
              durationSeconds: 5,
              transcript: 'hi',
              transcriptSource: 'user',
              captureMethod: 'upload',
            },
          }),
          currentArtifactVersion: 'v2.0.5',
        }),
      );
      expect(result).toEqual({ state: 'repairable' });
    });

    it('coqui everything current -> healthy', () => {
      const result = classifyClonedVoice(
        classifyInput({
          engine: 'coqui',
          entry: baseEntry({ engines: { xtts: { status: 'ready', coquiVersion: 'v2.0.5' } } }),
          currentArtifactVersion: 'v2.0.5',
        }),
      );
      expect(result).toEqual({ state: 'healthy' });
    });

    /* fs-38 Wave 3c, Task 18 — the ambiguity this task's brief called out
       explicitly: BOTH sides of the version comparison can be empty
       ('' is `derive-engine-artifact.ts`'s older-sidecar fallback for
       STORED, and coqui has no live "current installed version" oracle at
       all yet, so `currentArtifactVersion('coqui')` is `''` in production).
       An empty/unknown value on EITHER side must read as "not stale",
       never "always stale" — the latter would force a real GPU re-derive
       of every already-healthy coqui-cloned voice on every single chapter
       render (see clone-engines.ts's isArtifactVersionStale doc comment
       for the full reasoning). Pinned at the classifier's own boundary,
       not just the underlying predicate in isolation. */
    it('an EMPTY stored coquiVersion (older-sidecar fallback) never reads stale, even against a real known current version', () => {
      const result = classifyClonedVoice(
        classifyInput({
          engine: 'coqui',
          entry: baseEntry({ engines: { xtts: { status: 'ready', coquiVersion: '' } } }),
          currentArtifactVersion: 'v2.0.5',
        }),
      );
      expect(result).toEqual({ state: 'healthy' });
    });

    it('an EMPTY currentArtifactVersion (no live oracle) never reads a real stored coquiVersion as stale', () => {
      const result = classifyClonedVoice(
        classifyInput({
          engine: 'coqui',
          entry: baseEntry({ engines: { xtts: { status: 'ready', coquiVersion: 'v2.0.3' } } }),
          currentArtifactVersion: '',
        }),
      );
      expect(result).toEqual({ state: 'healthy' });
    });
  });
});

/* --- T5: orchestrator ------------------------------------------------------ */

function makeDeps(overrides: Partial<ResolveChapterDeps> = {}): ResolveChapterDeps & {
  readEntry: ReturnType<typeof vi.fn>;
  writeEntry: ReturnType<typeof vi.fn>;
  updateEntry: ReturnType<typeof vi.fn>;
  ptExists: ReturnType<typeof vi.fn>;
  deriveEngineArtifact: ReturnType<typeof vi.fn>;
  readMasterPcm: ReturnType<typeof vi.fn>;
  purgeCloneArtifacts: ReturnType<typeof vi.fn>;
} {
  // fs-38 Wave 3c, Task 14 — `readEntry`/`writeEntry` are pulled out as
  // locals (rather than inlined in the returned object) so the DEFAULT
  // `updateEntry` below can call through to whichever readEntry/writeEntry
  // mock a given test configured (including the sequenced
  // `mockResolvedValueOnce` chains the review-C-1 tests use), mirroring
  // exactly what the pre-Task-14 inline read+write did. This keeps every
  // pre-existing test's call-count/ordering assertions on `readEntry`/
  // `writeEntry` valid unchanged — a test only needs its own `updateEntry`
  // override when it's testing the LOCK itself (see the dedicated
  // concurrency describe block below), not the ordinary success/failure
  // paths.
  const readEntry = overrides.readEntry ?? vi.fn(async () => null);
  const writeEntry = overrides.writeEntry ?? vi.fn(async () => {});
  const defaultUpdateEntry = vi.fn(
    async (
      uuid: string,
      mutate: (
        entry: VoiceLibraryEntry | null,
      ) => Promise<VoiceLibraryEntry | null | undefined> | VoiceLibraryEntry | null | undefined,
    ) => {
      const fresh = await readEntry(uuid);
      const next = await mutate(fresh);
      if (!next) return null;
      await writeEntry(next);
      // Fix wave (review I-4) — production's `updateEntry` does a SECOND,
      // canonical re-read after the write (workspace/voice-library.ts),
      // not a bare return of `next`. The old double stopped at `writeEntry`
      // and never exercised that re-read, which is exactly where I-1's
      // null-conflation bug lived — a double that never reaches
      // production's real shape can't catch a regression there. Falls
      // back to `next` (I-1's fix, mirrored here too) when the re-read
      // comes back null/undefined, e.g. a test that only configured 2
      // `mockResolvedValueOnce` reads.
      return (await readEntry(uuid)) ?? next;
    },
  );
  return {
    readEntry,
    writeEntry,
    updateEntry: defaultUpdateEntry,
    ptExists: vi.fn(async () => true),
    deriveEngineArtifact: vi.fn(async () => ({
      previewPcm: Buffer.alloc(0),
      sampleRate: 24000,
      baseModel: 'qwen3-0.6b',
    })),
    readMasterPcm: vi.fn(async () => ({ pcm: Buffer.alloc(0), sampleRate: 24000, refText: 'hi' })),
    currentArtifactVersion: () => 'qwen3-0.6b',
    // Review C-1 — defaults to a no-op success; only the revoke/gone-mid-
    // derive tests need to observe this being called.
    purgeCloneArtifacts: vi.fn(async () => ({ failed: [] })),
    ...overrides,
  } as ResolveChapterDeps & {
    readEntry: ReturnType<typeof vi.fn>;
    writeEntry: ReturnType<typeof vi.fn>;
    updateEntry: ReturnType<typeof vi.fn>;
    ptExists: ReturnType<typeof vi.fn>;
    deriveEngineArtifact: ReturnType<typeof vi.fn>;
    readMasterPcm: ReturnType<typeof vi.fn>;
    purgeCloneArtifacts: ReturnType<typeof vi.fn>;
  };
}

const MASTER = {
  clipFile: 'master.wav',
  sampleRate: 24000,
  durationSeconds: 5,
  transcript: 'hi',
  transcriptSource: 'user' as const,
  captureMethod: 'upload' as const,
};

describe('resolveClonedVoicesForChapter', () => {
  it('the invariant, direct: a revoked voice rejects and NEVER calls deriveEngineArtifact', async () => {
    const revokedEntry = baseEntry({
      consent: {
        personName: 'x',
        relationship: 'self',
        permittedUse: 'personal',
        attestedAt: '2026-01-01T00:00:00Z',
        attestedBy: 'x',
        revokedAt: '2026-02-01T00:00:00Z',
      },
      master: MASTER,
    });
    const deps = makeDeps({ readEntry: vi.fn(async () => revokedEntry) });

    await expect(
      resolveClonedVoicesForChapter(
        [{ characterName: 'Marlow', libraryUuid: 'u1', engine: 'qwen' as const, wrongEngine: false, engineUnavailable: false }],
        deps,
      ),
    ).rejects.toBeInstanceOf(UnresolvableClonedVoiceError);

    expect(deps.deriveEngineArtifact).not.toHaveBeenCalled();
    expect(deps.writeEntry).not.toHaveBeenCalled();

    // Confirm the rejection actually carries the revoked reason (not a
    // coincidental throw from something else).
    try {
      await resolveClonedVoicesForChapter(
        [{ characterName: 'Marlow', libraryUuid: 'u1', engine: 'qwen' as const, wrongEngine: false, engineUnavailable: false }],
        deps,
      );
      throw new Error('expected rejection');
    } catch (e) {
      expect(e).toBeInstanceOf(UnresolvableClonedVoiceError);
      expect((e as UnresolvableClonedVoiceError).broken).toEqual([
        { name: 'Marlow', reason: 'revoked' },
      ]);
    }
  });

  it('repairable: derives once, writeEntry stamps ready + current baseModel, resolves — and preserves a sibling engine untouched', async () => {
    // A sibling `engines.xtts` entry must survive the `...entry.engines`
    // spread on write — this fixture catches a future edit that rewrites
    // the success write as `engines: { qwen: … }` and silently drops it.
    const entry = baseEntry({
      master: MASTER,
      engines: {
        qwen: { status: 'stale', baseModel: 'old-base' },
        xtts: { status: 'ready' },
      },
    });
    const controller = new AbortController();
    const deps = makeDeps({
      readEntry: vi.fn(async () => entry),
      ptExists: vi.fn(async () => true),
      currentArtifactVersion: () => 'qwen3-new',
      signal: controller.signal,
    });

    await expect(
      resolveClonedVoicesForChapter(
        [{ characterName: 'Marlow', libraryUuid: 'u1', engine: 'qwen' as const, wrongEngine: false, engineUnavailable: false }],
        deps,
      ),
    ).resolves.toBeUndefined();

    expect(deps.deriveEngineArtifact).toHaveBeenCalledTimes(1);
    expect(deps.deriveEngineArtifact).toHaveBeenCalledWith(
      'u1',
      'qwen',
      {
        masterPcm: expect.any(Buffer),
        sampleRate: 24000,
        refText: 'hi',
        auditionText: REPAIR_AUDITION_TEXT,
      },
      { signal: controller.signal },
    );
    expect(deps.writeEntry).toHaveBeenCalledTimes(1);
    const written = deps.writeEntry.mock.calls[0][0] as VoiceLibraryEntry;
    expect(written.engines.qwen).toEqual({ status: 'ready', baseModel: 'qwen3-new' });
    expect(written.engines.xtts).toEqual({ status: 'ready' });
  });

  /* Review I1 — pins the GPU-cost fix directly: even when the retained clip's
     `refText` is a full whisper transcript (up to 60s of speech), the
     resolver's derive call must never let that leak through as the audition
     text — the sidecar falls back to voicing `ref_text` in full when no
     `auditionText` is supplied, burning real synth time on a preview this
     orchestrator immediately discards. Fails before the I1 fix (no
     `auditionText` was sent at all, so the sidecar's fallback chain would
     have reached the long `refText`); passes after. */
  it('repairable: derive call requests a short audition, never the full-transcript refText', async () => {
    const longTranscript =
      'This is a long whisper transcript that stands in for up to sixty seconds of ' +
      'recorded speech, which must never be resynthesised just to build a preview ' +
      'that resolveClonedVoicesForChapter immediately discards.';
    const entry = baseEntry({ master: MASTER, engines: { qwen: { status: 'stale', baseModel: 'old' } } });
    const deps = makeDeps({
      readEntry: vi.fn(async () => entry),
      ptExists: vi.fn(async () => true),
      currentArtifactVersion: () => 'qwen3-new',
      readMasterPcm: vi.fn(async () => ({
        pcm: Buffer.alloc(0),
        sampleRate: 24000,
        refText: longTranscript,
      })),
    });

    await resolveClonedVoicesForChapter(
      [{ characterName: 'Marlow', libraryUuid: 'u1', engine: 'qwen' as const, wrongEngine: false, engineUnavailable: false }],
      deps,
    );

    const [, , input] = deps.deriveEngineArtifact.mock.calls[0];
    expect(input.refText).toBe(longTranscript); // refText itself is untouched...
    expect(input.auditionText).toBe(REPAIR_AUDITION_TEXT); // ...but a short audition is requested instead
    expect(input.auditionText).not.toBe(longTranscript);
    expect(input.auditionText.length).toBeLessThan(longTranscript.length);
  });

  it.each([
    ['unreachable (status 0)', 0],
    ['server error (status 500)', 500],
    ['no capacity (status 503)', 503],
  ])(
    'transient derive failure — %s — is Broken and does NOT persist failed',
    async (_label, status) => {
      const entry = baseEntry({ master: MASTER });
      const deps = makeDeps({
        readEntry: vi.fn(async () => entry),
        ptExists: vi.fn(async () => false),
        deriveEngineArtifact: vi.fn(async () => {
          throw Object.assign(new Error('sidecar trouble'), { status });
        }),
      });

      await expect(
        resolveClonedVoicesForChapter(
          [{ characterName: 'Marlow', libraryUuid: 'u1', engine: 'qwen' as const, wrongEngine: false, engineUnavailable: false }],
          deps,
        ),
      ).rejects.toBeInstanceOf(UnresolvableClonedVoiceError);

      expect(deps.writeEntry).not.toHaveBeenCalled();
    },
  );

  it('transient derive failure with no numeric status at all — fail-open default — is Broken and does NOT persist failed', async () => {
    const entry = baseEntry({ master: MASTER });
    const deps = makeDeps({
      readEntry: vi.fn(async () => entry),
      ptExists: vi.fn(async () => false),
      deriveEngineArtifact: vi.fn(async () => {
        throw new Error('readMasterPcm blew up');
      }),
    });

    await expect(
      resolveClonedVoicesForChapter(
        [{ characterName: 'Marlow', libraryUuid: 'u1', engine: 'qwen' as const, wrongEngine: false, engineUnavailable: false }],
        deps,
      ),
    ).rejects.toBeInstanceOf(UnresolvableClonedVoiceError);

    expect(deps.writeEntry).not.toHaveBeenCalled();
  });

  it('permanent derive failure (status 422) is Broken AND persists failed', async () => {
    const entry = baseEntry({ master: MASTER });
    const deps = makeDeps({
      readEntry: vi.fn(async () => entry),
      ptExists: vi.fn(async () => false),
      deriveEngineArtifact: vi.fn(async () => {
        throw Object.assign(new Error('rejected clip'), { status: 422 });
      }),
    });

    let thrown: UnresolvableClonedVoiceError | undefined;
    try {
      await resolveClonedVoicesForChapter(
        [{ characterName: 'Marlow', libraryUuid: 'u1', engine: 'qwen' as const, wrongEngine: false, engineUnavailable: false }],
        deps,
      );
    } catch (e) {
      thrown = e as UnresolvableClonedVoiceError;
    }
    expect(thrown).toBeInstanceOf(UnresolvableClonedVoiceError);
    expect(thrown?.broken).toEqual([{ name: 'Marlow', reason: 'derive-failed' }]);

    expect(deps.writeEntry).toHaveBeenCalledTimes(1);
    const written = deps.writeEntry.mock.calls[0][0] as VoiceLibraryEntry;
    expect(written.engines.qwen?.status).toBe('failed');
  });

  it('two broken voices -> the thrown error carries both names', async () => {
    const revokedEntry = baseEntry({
      voiceUuid: 'u1',
      consent: {
        personName: 'x',
        relationship: 'self',
        permittedUse: 'personal',
        attestedAt: '2026-01-01T00:00:00Z',
        attestedBy: 'x',
        revokedAt: '2026-02-01T00:00:00Z',
      },
    });
    const missingMasterEntry = baseEntry({ voiceUuid: 'u2' });
    const deps = makeDeps({
      readEntry: vi.fn(async (uuid: string) => (uuid === 'u1' ? revokedEntry : missingMasterEntry)),
      ptExists: vi.fn(async () => false),
    });

    let thrown: UnresolvableClonedVoiceError | undefined;
    try {
      await resolveClonedVoicesForChapter(
        [
          { characterName: 'Marlow', libraryUuid: 'u1', engine: 'qwen' as const, wrongEngine: false, engineUnavailable: false },
          { characterName: 'Reeve', libraryUuid: 'u2', engine: 'qwen' as const, wrongEngine: false, engineUnavailable: false },
        ],
        deps,
      );
    } catch (e) {
      thrown = e as UnresolvableClonedVoiceError;
    }
    expect(thrown?.broken).toEqual([
      { name: 'Marlow', reason: 'revoked' },
      { name: 'Reeve', reason: 'missing-master' },
    ]);
  });

  it('misconfigured: no libraryUuid -> Broken/misconfigured without touching readEntry/derive', async () => {
    const deps = makeDeps();

    let thrown: UnresolvableClonedVoiceError | undefined;
    try {
      await resolveClonedVoicesForChapter(
        [{ characterName: 'Marlow', libraryUuid: undefined, engine: 'qwen' as const, wrongEngine: false, engineUnavailable: false }],
        deps,
      );
    } catch (e) {
      thrown = e as UnresolvableClonedVoiceError;
    }
    expect(thrown?.broken).toEqual([{ name: 'Marlow', reason: 'misconfigured' }]);
    expect(deps.readEntry).not.toHaveBeenCalled();
    expect(deps.deriveEngineArtifact).not.toHaveBeenCalled();
  });

  it('misconfigured: readEntry resolves null -> Broken/misconfigured', async () => {
    const deps = makeDeps({ readEntry: vi.fn(async () => null) });

    let thrown: UnresolvableClonedVoiceError | undefined;
    try {
      await resolveClonedVoicesForChapter(
        [{ characterName: 'Marlow', libraryUuid: 'u1', engine: 'qwen' as const, wrongEngine: false, engineUnavailable: false }],
        deps,
      );
    } catch (e) {
      thrown = e as UnresolvableClonedVoiceError;
    }
    expect(thrown?.broken).toEqual([{ name: 'Marlow', reason: 'misconfigured' }]);
    expect(deps.deriveEngineArtifact).not.toHaveBeenCalled();
  });

  /* --- review C-1: revoke landing mid-derive is a lost-update, not a re-vivify --- */

  describe('review C-1 — a revoke/delete landing during an in-flight repair', () => {
    it('a revoke that lands between classify and derive-completion: revokedAt is NOT clobbered, the voice is reported Broken/revoked, the purge is re-run, and no ready stamp is written', async () => {
      const preDeriveEntry = baseEntry({
        master: MASTER,
        engines: { qwen: { status: 'stale', baseModel: 'old' } },
      });
      // What the entry looks like on disk AFTER a concurrent revoke landed
      // while the derive was in flight — this is what a fresh re-read must
      // see, in place of the stale `preDeriveEntry` snapshot classify() read.
      const postRevokeEntry = baseEntry({
        master: undefined, // purgeCloneArtifacts's deleteMasterClip already cleared it
        engines: { qwen: { status: 'stale', baseModel: 'old' } },
        consent: {
          personName: 'x',
          relationship: 'self',
          permittedUse: 'personal',
          attestedAt: '2026-01-01T00:00:00Z',
          attestedBy: 'x',
          revokedAt: '2026-02-01T00:00:00Z',
        },
      });
      const readEntry = vi
        .fn()
        .mockResolvedValueOnce(preDeriveEntry) // classify's read
        .mockResolvedValueOnce(postRevokeEntry); // guardPostDeriveWrite's re-read, post-derive
      const deps = makeDeps({
        readEntry,
        ptExists: vi.fn(async () => true),
        currentArtifactVersion: () => 'qwen3-new',
      });

      let thrown: UnresolvableClonedVoiceError | undefined;
      try {
        await resolveClonedVoicesForChapter(
          [{ characterName: 'Marlow', libraryUuid: 'u1', engine: 'qwen' as const, wrongEngine: false, engineUnavailable: false }],
          deps,
        );
      } catch (e) {
        thrown = e as UnresolvableClonedVoiceError;
      }

      // (b) reported Broken/revoked.
      expect(thrown?.broken).toEqual([{ name: 'Marlow', reason: 'revoked' }]);
      // (d) no ready stamp written — and more generally NO write at all, so
      // the concurrent revoke's own on-disk `revokedAt` is never touched by
      // this function (a): a write here using the stale `preDeriveEntry`
      // snapshot (no `revokedAt`) is exactly the clobber this fix closes.
      expect(deps.writeEntry).not.toHaveBeenCalled();
      // (c) the artifact purge is re-run — the derive that just completed
      // may have written a fresh `.pt` AFTER the revoke's own purge already
      // ran; this call is what erases it.
      expect(deps.purgeCloneArtifacts).toHaveBeenCalledWith('u1', {});
      expect(readEntry).toHaveBeenCalledTimes(2);
    });

    it('the entry disappearing entirely mid-derive (deleted) is treated the same as revoked: Broken/revoked, purge re-run, no write', async () => {
      const preDeriveEntry = baseEntry({ master: MASTER, engines: { qwen: { status: 'stale' } } });
      const readEntry = vi.fn().mockResolvedValueOnce(preDeriveEntry).mockResolvedValueOnce(null);
      const deps = makeDeps({ readEntry, ptExists: vi.fn(async () => true) });

      let thrown: UnresolvableClonedVoiceError | undefined;
      try {
        await resolveClonedVoicesForChapter(
          [{ characterName: 'Marlow', libraryUuid: 'u1', engine: 'qwen' as const, wrongEngine: false, engineUnavailable: false }],
          deps,
        );
      } catch (e) {
        thrown = e as UnresolvableClonedVoiceError;
      }

      expect(thrown?.broken).toEqual([{ name: 'Marlow', reason: 'revoked' }]);
      expect(deps.writeEntry).not.toHaveBeenCalled();
      expect(deps.purgeCloneArtifacts).toHaveBeenCalledWith('u1', {});
    });

    it('a successful repair merges the status stamp into the FRESH re-read entry, not the stale pre-derive snapshot — a concurrent unrelated sibling-engine edit survives', async () => {
      const preDeriveEntry = baseEntry({
        master: MASTER,
        engines: { qwen: { status: 'stale', baseModel: 'old' }, xtts: { status: 'ready' } },
      });
      // A totally unrelated concurrent edit landed on the entry while the
      // derive was running (e.g. an xtts re-derive elsewhere) — the sibling
      // engine's status flipped. The success write must pick this up, not
      // the pre-derive snapshot's stale `xtts: ready`.
      const postDeriveEntry = baseEntry({
        master: MASTER,
        engines: { qwen: { status: 'stale', baseModel: 'old' }, xtts: { status: 'stale' } },
      });
      const readEntry = vi
        .fn()
        .mockResolvedValueOnce(preDeriveEntry)
        .mockResolvedValueOnce(postDeriveEntry);
      const deps = makeDeps({ readEntry, ptExists: vi.fn(async () => true), currentArtifactVersion: () => 'qwen3-new' });

      await resolveClonedVoicesForChapter(
        [{ characterName: 'Marlow', libraryUuid: 'u1', engine: 'qwen' as const, wrongEngine: false, engineUnavailable: false }],
        deps,
      );

      expect(deps.writeEntry).toHaveBeenCalledTimes(1);
      const written = deps.writeEntry.mock.calls[0][0] as VoiceLibraryEntry;
      expect(written.engines.qwen).toEqual({ status: 'ready', baseModel: 'qwen3-new' });
      // The concurrent edit (xtts flipped to stale) survives — proof the
      // write merged into the FRESH read, not the stale pre-derive one.
      expect(written.engines.xtts).toEqual({ status: 'stale' });
      expect(deps.purgeCloneArtifacts).not.toHaveBeenCalled();
    });

    it('permanent (4xx) derive failure: a revoke landing before the failed-persist write is NOT clobbered — Broken/revoked (not derive-failed), purge re-run, no failed stamp written', async () => {
      const preDeriveEntry = baseEntry({ master: MASTER });
      const postRevokeEntry = baseEntry({
        master: undefined,
        consent: {
          personName: 'x',
          relationship: 'self',
          permittedUse: 'personal',
          attestedAt: '2026-01-01T00:00:00Z',
          attestedBy: 'x',
          revokedAt: '2026-02-01T00:00:00Z',
        },
      });
      const readEntry = vi.fn().mockResolvedValueOnce(preDeriveEntry).mockResolvedValueOnce(postRevokeEntry);
      const deps = makeDeps({
        readEntry,
        ptExists: vi.fn(async () => false),
        deriveEngineArtifact: vi.fn(async () => {
          throw Object.assign(new Error('rejected clip'), { status: 422 });
        }),
      });

      let thrown: UnresolvableClonedVoiceError | undefined;
      try {
        await resolveClonedVoicesForChapter(
          [{ characterName: 'Marlow', libraryUuid: 'u1', engine: 'qwen' as const, wrongEngine: false, engineUnavailable: false }],
          deps,
        );
      } catch (e) {
        thrown = e as UnresolvableClonedVoiceError;
      }

      expect(thrown?.broken).toEqual([{ name: 'Marlow', reason: 'revoked' }]);
      expect(deps.writeEntry).not.toHaveBeenCalled();
      expect(deps.purgeCloneArtifacts).toHaveBeenCalledWith('u1', {});
    });
  });

  /* --- fix wave, review I-1/I-4: the makeDeps default `updateEntry` used to
     stop at `writeEntry` and never exercise production's canonical
     post-write re-read — the exact spot where I-1's null-conflation bug
     lived. This test drives that double's real (fixed) two-read shape and
     configures its SECOND (post-write) read to come back undefined —
     reproducing "the write succeeded but the canonical re-read failed"
     inside the resolver's own permanent-derive-failure path, not just at
     the voice-library primitive in isolation. */
  describe('fix wave, review I-1/I-4 — a successful write must still be reported even when the canonical re-read fails', () => {
    it('permanent (4xx) derive failure: still reported as derive-failed even when the post-write canonical re-read comes back undefined', async () => {
      const preDeriveEntry = baseEntry({ master: MASTER });
      const freshEntry = baseEntry({ master: MASTER }); // NOT revoked — the write proceeds.
      const readEntry = vi
        .fn()
        .mockResolvedValueOnce(preDeriveEntry) // classify's read
        .mockResolvedValueOnce(freshEntry); // updateEntry's fresh pre-write read
      // Deliberately NO third mockResolvedValueOnce — the double's
      // canonical post-write re-read falls through to `undefined`,
      // reproducing I-1's "write succeeded, re-read failed" ambiguity.
      const deps = makeDeps({
        readEntry,
        ptExists: vi.fn(async () => false),
        deriveEngineArtifact: vi.fn(async () => {
          throw Object.assign(new Error('rejected clip'), { status: 422 });
        }),
      });

      let thrown: UnresolvableClonedVoiceError | undefined;
      try {
        await resolveClonedVoicesForChapter(
          [{ characterName: 'Marlow', libraryUuid: 'u1', engine: 'qwen' as const, wrongEngine: false, engineUnavailable: false }],
          deps,
        );
      } catch (e) {
        thrown = e as UnresolvableClonedVoiceError;
      }

      // The write DID happen — proving this isn't the "mutate declined"
      // branch (that's the pre-existing "revoked" test above).
      expect(deps.writeEntry).toHaveBeenCalledTimes(1);
      const written = deps.writeEntry.mock.calls[0][0] as VoiceLibraryEntry;
      expect(written.engines.qwen?.status).toBe('failed');

      // I-1: a write that succeeded but whose canonical re-read comes back
      // null/undefined must still be reported — not silently dropped.
      expect(thrown?.broken).toEqual([{ name: 'Marlow', reason: 'derive-failed' }]);
    });
  });

  /* --- review I-1: an abort mid-derive must propagate as an AbortError, ---
     --- never be misreported as a chapter/voice failure ------------------- */

  describe('review I-1 — an abort mid-derive propagates as AbortError, not a derive-failed report', () => {
    it('deriveEngineArtifact rejecting with a genuine AbortError propagates unchanged and skips the rest of the loop', async () => {
      const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
      const entry = baseEntry({ master: MASTER });
      const deriveEngineArtifact = vi.fn(async () => {
        throw abortErr;
      });
      const readEntry = vi.fn(async () => entry);
      const deps = makeDeps({ readEntry, ptExists: vi.fn(async () => false), deriveEngineArtifact });

      await expect(
        resolveClonedVoicesForChapter(
          [
            { characterName: 'Marlow', libraryUuid: 'u1', engine: 'qwen' as const, wrongEngine: false, engineUnavailable: false },
            { characterName: 'Second', libraryUuid: 'u2', engine: 'qwen' as const, wrongEngine: false, engineUnavailable: false },
          ],
          deps,
        ),
      ).rejects.toBe(abortErr);

      // The loop stopped at the first request — the second was never reached.
      expect(deriveEngineArtifact).toHaveBeenCalledTimes(1);
      expect(deps.writeEntry).not.toHaveBeenCalled();
    });

    /* This is the REALISTIC production shape: derive-engine-artifact.ts's
       fetch layer converts EVERY rejection, abort included, into a
       SidecarDesignError(status 0) — so `err.name` is NOT 'AbortError' here.
       Only `deps.signal.aborted` (set by the same `controller.abort()` call
       that caused the fetch to reject) proves this was actually a pause, not
       a real sidecar-unreachable failure. This is the case that used to
       produce a scary "cloned voice … derive-failed" chapter failure on a
       plain Pause click. */
    it('deriveEngineArtifact rejecting with the real wrapped SidecarDesignError(status 0) shape, with deps.signal aborted, still rejects as AbortError — not UnresolvableClonedVoiceError', async () => {
      const controller = new AbortController();
      const entry = baseEntry({ master: MASTER });
      const deriveEngineArtifact = vi.fn(async () => {
        controller.abort();
        throw Object.assign(new Error('TTS sidecar (…) is unreachable — The operation was aborted.'), {
          name: 'SidecarDesignError',
          status: 0,
        });
      });
      const readEntry = vi.fn(async () => entry);
      const deps = makeDeps({
        readEntry,
        ptExists: vi.fn(async () => false),
        deriveEngineArtifact,
        signal: controller.signal,
      });

      let rejection: unknown;
      try {
        await resolveClonedVoicesForChapter(
          [{ characterName: 'Marlow', libraryUuid: 'u1', engine: 'qwen' as const, wrongEngine: false, engineUnavailable: false }],
          deps,
        );
        throw new Error('expected rejection');
      } catch (e) {
        rejection = e;
      }

      expect(rejection).not.toBeInstanceOf(UnresolvableClonedVoiceError);
      expect((rejection as { name?: string })?.name).toBe('AbortError');
      expect(deps.writeEntry).not.toHaveBeenCalled();
    });

    it('an already-aborted signal is checked at the TOP of each loop iteration — a second requested voice is never even classified', async () => {
      const controller = new AbortController();
      controller.abort();
      const entry = baseEntry({ master: MASTER });
      const readEntry = vi.fn(async () => entry);
      const deps = makeDeps({ readEntry, signal: controller.signal });

      let rejection: unknown;
      try {
        await resolveClonedVoicesForChapter(
          [
            { characterName: 'Marlow', libraryUuid: 'u1', engine: 'qwen' as const, wrongEngine: false, engineUnavailable: false },
            { characterName: 'Second', libraryUuid: 'u2', engine: 'qwen' as const, wrongEngine: false, engineUnavailable: false },
          ],
          deps,
        );
        throw new Error('expected rejection');
      } catch (e) {
        rejection = e;
      }

      expect((rejection as { name?: string })?.name).toBe('AbortError');
      expect(readEntry).not.toHaveBeenCalled();
      expect(deps.deriveEngineArtifact).not.toHaveBeenCalled();
    });
  });

  /* --- fs-38 Wave 3c, Task 18 — the coqui path: same orchestrator, engine
     threaded through to the storage key, the derive call, and the written
     manifest slot (`engines.xtts` instead of `engines.qwen`). */
  describe('the coqui path', () => {
    /* Placebo-proof (per this task's brief): a raise-only assertion would
       pass against an implementation that raises AFTER wastefully deriving
       — assert BOTH halves. Mirrors the qwen "the invariant, direct" test
       above, on the coqui engine/xtts slot instead. */
    it('the invariant, direct: a revoked coqui-cloned voice rejects and NEVER calls deriveEngineArtifact', async () => {
      const revokedEntry = baseEntry({
        consent: {
          personName: 'x',
          relationship: 'self',
          permittedUse: 'personal',
          attestedAt: '2026-01-01T00:00:00Z',
          attestedBy: 'x',
          revokedAt: '2026-02-01T00:00:00Z',
        },
        master: MASTER,
        engines: { xtts: { status: 'ready', coquiVersion: 'v2.0.3' } },
      });
      const deps = makeDeps({ readEntry: vi.fn(async () => revokedEntry) });

      let thrown: UnresolvableClonedVoiceError | undefined;
      try {
        await resolveClonedVoicesForChapter(
          [{ characterName: 'Marlow', libraryUuid: 'u1', engine: 'coqui', wrongEngine: false, engineUnavailable: false }],
          deps,
        );
      } catch (e) {
        thrown = e as UnresolvableClonedVoiceError;
      }

      // Half 1: raises, with the right reason.
      expect(thrown).toBeInstanceOf(UnresolvableClonedVoiceError);
      expect(thrown?.broken).toEqual([{ name: 'Marlow', reason: 'revoked' }]);
      // Half 2: no derive was invoked — the raise-only assertion above would
      // also pass against a broken implementation that derives BEFORE
      // noticing the revoke; this is what actually catches that defect.
      expect(deps.deriveEngineArtifact).not.toHaveBeenCalled();
      expect(deps.writeEntry).not.toHaveBeenCalled();
    });

    it('coqui repairable: derives on the xtts slot, stamps ready with the derive-reported coquiVersion/modelId, and preserves a sibling qwen engine untouched', async () => {
      // Sibling preservation, direction 2 (coqui writes must not disturb an
      // existing qwen slot) — the mirror image of the pre-existing
      // "repairable: derives once..." qwen test, which only pinned qwen
      // writes preserving xtts.
      const entry = baseEntry({
        master: MASTER,
        engines: {
          xtts: { status: 'stale', coquiVersion: 'v2.0.3' },
          qwen: { status: 'ready', baseModel: 'qwen3-0.6b' },
        },
      });
      const controller = new AbortController();
      const deps = makeDeps({
        readEntry: vi.fn(async () => entry),
        ptExists: vi.fn(async () => true),
        currentArtifactVersion: () => '', // no live coqui oracle — see Task 18's decision.
        deriveEngineArtifact: vi.fn(async () => ({
          previewPcm: Buffer.alloc(0),
          sampleRate: 24000,
          coquiVersion: 'v2.0.5',
          modelId: 'tts_models/multilingual/multi-dataset/xtts_v2',
        })),
        signal: controller.signal,
      });

      await expect(
        resolveClonedVoicesForChapter(
          [{ characterName: 'Marlow', libraryUuid: 'u1', engine: 'coqui', wrongEngine: false, engineUnavailable: false }],
          deps,
        ),
      ).resolves.toBeUndefined();

      expect(deps.deriveEngineArtifact).toHaveBeenCalledTimes(1);
      expect(deps.deriveEngineArtifact).toHaveBeenCalledWith(
        'u1',
        'coqui',
        {
          masterPcm: expect.any(Buffer),
          sampleRate: 24000,
          refText: 'hi',
          auditionText: REPAIR_AUDITION_TEXT,
        },
        { signal: controller.signal },
      );
      expect(deps.writeEntry).toHaveBeenCalledTimes(1);
      const written = deps.writeEntry.mock.calls[0][0] as VoiceLibraryEntry;
      expect(written.engines.xtts).toEqual({
        status: 'ready',
        coquiVersion: 'v2.0.5',
        modelId: 'tts_models/multilingual/multi-dataset/xtts_v2',
      });
      // The sibling qwen slot survives untouched — the direction the
      // pre-existing qwen test above does NOT cover.
      expect(written.engines.qwen).toEqual({ status: 'ready', baseModel: 'qwen3-0.6b' });
    });

    it('coqui: a stat()/derive call is keyed on the xtts- storage key, not qwen-', async () => {
      const entry = baseEntry({ master: MASTER, engines: { xtts: { status: 'stale' } } });
      const ptExists = vi.fn(async () => false);
      const deps = makeDeps({
        readEntry: vi.fn(async () => entry),
        ptExists,
        deriveEngineArtifact: vi.fn(async () => ({
          previewPcm: Buffer.alloc(0),
          sampleRate: 24000,
          coquiVersion: 'v2.0.5',
          modelId: 'xtts_v2',
        })),
      });

      await resolveClonedVoicesForChapter(
        [{ characterName: 'Marlow', libraryUuid: 'u1', engine: 'coqui', wrongEngine: false, engineUnavailable: false }],
        deps,
      );

      expect(ptExists).toHaveBeenCalledWith('xtts-u1');
    });

    it('coqui permanent (4xx) derive failure persists failed on the xtts slot, not qwen', async () => {
      const entry = baseEntry({ master: MASTER, engines: { qwen: { status: 'ready', baseModel: 'qwen3-0.6b' } } });
      const deps = makeDeps({
        readEntry: vi.fn(async () => entry),
        ptExists: vi.fn(async () => false),
        deriveEngineArtifact: vi.fn(async () => {
          throw Object.assign(new Error('rejected clip'), { status: 422 });
        }),
      });

      let thrown: UnresolvableClonedVoiceError | undefined;
      try {
        await resolveClonedVoicesForChapter(
          [{ characterName: 'Marlow', libraryUuid: 'u1', engine: 'coqui', wrongEngine: false, engineUnavailable: false }],
          deps,
        );
      } catch (e) {
        thrown = e as UnresolvableClonedVoiceError;
      }

      expect(thrown?.broken).toEqual([{ name: 'Marlow', reason: 'derive-failed' }]);
      expect(deps.writeEntry).toHaveBeenCalledTimes(1);
      const written = deps.writeEntry.mock.calls[0][0] as VoiceLibraryEntry;
      expect(written.engines.xtts?.status).toBe('failed');
      // The sibling qwen slot is untouched by the coqui failure stamp.
      expect(written.engines.qwen).toEqual({ status: 'ready', baseModel: 'qwen3-0.6b' });
    });
  });

  /* fs-38 Wave 3c, Task 18 — UnresolvableClonedVoiceError's remedy text is
     now engine-aware: a coqui-unavailable voice must not tell the user to
     "Re-enable Qwen", which misdiagnoses a perfectly healthy Qwen. */
  describe('UnresolvableClonedVoiceError.fromList is engine-aware for engine-unavailable', () => {
    it('a coqui-unavailable voice is told to re-enable Coqui, not Qwen', async () => {
      const entry = baseEntry({ engines: { xtts: { status: 'ready', coquiVersion: 'v2.0.3' } } });
      const deps = makeDeps({ readEntry: vi.fn(async () => entry) });

      let thrown: UnresolvableClonedVoiceError | undefined;
      try {
        await resolveClonedVoicesForChapter(
          [{ characterName: 'Marlow', libraryUuid: 'u1', engine: 'coqui', wrongEngine: false, engineUnavailable: true }],
          deps,
        );
      } catch (e) {
        thrown = e as UnresolvableClonedVoiceError;
      }

      expect(thrown?.message).toContain('Re-enable Coqui');
      expect(thrown?.message).not.toContain('Re-enable Qwen');
    });

    it('a mix of qwen- and coqui-unavailable voices names both engines', async () => {
      const qwenEntry = baseEntry({ voiceUuid: 'u1', engines: { qwen: { status: 'ready', baseModel: 'qwen3-0.6b' } } });
      const coquiEntry = baseEntry({ voiceUuid: 'u2', engines: { xtts: { status: 'ready', coquiVersion: 'v2.0.3' } } });
      const deps = makeDeps({
        readEntry: vi.fn(async (uuid: string) => (uuid === 'u1' ? qwenEntry : coquiEntry)),
      });

      let thrown: UnresolvableClonedVoiceError | undefined;
      try {
        await resolveClonedVoicesForChapter(
          [
            { characterName: 'Marlow', libraryUuid: 'u1', engine: 'qwen', wrongEngine: false, engineUnavailable: true },
            { characterName: 'Reeve', libraryUuid: 'u2', engine: 'coqui', wrongEngine: false, engineUnavailable: true },
          ],
          deps,
        );
      } catch (e) {
        thrown = e as UnresolvableClonedVoiceError;
      }

      expect(thrown?.message).toContain('Re-enable Qwen or Coqui');
    });

    it('a qwen-unavailable voice still says "Re-enable Qwen" (byte-identical to pre-Task-18 text)', async () => {
      const entry = baseEntry({ engines: { qwen: { status: 'ready', baseModel: 'qwen3-0.6b' } } });
      const deps = makeDeps({ readEntry: vi.fn(async () => entry) });

      let thrown: UnresolvableClonedVoiceError | undefined;
      try {
        await resolveClonedVoicesForChapter(
          [{ characterName: 'Marlow', libraryUuid: 'u1', engine: 'qwen', wrongEngine: false, engineUnavailable: true }],
          deps,
        );
      } catch (e) {
        thrown = e as UnresolvableClonedVoiceError;
      }

      expect(thrown?.message).toContain(
        'Re-enable Qwen or restore the missing voice(s)',
      );
    });
  });
});

/* --- Task 12 (§2.3): designed-voice orphan self-heal ---------------------- */

function makeDesignedDeps(
  overrides: Partial<ResolveDesignedVoiceDeps> = {},
): ResolveDesignedVoiceDeps & {
  ptExists: ReturnType<typeof vi.fn>;
  readDesignedMasterPcm: ReturnType<typeof vi.fn>;
  deriveEngineArtifact: ReturnType<typeof vi.fn>;
  writeSidecarManifest: ReturnType<typeof vi.fn>;
  readEntry: ReturnType<typeof vi.fn>;
  writeEntry: ReturnType<typeof vi.fn>;
  updateEntry: ReturnType<typeof vi.fn>;
} {
  // fs-38 Wave 3c, Task 14 — same call-through default as makeDeps above, so
  // pre-existing tests asserting on `readEntry`/`writeEntry` directly keep
  // passing unchanged.
  const readEntry = overrides.readEntry ?? vi.fn(async () => null);
  const writeEntry = overrides.writeEntry ?? vi.fn(async () => {});
  const defaultUpdateEntry = vi.fn(
    async (
      uuid: string,
      mutate: (
        entry: VoiceLibraryEntry | null,
      ) => Promise<VoiceLibraryEntry | null | undefined> | VoiceLibraryEntry | null | undefined,
    ) => {
      const fresh = await readEntry(uuid);
      const next = await mutate(fresh);
      if (!next) return null;
      await writeEntry(next);
      // Fix wave (review I-4) — same production-shape fix as makeDeps'
      // default above: a real canonical re-read, falling back to `next`
      // (I-1) when it comes back null/undefined.
      return (await readEntry(uuid)) ?? next;
    },
  );
  return {
    ptExists: vi.fn(async () => true),
    readDesignedMasterPcm: vi.fn(async () => null),
    deriveEngineArtifact: vi.fn(async () => ({
      previewPcm: Buffer.alloc(0),
      sampleRate: 24000,
      baseModel: 'qwen3-0.6b',
    })),
    writeSidecarManifest: vi.fn(async () => {}),
    readEntry,
    writeEntry,
    updateEntry: defaultUpdateEntry,
    ...overrides,
  } as ResolveDesignedVoiceDeps & {
    ptExists: ReturnType<typeof vi.fn>;
    readDesignedMasterPcm: ReturnType<typeof vi.fn>;
    deriveEngineArtifact: ReturnType<typeof vi.fn>;
    writeSidecarManifest: ReturnType<typeof vi.fn>;
    readEntry: ReturnType<typeof vi.fn>;
    writeEntry: ReturnType<typeof vi.fn>;
    updateEntry: ReturnType<typeof vi.fn>;
  };
}

describe('resolveDesignedVoicesForChapter', () => {
  it('.pt missing + retained clip present -> re-derives once with the right voice id + ref text', async () => {
    const deps = makeDesignedDeps({
      ptExists: vi.fn(async () => false),
      readDesignedMasterPcm: vi.fn(async (uuid: string) =>
        uuid === 'lib-designed'
          ? {
              pcm: Buffer.alloc(1000),
              sampleRate: 24000,
              refText: 'A calibration line.',
              manifest: { voiceId: 'qwen-lib-designed', refText: 'A calibration line.' },
            }
          : null,
      ),
    });

    await expect(
      resolveDesignedVoicesForChapter(
        [{ characterName: 'Orin', libraryUuid: 'lib-designed' }],
        deps,
      ),
    ).resolves.toBeUndefined();

    expect(deps.ptExists).toHaveBeenCalledWith('qwen-lib-designed');
    expect(deps.readDesignedMasterPcm).toHaveBeenCalledWith('lib-designed');
    expect(deps.deriveEngineArtifact).toHaveBeenCalledTimes(1);
    expect(deps.deriveEngineArtifact).toHaveBeenCalledWith(
      'lib-designed',
      'qwen',
      {
        masterPcm: expect.any(Buffer),
        sampleRate: 24000,
        refText: 'A calibration line.',
        auditionText: REPAIR_AUDITION_TEXT,
      },
      { signal: undefined },
    );
  });

  it('.pt PRESENT -> no re-derive attempted (no needless GPU work), and the retained clip is never even read', async () => {
    const deps = makeDesignedDeps({ ptExists: vi.fn(async () => true) });

    await resolveDesignedVoicesForChapter(
      [{ characterName: 'Orin', libraryUuid: 'lib-designed' }],
      deps,
    );

    expect(deps.readDesignedMasterPcm).not.toHaveBeenCalled();
    expect(deps.deriveEngineArtifact).not.toHaveBeenCalled();
  });

  it('.pt missing + NO retained clip -> no crash, no re-derive, falls through to today\'s behaviour', async () => {
    const deps = makeDesignedDeps({
      ptExists: vi.fn(async () => false),
      readDesignedMasterPcm: vi.fn(async () => null),
    });

    await expect(
      resolveDesignedVoicesForChapter(
        [{ characterName: 'Orin', libraryUuid: 'lib-designed' }],
        deps,
      ),
    ).resolves.toBeUndefined();

    expect(deps.deriveEngineArtifact).not.toHaveBeenCalled();
  });

  it('a stale-baseModel designed entry (i.e. .pt still present on disk) -> NO re-derive — explicitly out of scope, pinned so nobody widens it', async () => {
    // This function never inspects a VoiceLibraryEntry's engines.qwen.baseModel
    // at all — it only checks on-disk `.pt` presence — so "stale" and
    // "healthy" are indistinguishable to it by design. Pinning this here so a
    // future edit that threads `currentBaseModel`/`baseModel` into this
    // function (widening the self-heal to the stale case) has to consciously
    // change this test, not silently pass it.
    const deps = makeDesignedDeps({ ptExists: vi.fn(async () => true) });

    await resolveDesignedVoicesForChapter(
      [{ characterName: 'Orin', libraryUuid: 'lib-designed' }],
      deps,
    );

    expect(deps.deriveEngineArtifact).not.toHaveBeenCalled();
  });

  it('a re-derive failure is swallowed — never throws, never bricks the run', async () => {
    const deps = makeDesignedDeps({
      ptExists: vi.fn(async () => false),
      readDesignedMasterPcm: vi.fn(async () => ({
        pcm: Buffer.alloc(10),
        sampleRate: 24000,
        refText: 'x',
        manifest: { refText: 'x' },
      })),
      deriveEngineArtifact: vi.fn(async () => {
        throw new Error('sidecar unreachable');
      }),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      resolveDesignedVoicesForChapter(
        [{ characterName: 'Orin', libraryUuid: 'lib-designed' }],
        deps,
      ),
    ).resolves.toBeUndefined();

    // M-3 (review) — the failure is logged, not silently swallowed.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Orin'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it('no libraryUuid -> skipped without touching ptExists/derive', async () => {
    const deps = makeDesignedDeps();

    await resolveDesignedVoicesForChapter(
      [{ characterName: 'Orin', libraryUuid: undefined }],
      deps,
    );

    expect(deps.ptExists).not.toHaveBeenCalled();
    expect(deps.readDesignedMasterPcm).not.toHaveBeenCalled();
    expect(deps.deriveEngineArtifact).not.toHaveBeenCalled();
  });

  /* --- review C-1: designed manifest fields survive a self-heal ---------- */

  it('C-1: a successful self-heal PRESERVES instruct/designModel/language, refreshing only refText/baseModel', async () => {
    // The sidecar's clone_voice handler truncate-rewrites qwen-<uuid>.json to
    // a bare clone shape on a successful derive — it has no idea this
    // voiceId was ever DESIGNED. The pre-derive manifest snapshot below is
    // what a real design_voice call would have left on disk; the fix must
    // restore its designed-only fields after the derive succeeds.
    const originalManifest = {
      voiceId: 'qwen-lib-designed',
      voiceUuid: 'lib-designed',
      instruct: 'A gravelly, world-weary tone.',
      language: 'en',
      refText: 'A calibration line.',
      baseModel: 'qwen3-old',
      designModel: 'qwen3-voicedesign-1.7b',
      mintMethod: 'anchored-icl-instruct',
    };
    const writeSidecarManifest = vi.fn(async (_uuid: string, _manifest: Record<string, unknown>) => {});
    const deps = makeDesignedDeps({
      ptExists: vi.fn(async () => false),
      readDesignedMasterPcm: vi.fn(async () => ({
        pcm: Buffer.alloc(1000),
        sampleRate: 24000,
        refText: 'A calibration line.',
        manifest: originalManifest,
      })),
      deriveEngineArtifact: vi.fn(async () => ({
        previewPcm: Buffer.alloc(0),
        sampleRate: 24000,
        baseModel: 'qwen3-new',
      })),
      writeSidecarManifest,
    });

    await resolveDesignedVoicesForChapter(
      [{ characterName: 'Orin', libraryUuid: 'lib-designed' }],
      deps,
    );

    expect(writeSidecarManifest).toHaveBeenCalledTimes(1);
    const [writtenUuid, writtenManifest] = writeSidecarManifest.mock.calls[0];
    expect(writtenUuid).toBe('lib-designed');
    // Designed-only fields survive — this is what the sidecar's clone_voice
    // handler would otherwise drop entirely.
    expect(writtenManifest.instruct).toBe('A gravelly, world-weary tone.');
    expect(writtenManifest.designModel).toBe('qwen3-voicedesign-1.7b');
    expect(writtenManifest.mintMethod).toBe('anchored-icl-instruct');
    expect(writtenManifest.language).toBe('en');
    expect(writtenManifest.voiceUuid).toBe('lib-designed');
    // ...while baseModel is refreshed to the derive's actual value.
    expect(writtenManifest.baseModel).toBe('qwen3-new');
  });

  it('C-1: a manifest-restore failure is logged but does not make a successful self-heal throw', async () => {
    const deps = makeDesignedDeps({
      ptExists: vi.fn(async () => false),
      readDesignedMasterPcm: vi.fn(async () => ({
        pcm: Buffer.alloc(10),
        sampleRate: 24000,
        refText: 'x',
        manifest: { refText: 'x', instruct: 'y' },
      })),
      writeSidecarManifest: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      resolveDesignedVoicesForChapter(
        [{ characterName: 'Orin', libraryUuid: 'lib-designed' }],
        deps,
      ),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  /* --- review I-1: ptExists / readDesignedMasterPcm throwing never escapes */

  it('I-1: readDesignedMasterPcm throwing (contract violation) is still swallowed, not propagated', async () => {
    const deps = makeDesignedDeps({
      ptExists: vi.fn(async () => false),
      readDesignedMasterPcm: vi.fn(async () => {
        throw new Error('undecodable clip (ffmpeg exited 1)');
      }),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      resolveDesignedVoicesForChapter(
        [{ characterName: 'Orin', libraryUuid: 'lib-designed' }],
        deps,
      ),
    ).resolves.toBeUndefined();

    expect(deps.deriveEngineArtifact).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('I-1: ptExists throwing is still swallowed, not propagated', async () => {
    const deps = makeDesignedDeps({
      ptExists: vi.fn(async () => {
        throw new Error('stat blew up');
      }),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      resolveDesignedVoicesForChapter(
        [{ characterName: 'Orin', libraryUuid: 'lib-designed' }],
        deps,
      ),
    ).resolves.toBeUndefined();

    expect(deps.readDesignedMasterPcm).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  /* --- review I-2: a healed voice is stamped ready, not stuck stale ------ */

  it('I-2: a successful self-heal stamps engines.qwen ready with the derive baseModel, preserving a sibling engine', async () => {
    const entry = {
      voiceUuid: 'lib-designed',
      name: 'Orin',
      provenance: 'designed' as const,
      tags: [],
      pinned: false,
      // A promote-with-no-.pt entry is created exactly this way — `stale`,
      // no baseModel at all — which `withComputedStaleness` can't repair.
      engines: { qwen: { status: 'stale' as const }, xtts: { status: 'ready' as const } },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const writeEntry = vi.fn(async (_entry: typeof entry) => {});
    const deps = makeDesignedDeps({
      ptExists: vi.fn(async () => false),
      readDesignedMasterPcm: vi.fn(async () => ({
        pcm: Buffer.alloc(10),
        sampleRate: 24000,
        refText: 'x',
        manifest: { refText: 'x' },
      })),
      deriveEngineArtifact: vi.fn(async () => ({
        previewPcm: Buffer.alloc(0),
        sampleRate: 24000,
        baseModel: 'qwen3-new',
      })),
      readEntry: vi.fn(async () => entry),
      writeEntry,
    });

    await resolveDesignedVoicesForChapter(
      [{ characterName: 'Orin', libraryUuid: 'lib-designed' }],
      deps,
    );

    expect(writeEntry).toHaveBeenCalledTimes(1);
    const written = writeEntry.mock.calls[0][0];
    expect(written.engines.qwen).toEqual({ status: 'ready', baseModel: 'qwen3-new' });
    expect(written.engines.xtts).toEqual({ status: 'ready' }); // sibling engine survives
  });

  /* Task 15 (DELTA-I4) — `deriveEngineArtifact`'s `baseModel` is now optional
     on its result (a coqui derive never sets it), so `result.baseModel` is
     `string | undefined` at this call site even though it always derives via
     the literal 'qwen'. Left unguarded, a falsy `result.baseModel` would
     write `baseModel: undefined` onto `engines.qwen`, which
     `withComputedStaleness` (routes/voice-library.ts) reads as "never
     stale" — a silent regression to this self-heal. Pins the guard: an
     undefined `baseModel` on the derive result falls back to
     `currentQwenBaseModel()`, never `undefined`. */
  it('I-2/Task-15: a derive result with no baseModel stamps engines.qwen with currentQwenBaseModel(), never undefined', async () => {
    const entry = {
      voiceUuid: 'lib-designed',
      name: 'Orin',
      provenance: 'designed' as const,
      tags: [],
      pinned: false,
      engines: { qwen: { status: 'stale' as const } },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const writeEntry = vi.fn(async (_entry: typeof entry) => {});
    const deps = makeDesignedDeps({
      ptExists: vi.fn(async () => false),
      readDesignedMasterPcm: vi.fn(async () => ({
        pcm: Buffer.alloc(10),
        sampleRate: 24000,
        refText: 'x',
        manifest: { refText: 'x' },
      })),
      deriveEngineArtifact: vi.fn(async () => ({
        previewPcm: Buffer.alloc(0),
        sampleRate: 24000,
        baseModel: undefined,
      })),
      readEntry: vi.fn(async () => entry),
      writeEntry,
    });

    await resolveDesignedVoicesForChapter(
      [{ characterName: 'Orin', libraryUuid: 'lib-designed' }],
      deps,
    );

    expect(writeEntry).toHaveBeenCalledTimes(1);
    const written = writeEntry.mock.calls[0][0];
    expect(written.engines.qwen).toEqual({ status: 'ready', baseModel: currentQwenBaseModel() });
  });

  /* Review C-1 — a designed voice carries no consent dimension, so there's
     no revoke race to guard against here, but the SAME lost-update shape
     the cloned resolver fixes (stamping a status write into a STALE
     pre-derive snapshot) would be just as real if this function's `readEntry`
     were called before the derive. It isn't: `readEntry` (deps.readEntry)
     is only ever called ONCE in this whole function, and that call sits
     immediately before the write — AFTER the derive has already completed
     — so whatever a concurrent, unrelated edit changed on the entry WHILE
     the derive was running is picked up here, not clobbered. This test
     pins that: it does NOT fail on the pre-existing code (no separate
     stale-snapshot variable exists in this function to fix), which is
     itself the finding — confirming there is no analogous C-1 gap on the
     designed self-heal's own write, only the documentation debt of proving
     it. */
  it('C-1 (designed path): a concurrent unrelated entry edit made while the derive was running is NOT clobbered — the stamp merges into whatever readEntry returns post-derive', async () => {
    const entryAfterConcurrentEdit = {
      voiceUuid: 'lib-designed',
      name: 'Orin',
      provenance: 'designed' as const,
      tags: ['edited-during-derive'], // a concurrent, unrelated write landed mid-derive
      pinned: true,
      engines: { qwen: { status: 'stale' as const }, xtts: { status: 'ready' as const } },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const writeEntry = vi.fn(async (_entry: typeof entryAfterConcurrentEdit) => {});
    const deps = makeDesignedDeps({
      ptExists: vi.fn(async () => false),
      readDesignedMasterPcm: vi.fn(async () => ({
        pcm: Buffer.alloc(10),
        sampleRate: 24000,
        refText: 'x',
        manifest: { refText: 'x' },
      })),
      deriveEngineArtifact: vi.fn(async () => ({
        previewPcm: Buffer.alloc(0),
        sampleRate: 24000,
        baseModel: 'qwen3-new',
      })),
      readEntry: vi.fn(async () => entryAfterConcurrentEdit),
      writeEntry,
    });

    await resolveDesignedVoicesForChapter([{ characterName: 'Orin', libraryUuid: 'lib-designed' }], deps);

    expect(writeEntry).toHaveBeenCalledTimes(1);
    const written = writeEntry.mock.calls[0][0];
    // The concurrent edit survives in the write — proof this merges into
    // whatever the fresh (post-derive) readEntry call returns.
    expect(written.tags).toEqual(['edited-during-derive']);
    expect(written.pinned).toBe(true);
    expect(written.engines.qwen).toEqual({ status: 'ready', baseModel: 'qwen3-new' });
  });

  it('I-2: readEntry returning null skips the stamp without throwing', async () => {
    const deps = makeDesignedDeps({
      ptExists: vi.fn(async () => false),
      readDesignedMasterPcm: vi.fn(async () => ({
        pcm: Buffer.alloc(10),
        sampleRate: 24000,
        refText: 'x',
        manifest: { refText: 'x' },
      })),
      readEntry: vi.fn(async () => null),
    });

    await expect(
      resolveDesignedVoicesForChapter(
        [{ characterName: 'Orin', libraryUuid: 'lib-designed' }],
        deps,
      ),
    ).resolves.toBeUndefined();

    expect(deps.writeEntry).not.toHaveBeenCalled();
  });

  /* --- review M-1: an abort stops the loop instead of being swallowed ---- */

  it('M-1: an AbortError from the derive propagates (is NOT swallowed) and stops the loop', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const deriveEngineArtifact = vi.fn(async () => {
      throw abortErr;
    });
    const readDesignedMasterPcm = vi.fn(async () => ({
      pcm: Buffer.alloc(10),
      sampleRate: 24000,
      refText: 'x',
      manifest: { refText: 'x' },
    }));
    const deps = makeDesignedDeps({
      ptExists: vi.fn(async () => false),
      readDesignedMasterPcm,
      deriveEngineArtifact,
    });

    await expect(
      resolveDesignedVoicesForChapter(
        [
          { characterName: 'Orin', libraryUuid: 'lib-designed' },
          { characterName: 'Second', libraryUuid: 'lib-second' },
        ],
        deps,
      ),
    ).rejects.toBe(abortErr);

    // The loop stopped at the first request — the second was never reached.
    expect(readDesignedMasterPcm).toHaveBeenCalledTimes(1);
  });
});
