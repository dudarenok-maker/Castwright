/* Unit tests for queue-dispatcher-middleware (plan 111 worker pool).
 *
 * The dispatcher is the sole stream-opener: it fills up to N workers from the
 * flat queue across books, coalescing same-book claims into ONE stream, and
 * DELETEs an entry once its book's stream closes. These tests pin: the open
 * args + row flip, the completion DELETE, N-slot fill across books, same-book
 * coalescing (no second forced request), no double-claim, and the no-loop
 * invariant. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { queueSlice, type QueueEntry } from './queue-slice';
import { chaptersSlice } from './chapters-slice';
import { uiSlice } from './ui-slice';
import { accountSlice } from './account-slice';
import { notificationsSlice } from './notifications-slice';
import { queueDispatcherMiddleware } from './queue-dispatcher-middleware';
import { createStreamRunner, type StreamRunner } from './generation-stream-runner';
import type { GenerationTick } from '../lib/types';

const streamGenerationMock = vi.fn();
const cancelStreamMock = vi.fn();
vi.mock('../lib/api', () => ({
  api: {
    streamGeneration: (args: unknown) => {
      streamGenerationMock(args);
      return cancelStreamMock;
    },
    pauseGeneration: () => Promise.resolve(),
  },
}));

const entry = (overrides: Partial<QueueEntry> = {}): QueueEntry => ({
  id: 'e1',
  bookId: 'book-A',
  chapterId: 3,
  scope: 'this',
  addedAt: '2026-05-23T00:00:00.000Z',
  status: 'queued',
  order: 0,
  ...overrides,
});

let fetchMock: ReturnType<typeof vi.fn>;
/* Stateful server-queue mirror so a DELETE removes one entry (not the whole
   queue) and the returned snapshot stays consistent across drains. */
let queueEntries: QueueEntry[] = [];

beforeEach(() => {
  queueEntries = [];
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url);
    if (u.includes('/api/queue/enqueue')) {
      const incoming = init?.body ? (JSON.parse(init.body).entries as QueueEntry[]) : [];
      queueEntries = [...queueEntries, ...incoming];
    } else if (init?.method === 'DELETE') {
      const id = u.split('/').pop();
      queueEntries = queueEntries.filter((e) => e.id !== id);
    }
    return jsonResp({ entries: queueEntries, paused: false });
  });
  vi.stubGlobal('fetch', fetchMock);
  streamGenerationMock.mockClear();
  cancelStreamMock.mockClear();
});

/* Seed the queue in BOTH the store and the mock mirror so DELETE responses
   stay consistent. */
function seed(store: ReturnType<typeof makeStore>, entries: QueueEntry[]): void {
  queueEntries = [...entries];
  store.dispatch(queueSlice.actions.setSnapshot({ entries: queueEntries, paused: false }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
  } as Response;
}

function makeStore(generationWorkers = 2) {
  let runner: StreamRunner | null = null;
  const getRunner = (): StreamRunner => runner!;
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      queue: queueSlice.reducer,
      chapters: chaptersSlice.reducer,
      account: accountSlice.reducer,
      notifications: notificationsSlice.reducer,
    },
    preloadedState: {
      account: { ...accountSlice.getInitialState(), generationWorkers },
    },
    middleware: (getDefault) =>
      getDefault({ serializableCheck: false }).concat(queueDispatcherMiddleware(getRunner)),
  });
  runner = createStreamRunner(store);
  return store;
}

