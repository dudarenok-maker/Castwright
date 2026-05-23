/* Unit tests for queue-dispatcher-middleware (plan 102 Wave 4a).
 *
 * The dispatcher drains the workspace queue by dispatching regenerateChapter
 * for the head entry when same-book conditions are met. These tests use a
 * minimal store wiring the queue + chapters slices and the dispatcher
 * middleware; they assert (a) when a regenerate fires, (b) when it doesn't,
 * (c) that completion (clearActiveStream) triggers a DELETE round-trip,
 * (d) pause halts dispatch. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { queueSlice, type QueueEntry } from './queue-slice';
import { chaptersSlice } from './chapters-slice';
import { uiSlice } from './ui-slice';
import { notificationsSlice } from './notifications-slice';
import { queueDispatcherMiddleware } from './queue-dispatcher-middleware';
import { createStreamRunner, type StreamRunner } from './generation-stream-runner';

/* The cross-book branch opens the SSE directly via the shared runner, which
   calls api.streamGeneration. Mock it so we can assert the open args; the
   DELETE round-trip still goes through the global fetch mock (queue-thunks
   uses fetch directly, not the api module). */
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

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  streamGenerationMock.mockClear();
  cancelStreamMock.mockClear();
});

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

function makeStore() {
  /* One runner per store (test isolation). Lazy accessor breaks the
     store↔runner creation cycle — see src/store/index.ts for the same
     pattern in production. */
  let runner: StreamRunner | null = null;
  const getRunner = (): StreamRunner => runner!;
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      queue: queueSlice.reducer,
      chapters: chaptersSlice.reducer,
      notifications: notificationsSlice.reducer,
    },
    middleware: (getDefault) =>
      getDefault({ serializableCheck: false }).concat(queueDispatcherMiddleware(getRunner)),
  });
  runner = createStreamRunner(store);
  return store;
}

/** Helper — flush microtasks (the dispatcher defers tick() via
    queueMicrotask). */
