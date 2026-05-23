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
  return configureStore({
    reducer: {
      ui: uiSlice.reducer,
      queue: queueSlice.reducer,
      chapters: chaptersSlice.reducer,
      notifications: notificationsSlice.reducer,
    },
    middleware: (getDefault) =>
      getDefault({ serializableCheck: false }).concat(queueDispatcherMiddleware),
  });
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
    expect(store.getState().chapters.pendingRegen).toBeNull();

    /* Now an entry arrives via setSnapshot — dispatcher should fire. */
    store.dispatch(
      queueSlice.actions.setSnapshot({ entries: [entry()], paused: false }),
    );
    await flushMicro();
    expect(store.getState().chapters.pendingRegen).toEqual({ chapterIds: [3], force: true });
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
    expect(store.getState().chapters.pendingRegen).toBeNull();
  });

  it('does not dispatch when the head entry is for a different book (same-book gate)', async () => {
    const store = makeStore();
    store.dispatch(chaptersSlice.actions.setCurrentBookId('book-A'));
    store.dispatch(
      chaptersSlice.actions.setChapters([
        { id: 3, title: 'Chapter 3', state: 'done', progress: 1, duration: '0:30', characters: {} },
      ] as never),
    );
    store.dispatch(
      queueSlice.actions.setSnapshot({
        entries: [entry({ bookId: 'book-B' })],
        paused: false,
      }),
    );
    await flushMicro();
    expect(store.getState().chapters.pendingRegen).toBeNull();
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
    expect(store.getState().chapters.pendingRegen).toBeNull();
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
    expect(store.getState().chapters.pendingRegen).not.toBeNull();

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
    /* regenerateCharacter sets pendingRegen the same way regenerateChapter
       does — the dispatcher's scope branch routes to the right action. */
    expect(store.getState().chapters.pendingRegen).toEqual({ chapterIds: [3], force: true });
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
    expect(store.getState().chapters.pendingRegen).toBeNull();
  });
});
