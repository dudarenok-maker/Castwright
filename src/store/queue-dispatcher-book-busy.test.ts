/* #3436 (owner decision 2026-11-21) -- queued chapters of a book that is being analysed stay
   queued, and the server's 409 `book_busy` render refusal can never fail them or pause the queue.

   Drives the REAL path: `api.streamGeneration` (real fetch against a stubbed network), the real
   `createStreamRunner` and the real `queueDispatcherMiddleware`. Only the network is faked: the
   queue endpoints are a stateful mirror, and `/generation` answers book-A with the server's 409
   and any other book with a stream that ends at once. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { queueSlice, type QueueEntry } from './queue-slice';
import { chaptersSlice, chaptersActions } from './chapters-slice';
import { revisionsSlice } from './revisions-slice';
import { uiSlice } from './ui-slice';
import { accountSlice } from './account-slice';
import { notificationsSlice } from './notifications-slice';
import { changeLogSlice } from './change-log-slice';
import type { Chapter } from '../lib/types';
import { analysisSlice, analysisActions, type AnalysisStreamSnapshot } from './analysis-slice';
import { queueDispatcherMiddleware } from './queue-dispatcher-middleware';
import { createStreamRunner, type StreamRunner } from './generation-stream-runner';

const SENTENCE =
  'This book is busy (analysing). Rendering audio is refused while it is analysing, so this was not started. Wait for the analysis to finish, then try again.';

const entry = (id: string, bookId: string, chapterId: number, order: number): QueueEntry => ({
  id,
  bookId,
  chapterId,
  scope: 'this',
  addedAt: '2026-11-21T00:00:00.000Z',
  status: 'queued',
  order,
});

let queueEntries: QueueEntry[] = [];
let queuePaused = false;
let generationPosts: string[] = [];
let retryCalls = 0;
let failedWrites: string[] = [];
let fetchMock: ReturnType<typeof vi.fn>;
/* When set, book-A's /generation answer waits on it, so a test can act between the claim and the 409. */
let generationGate: Promise<void> | null = null;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  queueEntries = [];
  queuePaused = false;
  generationPosts = [];
  retryCalls = 0;
  failedWrites = [];
  generationGate = null;
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url);
    const gen = /\/api\/books\/([^/]+)\/generation$/.exec(u);
    if (gen) {
      const bookId = decodeURIComponent(gen[1]);
      generationPosts.push(bookId);
      if (bookId === 'book-A') {
        if (generationGate) await generationGate;
        return json({ error: SENTENCE, code: 'book_busy' }, 409);
      }
      return new Response('data: {"type":"idle"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    if (u.endsWith('/api/queue/pause')) {
      queuePaused = init?.body ? Boolean(JSON.parse(init.body).paused) : queuePaused;
    } else if (init?.method === 'POST' && u.endsWith('/start')) {
      const id = u.split('/').slice(-2)[0];
      queueEntries = queueEntries.map((e) => (e.id === id ? { ...e, status: 'in_progress' } : e));
    } else if (init?.method === 'POST' && u.endsWith('/retry')) {
      retryCalls += 1;
      const id = u.split('/').slice(-2)[0];
      queueEntries = queueEntries.map((e) =>
        e.id === id && e.status === 'failed' ? { ...e, status: 'queued', errorReason: null } : e,
      );
    } else if (init?.method === 'POST' && u.endsWith('/complete')) {
      const id = u.split('/').slice(-2)[0];
      const body = init?.body ? (JSON.parse(init.body) as { outcome?: string; errorReason?: string }) : {};
      /* the server's `completeEntry`: requeued is in_progress -> queued, never through `failed` */
      queueEntries =
        body.outcome === 'failed'
          ? queueEntries.map((e) =>
              e.id === id ? { ...e, status: 'failed', errorReason: body.errorReason ?? null } : e,
            )
          : body.outcome === 'requeued'
            ? queueEntries.map((e) =>
                e.id === id && e.status === 'in_progress' ? { ...e, status: 'queued', errorReason: null } : e,
              )
            : queueEntries.filter((e) => e.id !== id);
      if (body.outcome === 'failed') failedWrites.push(id);
    }
    return json({ entries: queueEntries, paused: queuePaused });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function makeStore(generationWorkers = 3) {
  let runner: StreamRunner | null = null;
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      queue: queueSlice.reducer,
      chapters: chaptersSlice.reducer,
      revisions: revisionsSlice.reducer,
      account: accountSlice.reducer,
      notifications: notificationsSlice.reducer,
      analysis: analysisSlice.reducer,
      changeLog: changeLogSlice.reducer,
    },
    preloadedState: { account: { ...accountSlice.getInitialState(), generationWorkers } },
    middleware: (g) => g({ serializableCheck: false }).concat(queueDispatcherMiddleware(() => runner!)),
  });
  runner = createStreamRunner(store);
  return store;
}

