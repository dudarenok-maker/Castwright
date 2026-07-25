/* voice-library-slice — covers the Immer-style optimistic reducer for
   `patchEntry`, the `designVoice` pending/settle toggle, the pinned-first
   `selectMyVoices` sort, and the focus/visibilitychange refetch listener's
   stale/fresh/empty gating (task-13 brief). Mocks `src/lib/api` at the
   module level so no real network/mock-fixture wiring is exercised here —
   Task 12's own tests already cover the api pair. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import type { VoiceLibraryEntry } from '../lib/api';
import {
  voiceLibrarySlice,
  fetchVoiceLibrary,
  designVoice,
  redesignVoice,
  promoteRedesign,
  discardRedesign,
  patchEntry,
  deleteEntry,
  assignVoice,
  promoteCharacterVoice,
  selectMyVoices,
  selectVoiceByUuid,
  installVoiceLibraryFocusListener,
} from './voice-library-slice';

vi.mock('../lib/api', () => ({
  api: {
    listVoiceLibrary: vi.fn(),
    patchVoiceLibrary: vi.fn(),
    deleteVoiceLibrary: vi.fn(),
    designLibraryVoice: vi.fn(),
    redesignLibraryVoice: vi.fn(),
    promoteLibraryRedesign: vi.fn(),
    discardLibraryRedesign: vi.fn(),
    promoteToLibrary: vi.fn(),
    assignLibraryVoice: vi.fn(),
    sampleLibraryVoice: vi.fn(),
  },
}));

import { api } from '../lib/api';

function makeEntry(overrides: Partial<VoiceLibraryEntry> = {}): VoiceLibraryEntry {
  return {
    voiceUuid: 'v1',
    name: 'Captain Halloran',
    provenance: 'designed',
    tags: [],
    pinned: false,
    engines: {},
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-06-01T09:00:00.000Z',
    ...overrides,
  };
}

function makeStore(preloaded?: Partial<ReturnType<typeof voiceLibrarySlice.reducer>>) {
  return configureStore({
    reducer: { voiceLibrary: voiceLibrarySlice.reducer },
    preloadedState: preloaded ? { voiceLibrary: preloaded as never } : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('voiceLibrarySlice reducers', () => {
  it('fetchVoiceLibrary.fulfilled hydrates entries and marks ready', () => {
    const entries = [makeEntry()];
    const state = voiceLibrarySlice.reducer(
      undefined,
      fetchVoiceLibrary.fulfilled({ voices: entries }, 'reqId', undefined),
    );
    expect(state.entries).toEqual(entries);
    expect(state.status).toBe('ready');
    expect(state.lastFetchedAt).not.toBeNull();
  });

  it('fetchVoiceLibrary.pending sets status to loading', () => {
    const state = voiceLibrarySlice.reducer(undefined, fetchVoiceLibrary.pending('reqId', undefined));
    expect(state.status).toBe('loading');
  });

  it('fetchVoiceLibrary.rejected sets status to error', () => {
    const state = voiceLibrarySlice.reducer(
      undefined,
      fetchVoiceLibrary.rejected(new Error('boom'), 'reqId', undefined),
    );
    expect(state.status).toBe('error');
  });

  it('patchEntry.pending optimistically mutates the matching entry (Immer draft)', () => {
    const initial = {
      entries: [makeEntry({ voiceUuid: 'v1', pinned: false, tags: ['a'] })],
      status: 'ready' as const,
      designPending: false,
      clonePending: false,
      lastFetchedAt: 1000,
    };
    const state = voiceLibrarySlice.reducer(
      initial,
      patchEntry.pending('reqId', { voiceUuid: 'v1', patch: { pinned: true, tags: ['a', 'b'] } }),
    );
    expect(state.entries[0].pinned).toBe(true);
    expect(state.entries[0].tags).toEqual(['a', 'b']);
    /* Untouched entries elsewhere aren't affected — the mutation is scoped
       to the matched voiceUuid only. */
    expect(state.entries).toHaveLength(1);
  });

  it('patchEntry.pending on an unknown voiceUuid is a no-op (no throw)', () => {
    const initial = {
      entries: [makeEntry({ voiceUuid: 'v1' })],
      status: 'ready' as const,
      designPending: false,
      clonePending: false,
      lastFetchedAt: 1000,
    };
    const state = voiceLibrarySlice.reducer(
      initial,
      patchEntry.pending('reqId', { voiceUuid: 'nope', patch: { pinned: true } }),
    );
    expect(state.entries[0].pinned).toBe(false);
  });

  it('patchEntry.fulfilled reconciles the entry with the server response', () => {
    const initial = {
      entries: [makeEntry({ voiceUuid: 'v1', name: 'Old Name' })],
      status: 'ready' as const,
      designPending: false,
      clonePending: false,
      lastFetchedAt: 1000,
    };
    const serverEntry = makeEntry({ voiceUuid: 'v1', name: 'New Name', updatedAt: '2026-07-01T00:00:00.000Z' });
    const state = voiceLibrarySlice.reducer(
      initial,
      patchEntry.fulfilled(serverEntry, 'reqId', { voiceUuid: 'v1', patch: { name: 'New Name' } }),
    );
    expect(state.entries[0]).toEqual(serverEntry);
  });

  it('designVoice toggles designPending true on pending, false on fulfilled', () => {
    const pendingState = voiceLibrarySlice.reducer(
      undefined,
      designVoice.pending('reqId', { name: 'X', persona: 'Y' }),
    );
    expect(pendingState.designPending).toBe(true);

    const fulfilledState = voiceLibrarySlice.reducer(
      pendingState,
      designVoice.fulfilled(
        { entry: makeEntry(), previewUrl: '/preview.mp3' },
        'reqId',
        { name: 'X', persona: 'Y' },
      ),
    );
    expect(fulfilledState.designPending).toBe(false);
  });

  it('designVoice toggles designPending back to false on rejected', () => {
    const pendingState = voiceLibrarySlice.reducer(
      undefined,
      designVoice.pending('reqId', { name: 'X', persona: 'Y' }),
    );
    const rejectedState = voiceLibrarySlice.reducer(
      pendingState,
      designVoice.rejected(new Error('boom'), 'reqId', { name: 'X', persona: 'Y' }),
    );
    expect(rejectedState.designPending).toBe(false);
  });
});

