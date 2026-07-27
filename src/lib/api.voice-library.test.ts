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
  _mockAssignGuardError,
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

  it('409s a cloned entry that has not finished deriving', () => {
    const entry = makeCloned({ engines: {} });
    expect(_mockAssignGuardError(entry, undefined)).toBe(
      'Cloned voice is not ready to assign yet.',
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

  it('mockAssignLibraryVoice succeeds for the ready lib-cloned-demo fixture', async () => {
    const result = await mockAssignLibraryVoice('lib-cloned-demo', {
      bookId: 'b1',
      characterId: 'c1',
      modelKey: 'qwen3-tts-0.6b',
    });
    expect(result).toEqual({ updated: 1 });
  });

  it('mockAssignLibraryVoice still 409s lib-cloned-demo on a coqui assign, even though its xtts slot is ready — deliberate lag, the real route (as mirrored) is still qwen-only', async () => {
    await expect(
      mockAssignLibraryVoice('lib-cloned-demo', {
        bookId: 'b1',
        characterId: 'c1',
        modelKey: 'coqui-xtts-v2',
      }),
    ).rejects.toThrow(/Cloned voices render on Qwen/);
  });

  it('mockAssignLibraryVoice 409s the real lib-cloned-revoked fixture', async () => {
    await expect(
      mockAssignLibraryVoice('lib-cloned-revoked', { bookId: 'b1', characterId: 'c1' }),
    ).rejects.toThrow('Consent for this voice has been revoked.');
  });
});