function seed(store: ReturnType<typeof makeStore>, entries: QueueEntry[]): void {
  queueEntries = [...entries];
  store.dispatch(queueSlice.actions.setSnapshot({ entries: queueEntries, paused: false }));
}

const runningAnalysisOf = (bookId: string): AnalysisStreamSnapshot => ({
  bookId,
  manuscriptId: `m-${bookId}`,
  phaseId: 1,
  phaseLabel: 'Attributing',
  phaseProgress: 10,
  remainingMs: null,
  lastTickAt: Date.now(),
  state: 'running',
  kind: 'subset',
  subsetChapterIds: [1],
  subsetOrigin: 'reanalyse',
});

const statusOf = (id: string) => queueEntries.find((e) => e.id === id)?.status;
const breakerToasts = (store: ReturnType<typeof makeStore>) =>
  store.getState().notifications.toasts.filter((t) => t.dedupeKey?.startsWith('queue-failure-breaker'));

describe('#3436 queued chapters of a book under analysis', () => {
  it('stay queued while it is analysing (never claimed, never failed); other books keep rendering; they resume when it ends', async () => {
    const store = makeStore();
    store.dispatch(analysisActions.setActiveStream(runningAnalysisOf('book-A')));
    seed(store, [entry('a1', 'book-A', 1, 0), entry('a2', 'book-A', 2, 1), entry('b1', 'book-B', 1, 2)]);

    await vi.waitFor(() => expect(generationPosts).toContain('book-B'));
    await vi.waitFor(() => expect(queueEntries.some((e) => e.id === 'b1')).toBe(false));
    expect(generationPosts).not.toContain('book-A');
    expect(statusOf('a1')).toBe('queued');
    expect(statusOf('a2')).toBe('queued');
    expect(store.getState().queue.paused).toBe(false);

    /* the analysis ends: the dispatcher resumes the book's entries */
    store.dispatch(analysisActions.clearActiveStream());
    await vi.waitFor(() => expect(generationPosts.filter((b) => b === 'book-A').length).toBeGreaterThan(0));
  });
});

describe('#3436 a 409 book_busy render refusal (the race the dispatcher cannot see)', () => {
  it('never fails the entries, never counts toward the streak, never pauses the queue; other books continue', async () => {
    const store = makeStore();
    seed(store, [
      entry('a1', 'book-A', 1, 0),
      entry('a2', 'book-A', 2, 1),
      entry('a3', 'book-A', 3, 2),
      entry('b1', 'book-B', 1, 3),
    ]);

    /* every A entry is refused once, requeued, and held back (no hot loop) */
    await vi.waitFor(() => expect(generationPosts.filter((b) => b === 'book-A').length).toBe(3));
    await vi.waitFor(() => expect(['a1', 'a2', 'a3'].map(statusOf)).toEqual(['queued', 'queued', 'queued']));
    await vi.waitFor(() => expect(queueEntries.some((e) => e.id === 'b1')).toBe(false));
    expect(generationPosts).toContain('book-B');
    expect(store.getState().queue.paused).toBe(false);
    expect(queuePaused).toBe(false);
    expect(breakerToasts(store)).toHaveLength(0);
    /* the atomic requeue: `failed` is never written to the queue file and /retry is never called */
    expect(failedWrites).toEqual([]);
    expect(retryCalls).toBe(0);
    /* held back, not retried in a loop */
    await new Promise((r) => setTimeout(r, 300));
    expect(generationPosts.filter((b) => b === 'book-A').length).toBe(3);
  });

  it('control: an ordinary identical failure still trips the breaker (the exemption is only book-busy)', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if (/\/generation$/.test(u)) return json({ error: 'engine exploded' }, 500);
      if (init?.method === 'POST' && u.endsWith('/start')) {
        const id = u.split('/').slice(-2)[0];
        queueEntries = queueEntries.map((e) => (e.id === id ? { ...e, status: 'in_progress' } : e));
      } else if (init?.method === 'POST' && u.endsWith('/complete')) {
        const id = u.split('/').slice(-2)[0];
        const body = JSON.parse(init.body!) as { errorReason?: string };
        queueEntries = queueEntries.map((e) =>
          e.id === id ? { ...e, status: 'failed', errorReason: body.errorReason ?? null } : e,
        );
      } else if (u.endsWith('/api/queue/pause')) {
        queuePaused = Boolean(JSON.parse(init!.body!).paused);
      }
      return json({ entries: queueEntries, paused: queuePaused });
    });
    const store = makeStore(1);
    seed(store, [entry('a1', 'book-A', 1, 0), entry('a2', 'book-A', 2, 1), entry('a3', 'book-A', 3, 2)]);
    await vi.waitFor(() => expect(breakerToasts(store)).toHaveLength(1), { timeout: 4000 });
  });
});