async function flushMicro(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/* Find the open call for a book and drive its stream to completion by feeding
   an idle tick through the runner's per-stream onTick (the runner then closes
   the handle + clears the book's snapshot, which wakes the dispatcher). */
function completeStream(bookId: string): void {
  const call = streamGenerationMock.mock.calls.find(
    (c) => (c[0] as { bookId?: string }).bookId === bookId,
  );
  if (!call) throw new Error(`no open stream for ${bookId}`);
  (call[0] as { onTick: (ev: GenerationTick) => void }).onTick({ type: 'idle' } as GenerationTick);
}

const openedBookIds = () =>
  streamGenerationMock.mock.calls.map((c) => (c[0] as { bookId: string }).bookId);

describe('queue-dispatcher-middleware (worker pool)', () => {
  it('opens a stream for a same-book entry and flips its rows', async () => {
    const store = makeStore();
    store.dispatch(chaptersSlice.actions.setCurrentBookId('book-A'));
    store.dispatch(
      chaptersSlice.actions.setChapters([
        { id: 3, title: 'Chapter 3', state: 'done', progress: 1, duration: '0:30', characters: {} },
      ] as never),
    );
    store.dispatch(queueSlice.actions.setSnapshot({ entries: [entry()], paused: false }));
    await flushMicro();

    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    const args = streamGenerationMock.mock.calls[0][0] as { bookId: string; chapterIds: number[] };
    expect(args.bookId).toBe('book-A');
    expect(args.chapterIds).toEqual([3]);
    /* Viewed-book row flipped to in_progress via regenerateChapterIds. */
    expect(store.getState().chapters.chapters[0].state).toBe('in_progress');
  });

  it('coalesces same-book entries into ONE stream (same-book no-abort)', async () => {
    const store = makeStore(2);
    store.dispatch(
      queueSlice.actions.setSnapshot({
        entries: [
          entry({ id: 'a3', bookId: 'book-A', chapterId: 3 }),
          entry({ id: 'a4', bookId: 'book-A', chapterId: 4 }),
        ],
        paused: false,
      }),
    );
    await flushMicro();
    /* Both same-book chapters ride ONE forced request — never a second that
       would abort the first server-side. */
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    const args = streamGenerationMock.mock.calls[0][0] as { bookId: string; chapterIds: number[] };
    expect(args.bookId).toBe('book-A');
    expect(args.chapterIds.sort()).toEqual([3, 4]);
  });

  it('fills up to N workers across books and holds the rest', async () => {
    const store = makeStore(2);
    seed(store, [
      entry({ id: 'a', bookId: 'book-A', chapterId: 1 }),
      entry({ id: 'b', bookId: 'book-B', chapterId: 1 }),
      entry({ id: 'c', bookId: 'book-C', chapterId: 1 }),
    ]);
    await flushMicro();
    /* N=2 → two books streaming, the third waits. */
    expect(openedBookIds().sort()).toEqual(['book-A', 'book-B']);

    /* Book-A finishes → its slot frees → book-C opens. */
    completeStream('book-A');
    await flushMicro();
    expect(openedBookIds()).toContain('book-C');
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/queue/a'))).toBe(true);
  });

  it('DELETEs an entry only after its book’s stream closes (no-loop)', async () => {
    const store = makeStore(2);
    store.dispatch(chaptersSlice.actions.setCurrentBookId('book-A'));
    store.dispatch(
      chaptersSlice.actions.setChapters([
        { id: 3, title: 'Chapter 3', state: 'queued', progress: 0, duration: '0:30', characters: {} },
      ] as never),
    );
    seed(store, [entry()]);
    await flushMicro();
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    /* No DELETE while the stream is live. */
    expect(fetchMock.mock.calls.some((c) => (c[1] as { method?: string })?.method === 'DELETE')).toBe(
      false,
    );

    /* Mark the chapter done + close the stream (idle). */
    store.dispatch(chaptersSlice.actions.applyGenerationTick({ type: 'chapter_complete', chapterId: 3 } as GenerationTick));
    completeStream('book-A');
    await flushMicro();

    /* Entry DELETEd exactly once, and no re-open of the done chapter. */
    expect(fetchMock).toHaveBeenCalledWith('/api/queue/e1', { method: 'DELETE' });
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
  });

  it('does not double-claim across back-to-back snapshots', async () => {
    const store = makeStore(2);
    const snap = { entries: [entry({ id: 'a', bookId: 'book-A', chapterId: 1 })], paused: false };
    store.dispatch(queueSlice.actions.setSnapshot(snap));
    store.dispatch(queueSlice.actions.setSnapshot(snap));
    await flushMicro();
    /* The single entry opens exactly one stream despite two snapshot ticks. */
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch while the queue is paused', async () => {
    const store = makeStore(2);
    store.dispatch(queueSlice.actions.setSnapshot({ entries: [entry()], paused: true }));
    await flushMicro();
    expect(streamGenerationMock).not.toHaveBeenCalled();
  });

  it('waits for the cold-boot snapshot before opening anything', async () => {
    const store = makeStore(2);
    /* No setSnapshot yet → queue.loaded false → dispatcher idle even if a
       slice mutation fires. */
    store.dispatch(chaptersSlice.actions.setCurrentBookId('book-A'));
    await flushMicro();
    expect(streamGenerationMock).not.toHaveBeenCalled();
  });
});