describe('voiceLibrarySlice thunks against api mocks', () => {
  it('fetchVoiceLibrary dispatches api.listVoiceLibrary and hydrates the store', async () => {
    vi.mocked(api.listVoiceLibrary).mockResolvedValue({ voices: [makeEntry()] });
    const store = makeStore();
    await store.dispatch(fetchVoiceLibrary());
    expect(api.listVoiceLibrary).toHaveBeenCalledTimes(1);
    expect(store.getState().voiceLibrary.entries).toHaveLength(1);
    expect(store.getState().voiceLibrary.status).toBe('ready');
  });

  it('designVoice calls api.designLibraryVoice then refetches the full list', async () => {
    vi.mocked(api.designLibraryVoice).mockResolvedValue({
      entry: makeEntry({ voiceUuid: 'new' }),
      previewUrl: '/preview.mp3',
    });
    vi.mocked(api.listVoiceLibrary).mockResolvedValue({ voices: [makeEntry({ voiceUuid: 'new' })] });
    const store = makeStore();
    await store.dispatch(designVoice({ name: 'New', persona: 'A voice' }));
    expect(api.designLibraryVoice).toHaveBeenCalledWith({ name: 'New', persona: 'A voice' });
    expect(api.listVoiceLibrary).toHaveBeenCalledTimes(1);
    expect(store.getState().voiceLibrary.entries.map((e) => e.voiceUuid)).toEqual(['new']);
    expect(store.getState().voiceLibrary.designPending).toBe(false);
  });

  it('patchEntry calls api.patchVoiceLibrary with the voiceUuid + patch', async () => {
    const updated = makeEntry({ voiceUuid: 'v1', pinned: true });
    vi.mocked(api.patchVoiceLibrary).mockResolvedValue(updated);
    const store = makeStore({
      entries: [makeEntry({ voiceUuid: 'v1', pinned: false })],
      status: 'ready',
      designPending: false,
      clonePending: false,
      lastFetchedAt: 1000,
    });
    await store.dispatch(patchEntry({ voiceUuid: 'v1', patch: { pinned: true } }));
    expect(api.patchVoiceLibrary).toHaveBeenCalledWith('v1', { pinned: true });
    expect(store.getState().voiceLibrary.entries[0]).toEqual(updated);
  });

  it('patchEntry refetches the list to revert the optimistic edit on failure', async () => {
    vi.mocked(api.patchVoiceLibrary).mockRejectedValue(new Error('server rejected'));
    vi.mocked(api.listVoiceLibrary).mockResolvedValue({
      voices: [makeEntry({ voiceUuid: 'v1', pinned: false })],
    });
    const store = makeStore({
      entries: [makeEntry({ voiceUuid: 'v1', pinned: false })],
      status: 'ready',
      designPending: false,
      clonePending: false,
      lastFetchedAt: 1000,
    });
    await store.dispatch(patchEntry({ voiceUuid: 'v1', patch: { pinned: true } }));
    /* Optimistic pending mutation flipped pinned true; the failure path
       should have refetched the server truth (pinned: false) to revert it. */
    expect(api.listVoiceLibrary).toHaveBeenCalledTimes(1);
    expect(store.getState().voiceLibrary.entries[0].pinned).toBe(false);
  });

  it('deleteEntry refetches after a successful delete but not after a 409 usage block', async () => {
    vi.mocked(api.deleteVoiceLibrary).mockResolvedValueOnce({ deleted: true });
    vi.mocked(api.listVoiceLibrary).mockResolvedValue({ voices: [] });
    const store = makeStore({
      entries: [makeEntry({ voiceUuid: 'v1' })],
      status: 'ready',
      designPending: false,
      clonePending: false,
      lastFetchedAt: 1000,
    });
    await store.dispatch(deleteEntry({ voiceUuid: 'v1' }));
    expect(api.listVoiceLibrary).toHaveBeenCalledTimes(1);

    vi.mocked(api.deleteVoiceLibrary).mockResolvedValueOnce({
      usage: [{ bookId: 'b', bookTitle: 'B', characterId: 'c', characterName: 'C' }],
    });
    vi.mocked(api.listVoiceLibrary).mockClear();
    await store.dispatch(deleteEntry({ voiceUuid: 'v1' }));
    expect(api.listVoiceLibrary).not.toHaveBeenCalled();
  });

  it('redesignVoice calls api.redesignLibraryVoice and does NOT refetch the library', async () => {
    vi.mocked(api.redesignLibraryVoice).mockResolvedValue({ previewUrl: '/redesign-preview.mp3' });
    const store = makeStore({
      entries: [makeEntry({ voiceUuid: 'v1' })],
      status: 'ready',
      designPending: false,
      clonePending: false,
      lastFetchedAt: 1000,
    });
    const action = await store.dispatch(redesignVoice({ voiceUuid: 'v1', persona: 'Gruffer, older' }));
    expect(api.redesignLibraryVoice).toHaveBeenCalledWith('v1', { persona: 'Gruffer, older' });
    expect(action.payload).toEqual({ previewUrl: '/redesign-preview.mp3' });
    /* A redesign only produces a preview — nothing persists server-side
       until promote/discard — so it deliberately does NOT trigger a
       library refetch. */
    expect(api.listVoiceLibrary).not.toHaveBeenCalled();
  });

  it('promoteRedesign calls api.promoteLibraryRedesign and refetches the list', async () => {
    const promoted = makeEntry({ voiceUuid: 'v1', persona: 'Gruffer, older' });
    vi.mocked(api.promoteLibraryRedesign).mockResolvedValue(promoted);
    vi.mocked(api.listVoiceLibrary).mockResolvedValue({ voices: [promoted] });
    const store = makeStore({
      entries: [makeEntry({ voiceUuid: 'v1' })],
      status: 'ready',
      designPending: false,
      clonePending: false,
      lastFetchedAt: 1000,
    });
    await store.dispatch(promoteRedesign({ voiceUuid: 'v1', persona: 'Gruffer, older' }));
    expect(api.promoteLibraryRedesign).toHaveBeenCalledWith('v1', { persona: 'Gruffer, older' });
    expect(api.listVoiceLibrary).toHaveBeenCalledTimes(1);
  });

  it('discardRedesign calls api.discardLibraryRedesign and refetches the list', async () => {
    const reverted = makeEntry({ voiceUuid: 'v1' });
    vi.mocked(api.discardLibraryRedesign).mockResolvedValue(reverted);
    vi.mocked(api.listVoiceLibrary).mockResolvedValue({ voices: [reverted] });
    const store = makeStore({
      entries: [makeEntry({ voiceUuid: 'v1' })],
      status: 'ready',
      designPending: false,
      clonePending: false,
      lastFetchedAt: 1000,
    });
    await store.dispatch(discardRedesign('v1'));
    expect(api.discardLibraryRedesign).toHaveBeenCalledWith('v1');
    expect(api.listVoiceLibrary).toHaveBeenCalledTimes(1);
  });

  it('assignVoice calls api.assignLibraryVoice with the right args and refetches the list', async () => {
    vi.mocked(api.assignLibraryVoice).mockResolvedValue({ updated: 1 });
    vi.mocked(api.listVoiceLibrary).mockResolvedValue({ voices: [makeEntry({ voiceUuid: 'v1' })] });
    const store = makeStore({
      entries: [makeEntry({ voiceUuid: 'v1' })],
      status: 'ready',
      designPending: false,
      clonePending: false,
      lastFetchedAt: 1000,
    });
    await store.dispatch(assignVoice({ voiceUuid: 'v1', bookId: 'book-1', characterId: 'char-1' }));
    expect(api.assignLibraryVoice).toHaveBeenCalledWith('v1', { bookId: 'book-1', characterId: 'char-1' });
    expect(api.listVoiceLibrary).toHaveBeenCalledTimes(1);
  });

  it('promoteCharacterVoice calls api.promoteToLibrary and refetches the list', async () => {
    const promoted = makeEntry({ voiceUuid: 'lib-new', name: 'New Voice' });
    vi.mocked(api.promoteToLibrary).mockResolvedValue(promoted);
    vi.mocked(api.listVoiceLibrary).mockResolvedValue({ voices: [promoted] });
    const store = makeStore();
    await store.dispatch(
      promoteCharacterVoice({ bookId: 'book-1', characterId: 'char-1', name: 'New Voice' }),
    );
    expect(api.promoteToLibrary).toHaveBeenCalledWith({
      bookId: 'book-1',
      characterId: 'char-1',
      name: 'New Voice',
    });
    expect(api.listVoiceLibrary).toHaveBeenCalledTimes(1);
  });
});

