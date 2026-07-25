import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

vi.mock('../lib/api', () => ({
  api: {
    cloneVoice: vi.fn().mockResolvedValue({
      voiceUuid: 'lib-clone-x', name: 'Mum', provenance: 'cloned', tags: [], pinned: false,
      engines: { qwen: { status: 'ready', baseModel: 'q' } },
      createdAt: 'a', updatedAt: 'b',
    }),
    listVoiceLibrary: vi.fn().mockResolvedValue({ voices: [] }),
    revokeVoiceLibraryEntry: vi.fn().mockResolvedValue({ voiceUuid: 'r1', name: 'X', provenance: 'cloned', consent: { revokedAt: 'now' } }),
  },
}));

import { voiceLibrarySlice, cloneVoice, revokeVoice } from './voice-library-slice';

function makeStore() {
  return configureStore({ reducer: { voiceLibrary: voiceLibrarySlice.reducer } });
}

beforeEach(() => vi.clearAllMocks());

describe('cloneVoice thunk', () => {
  it('flips clonePending and appends the returned cloned entry', async () => {
    const store = makeStore();
    const p = store.dispatch(
      cloneVoice({ candidateId: 'c1', consent: { personName: 'Mum', relationship: 'self', permittedUse: 'personal' } }) as never,
    );
    expect(store.getState().voiceLibrary.clonePending).toBe(true);
    await p;
    const s = store.getState().voiceLibrary;
    expect(s.clonePending).toBe(false);
    expect(s.entries.map((e) => e.voiceUuid)).toContain('lib-clone-x');
  });
});

it('revokeVoice calls the api and refetches', async () => {
  const store = makeStore();
  await store.dispatch(revokeVoice('r1') as never);
  const { api } = await import('../lib/api');
  expect(api.revokeVoiceLibraryEntry).toHaveBeenCalledWith('r1');
  expect(api.listVoiceLibrary).toHaveBeenCalled();
});
