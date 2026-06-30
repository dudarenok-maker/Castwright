/* Unit tests for queue-thunks (plan 102).
 *
 * Mocks `fetch` and asserts (a) the request shape sent to /api/queue/*,
 * (b) the dispatched setSnapshot action carries the parsed response,
 * (c) the toast fires on enqueue / cancel-of-in_progress. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { queueSlice, type QueueEntry } from './queue-slice';
import { notificationsSlice } from './notifications-slice';
import { chaptersSlice } from './chapters-slice';
import { api } from '../lib/api';
import type { Chapter } from '../lib/types';
import {
  cancelQueueEntry,
  completeQueueEntry,
  enqueueQueueEntries,
  haltActiveGeneration,
  loadQueue,
  reorderQueue,
  retryQueueEntry,
  setQueuePaused,
  startQueueEntry,
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
  getState: () => {
    queue: ReturnType<typeof queueSlice.reducer>;
    notifications: ReturnType<typeof notificationsSlice.reducer>;
  };
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
    /* queueRequest forwards `init` (undefined for the GET) to fetch. */
    expect(fetchMock).toHaveBeenCalledWith('/api/queue', undefined);
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

describe('enqueueQueueEntries — analysis gate', () => {
  /* Reuses the file's top-level fetchMock (set up in beforeEach / torn down in
     afterEach). Per-describe beforeEach captures the POST body so we can assert
     which entries were actually sent to the server. */
  const posted: unknown[] = [];

  beforeEach(() => {
    posted.length = 0;
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { entries: unknown[] };
      posted.push(...body.entries);
      return {
        ok: true,
        json: async () => ({ entries: body.entries, paused: false, recycling: false }),
      };
    });
  });

  it('enqueues only un-gated entries and toasts the gated pass', async () => {
    const dispatch = vi.fn();
    /* b1 has prosody running → gated. b2 has no active streams → allowed. */
    const getState = () =>
      ({
        prosody: { activeStreams: { b1: { progress: 0, label: 'Detecting emotions' } } },
        scriptReview: { activeStreams: {} },
        queue: { entries: [], paused: false, recycling: false, loaded: false },
      }) as never;

    await enqueueQueueEntries([
      { id: 'e1', bookId: 'b1', chapterId: 1, scope: 'this' },
      { id: 'e2', bookId: 'b2', chapterId: 1, scope: 'this' },
    ])(dispatch as never, getState as never);

    /* Only the un-gated b2 entry was POSTed to the server: */
    expect(posted).toEqual([{ id: 'e2', bookId: 'b2', chapterId: 1, scope: 'this' }]);

    /* A warn toast with the per-pass (prosody) copy fired: */
    const toasts = dispatch.mock.calls
      .map((c) => c[0] as { type?: string; payload?: { message?: string } })
      .filter((a) => a.type?.includes('pushToast'));
    expect(toasts.some((t) => t.payload?.message === 'Wait — emotions are still being detected')).toBe(true);
  });

  it('still gates a silent (background auto-resume) enqueue but suppresses the warn toast', async () => {
    const dispatch = vi.fn();
    /* b1 gated; the only entry is for b1, so nothing is enqueued. */
    const getState = () =>
      ({
        prosody: { activeStreams: { b1: { progress: 0, label: 'Detecting emotions' } } },
        scriptReview: { activeStreams: {} },
        queue: { entries: [], paused: false, recycling: false, loaded: false },
      }) as never;

    await enqueueQueueEntries([{ id: 'e1', bookId: 'b1', chapterId: 1, scope: 'this' }], {
      silent: true,
    })(dispatch as never, getState as never);

    /* Nothing was POSTed (the single entry was gated): */
    expect(posted).toEqual([]);

    /* No warn toast fired — a silent caller is background work, not a user click: */
    const toasts = dispatch.mock.calls
      .map((c) => c[0] as { type?: string; payload?: { message?: string } })
      .filter((a) => a.type?.includes('pushToast'));
    expect(toasts).toHaveLength(0);
  });
});

describe('startQueueEntry', () => {
  it('POSTs /start and dispatches the snapshot (entry now in_progress)', async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        entries: [sampleEntry({ id: 'e1', status: 'in_progress' })],
        paused: false,
      }),
    );
    const store = makeStore();
    await store.dispatch(startQueueEntry('e1'));
    expect(fetchMock).toHaveBeenCalledWith('/api/queue/e1/start', { method: 'POST' });
    expect(store.getState().queue.entries[0].status).toBe('in_progress');
  });
});

describe('completeQueueEntry', () => {
  it('POSTs /complete with outcome:done by default and dispatches the snapshot', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ entries: [], paused: false }));
    const store = makeStore();
    await store.dispatch(completeQueueEntry('e1'));
    expect(fetchMock).toHaveBeenCalledWith('/api/queue/e1/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'done' }),
    });
    expect(store.getState().queue.entries).toEqual([]);
  });

  it('sends outcome:failed + errorReason so the entry lingers as failed', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ entries: [], paused: false }));
    const store = makeStore();
    await store.dispatch(completeQueueEntry('e1', { outcome: 'failed', errorReason: 'boom' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/queue/e1/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'failed', errorReason: 'boom' }),
    });
  });
});

