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
/* Mirror the queue-global pause flag too, so a POST /api/queue/pause sticks
   across subsequent snapshots (the breaker test asserts the queue STAYS
   paused after it trips). */
let queuePaused = false;

beforeEach(() => {
  queueEntries = [];
  queuePaused = false;
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url);
    if (u.endsWith('/api/queue/pause')) {
      queuePaused = init?.body ? Boolean(JSON.parse(init.body).paused) : queuePaused;
    } else if (u.includes('/api/queue/enqueue')) {
      const incoming = init?.body ? (JSON.parse(init.body).entries as QueueEntry[]) : [];
      queueEntries = [...queueEntries, ...incoming];
    } else if (init?.method === 'POST' && u.endsWith('/start')) {
      /* Status-only mark to in_progress (no reorder). */
      const id = u.split('/').slice(-2)[0];
      queueEntries = queueEntries.map((e) => (e.id === id ? { ...e, status: 'in_progress' } : e));
    } else if (init?.method === 'POST' && u.endsWith('/complete')) {
      /* Resolve a finished entry. Body `{ outcome }`: `done` (default) prunes;
         `failed` keeps it as failed (lingers for retry). */
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

/* Drive a stream to FAILURE: a chapter_failed tick (records the reason in the
   runner) followed by idle (closes the stream → wakes the dispatcher, which
   then reconciles the entry as `failed`). */
function failStream(bookId: string, chapterId: number, reason: string): void {
  const call = streamGenerationMock.mock.calls.find((c) => {
    const a = c[0] as { bookId?: string; chapterIds?: number[] };
    return a.bookId === bookId && (a.chapterIds ?? []).includes(chapterId);
  });
  if (!call) throw new Error(`no open stream for ${bookId}::${chapterId}`);
  const onTick = (call[0] as { onTick: (ev: GenerationTick) => void }).onTick;
  onTick({ type: 'chapter_failed', chapterId, errorReason: reason } as GenerationTick);
  onTick({ type: 'idle' } as GenerationTick);
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
    const doneInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'done' }),
    };
    expect(fetchMock).toHaveBeenCalledWith('/api/queue/a3/complete', doneInit);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/queue/a4/complete'))).toBe(
      false,
    );

    /* Now close chapter 4. */
    completeStream('book-A', 4);
    await flushMicro();
    expect(fetchMock).toHaveBeenCalledWith('/api/queue/a4/complete', doneInit);
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

    /* Entry completed exactly once (outcome:done — no failure recorded), and no
       re-open of the done chapter. */
    expect(fetchMock).toHaveBeenCalledWith('/api/queue/e1/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'done' }),
    });
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
  });

  it('marks a FAILED chapter as failed (lingers) not done-pruned, and a retry re-runs it', async () => {
    const store = makeStore(1);
    seed(store, [entry({ id: 'a3', bookId: 'book-A', chapterId: 3 })]);
    await flushMicro();
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);

    /* Chapter fails: chapter_failed records the reason, then idle closes the
       stream → the dispatcher reconciles. */
    failStream('book-A', 3, 'sidecar 500');
    await flushMicro();

    /* /complete sent outcome:failed → the entry LINGERS as failed (not removed). */
    const completeCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/a3/complete'));
    expect(completeCall).toBeDefined();
    expect(JSON.parse((completeCall![1] as { body: string }).body).outcome).toBe('failed');
    const failed = store.getState().queue.entries.find((e) => e.id === 'a3');
    expect(failed?.status).toBe('failed');
    expect(failed?.errorReason).toBe('sidecar 500');

    /* Retry — the user flips it back to queued. The dispatcher must re-claim it
       (a failed entry was NOT added to the no-reclaim `completed` set), opening
       a SECOND stream for chapter 3. */
    queueEntries = queueEntries.map((e) =>
      e.id === 'a3' ? { ...e, status: 'queued', errorReason: null } : e,
    );
    store.dispatch(queueSlice.actions.setSnapshot({ entries: queueEntries, paused: false }));
    await flushMicro();
    const opensForCh3 = streamGenerationMock.mock.calls.filter((c) =>
      ((c[0] as { chapterIds?: number[] }).chapterIds ?? []).includes(3),
    );
    expect(opensForCh3).toHaveLength(2);
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

  it('does not claim/open a new entry while the sidecar is recycling', async () => {
    const store = makeStore(2);
    store.dispatch(
      queueSlice.actions.setSnapshot({ entries: [entry()], paused: false, recycling: true }),
    );
    await flushMicro();
    expect(streamGenerationMock).not.toHaveBeenCalled();
    /* inFlight stays empty — the entry was never claimed. */
    expect(store.getState().queue.entries[0]?.status).toBe('queued');
  });

  it('waits for the cold-boot snapshot before opening anything', async () => {
    const store = makeStore(2);
    /* No setSnapshot yet → queue.loaded false → dispatcher idle even if a
       slice mutation fires. */
    store.dispatch(chaptersSlice.actions.setCurrentBookId('book-A'));
    await flushMicro();
    expect(streamGenerationMock).not.toHaveBeenCalled();
  });

  /* srv-11 — consecutive-IDENTICAL-failure circuit breaker. Run one worker so
     chapters fail strictly one at a time and the streak is deterministic. */
  describe('consecutive-failure circuit breaker (srv-11)', () => {
    /* Re-queue a failed entry so the single worker re-claims it and fails again,
       mirroring a wedged book where every chapter trips the same error. */
    function requeue(store: ReturnType<typeof makeStore>, id: string): void {
      queueEntries = queueEntries.map((e) =>
        e.id === id ? { ...e, status: 'queued', errorReason: null } : e,
      );
      store.dispatch(queueSlice.actions.setSnapshot({ entries: queueEntries, paused: false }));
    }

    const toasts = (store: ReturnType<typeof makeStore>) =>
      store.getState().notifications.toasts;

    it('does NOT trip on a single transient failure', async () => {
      const store = makeStore(1);
      seed(store, [entry({ id: 'a3', bookId: 'book-A', chapterId: 3 })]);
      await flushMicro();
      failStream('book-A', 3, 'sidecar 500');
      await flushMicro();

      expect(store.getState().queue.paused).toBe(false);
      expect(toasts(store).some((t) => t.dedupeKey?.startsWith('queue-failure-breaker'))).toBe(
        false,
      );
    });

    it('does NOT trip when consecutive failures carry DIFFERING reasons', async () => {
      const store = makeStore(1);
      seed(store, [entry({ id: 'a3', bookId: 'book-A', chapterId: 3 })]);
      await flushMicro();
      /* Three failures, each a different reason → streak keeps resetting to 1. */
      failStream('book-A', 3, 'sidecar 500');
      await flushMicro();
      requeue(store, 'a3');
      await flushMicro();
      failStream('book-A', 3, 'timeout');
      await flushMicro();
      requeue(store, 'a3');
      await flushMicro();
      failStream('book-A', 3, 'OOM');
      await flushMicro();

      expect(store.getState().queue.paused).toBe(false);
      expect(toasts(store).some((t) => t.dedupeKey?.startsWith('queue-failure-breaker'))).toBe(
        false,
      );
    });

    it('trips after THRESHOLD identical failures → pauses queue + toasts the book + reason', async () => {
      const store = makeStore(1);
      seed(store, [entry({ id: 'a3', bookId: 'book-A', chapterId: 3 })]);
      await flushMicro();

      /* Same reason three times in a row. */
      for (let i = 0; i < 3; i++) {
        failStream('book-A', 3, 'sidecar 500');
        await flushMicro();
        if (i < 2) {
          requeue(store, 'a3');
          await flushMicro();
        }
      }

      expect(store.getState().queue.paused).toBe(true);
      const tripped = toasts(store).find((t) =>
        t.dedupeKey?.startsWith('queue-failure-breaker'),
      );
      expect(tripped).toBeDefined();
      expect(tripped!.kind).toBe('error');
      expect(tripped!.message).toContain('book-A');
      expect(tripped!.message).toContain('sidecar 500');
    });

    it('resets the streak on a successful chapter so prior failures do not accumulate', async () => {
      const store = makeStore(1);
      seed(store, [entry({ id: 'a3', bookId: 'book-A', chapterId: 3 })]);
      await flushMicro();

      /* Same single chapter, single worker: fail, fail (re-queued + re-claimed),
         then SUCCEED (reset), then fail once more. Streak peaks at 2 before the
         success clears it, then climbs back to 1 — never 3 identical-in-a-row. */
      failStream('book-A', 3, 'sidecar 500');
      await flushMicro();
      requeue(store, 'a3');
      await flushMicro();
      failStream('book-A', 3, 'sidecar 500');
      await flushMicro();
      requeue(store, 'a3');
      await flushMicro();
      /* This run succeeds — resets the book's streak. */
      completeStream('book-A', 3);
      await flushMicro();
      /* Re-enqueue the (now done-pruned) chapter and fail it once more. */
      queueEntries = [entry({ id: 'a3b', bookId: 'book-A', chapterId: 3 })];
      store.dispatch(queueSlice.actions.setSnapshot({ entries: queueEntries, paused: false }));
      await flushMicro();
      failStream('book-A', 3, 'sidecar 500');
      await flushMicro();

      expect(store.getState().queue.paused).toBe(false);
      expect(toasts(store).some((t) => t.dedupeKey?.startsWith('queue-failure-breaker'))).toBe(
        false,
      );
    });
  });

  describe('loud-fallback gate', () => {
    it('does NOT /complete a claimed entry that the server parked on awaiting_confirm', async () => {
      const store = makeStore(2);
      seed(store, [entry({ id: 'a1', bookId: 'book-A', chapterId: 1 })]);
      await flushMicro();
      /* The dispatcher claimed + opened the stream (POST /start). */
      expect(openedBookIds()).toContain('book-A');

      /* Server parks the chapter: the snapshot now shows awaiting_confirm. */
      seed(store, [
        entry({
          id: 'a1',
          bookId: 'book-A',
          chapterId: 1,
          status: 'awaiting_confirm',
          fallbackCharacters: [{ id: 'wren', name: 'Wren' }],
        }),
      ]);
      /* Worker closed the stream without completing (idle). */
      completeStream('book-A', 1);
      await flushMicro();

      /* Reconcile must NOT POST /complete for the parked entry — that would
         clobber it — and must leave it re-claimable (still awaiting_confirm). */
      expect(
        fetchMock.mock.calls.some((c) => String(c[0]) === '/api/queue/a1/complete'),
      ).toBe(false);
      expect(store.getState().queue.entries[0]?.status).toBe('awaiting_confirm');
    });

    it('threads fallbackConfirmed into the stream open for a confirmed entry', async () => {
      const store = makeStore(2);
      seed(store, [
        entry({ id: 'a1', bookId: 'book-A', chapterId: 1, fallbackConfirmed: true }),
      ]);
      await flushMicro();
      const call = streamGenerationMock.mock.calls.find((c) => {
        const a = c[0] as { bookId?: string };
        return a.bookId === 'book-A';
      });
      expect(call).toBeDefined();
      expect((call![0] as { fallbackConfirmed?: boolean }).fallbackConfirmed).toBe(true);
    });

    it('threads the entry modelKey override into the stream open (regenerate at a chosen tier)', async () => {
      const store = makeStore(2);
      store.dispatch(uiSlice.actions.setTtsModelKey('qwen3-tts-0.6b')); // session default
      seed(store, [entry({ id: 'a1', bookId: 'book-A', chapterId: 1, modelKey: 'qwen3-tts-1.7b' })]);
      await flushMicro();
      const call = streamGenerationMock.mock.calls.find(
        (c) => (c[0] as { bookId?: string }).bookId === 'book-A',
      );
      expect(call).toBeDefined();
      expect((call![0] as { modelKey?: string }).modelKey).toBe('qwen3-tts-1.7b');
    });

    it('falls back to the session ttsModelKey when the entry has no model override', async () => {
      const store = makeStore(2);
      store.dispatch(uiSlice.actions.setTtsModelKey('qwen3-tts-0.6b'));
      seed(store, [entry({ id: 'a1', bookId: 'book-A', chapterId: 1 })]);
      await flushMicro();
      const call = streamGenerationMock.mock.calls.find(
        (c) => (c[0] as { bookId?: string }).bookId === 'book-A',
      );
      expect((call![0] as { modelKey?: string }).modelKey).toBe('qwen3-tts-0.6b');
    });
  });
});
