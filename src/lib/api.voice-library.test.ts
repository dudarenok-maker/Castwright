/* Mock-side tests for the voice-library api surface (fs-38 Wave 1, Task 12,
   GET/PATCH/DELETE /api/voice-library and friends). Imports the mock pair
   directly because the api module locks USE_MOCKS at import time — mirrors
   api.mock-state.test.ts's pattern (flipping the env in a test file is too
   late to swap api.* over to the mock branch). */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  mockListVoiceLibrary,
  mockDesignLibraryVoice,
  mockDeleteVoiceLibrary,
  mockPromoteLibraryRedesign,
  mockAssignLibraryVoice,
  mockRevokeVoiceLibraryEntry,
  mockCloneVoice,
  _mockAssignGuardError,
  _mockAssignAdvisory,
  _mockAssignWrittenSlots,
  _resetMockVoiceLibrary,
} from './api';
import { MOCK_VOICE_LIBRARY_ENTRIES, type VoiceLibraryEntry } from '../mocks/voice-library';

beforeEach(() => {
  _resetMockVoiceLibrary();
});

describe('mock voice library', () => {
  it('list returns the seeded fixtures', async () => {
    const { voices } = await mockListVoiceLibrary();
    expect(voices).toHaveLength(MOCK_VOICE_LIBRARY_ENTRIES.length);
    expect(voices.map((v) => v.voiceUuid).sort()).toEqual(
      MOCK_VOICE_LIBRARY_ENTRIES.map((v) => v.voiceUuid).sort(),
    );
  });

  it('design appends a new entry to the list', async () => {
    const before = await mockListVoiceLibrary();

    const { entry, previewUrl } = await mockDesignLibraryVoice({
      name: 'New Voice',
      persona: 'A cheerful narrator.',
    });
    expect(entry.name).toBe('New Voice');
    expect(entry.provenance).toBe('designed');
    expect(previewUrl).toBeTruthy();

    const after = await mockListVoiceLibrary();
    expect(after.voices).toHaveLength(before.voices.length + 1);
    expect(after.voices.some((v) => v.voiceUuid === entry.voiceUuid)).toBe(true);
  });

  it('delete without confirm on the in-use fixture returns the 409-shaped usage payload', async () => {
    const result = await mockDeleteVoiceLibrary('lib-used');

    expect('usage' in result).toBe(true);
    if ('usage' in result) {
      expect(result.usage.length).toBeGreaterThan(0);
      expect(result.usage[0]).toMatchObject({
        bookId: expect.any(String),
        characterId: expect.any(String),
      });
    }

    // Refused delete leaves the entry in place.
    const { voices } = await mockListVoiceLibrary();
    expect(voices.some((v) => v.voiceUuid === 'lib-used')).toBe(true);
  });

  it('delete with confirm on the in-use fixture succeeds and removes the entry', async () => {
    const result = await mockDeleteVoiceLibrary('lib-used', { confirm: true });
    expect(result).toEqual({ deleted: true });

    const { voices } = await mockListVoiceLibrary();
    expect(voices.some((v) => v.voiceUuid === 'lib-used')).toBe(false);
  });

  it('promote-redesign persists the edited persona onto the entry', async () => {
    const before = await mockListVoiceLibrary();
    const original = before.voices.find((v) => v.voiceUuid === 'lib-pinned');
    expect(original?.persona).toBe(
      'A weathered ship captain, baritone, northern English, authoritative.',
    );

    const updated = await mockPromoteLibraryRedesign('lib-pinned', {
      persona: 'A jovial retired quartermaster, tenor, softer edge.',
    });
    expect(updated.persona).toBe('A jovial retired quartermaster, tenor, softer edge.');

    const after = await mockListVoiceLibrary();
    const persisted = after.voices.find((v) => v.voiceUuid === 'lib-pinned');
    expect(persisted?.persona).toBe('A jovial retired quartermaster, tenor, softer edge.');
  });

  it('#1808 — revoke on an unknown voiceUuid throws a clear error instead of crashing on find()!', async () => {
    await expect(mockRevokeVoiceLibraryEntry('nope')).rejects.toThrow(/no voice-library entry/i);
  });
});