describe('selectMyVoices', () => {
  it('sorts pinned entries first, then by updatedAt descending', () => {
    const state = {
      voiceLibrary: {
        entries: [
          makeEntry({ voiceUuid: 'old-unpinned', pinned: false, updatedAt: '2026-01-01T00:00:00.000Z' }),
          makeEntry({ voiceUuid: 'newer-pinned', pinned: true, updatedAt: '2026-02-01T00:00:00.000Z' }),
          makeEntry({ voiceUuid: 'newest-unpinned', pinned: false, updatedAt: '2026-06-01T00:00:00.000Z' }),
          makeEntry({ voiceUuid: 'oldest-pinned', pinned: true, updatedAt: '2026-01-15T00:00:00.000Z' }),
        ],
        status: 'ready' as const,
        designPending: false,
        clonePending: false,
        lastFetchedAt: 1000,
      },
    };
    const sorted = selectMyVoices(state).map((e) => e.voiceUuid);
    expect(sorted).toEqual(['newer-pinned', 'oldest-pinned', 'newest-unpinned', 'old-unpinned']);
  });
});

describe('selectVoiceByUuid', () => {
  it('returns the matching entry or undefined', () => {
    const state = {
      voiceLibrary: {
        entries: [makeEntry({ voiceUuid: 'v1' })],
        status: 'ready' as const,
        designPending: false,
        clonePending: false,
        lastFetchedAt: 1000,
      },
    };
    expect(selectVoiceByUuid(state, 'v1')?.voiceUuid).toBe('v1');
    expect(selectVoiceByUuid(state, 'nope')).toBeUndefined();
  });
});