describe('#3436 a 409 book_busy refusal on the OPEN book (the row and the change log)', () => {
  /* The row a rendered chapter had before the claim. The claim flips it to in_progress
     (`regenerateChapterIds`); the refusal must hand it back as the skip path would have left it. */
  const doneRow: Chapter = {
    id: 1,
    title: 'Chapter 1',
    duration: '04:12',
    state: 'done',
    progress: 1,
    characters: { narrator: 'done' },
    completedSentenceIds: [1, 2],
    audioRenderedAt: '2026-11-20T00:00:00.000Z',
  } as Chapter;

  it('leaves the chapter row unchanged (not failed, no busy sentence) and appends no change-log event', async () => {
    const store = makeStore();
    store.dispatch(chaptersActions.setChapters([doneRow]));
    store.dispatch(chaptersActions.setCurrentBookId('book-A'));
    const logBefore = store.getState().changeLog.events.length;
    seed(store, [entry('a1', 'book-A', 1, 0)]);

    await vi.waitFor(() => expect(generationPosts.filter((b) => b === 'book-A').length).toBe(1));
    await vi.waitFor(() => expect(statusOf('a1')).toBe('queued'));
    await vi.waitFor(() => expect(store.getState().chapters.chapters[0].state).not.toBe('in_progress'));

    expect(store.getState().chapters.chapters[0]).toEqual(doneRow);
    expect(store.getState().changeLog.events).toHaveLength(logBefore);
    expect(failedWrites).toEqual([]);
  });

  it('keeps a row hydrated after the claim when the book is opened before the refusal lands (no pre-claim row to restore)', async () => {
    let release!: () => void;
    generationGate = new Promise<void>((r) => (release = r));
    const store = makeStore();
    seed(store, [entry('a1', 'book-A', 1, 0)]);
    await vi.waitFor(() => expect(generationPosts.filter((b) => b === 'book-A').length).toBe(1));

    /* the book is opened AFTER the claim: its hydrated row is not the claim's doing */
    store.dispatch(chaptersActions.setCurrentBookId('book-A'));
    store.dispatch(chaptersActions.setChapters([doneRow]));
    release();

    await vi.waitFor(() => expect(statusOf('a1')).toBe('queued'));
    await new Promise((r) => setTimeout(r, 50));
    expect(store.getState().chapters.chapters[0]).toEqual(doneRow);
  });

  it('keeps the "Generation halted" banner across a refused claim (the skip path would have left it up)', async () => {
    const store = makeStore();
    store.dispatch(chaptersActions.setChapters([doneRow]));
    store.dispatch(chaptersActions.setCurrentBookId('book-A'));
    store.dispatch(
      chaptersActions.applyGenerationTick({ type: 'chapter_failed', errorReason: 'Sidecar is not ready.' } as never),
    );
    expect(store.getState().chapters.lastError).toBe('Sidecar is not ready.');
    seed(store, [entry('a1', 'book-A', 1, 0)]);

    await vi.waitFor(() => expect(generationPosts.filter((b) => b === 'book-A').length).toBe(1));
    await vi.waitFor(() => expect(statusOf('a1')).toBe('queued'));
    await vi.waitFor(() => expect(store.getState().chapters.chapters[0].state).not.toBe('in_progress'));
    expect(store.getState().chapters.lastError).toBe('Sidecar is not ready.');
  });
});
