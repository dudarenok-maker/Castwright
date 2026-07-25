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
  type ClassifyInput,
  type ResolveChapterDeps,
} from './clone-voice-resolver.js';
import type { VoiceLibraryEntry } from '../workspace/voice-library.js';

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
    wrongEngine: false,
    engineUnavailable: false,
    ptExists: true,
    currentBaseModel: 'qwen3-0.6b',
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
        currentBaseModel: 'qwen3-0.6b',
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
});

/* --- T5: orchestrator ------------------------------------------------------ */

function makeDeps(overrides: Partial<ResolveChapterDeps> = {}): ResolveChapterDeps & {
  readEntry: ReturnType<typeof vi.fn>;
  writeEntry: ReturnType<typeof vi.fn>;
  ptExists: ReturnType<typeof vi.fn>;
  deriveEngineArtifact: ReturnType<typeof vi.fn>;
  readMasterPcm: ReturnType<typeof vi.fn>;
} {
  return {
    readEntry: vi.fn(async () => null),
    writeEntry: vi.fn(async () => {}),
    ptExists: vi.fn(async () => true),
    deriveEngineArtifact: vi.fn(async () => ({
      previewPcm: Buffer.alloc(0),
      sampleRate: 24000,
      baseModel: 'qwen3-0.6b',
    })),
    readMasterPcm: vi.fn(async () => ({ pcm: Buffer.alloc(0), sampleRate: 24000, refText: 'hi' })),
    currentBaseModel: () => 'qwen3-0.6b',
    ...overrides,
  } as ResolveChapterDeps & {
    readEntry: ReturnType<typeof vi.fn>;
    writeEntry: ReturnType<typeof vi.fn>;
    ptExists: ReturnType<typeof vi.fn>;
    deriveEngineArtifact: ReturnType<typeof vi.fn>;
    readMasterPcm: ReturnType<typeof vi.fn>;
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
        [{ characterName: 'Marlow', libraryUuid: 'u1', wrongEngine: false, engineUnavailable: false }],
        deps,
      ),
    ).rejects.toBeInstanceOf(UnresolvableClonedVoiceError);

    expect(deps.deriveEngineArtifact).not.toHaveBeenCalled();
    expect(deps.writeEntry).not.toHaveBeenCalled();

    // Confirm the rejection actually carries the revoked reason (not a
    // coincidental throw from something else).
    try {
      await resolveClonedVoicesForChapter(
        [{ characterName: 'Marlow', libraryUuid: 'u1', wrongEngine: false, engineUnavailable: false }],
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
      currentBaseModel: () => 'qwen3-new',
      signal: controller.signal,
    });

    await expect(
      resolveClonedVoicesForChapter(
        [{ characterName: 'Marlow', libraryUuid: 'u1', wrongEngine: false, engineUnavailable: false }],
        deps,
      ),
    ).resolves.toBeUndefined();

    expect(deps.deriveEngineArtifact).toHaveBeenCalledTimes(1);
    expect(deps.deriveEngineArtifact).toHaveBeenCalledWith(
      'u1',
      'qwen',
      { masterPcm: expect.any(Buffer), sampleRate: 24000, refText: 'hi' },
      { signal: controller.signal },
    );
    expect(deps.writeEntry).toHaveBeenCalledTimes(1);
    const written = deps.writeEntry.mock.calls[0][0] as VoiceLibraryEntry;
    expect(written.engines.qwen).toEqual({ status: 'ready', baseModel: 'qwen3-new' });
    expect(written.engines.xtts).toEqual({ status: 'ready' });
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
          [{ characterName: 'Marlow', libraryUuid: 'u1', wrongEngine: false, engineUnavailable: false }],
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
        [{ characterName: 'Marlow', libraryUuid: 'u1', wrongEngine: false, engineUnavailable: false }],
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
        [{ characterName: 'Marlow', libraryUuid: 'u1', wrongEngine: false, engineUnavailable: false }],
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
          { characterName: 'Marlow', libraryUuid: 'u1', wrongEngine: false, engineUnavailable: false },
          { characterName: 'Reeve', libraryUuid: 'u2', wrongEngine: false, engineUnavailable: false },
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
        [{ characterName: 'Marlow', libraryUuid: undefined, wrongEngine: false, engineUnavailable: false }],
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
        [{ characterName: 'Marlow', libraryUuid: 'u1', wrongEngine: false, engineUnavailable: false }],
        deps,
      );
    } catch (e) {
      thrown = e as UnresolvableClonedVoiceError;
    }
    expect(thrown?.broken).toEqual([{ name: 'Marlow', reason: 'misconfigured' }]);
    expect(deps.deriveEngineArtifact).not.toHaveBeenCalled();
  });
});
