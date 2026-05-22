/* Unit tests for queue-thunks (plan 102).
 *
 * Mocks `fetch` and asserts (a) the request shape sent to /api/queue/*,
 * (b) the dispatched setSnapshot action carries the parsed response,
 * (c) the toast fires on enqueue / cancel-of-in_progress. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { queueSlice, type QueueEntry } from './queue-slice';
import { notificationsSlice } from './notifications-slice';
import {
  cancelQueueEntry,
  enqueueQueueEntries,
  loadQueue,
  reorderQueue,
  setQueuePaused,
} from './queue-thunks';

const sampleEntry = (overrides: Partial<QueueEntry> = {}): QueueEntry => ({
  id: 'e1',
  bookId: 'book-A',
  chapterId: 1,
  scope: 'this',
  addedAt: '2026-05-23T00:00:00.000Z',
  status: 'queued',
  order: 0,
  ...overrides,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* Test store typed with AppDispatch so dispatch(thunk) typechecks the same
   way it does in the real store. */
type TestDispatch = (action: unknown) => Promise<unknown>;
function makeStore(): {
  getState: () => { queue: ReturnType<typeof queueSlice.reducer>; notifications: ReturnType<typeof notificationsSlice.reducer> };
  dispatch: TestDispatch;
} {
  const store = configureStore({
    reducer: { queue: queueSlice.reducer, notifications: notificationsSlice.reducer },
  });
  return store as unknown as {
    getState: typeof store.getState;
    dispatch: TestDispatch;
  };
}

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('loadQueue', () => {
  it('GETs /api/queue and dispatches setSnapshot', async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse({ entries: [sampleEntry({ id: 'q1' })], paused: false }),
    );
    const store = makeStore();
    await store.dispatch(loadQueue());
    expect(fetchMock).toHaveBeenCalledWith('/api/queue');
    expect(store.getState().queue.entries).toHaveLength(1);
    expect(store.getState().queue.entries[0].id).toBe('q1');
    expect(store.getState().queue.loaded).toBe(true);
  });

  it('throws on non-2xx', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ error: 'workspace missing' }, 500));
    const store = makeStore();
    await expect(store.dispatch(loadQueue())).rejects.toThrowError(/workspace missing/);
  });
});

describe('enqueueQueueEntries', () => {
  it('POSTs the entries to /api/queue/enqueue + dispatches the snapshot + fires toast', async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        entries: [sampleEntry({ id: 'a1' }), sampleEntry({ id: 'a2', chapterId: 2, order: 1 })],
        paused: false,
      }),
    );
    const store = makeStore();
    await store.dispatch(
      enqueueQueueEntries([
        { id: 'a1', bookId: 'book-A', chapterId: 1, scope: 'this' },
        { id: 'a2', bookId: 'book-A', chapterId: 2, scope: 'this' },
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/queue/enqueue',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.stringContaining('"id":"a1"'),
      }),
    );
    expect(store.getState().queue.entries).toHaveLength(2);
    /* Toast pushed via notificationsActions.pushToast — assert via slice. */
    const toasts = store.getState().notifications.toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain('Added to queue');
    expect(toasts[0].message).toContain('2 entries pending');
  });

  it('singularises the toast message when count === 1', async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse({ entries: [sampleEntry({ id: 'a1' })], paused: false }),
    );
    const store = makeStore();
    await store.dispatch(
      enqueueQueueEntries([{ id: 'a1', bookId: 'book-A', chapterId: 1, scope: 'this' }]),
    );
    expect(store.getState().notifications.toasts[0].message).toContain('1 entry pending');
  });
});

describe('reorderQueue', () => {
  it('POSTs the desired order + dispatches the snapshot', async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        entries: [sampleEntry({ id: 'a2', order: 0 }), sampleEntry({ id: 'a1', order: 1 })],
        paused: false,
      }),
    );
    const store = makeStore();
    await store.dispatch(reorderQueue(['a2', 'a1']));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/queue/reorder',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ order: ['a2', 'a1'] }),
      }),
    );
    expect(store.getState().queue.entries.map((e) => e.id)).toEqual(['a2', 'a1']);
  });
});

describe('setQueuePaused', () => {
  it('flips the global pause flag via /api/queue/pause', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ entries: [], paused: true }));
    const store = makeStore();
    await store.dispatch(setQueuePaused(true));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/queue/pause',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ paused: true }) }),
    );
    expect(store.getState().queue.paused).toBe(true);
  });
});

describe('cancelQueueEntry', () => {
  it('DELETEs and dispatches the snapshot on success', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ entries: [], paused: false }));
    const store = makeStore();
    await store.dispatch(cancelQueueEntry('e1'));
    expect(fetchMock).toHaveBeenCalledWith('/api/queue/e1', { method: 'DELETE' });
  });

  it('on 409 pops a warn toast + re-throws so the caller can recover', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ error: 'entry is in_progress' }, 409));
    const store = makeStore();
    await expect(store.dispatch(cancelQueueEntry('inflight'))).rejects.toThrowError(/in_progress/);
    const toasts = store.getState().notifications.toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe('warn');
    expect(toasts[0].message).toContain('Pause the queue');
  });
});
