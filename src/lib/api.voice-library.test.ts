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
  _resetMockVoiceLibrary,
} from './api';
import { MOCK_VOICE_LIBRARY_ENTRIES } from '../mocks/voice-library';

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
});
