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
    cloneVoiceSample: vi.fn().mockResolvedValue({
      candidateId: 'cand-1', transcript: 'hi there', durationSeconds: 9, sampleRate: 24_000, qualityWarnings: [],
    }),
  },
}));

import { voiceLibrarySlice, cloneVoice, revokeVoice, cloneSample } from './voice-library-slice';

function makeStore() {
  return configureStore({ reducer: { voiceLibrary: voiceLibrarySlice.reducer } });
}

beforeEach(() => vi.clearAllMocks());

describe('cloneVoice thunk', () => {
  it('#2648 — cloneVoice refetches and stores the staleness-computed entry, not the raw /clone response', async () => {
    const { api } = await import('../lib/api');
    /* The raw POST /clone response: the one entry-returning route that skips
       the server's `withComputedStaleness` (routes/voice-library.ts) — its
       slots still say 'ready' although baseModel/coquiVersion are stale. */
    const rawCloneResponse = {
      voiceUuid: 'lib-clone-x', name: 'Mum', provenance: 'cloned', tags: [], pinned: false,
      engines: {
        qwen: { status: 'ready', baseModel: 'qwen2-audio-0.5b-2026-01' },
        xtts: { status: 'ready', coquiVersion: '0.26.1' },
      },
      createdAt: 'a', updatedAt: 'b',
    };
    /* What the refetch (GET /api/voice-library) returns for the same entry:
       `withComputedStaleness` has rewritten both slots to 'stale'. */
    const computedEntry = {
      ...rawCloneResponse,
      engines: {
        qwen: { status: 'stale', baseModel: 'qwen2-audio-0.5b-2026-01' },
        xtts: { status: 'stale', coquiVersion: '0.26.1' },
      },
    };
    vi.mocked(api.cloneVoice).mockResolvedValueOnce(rawCloneResponse as never);
    vi.mocked(api.listVoiceLibrary).mockResolvedValueOnce({ voices: [computedEntry] } as never);

    const store = makeStore();
    const p = store.dispatch(
      cloneVoice({ candidateId: 'c1', consent: { personName: 'Mum', relationship: 'self', permittedUse: 'personal' } }) as never,
    );
    expect(store.getState().voiceLibrary.clonePending).toBe(true);
    await p;
    const s = store.getState().voiceLibrary;
    expect(s.clonePending).toBe(false);
    /* The thunk refetched like its sibling thunks — the staleness-computed
       source of truth, not the raw POST /clone payload. */
    expect(api.listVoiceLibrary).toHaveBeenCalled();
    /* The slice ends up holding the computed entry, not the raw one. */
    const entry = s.entries.find((e) => e.voiceUuid === 'lib-clone-x');
    expect(entry).toEqual(computedEntry);
    expect(entry?.engines.qwen?.status).toBe('stale');
    expect(entry?.engines.xtts?.status).toBe('stale');
  });
});

it('revokeVoice calls the api and refetches', async () => {
  const store = makeStore();
  await store.dispatch(revokeVoice('r1') as never);
  const { api } = await import('../lib/api');
  expect(api.revokeVoiceLibraryEntry).toHaveBeenCalledWith('r1');
  expect(api.listVoiceLibrary).toHaveBeenCalled();
});

it('#1808 — cloneSample calls api.cloneVoiceSample with the form and resolves its response (thin passthrough)', async () => {
  const store = makeStore();
  const form = new FormData();
  const action = await store.dispatch(cloneSample(form) as never);
  const { api } = await import('../lib/api');
  expect(api.cloneVoiceSample).toHaveBeenCalledWith(form);
  expect((action as { payload: unknown }).payload).toEqual({
    candidateId: 'cand-1', transcript: 'hi there', durationSeconds: 9, sampleRate: 24_000, qualityWarnings: [],
  });
});