describe('installVoiceLibraryFocusListener', () => {
  function fireVisible() {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  it('refetches when the tab becomes visible, entries are non-empty, and the last fetch is stale (>5s)', () => {
    vi.mocked(api.listVoiceLibrary).mockResolvedValue({ voices: [makeEntry()] });
    const store = makeStore({
      entries: [makeEntry()],
      status: 'ready',
      designPending: false,
      lastFetchedAt: Date.now() - 6000,
    });
    const teardown = installVoiceLibraryFocusListener(store);
    fireVisible();
    expect(api.listVoiceLibrary).toHaveBeenCalledTimes(1);
    teardown();
  });

  it('does NOT refetch when the last fetch is fresh (<5s)', () => {
    const store = makeStore({
      entries: [makeEntry()],
      status: 'ready',
      designPending: false,
      lastFetchedAt: Date.now() - 1000,
    });
    const teardown = installVoiceLibraryFocusListener(store);
    fireVisible();
    expect(api.listVoiceLibrary).not.toHaveBeenCalled();
    teardown();
  });

  it('does NOT refetch when entries are empty, even if stale', () => {
    const store = makeStore({
      entries: [],
      status: 'idle',
      designPending: false,
      lastFetchedAt: Date.now() - 60000,
    });
    const teardown = installVoiceLibraryFocusListener(store);
    fireVisible();
    expect(api.listVoiceLibrary).not.toHaveBeenCalled();
    teardown();
  });

  it('does NOT refetch when never fetched (lastFetchedAt null), even with entries preloaded', () => {
    const store = makeStore({
      entries: [makeEntry()],
      status: 'idle',
      designPending: false,
      lastFetchedAt: null,
    });
    const teardown = installVoiceLibraryFocusListener(store);
    fireVisible();
    expect(api.listVoiceLibrary).not.toHaveBeenCalled();
    teardown();
  });

  it('does NOT refetch on a visibilitychange to hidden', () => {
    const store = makeStore({
      entries: [makeEntry()],
      status: 'ready',
      designPending: false,
      lastFetchedAt: Date.now() - 60000,
    });
    const teardown = installVoiceLibraryFocusListener(store);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(api.listVoiceLibrary).not.toHaveBeenCalled();
    teardown();
  });

  it('teardown removes the listeners so a later focus event is a no-op', () => {
    const store = makeStore({
      entries: [makeEntry()],
      status: 'ready',
      designPending: false,
      lastFetchedAt: Date.now() - 60000,
    });
    const teardown = installVoiceLibraryFocusListener(store);
    teardown();
    fireVisible();
    expect(api.listVoiceLibrary).not.toHaveBeenCalled();
  });
});
