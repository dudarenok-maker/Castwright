/* Integration test for #3026's queue slot leak and #3029's re-park, through
 * the REAL client API, REAL stream runner, and REAL queue dispatcher
 * together — only `fetch` is stubbed. `queue-dispatcher-middleware.test.ts`
 * mocks `api.streamGeneration`, and that mock is exactly how both bugs went
 * uncaught: the real `realStreamGeneration` in `../lib/api` is what actually
 * emits the terminal `chapter_failed` + `idle` pair (fix 2) and threads
 * `fallbackConfirmed` into the POST body (fix 1). Deliberately does NOT
 * `vi.mock('../lib/api', ...)` — leaving the real API in place is the whole
 * point of this file. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { queueSlice, type QueueEntry } from './queue-slice';
import { chaptersSlice } from './chapters-slice';
import { uiSlice } from './ui-slice';
import { accountSlice } from './account-slice';
import { notificationsSlice } from './notifications-slice';
import { queueDispatcherMiddleware } from './queue-dispatcher-middleware';
import { createStreamRunner, type StreamRunner } from './generation-stream-runner';
import { setLanguageGuardHandler } from '../lib/language-guard-bus';

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

/** Build a Response whose body emits the given SSE frames then closes —
    copied from api-stream-reconnect.test.ts's `sseResponse`, since
    `realStreamGeneration` is the real implementation under test here. */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
      }
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: stream,
    text: () => Promise.resolve(''),
  } as unknown as Response;
}

function badGateway(): Response {
  return {
    ok: false,
    status: 502,
    statusText: 'Bad Gateway',
    body: null,
    text: () => Promise.resolve(''),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
/* Stateful server-queue mirror, same shape as queue-dispatcher-middleware.test.ts's,
   so /complete + DELETE responses stay consistent across the dispatcher's
   several reconcile round-trips. */
let queueEntries: QueueEntry[] = [];
let queuePaused = false;
/* Per-chapter generation response, keyed by the single chapterId each test's
   generation POST carries (one chapter per stream — see
   queue-dispatcher-middleware.ts's per-entry claim). */
let generationResponses: Map<number, () => Response> = new Map();

function jsonResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
  } as Response;
}

beforeEach(() => {
  queueEntries = [];
  queuePaused = false;
  generationResponses = new Map();
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url);
    if (u.includes('/generation')) {
      const body = init?.body ? (JSON.parse(init.body) as { chapterIds?: number[] }) : {};
      const chapterId = body.chapterIds?.[0];
      const resolver = chapterId != null ? generationResponses.get(chapterId) : undefined;
      if (!resolver) throw new Error(`no generation response stubbed for chapter ${chapterId}`);
      return resolver();
    }
    if (u.endsWith('/api/queue/pause')) {
      queuePaused = init?.body ? Boolean(JSON.parse(init.body).paused) : queuePaused;
    } else if (init?.method === 'POST' && u.endsWith('/start')) {
      const id = u.split('/').slice(-2)[0];
      queueEntries = queueEntries.map((e) => (e.id === id ? { ...e, status: 'in_progress' } : e));
    } else if (init?.method === 'POST' && u.endsWith('/complete')) {
      const id = u.split('/').slice(-2)[0];
      const body = init?.body ? (JSON.parse(init.body) as { outcome?: string; errorReason?: string }) : {};
      if (body.outcome === 'failed') {
        queueEntries = queueEntries.map((e) =>
          e.id === id ? { ...e, status: 'failed', errorReason: body.errorReason ?? null } : e,
        );
      } else {
        queueEntries = queueEntries.filter((e) => e.id !== id);
      }
    } else if (init?.method === 'DELETE') {
      const id = u.split('/').pop();
      queueEntries = queueEntries.filter((e) => e.id !== id);
    }
    return jsonResp({ entries: queueEntries, paused: queuePaused });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  setLanguageGuardHandler(null);
  vi.unstubAllGlobals();
});

function seed(store: ReturnType<typeof makeStore>, entries: QueueEntry[]): void {
  queueEntries = [...entries];
  store.dispatch(queueSlice.actions.setSnapshot({ entries: queueEntries, paused: false }));
}

function makeStore(generationWorkers = 1) {
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
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function generationCallsForChapter(chapterId: number): unknown[] {
  return fetchMock.mock.calls.filter((c) => {
    const [url, init] = c as [string, { body?: string } | undefined];
    if (!String(url).includes('/generation')) return false;
    const body = init?.body ? (JSON.parse(init.body) as { chapterIds?: number[] }) : {};
    return (body.chapterIds ?? [])[0] === chapterId;
  });
}

describe('queue-stream-slot-leak integration (real api + runner + dispatcher)', () => {
  it('#3026: a failed chapter frees its worker slot so a later-queued chapter still dispatches', async () => {
    const store = makeStore(2);
    generationResponses.set(1, () => badGateway());
    generationResponses.set(2, () => badGateway());
    generationResponses.set(3, () =>
      sseResponse([
        JSON.stringify({ type: 'progress', progress: 0.5 }),
        JSON.stringify({ type: 'chapter_complete', chapterId: 3 }),
        JSON.stringify({ type: 'idle' }),
      ]),
    );

    seed(store, [
      entry({ id: 'e1', bookId: 'book-A', chapterId: 1 }),
      entry({ id: 'e2', bookId: 'book-A', chapterId: 2 }),
      entry({ id: 'e3', bookId: 'book-A', chapterId: 3 }),
    ]);

    await vi.waitFor(() => {
      expect(generationCallsForChapter(3).length).toBeGreaterThan(0);
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/queue/e1/complete',
        expect.objectContaining({
          body: expect.stringContaining('"outcome":"failed"'),
        }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/queue/e2/complete',
        expect.objectContaining({
          body: expect.stringContaining('"outcome":"failed"'),
        }),
      );
    });

    await flushMicro();
  });

  it('#3029: a confirmed fallback entry threads fallbackConfirmed into the generation POST body', async () => {
    const store = makeStore(2);
    generationResponses.set(1, () => sseResponse([JSON.stringify({ type: 'idle' })]));

    seed(store, [
      entry({ id: 'e1', bookId: 'book-A', chapterId: 1, status: 'queued', fallbackConfirmed: true }),
    ]);

    await vi.waitFor(() => {
      expect(generationCallsForChapter(1).length).toBeGreaterThan(0);
    });

    const [, init] = generationCallsForChapter(1)[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { fallbackConfirmed?: boolean };
    expect(body.fallbackConfirmed).toBe(true);
  });
});