async function flushMicro(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('queue-dispatcher-middleware', () => {
  it('dispatches regenerateChapter for the head entry when book matches and no stream is active', async () => {
    const store = makeStore();
    /* Seed currentBookId so the same-book gate clears. */
    store.dispatch(chaptersSlice.actions.setCurrentBookId('book-A'));
    /* Seed a chapter row so regenerateChapter has something to mutate. */
    store.dispatch(
      chaptersSlice.actions.setChapters([
        {
          id: 3,
          title: 'Chapter 3',
          state: 'done',
          progress: 1,
          duration: '0:30',
          characters: {},
        },
      ] as never),
    );

    /* Cold-boot snapshot — first GET landed, empty queue. */
    store.dispatch(queueSlice.actions.setSnapshot({ entries: [], paused: false }));
    await flushMicro();
    /* Same-book regen NOT fired → the head chapter row is untouched (still
       'done'). regenerateChapter would have flipped it to 'in_progress'. */
    expect(store.getState().chapters.chapters[0].state).toBe('done');

    /* Now an entry arrives via setSnapshot — dispatcher should fire. */
    store.dispatch(
      queueSlice.actions.setSnapshot({ entries: [entry()], paused: false }),
    );
    await flushMicro();
    /* Same-book regen fired → regenerateChapter flipped the head row to
       in_progress. (The stream spec now lives middleware-local in the
       generation-stream middleware, which this store doesn't include.) */
    expect(store.getState().chapters.chapters[0].state).toBe('in_progress');
  });

  it('does not dispatch when the queue is paused', async () => {
    const store = makeStore();
    store.dispatch(chaptersSlice.actions.setCurrentBookId('book-A'));
    store.dispatch(
      chaptersSlice.actions.setChapters([
        { id: 3, title: 'Chapter 3', state: 'done', progress: 1, duration: '0:30', characters: {} },
      ] as never),
    );
    store.dispatch(queueSlice.actions.setSnapshot({ entries: [entry()], paused: true }));
    await flushMicro();
    /* Same-book regen NOT fired → the head chapter row is untouched (still
       'done'). regenerateChapter would have flipped it to 'in_progress'. */
    expect(store.getState().chapters.chapters[0].state).toBe('done');
  });

  it('opens a CROSS-book entry directly via the runner without dispatching a regenerate (Wave 4b)', async () => {
    /* The user is viewing book-A; the head entry is for book-B. The
       same-book gate is lifted (Should #6): instead of waiting for the user
       to navigate, the dispatcher opens the SSE for book-B directly through
       the shared runner. It must NOT dispatch a regenerate action — that
       would mutate book-A's rows (the slice holds book-A). So pendingRegen
       stays null, but streamGeneration fires for book-B with the explicit
       spec + queueEntryId, and the cross-book activeStream snapshot is
       seeded so the global pill keeps moving. */
    const store = makeStore();
    store.dispatch(chaptersSlice.actions.setCurrentBookId('book-A'));
    store.dispatch(
      chaptersSlice.actions.setChapters([
        { id: 3, title: 'Chapter 3', state: 'done', progress: 1, duration: '0:30', characters: {} },
      ] as never),
    );
    store.dispatch(
      queueSlice.actions.setSnapshot({
        entries: [entry({ id: 'xb1', bookId: 'book-B', chapterId: 7 })],
        paused: false,
      }),
    );
    await flushMicro();

    /* No slice-level regen — book-A's rows are untouched. */
    /* Same-book regen NOT fired → the head chapter row is untouched (still
       'done'). regenerateChapter would have flipped it to 'in_progress'. */
    expect(store.getState().chapters.chapters[0].state).toBe('done');
    /* The cross-book stream opened with the right spec + entry correlation. */
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    const args = streamGenerationMock.mock.calls[0]?.[0] as {
      bookId?: string;
      chapterIds?: number[];
      force?: boolean;
      queueEntryId?: string;
    };
    expect(args.bookId).toBe('book-B');
    expect(args.chapterIds).toEqual([7]);
    expect(args.force).toBe(true);
    expect(args.queueEntryId).toBe('xb1');
    /* Cross-book snapshot seeded for the streaming book, not the viewed one. */
    expect(store.getState().chapters.activeStream?.bookId).toBe('book-B');
  });

  it('does not open a SECOND stream for a cross-book head while one is already in flight', async () => {
    const store = makeStore();
    store.dispatch(chaptersSlice.actions.setCurrentBookId('book-A'));
    store.dispatch(
      chaptersSlice.actions.setChapters([
        { id: 3, title: 'Chapter 3', state: 'done', progress: 1, duration: '0:30', characters: {} },
      ] as never),
    );
    /* A stream is already open (some other book's work). */
    store.dispatch(
      chaptersSlice.actions.setActiveStream({
        bookId: 'book-C',
        modelKey: 'kokoro-v1',
        done: 0,
        total: 3,
        inProgress: 1,
        lastTickAt: Date.now(),
        halted: false,
      } as never),
    );
    store.dispatch(
      queueSlice.actions.setSnapshot({
        entries: [entry({ id: 'xb2', bookId: 'book-B' })],
        paused: false,
      }),
    );
    await flushMicro();
    /* The activeStream gate holds — no second SSE. */
    expect(streamGenerationMock).not.toHaveBeenCalled();
  });

  it('DELETEs the cross-book entry when its SSE finishes (idle → clearActiveStream)', async () => {
    const store = makeStore();
    store.dispatch(chaptersSlice.actions.setCurrentBookId('book-A'));
    store.dispatch(
      chaptersSlice.actions.setChapters([
        { id: 3, title: 'Chapter 3', state: 'done', progress: 1, duration: '0:30', characters: {} },
      ] as never),
    );
    store.dispatch(
      queueSlice.actions.setSnapshot({
        entries: [entry({ id: 'xb3', bookId: 'book-B', chapterId: 7 })],
        paused: false,
      }),
    );
    await flushMicro();
    /* Cross-book stream opened + activeStream seeded by the runner. */
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    expect(store.getState().chapters.activeStream?.bookId).toBe('book-B');

    /* SSE drains — runner closes → clearActiveStream. Dispatcher then DELETEs
       the entry it was tracking (inFlightEntryId = 'xb3'). */
    fetchMock.mockResolvedValueOnce(jsonResp({ entries: [], paused: false }));
    store.dispatch(chaptersSlice.actions.clearActiveStream());
    await flushMicro();
    await flushMicro();
    expect(fetchMock).toHaveBeenCalledWith('/api/queue/xb3', { method: 'DELETE' });
  });

  it('does not dispatch while an SSE handle is open (activeStream non-null)', async () => {
    const store = makeStore();
    store.dispatch(chaptersSlice.actions.setCurrentBookId('book-A'));
    store.dispatch(
      chaptersSlice.actions.setChapters([
        { id: 3, title: 'Chapter 3', state: 'done', progress: 1, duration: '0:30', characters: {} },
      ] as never),
    );
    /* Simulate the existing middleware having opened an SSE for some other
       work. */
    store.dispatch(
      chaptersSlice.actions.setActiveStream({
        bookId: 'book-A',
        modelKey: 'kokoro-v1',
        done: 0,
        total: 5,
        inProgress: 1,
        lastTickAt: Date.now(),
        halted: false,
      } as never),
    );
    store.dispatch(queueSlice.actions.setSnapshot({ entries: [entry()], paused: false }));
    await flushMicro();
    /* Same-book regen NOT fired → the head chapter row is untouched (still
       'done'). regenerateChapter would have flipped it to 'in_progress'. */
    expect(store.getState().chapters.chapters[0].state).toBe('done');
  });

  it('DELETEs the in-flight entry when the SSE finishes (clearActiveStream)', async () => {
    const store = makeStore();
    store.dispatch(chaptersSlice.actions.setCurrentBookId('book-A'));
    store.dispatch(
      chaptersSlice.actions.setChapters([
        { id: 3, title: 'Chapter 3', state: 'done', progress: 1, duration: '0:30', characters: {} },
      ] as never),
    );
    /* Seed the queue + let dispatcher fire regenerate. */
    store.dispatch(queueSlice.actions.setSnapshot({ entries: [entry()], paused: false }));
    await flushMicro();
    expect(store.getState().chapters.chapters[0].state).toBe('in_progress');

    /* Simulate the existing middleware opening the SSE → setActiveStream. */
    store.dispatch(
      chaptersSlice.actions.setActiveStream({
        bookId: 'book-A',
        modelKey: 'kokoro-v1',
        done: 0,
        total: 1,
        inProgress: 1,
        lastTickAt: Date.now(),
        halted: false,
      } as never),
    );
    await flushMicro();

    /* Now the SSE finishes — closeHandle dispatches clearActiveStream. */
    fetchMock.mockResolvedValueOnce(jsonResp({ entries: [], paused: false }));
    store.dispatch(chaptersSlice.actions.clearActiveStream());
    await flushMicro();
    await flushMicro();

    /* Dispatcher should have fired DELETE /api/queue/e1. */
    expect(fetchMock).toHaveBeenCalledWith('/api/queue/e1', { method: 'DELETE' });
  });

  it('dispatches regenerateCharacter when the head entry is scope=character (Wave 4b)', async () => {
    const store = makeStore();
    store.dispatch(chaptersSlice.actions.setCurrentBookId('book-A'));
    store.dispatch(
      chaptersSlice.actions.setChapters([
        {
          id: 3,
          title: 'Chapter 3',
          state: 'done',
          progress: 1,
          duration: '0:30',
          /* Character must exist on the row for regenerateCharacter to
             mutate it (the reducer no-ops when the character is missing
             or 'skipped'). */
          characters: { narrator: 'done' },
        },
      ] as never),
    );
    store.dispatch(
      queueSlice.actions.setSnapshot({
        entries: [entry({ scope: 'character', characterId: 'narrator' })],
        paused: false,
      }),
    );
    await flushMicro();
    /* regenerateCharacter routed via the dispatcher's scope branch flips the
       character to 'queued' and (since the chapter was done) the row to
       in_progress. */
    expect(store.getState().chapters.chapters[0].state).toBe('in_progress');
    expect(store.getState().chapters.chapters[0].characters.narrator).toBe('queued');
  });

  it('waits for the cold-boot snapshot before doing anything', async () => {
    const store = makeStore();
    store.dispatch(chaptersSlice.actions.setCurrentBookId('book-A'));
    store.dispatch(
      chaptersSlice.actions.setChapters([
        { id: 3, title: 'Chapter 3', state: 'done', progress: 1, duration: '0:30', characters: {} },
      ] as never),
    );
    /* No setSnapshot yet — loaded is false. Even if the queue magically had
       entries (it can't until setSnapshot fires, but defense-in-depth), the
       dispatcher would do nothing. We assert by checking that just setting
       chapters (which is a trigger type) doesn't fire a regenerate. */
    await flushMicro();
    /* Same-book regen NOT fired → the head chapter row is untouched (still
       'done'). regenerateChapter would have flipped it to 'in_progress'. */
    expect(store.getState().chapters.chapters[0].state).toBe('done');
  });
});
