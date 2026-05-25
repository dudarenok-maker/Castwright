/* Unit tests for queue-dispatcher-middleware (queue-sole concurrency).
 *
 * The dispatcher is the sole stream-opener: it fills up to N workers from the
 * flat queue across books, opening ONE stream PER CHAPTER (one queue worker =
 * one chapter), and DELETEs an entry once its CHAPTER's stream closes. These
 * tests pin: the open args + row flip, the chapter-level completion DELETE,
 * N-slot fill across books, two same-book chapters opening two streams (no
 * coalescing, no second-request abort since each chapter is keyed
 * independently server-side), no double-claim, and the no-loop invariant. */

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
    } else if (init?.method === 'POST' && u.endsWith('/start')) {
      /* Status-only mark to in_progress (no reorder). */
      const id = u.split('/').slice(-2)[0];
      queueEntries = queueEntries.map((e) => (e.id === id ? { ...e, status: 'in_progress' } : e));
    } else if (init?.method === 'POST' && u.endsWith('/complete')) {
      /* Done-prune a finished entry (status-agnostic). */
      const id = u.split('/').slice(-2)[0];
      queueEntries = queueEntries.filter((e) => e.id !== id);
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
  /* The dispatcher fires its tick from a queueMicrotask, and the /start +
     /complete thunks chain fetch → res.json() → setSnapshot (each an await),
     which can re-trigger a tick. Flush generously so every cascade settles
     before assertions read the slice. */
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

/* Find the open call for a (book, chapter) and drive its stream to completion
   by feeding an idle tick through the runner's per-stream onTick (the runner
   then closes that chapter's handle + clears its snapshot, which wakes the
   dispatcher). */
function completeStream(bookId: string, chapterId: number): void {
  const call = streamGenerationMock.mock.calls.find((c) => {
    const a = c[0] as { bookId?: string; chapterIds?: number[] };
    return a.bookId === bookId && (a.chapterIds ?? []).includes(chapterId);
  });
  if (!call) throw new Error(`no open stream for ${bookId}::${chapterId}`);
  (call[0] as { onTick: (ev: GenerationTick) => void }).onTick({ type: 'idle' } as GenerationTick);
}

const openedBookIds = () =>
  streamGenerationMock.mock.calls.map((c) => (c[0] as { bookId: string }).bookId);

/* The single chapterId each open call carries (one chapter per stream). */
const openedChapterIds = () =>
  streamGenerationMock.mock.calls.map((c) => (c[0] as { chapterIds: number[] }).chapterIds);

describe('queue-dispatcher-middleware (queue-sole concurrency)', () => {
  it('opens a stream for a same-book entry and flips its rows', async () => {
    const store = makeStore();
    store.dispatch(chaptersSlice.actions.setCurrentBookId('book-A'));
    store.dispatch(
      chaptersSlice.actions.setChapters([
        { id: 3, title: 'Chapter 3', state: 'done', progress: 1, duration: '0:30', characters: {} },
      ] as never),
    );
    seed(store, [entry()]);
    await flushMicro();

    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    const args = streamGenerationMock.mock.calls[0][0] as {
      bookId: string;
      chapterIds: number[];
    };
    expect(args.bookId).toBe('book-A');
    /* One chapter on the wire (chapterIds is the server contract; the runner
       keys its handle off the same single chapter via the opts.chapterId,
       which is not part of the streamGeneration wire args). */
    expect(args.chapterIds).toEqual([3]);
    /* Viewed-book row flipped to in_progress via regenerateChapterIds. */
    expect(store.getState().chapters.chapters[0].state).toBe('in_progress');
  });

  it('flips the claimed entry to in_progress on claim (POST /start), so the modal reads "In flight"', async () => {
    const store = makeStore(2);
    seed(store, [entry({ id: 'a3', bookId: 'book-A', chapterId: 3 })]);
    await flushMicro();
    /* The dispatcher POSTed /start the instant it claimed the entry. */
    expect(fetchMock).toHaveBeenCalledWith('/api/queue/a3/start', { method: 'POST' });
    /* The slice mirrors the server snapshot — the entry is now in_progress
       (not "queued"), which is what the modal's per-row "In flight" label
       keys off. */
    const e = store.getState().queue.entries.find((x) => x.id === 'a3');
    expect(e?.status).toBe('in_progress');
  });

  it('marks ALL N claimed entries in_progress when several run concurrently', async () => {
    const store = makeStore(2);
    seed(store, [
      entry({ id: 'a3', bookId: 'book-A', chapterId: 3 }),
      entry({ id: 'b1', bookId: 'book-B', chapterId: 1 }),
    ]);
    await flushMicro();
    /* Two workers → two concurrent chapters → both entries in_progress. */
    const statuses = store.getState().queue.entries.map((e) => [e.id, e.status]);
    expect(statuses).toEqual(
      expect.arrayContaining([
        ['a3', 'in_progress'],
        ['b1', 'in_progress'],
      ]),
    );
  });

  it('opens ONE stream PER same-book chapter (no coalescing, no second-request abort)', async () => {
    const store = makeStore(2);
    seed(store, [
      entry({ id: 'a3', bookId: 'book-A', chapterId: 3 }),
      entry({ id: 'a4', bookId: 'book-A', chapterId: 4 }),
    ]);
    await flushMicro();
    /* Each same-book chapter rides its OWN forced request, keyed
       `${bookId}::${chapterId}` server-side — two streams, never one that
       aborts the other. */
    expect(streamGenerationMock).toHaveBeenCalledTimes(2);
    expect(openedBookIds()).toEqual(['book-A', 'book-A']);
    /* Each stream carries exactly one chapter on the wire. */
    expect(
      openedChapterIds()
        .map((ids) => ids[0])
        .sort(),
    ).toEqual([3, 4]);
  });

  it('chapter-level completion: completing ch3’s stream removes its entry without waiting on ch4', async () => {
    const store = makeStore(2);
    seed(store, [
      entry({ id: 'a3', bookId: 'book-A', chapterId: 3 }),
      entry({ id: 'a4', bookId: 'book-A', chapterId: 4 }),
    ]);
    await flushMicro();
    expect(streamGenerationMock).toHaveBeenCalledTimes(2);

    /* Close ONLY chapter 3's stream. */
    completeStream('book-A', 3);
    await flushMicro();
    /* ch3's entry completed (done-prune via /complete, NOT DELETE — the entry
       is in_progress by now); ch4 still in flight (not completed yet). */
    expect(fetchMock).toHaveBeenCalledWith('/api/queue/a3/complete', { method: 'POST' });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/queue/a4/complete'))).toBe(
      false,
    );

    /* Now close chapter 4. */
    completeStream('book-A', 4);
    await flushMicro();
    expect(fetchMock).toHaveBeenCalledWith('/api/queue/a4/complete', { method: 'POST' });
  });

  it('fills up to N workers across books and holds the rest', async () => {
    const store = makeStore(2);
    seed(store, [
      entry({ id: 'a', bookId: 'book-A', chapterId: 1 }),
      entry({ id: 'b', bookId: 'book-B', chapterId: 1 }),
      entry({ id: 'c', bookId: 'book-C', chapterId: 1 }),
    ]);
    await flushMicro();
    /* N=2 → two chapters streaming, the third waits. */
    expect(openedBookIds().sort()).toEqual(['book-A', 'book-B']);

    /* Book-A's chapter finishes → its slot frees → book-C opens. */
    completeStream('book-A', 1);
    await flushMicro();
    expect(openedBookIds()).toContain('book-C');
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/queue/a/complete'))).toBe(
      true,
    );
  });

  it('completes an entry only after its chapter’s stream closes (no-loop)', async () => {
    const store = makeStore(2);
    store.dispatch(chaptersSlice.actions.setCurrentBookId('book-A'));
    store.dispatch(
      chaptersSlice.actions.setChapters([
        {
          id: 3,
          title: 'Chapter 3',
          state: 'queued',
          progress: 0,
          duration: '0:30',
          characters: {},
        },
      ] as never),
    );
    seed(store, [entry()]);
    await flushMicro();
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    /* No completion-removal while the stream is live (the claim POSTed /start,
       but never /complete and never DELETE). */
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/complete'))).toBe(false);
    expect(
      fetchMock.mock.calls.some((c) => (c[1] as { method?: string })?.method === 'DELETE'),
    ).toBe(false);

    /* Mark the chapter done + close the stream (idle). */
    store.dispatch(
      chaptersSlice.actions.applyGenerationTick({
        type: 'chapter_complete',
        chapterId: 3,
      } as GenerationTick),
    );
    completeStream('book-A', 3);
    await flushMicro();

    /* Entry completed exactly once, and no re-open of the done chapter. */
    expect(fetchMock).toHaveBeenCalledWith('/api/queue/e1/complete', { method: 'POST' });
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
  });

  it('does not double-claim across back-to-back snapshots', async () => {
    const store = makeStore(2);
    seed(store, [entry({ id: 'a', bookId: 'book-A', chapterId: 1 })]);
    /* A second identical snapshot tick must not re-claim the same entry. */
    store.dispatch(
      queueSlice.actions.setSnapshot({
        entries: [entry({ id: 'a', bookId: 'book-A', chapterId: 1 })],
        paused: false,
      }),
    );
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
