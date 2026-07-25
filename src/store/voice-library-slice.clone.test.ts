import { it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { voiceLibrarySlice, revokeVoice } from './voice-library-slice';

const { revokeVoiceLibraryEntry, listVoiceLibrary } = vi.hoisted(() => ({
  revokeVoiceLibraryEntry: vi.fn().mockResolvedValue({ voiceUuid: 'r1', name: 'X', provenance: 'cloned', consent: { revokedAt: 'now' } }),
  // fetchVoiceLibrary.fulfilled reads action.payload.voices — the real api returns { voices: [...] }, NOT a bare array
  listVoiceLibrary: vi.fn().mockResolvedValue({ voices: [] }),
}));
vi.mock('../lib/api', () => ({ api: { revokeVoiceLibraryEntry, listVoiceLibrary } }));

it('revokeVoice calls the api and refetches', async () => {
  const store = configureStore({ reducer: { voiceLibrary: voiceLibrarySlice.reducer } });
  await store.dispatch(revokeVoice('r1') as never);
  expect(revokeVoiceLibraryEntry).toHaveBeenCalledWith('r1');
  expect(listVoiceLibrary).toHaveBeenCalled();
});