/* fs-38 Wave 3c, Task 29 [ADV-C4][AC-I10][EX-15] — the assign mock used to
   return `{ updated: 1 }` unconditionally, with none of the real route's
   three 409s. `_mockAssignGuardError` is unit-tested directly against
   ad-hoc entries (rather than growing MOCK_VOICE_LIBRARY_ENTRIES, which the
   e2e voice-library spec's card-count assertions count) for the guard
   logic itself, and `mockAssignLibraryVoice` is exercised end-to-end
   against the real `lib-cloned-demo`/`lib-cloned-revoked` fixtures for the
   success + fixture-shape cases. */
describe('mock assign guards (fs-38 Wave 3c, Task 29)', () => {
  const baseConsent = {
    personName: 'Mum',
    relationship: 'family-with-permission' as const,
    permittedUse: 'personal' as const,
    attestedAt: '2026-07-20T00:00:00Z',
    attestedBy: 'me',
  };

  function makeCloned(overrides: Partial<VoiceLibraryEntry> = {}): VoiceLibraryEntry {
    return {
      voiceUuid: 'lib-clone-test',
      name: 'Test clone',
      provenance: 'cloned',
      tags: [],
      pinned: false,
      consent: baseConsent,
      engines: { qwen: { status: 'ready', baseModel: 'qwen3-tts-0.6b-2026-05' } },
      createdAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-20T00:00:00Z',
      ...overrides,
    };
  }

  it('409s a revoked entry', () => {
    const entry = makeCloned({ consent: { ...baseConsent, revokedAt: '2026-07-22T00:00:00Z' } });
    expect(_mockAssignGuardError(entry, undefined)).toBe(
      'Consent for this voice has been revoked.',
    );
  });

  it('409s a cloned entry with no engines[] and no retained reference clip (#1933 — replaces the retired Qwen-only "not ready" gate)', () => {
    const entry = makeCloned({ engines: {} });
    expect(_mockAssignGuardError(entry, undefined)).toBe(
      '"Test clone" has no retained reference clip and its Qwen voice is not ready, so there is nothing to derive it from. Re-clone the voice before assigning it to this character.',
    );
  });

  it('409s a ready, non-revoked cloned entry assigned to a non-clone-capable engine', () => {
    const entry = makeCloned();
    expect(_mockAssignGuardError(entry, 'kokoro-v1')).toMatch(/Cloned voices render on Qwen/);
  });

  it('allows a ready, non-revoked cloned entry assigned to Qwen', () => {
    const entry = makeCloned();
    expect(_mockAssignGuardError(entry, 'qwen3-tts-0.6b')).toBeNull();
  });

  it('allows a designed (non-cloned) entry regardless of modelKey — the guards are cloned-only, matching the real route', () => {
    const entry = makeCloned({ provenance: 'designed' });
    expect(_mockAssignGuardError(entry, 'kokoro-v1')).toBeNull();
  });

  it('checks revoked consent before readiness — guard order matches the real route', () => {
    const entry = makeCloned({
      engines: {},
      consent: { ...baseConsent, revokedAt: '2026-07-22T00:00:00Z' },
    });
    expect(_mockAssignGuardError(entry, undefined)).toBe(
      'Consent for this voice has been revoked.',
    );
  });

  /* #1933 — mock mirrors of three representative shapes from the server
     suite's T1/T3/T6b (server/src/routes/voice-library.test.ts): a
     coqui-routed assign despite a failed qwen slot (200 + advisory), a
     coqui-routed assign of a failed xtts slot even though qwen is ready
     (409 naming Coqui), and a coqui-routed assign of a transcript-less
     clip (200 + Qwen-transcript advisory). Tested directly against the
     exported guard/advisory helpers rather than growing
     `MOCK_VOICE_LIBRARY_ENTRIES` (same rationale as the guard tests
     above) — mock mode has no filesystem, so `master` presence alone
     stands in for the server's clip-on-disk check (see
     `_mockClonedAssignBlock`'s own doc comment). */
  describe('per-engine readiness gate (#1933)', () => {
    it('T1-mirror — allows a coqui-routed assign despite a terminally failed qwen slot, with a Qwen advisory', () => {
      const entry = makeCloned({
        engines: { qwen: { status: 'failed' } },
        master: {
          clipFile: 'master.wav',
          sampleRate: 24_000,
          durationSeconds: 5,
          transcript: 'hello there',
          transcriptSource: 'whisper',
          captureMethod: 'record',
        },
      });
      expect(_mockAssignGuardError(entry, 'coqui-xtts-v2')).toBeNull();
      const advisory = _mockAssignAdvisory(entry, 'coqui-xtts-v2');
      expect(advisory).toMatch(/Qwen/);
      expect(advisory).toMatch(/failed to derive/);
    });

    it('T3-mirror — 409s a coqui-routed assign of a failed xtts slot even though qwen is ready', () => {
      const entry = makeCloned({
        engines: { qwen: { status: 'ready', baseModel: 'x' }, xtts: { status: 'failed' } },
      });
      expect(_mockAssignGuardError(entry, 'coqui-xtts-v2')).toMatch(/Coqui XTTS v2/);
    });

    it('T6b-mirror — allows a coqui-routed assign of a transcript-less clip, with a Qwen transcript advisory', () => {
      const entry = makeCloned({
        engines: {},
        master: {
          clipFile: 'master.wav',
          sampleRate: 24_000,
          durationSeconds: 5,
          transcript: '',
          transcriptSource: 'whisper',
          captureMethod: 'record',
        },
      });
      expect(_mockAssignGuardError(entry, 'coqui-xtts-v2')).toBeNull();
      const advisory = _mockAssignAdvisory(entry, 'coqui-xtts-v2');
      expect(advisory).toMatch(/Qwen/);
      expect(advisory).toMatch(/transcript/);
    });
  });

  it('mockAssignLibraryVoice succeeds for the ready lib-cloned-demo fixture', async () => {
    const result = await mockAssignLibraryVoice('lib-cloned-demo', {
      bookId: 'b1',
      characterId: 'c1',
      modelKey: 'qwen3-tts-0.6b',
    });
    /* `lib-cloned-demo` is CLONED, so both clone-capable slots are written. */
    expect(result).toEqual({ updated: 1, written: ['qwen', 'coqui'] });
  });

  /* fs-38 Wave 3c, Task 41 — this test used to pin the OLD "deliberate lag"
     contract on purpose: `mockAssignLibraryVoice` mirrored the assign route
     as it stood before Task 24, which still hardcoded the qwen slot, so a
     coqui-routed assign 409'd here even though `lib-cloned-demo` carries a
     ready `xtts` slot too. Task 24 landed on this branch and made the real
     route engine-aware (coqui joined `CLONE_CAPABLE_ENGINES`), so the mock
     guard (`_mockAssignGuardError`, api.ts) was re-mirrored to match — this
     now asserts the NEW contract: a cloned voice with a ready xtts slot
     assigns cleanly on a coqui-routed character, same as it always did on
     qwen. Kept as a test, not deleted, so the old defect can't quietly come
     back the next time the route or the mock changes independently. */
  it('mockAssignLibraryVoice succeeds for lib-cloned-demo on a coqui assign — its xtts slot is ready', async () => {
    const result = await mockAssignLibraryVoice('lib-cloned-demo', {
      bookId: 'b1',
      characterId: 'c1',
      modelKey: 'coqui-xtts-v2',
    });
    expect(result).toEqual({ updated: 1, written: ['qwen', 'coqui'] });
  });

  it('mockAssignLibraryVoice 409s the real lib-cloned-revoked fixture', async () => {
    await expect(
      mockAssignLibraryVoice('lib-cloned-revoked', { bookId: 'b1', characterId: 'c1' }),
    ).rejects.toThrow('Consent for this voice has been revoked.');
  });

  /* GATE 1 [F1] — the mock's mirror of the route's `shouldWriteCoquiSlot`.
     The point of mirroring it at all is that mock mode must be able to
     produce the DECLINED-coqui response, or no mock-mode surface (including
     the e2e spec) can exercise the reconciliation the finding is about. */
  describe('_mockAssignWrittenSlots — which slots the mock reports written', () => {
    it('reports both slots for a cloned entry (always clone-capable on both)', () => {
      expect(_mockAssignWrittenSlots(makeCloned())).toEqual(['qwen', 'coqui']);
    });

    it('reports qwen ONLY for a designed entry with no coqui artifact', () => {
      expect(
        _mockAssignWrittenSlots(
          makeCloned({ provenance: 'designed', engines: { qwen: { status: 'ready' } } }),
        ),
      ).toEqual(['qwen']);
    });

    it('reports both slots for a designed entry that already carries an xtts artifact', () => {
      expect(
        _mockAssignWrittenSlots(
          makeCloned({
            provenance: 'designed',
            engines: { qwen: { status: 'ready' }, xtts: { status: 'ready' } },
          }),
        ),
      ).toEqual(['qwen', 'coqui']);
    });

    it('reports qwen ONLY for an imported entry, even with an xtts artifact present', () => {
      /* Discriminating against the proxy: `imported` never qualifies on the
         real route regardless of what it has derived, so the xtts check must
         not be reached for it. */
      expect(
        _mockAssignWrittenSlots(
          makeCloned({
            provenance: 'imported',
            consent: undefined,
            engines: { qwen: { status: 'ready' }, xtts: { status: 'ready' } },
          }),
        ),
      ).toEqual(['qwen']);
    });

    it('every designed fixture in MOCK_VOICE_LIBRARY_ENTRIES is qwen-only, so mock mode can reach the declined-coqui path', () => {
      const designed = MOCK_VOICE_LIBRARY_ENTRIES.filter((e) => e.provenance === 'designed');
      expect(designed.length).toBeGreaterThan(0);
      for (const entry of designed) {
        expect(_mockAssignWrittenSlots(entry)).toEqual(['qwen']);
      }
    });
  });

  /* #1943 — the mock must mirror the real route's attester handling. It used
     to hardcode `attestedBy: personName`, so mock mode (every `npm run dev`
     and every e2e run) kept reproducing the exact bug the real path fixed:
     a guardian-of-minor record claiming the child attested for themselves. */
  describe('clone consent attester', () => {
    const consent = {
      personName: 'Ana',
      relationship: 'guardian-of-minor' as const,
      permittedUse: 'personal' as const,
    };

    it('persists a supplied attestedBy distinct from personName', async () => {
      const entry = await mockCloneVoice({
        candidateId: 'cand-1',
        consent: { ...consent, attestedBy: 'Dana' },
      });
      expect(entry.consent?.personName).toBe('Ana');
      expect(entry.consent?.attestedBy).toBe('Dana');
    });

    it('trims a supplied attestedBy', async () => {
      const entry = await mockCloneVoice({
        candidateId: 'cand-1',
        consent: { ...consent, attestedBy: '  Dana  ' },
      });
      expect(entry.consent?.attestedBy).toBe('Dana');
    });

    /* #1959 — non-self relationships require attestedBy; only 'self' can fall
       back to personName. This test (previously testing the fallback on
       guardian-of-minor) is superseded by the clone-voice.test.ts suite. */
    it('requires attestedBy for guardian-of-minor (omitted is rejected)', async () => {
      await expect(
        mockCloneVoice({ candidateId: 'cand-1', consent }),
      ).rejects.toThrow(/attestedBy/);
    });

    it('requires attestedBy for guardian-of-minor (blank is rejected)', async () => {
      await expect(
        mockCloneVoice({
          candidateId: 'cand-1',
          consent: { ...consent, attestedBy: '   ' },
        }),
      ).rejects.toThrow(/attestedBy/);
    });
  });
});