describe('retryQueueEntry', () => {
  it('POSTs /retry and dispatches the snapshot', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ entries: [], paused: false }));
    const store = makeStore();
    await store.dispatch(retryQueueEntry('e1'));
    expect(fetchMock).toHaveBeenCalledWith('/api/queue/e1/retry', { method: 'POST' });
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

  it('force=true appends ?force=true so the server drops a stuck in_progress entry', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ entries: [], paused: false }));
    const store = makeStore();
    await store.dispatch(cancelQueueEntry('stuck', { force: true }));
    expect(fetchMock).toHaveBeenCalledWith('/api/queue/stuck?force=true', { method: 'DELETE' });
  });
});

/* Bug 1 — deleting a chapter-scope entry for a genuinely-queued, un-rendered
   chapter records the user's intent by flipping that chapter to "Not queued"
   (held), so the row stops reading "Queued" and auto-work stops re-adding it.
   Guards: this-scope only, loaded book only, only when the chapter is `queued`
   (a `done` regenerate ticket or an `in_progress` row is left alone). */
describe('cancelQueueEntry — "Not queued" (held) wiring (Bug 1)', () => {
  function makeHeldStore(chapter: Partial<Chapter> & { id: number }, entry: QueueEntry) {
    const store = configureStore({
      reducer: {
        queue: queueSlice.reducer,
        notifications: notificationsSlice.reducer,
        chapters: chaptersSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setCurrentBookId('book-A'));
    store.dispatch(
      chaptersSlice.actions.setChapters([
        {
          title: `Chapter ${chapter.id}`,
          duration: '00:00',
          state: 'queued',
          progress: 0,
          characters: {},
          ...chapter,
        } as Chapter,
      ]),
    );
    store.dispatch(queueSlice.actions.setSnapshot({ entries: [entry], paused: false }));
    return store as unknown as { getState: typeof store.getState; dispatch: TestDispatch };
  }

  it('flips a queued chapter to held on a this-scope cancel + persists via api', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ entries: [], paused: false }));
    const persist = vi.spyOn(api, 'setChapterHeld').mockResolvedValue({
      id: 1,
      title: 'Chapter 1',
      slug: '01',
      held: true,
    });
    const store = makeHeldStore(
      { id: 1, state: 'queued' },
      sampleEntry({ id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this' }),
    );
    await store.dispatch(cancelQueueEntry('e1'));
    expect(store.getState().chapters.chapters[0].held).toBe(true);
    expect(persist).toHaveBeenCalledWith('book-A', 1, true);
    persist.mockRestore();
  });

  it('does NOT hold a done chapter (a regenerate ticket — its audio stays)', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ entries: [], paused: false }));
    const persist = vi.spyOn(api, 'setChapterHeld');
    const store = makeHeldStore(
      { id: 1, state: 'done', progress: 1 },
      sampleEntry({ id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this' }),
    );
    await store.dispatch(cancelQueueEntry('e1'));
    expect(store.getState().chapters.chapters[0].held).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
    persist.mockRestore();
  });

  it('does NOT hold on a character-scope cancel (per-character splice, not a whole chapter)', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ entries: [], paused: false }));
    const persist = vi.spyOn(api, 'setChapterHeld');
    const store = makeHeldStore(
      { id: 1, state: 'queued' },
      sampleEntry({ id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'character' }),
    );
    await store.dispatch(cancelQueueEntry('e1'));
    expect(store.getState().chapters.chapters[0].held).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
    persist.mockRestore();
  });

  it('does NOT hold a cross-book entry (chapter state not on screen)', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ entries: [], paused: false }));
    const persist = vi.spyOn(api, 'setChapterHeld');
    const store = makeHeldStore(
      { id: 1, state: 'queued' },
      sampleEntry({ id: 'e1', bookId: 'book-OTHER', chapterId: 1, scope: 'this' }),
    );
    await store.dispatch(cancelQueueEntry('e1'));
    expect(store.getState().chapters.chapters[0].held).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
    persist.mockRestore();
  });
});

describe('haltActiveGeneration (plan 102 Should #5 — local-analyzer GPU halt)', () => {
  it('dispatches the requestStreamHalt one-shot AND pauses the queue', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ entries: [], paused: true }));
    /* A recording middleware captures every dispatched action type — including
       the thunk-internal requestStreamHalt (a dispatch spy on store.dispatch
       wouldn't, since the thunk closes over the pre-spy dispatch). */
    const recorded: string[] = [];
    const recorder =
      () =>
      (next: (a: unknown) => unknown) =>
      (action: unknown): unknown => {
        if (action && typeof action === 'object' && 'type' in action) {
          recorded.push((action as { type: string }).type);
        }
        return next(action);
      };
    const store = configureStore({
      reducer: {
        queue: queueSlice.reducer,
        notifications: notificationsSlice.reducer,
        chapters: chaptersSlice.reducer,
      },
      middleware: (gd) => gd().concat(recorder),
    });

    await (store.dispatch as unknown as TestDispatch)(haltActiveGeneration());

    /* (a) requestStreamHalt — the generation-stream middleware observes this to
       close the open SSE handle immediately (free the GPU within the chapter). */
    expect(recorded).toContain('chapters/requestStreamHalt');
    /* (b) the queue is paused so the dispatcher won't re-drain while the
       analyzer owns the GPU. */
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/queue/pause',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ paused: true }) }),
    );
    expect(store.getState().queue.paused).toBe(true);
  });
});
