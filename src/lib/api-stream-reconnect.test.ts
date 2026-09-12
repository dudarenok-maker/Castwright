/* Plan 102 — realStreamGeneration auto-reconnects on unexpected SSE end.
 *
 * Six scenarios verified:
 *   1. Stream ends cleanly with no `idle` tick after at least one real tick →
 *      reconnect once, deliver the next batch of ticks.
 *   2. Stream ends with an `idle` tick → no reconnect (queue drained naturally).
 *   3. Caller cancels via the returned canceller mid-stream → no reconnect, no
 *      terminal chapter_failed/idle pair (user-initiated stop).
 *   4. Stream closes after zero ticks (setup error) → no reconnect, but still
 *      emit chapter_failed + idle to free the worker slot.
 *   5. Non-OK response (server error) → no reconnect, emit chapter_failed + idle.
 *   6. Reconnect attempts exhausted → emit chapter_failed + idle once.
 *
 * The terminal block (chapter_failed + idle pair) is emitted on every give-up
 * shape except idle-terminated streams and caller cancellation. Mocks `fetch`
 * to return a streaming Response whose ReadableStream emits a controlled
 * sequence of SSE frames, then closes, or rejects. The reconnect strategy
 * matches plan 102 invariant 6 (the resume_from server-side ack is the
 * complementary piece, tested separately in
 * server/src/routes/generation-resume-from.test.ts). */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Build a Response whose body emits the given SSE frames then closes. */
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

/** Wait one macrotask so awaited fetches settle. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

describe('realStreamGeneration auto-reconnect', () => {
  it('reconnects when the stream closes without an idle tick after seeing ticks', async () => {
    const { api } = await import('./api');
    /* First fetch: emit one progress tick then close (simulates tsx watch
       restart mid-run). Second fetch: emit a chapter_complete + idle. */
    fetchMock
      .mockResolvedValueOnce(sseResponse([JSON.stringify({ type: 'progress', progress: 0.3 })]))
      .mockResolvedValueOnce(
        sseResponse([
          JSON.stringify({ type: 'chapter_complete', chapterId: 1 }),
          JSON.stringify({ type: 'idle' }),
        ]),
      );
    const ticks: { type: string }[] = [];
    const cancel = api.streamGeneration({
      bookId: 'book-A',
      modelKey: 'kokoro-v1',
      chapterIds: [1],
      queueEntryId: 'queue-entry-xyz',
      onTick: (t) => ticks.push(t),
    });
    /* Wait long enough for backoff (500ms) + second fetch + tick parsing. */
    await new Promise((r) => setTimeout(r, 800));
    cancel();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    /* Both fetches POSTed with the same body — queueEntryId is preserved. */
    expect(fetchMock.mock.calls[0][1].body).toContain('"queueEntryId":"queue-entry-xyz"');
    expect(fetchMock.mock.calls[1][1].body).toContain('"queueEntryId":"queue-entry-xyz"');
    /* All ticks delivered: progress + chapter_complete + idle. */
    expect(ticks.map((t) => t.type)).toEqual(['progress', 'chapter_complete', 'idle']);
  });

  it('does NOT reconnect after receiving the idle tick (clean queue drain)', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(
      sseResponse([JSON.stringify({ type: 'progress' }), JSON.stringify({ type: 'idle' })]),
    );
    const ticks: { type: string }[] = [];
    api.streamGeneration({
      bookId: 'book-A',
      modelKey: 'kokoro-v1',
      onTick: (t) => ticks.push(t),
    });
    await flush();
    await new Promise((r) => setTimeout(r, 600));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ticks.map((t) => t.type)).toEqual(['progress', 'idle']);
  });

  it('does NOT reconnect when cancelled by the caller mid-stream', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(
      sseResponse([JSON.stringify({ type: 'progress' })]),
      /* Second fetch would happen IF we reconnected — gate with a flag. */
    );
    const ticks: { type: string }[] = [];
    const cancel = api.streamGeneration({
      bookId: 'book-A',
      modelKey: 'kokoro-v1',
      onTick: (t) => ticks.push(t),
    });
    await flush();
    cancel();
    await new Promise((r) => setTimeout(r, 700));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ticks.map((t) => t.type)).toEqual(['progress']);
  });

  it('does NOT reconnect when the FIRST fetch never delivered a tick (setup error)', async () => {
    const { api } = await import('./api');
    /* Empty stream — server closed immediately. */
    fetchMock.mockResolvedValueOnce(sseResponse([]));
    const ticks: { type: string }[] = [];
    api.streamGeneration({
      bookId: 'book-A',
      modelKey: 'kokoro-v1',
      onTick: (t) => ticks.push(t),
    });
    await new Promise((r) => setTimeout(r, 600));
    /* Only one fetch (no reconnect). */
    expect(fetchMock).toHaveBeenCalledTimes(1);
    /* #3026 step 2 — a zero-tick close is a stream-slot leak same as a 502 or
       a rejected fetch: the client must still deliver chapter_failed + idle
       so the dispatcher frees the queue worker slot. Deliberate behaviour
       change for this shape — it used to deliver nothing at all. */
    expect(ticks.map((t) => t.type)).toEqual(['chapter_failed', 'idle']);
  });

  /* #3026 step 2 — shape A: a non-OK response (e.g. the dev proxy's 502/504
     while the server is down or restarting) must still end with exactly one
     chapter_failed (carrying chapterId for a single-chapter request) then
     idle, so the dispatcher frees the worker slot instead of wedging the
     queue forever. */
  it('delivers chapter_failed + idle for a non-OK response (single chapter)', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      body: null,
      text: () => Promise.resolve(''),
    } as unknown as Response);
    const ticks: { type: string; chapterId?: number }[] = [];
    api.streamGeneration({
      bookId: 'book-A',
      modelKey: 'kokoro-v1',
      chapterIds: [7],
      onTick: (t) => ticks.push(t as { type: string; chapterId?: number }),
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ticks.map((t) => t.type)).toEqual(['chapter_failed', 'idle']);
    expect(ticks[0].chapterId).toBe(7);
  });

  /* #3026 step 2 — shape C: the first fetch throwing before any tick (e.g.
     connection refused) is the same leak as shape A and gets the same
     terminal pair. */
  it('delivers chapter_failed + idle when the first fetch throws (single chapter)', async () => {
    const { api } = await import('./api');
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const ticks: { type: string; chapterId?: number }[] = [];
    api.streamGeneration({
      bookId: 'book-A',
      modelKey: 'kokoro-v1',
      chapterIds: [7],
      onTick: (t) => ticks.push(t as { type: string; chapterId?: number }),
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ticks.map((t) => t.type)).toEqual(['chapter_failed', 'idle']);
    expect(ticks[0].chapterId).toBe(7);
  });

  /* #3026 step 2 — a multi-chapter request has no single chapter to blame,
     so the chapter_failed tick omits chapterId entirely rather than
     guessing. */
  it('omits chapterId on the terminal chapter_failed for a multi-chapter request', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      body: null,
      text: () => Promise.resolve(''),
    } as unknown as Response);
    const ticks: { type: string; chapterId?: number }[] = [];
    api.streamGeneration({
      bookId: 'book-A',
      modelKey: 'kokoro-v1',
      chapterIds: [1, 2],
      onTick: (t) => ticks.push(t as { type: string; chapterId?: number }),
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(ticks.map((t) => t.type)).toEqual(['chapter_failed', 'idle']);
    expect(ticks[0].chapterId).toBeUndefined();
  });

  /* #2516/#2763 — a route-level precondition failure (cast not confirmed,
     book not found, provider selection failure) closes the stream with
     exactly one `chapter_failed` tick followed by `idle` (fixed server-side
     in fa5d0923 — see server/src/routes/generation.test.ts's "emits idle
     after a book-not-found/cast-not-confirmed chapter_failed" cases).
     Retrying is pointless: the failure is deterministic until something
     outside the stream changes. The reconnect gate already treats ANY
     idle-terminated stream as drained regardless of tick type, so this is
     a regression test pinning that behavior for this specific shape rather
     than a new code path. */
  it('does NOT reconnect after a deterministic precondition failure (chapter_failed + idle, zero synth ticks)', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        JSON.stringify({
          type: 'chapter_failed',
          errorReason: 'Cast not confirmed yet — open the cast view first.',
        }),
        JSON.stringify({ type: 'idle' }),
      ]),
    );
    const ticks: { type: string }[] = [];
    api.streamGeneration({
      bookId: 'book-A',
      modelKey: 'kokoro-v1',
      onTick: (t) => ticks.push(t),
    });
    await flush();
    await new Promise((r) => setTimeout(r, 600));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ticks.map((t) => t.type)).toEqual(['chapter_failed', 'idle']);
  });

  /* Contrast case: a transient mid-run failure (no precondition guard, no
     idle — e.g. a sidecar crash) still reconnects exactly as before. Proves
     the precondition-failure test above isn't passing because chapter_failed
     ticks are special-cased, only because idle followed it. */
  it('still reconnects after a transient chapter_failed with no idle (unchanged behavior)', async () => {
    const { api } = await import('./api');
    fetchMock
      .mockResolvedValueOnce(
        sseResponse([JSON.stringify({ type: 'chapter_failed', errorReason: 'sidecar 500' })]),
      )
      .mockResolvedValueOnce(sseResponse([JSON.stringify({ type: 'idle' })]));
    const ticks: { type: string }[] = [];
    const cancel = api.streamGeneration({
      bookId: 'book-A',
      modelKey: 'kokoro-v1',
      onTick: (t) => ticks.push(t),
    });
    await new Promise((r) => setTimeout(r, 800));
    cancel();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ticks.map((t) => t.type)).toEqual(['chapter_failed', 'idle']);
  });

  /* #3026 step 3 — shape D: every reconnect attempt after the first real tick
     fails, so RECONNECT_MAX_ATTEMPTS (5 fetches total: the initial open plus
     four reconnects) is exhausted without ever seeing `idle`. The terminal
     block still delivers exactly one chapter_failed + idle pair, same as
     every other give-up shape. Fake timers stand in for the ~15.5s of real
     backoff (500+1000+2000+4000+8000ms). */
  it('delivers chapter_failed + idle once reconnect attempts are exhausted (shape D)', async () => {
    vi.useFakeTimers();
    try {
      const { api } = await import('./api');
      fetchMock
        .mockResolvedValueOnce(sseResponse([JSON.stringify({ type: 'progress', progress: 0.3 })]))
        .mockRejectedValue(new TypeError('Failed to fetch'));
      const ticks: { type: string; chapterId?: number }[] = [];
      api.streamGeneration({
        bookId: 'book-A',
        modelKey: 'kokoro-v1',
        chapterIds: [7],
        onTick: (t) => ticks.push(t as { type: string; chapterId?: number }),
      });
      await vi.advanceTimersByTimeAsync(20000);
      /* One initial fetch + four reconnects = five total. */
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(ticks.map((t) => t.type).slice(-2)).toEqual(['chapter_failed', 'idle']);
      expect(ticks.filter((t) => t.type === 'idle')).toHaveLength(1);
      const failedTicks = ticks.filter((t) => t.type === 'chapter_failed');
      expect(failedTicks).toHaveLength(1);
      expect(failedTicks[0].chapterId).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  /* #3026 step 3 — cancelling while the client is waiting out a reconnect
     backoff must emit nothing: the outer `cancelled` flag short-circuits the
     terminal-handling block, so no chapter_failed/idle pair follows the
     tick(s) already delivered. */
  it('cancelling during a reconnect backoff emits nothing further', async () => {
    vi.useFakeTimers();
    try {
      const { api } = await import('./api');
      fetchMock
        .mockResolvedValueOnce(sseResponse([JSON.stringify({ type: 'progress', progress: 0.3 })]))
        .mockRejectedValue(new TypeError('Failed to fetch'));
      const ticks: { type: string }[] = [];
      const cancel = api.streamGeneration({
        bookId: 'book-A',
        modelKey: 'kokoro-v1',
        chapterIds: [7],
        onTick: (t) => ticks.push(t as { type: string }),
      });
      /* Flush microtasks so the first fetch resolves and the loop enters its
         first backoff wait, without yet advancing real timer-bound delay. */
      await vi.advanceTimersByTimeAsync(0);
      cancel();
      /* Advance well past the full backoff — nothing further should fire. */
      await vi.advanceTimersByTimeAsync(20000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(ticks.map((t) => t.type)).toEqual(['progress']);
    } finally {
      vi.useRealTimers();
    }
  });

  /* #3026 — when reader.read() rejects with AbortError (e.g. a network
     abort mid-flight in a real browser), the AbortError catch at api.ts:5908
     returns { shouldReconnect: false }, then falls through via the return→break
     change at :5924 to the terminal block where !cancelled && !sawIdle
     guards the chapter_failed + idle pair. This test directly exercises that
     catch edge and its terminal-block delivery, verifying it emits the correct
     pair once even when called with a single-chapter chapterId. */
  it('delivers chapter_failed + idle when fetch rejects with AbortError', async () => {
    const { api } = await import('./api');
    /* First fetch succeeds with one progress tick, triggering shouldReconnect
       condition. Second fetch rejects with AbortError, hitting the catch at
       api.ts:5908 which returns { shouldReconnect: false }, then breaks due to
       the return→break change at :5924, falling through to the terminal block. */
    fetchMock
      .mockResolvedValueOnce(sseResponse([JSON.stringify({ type: 'progress', progress: 0.3 })]))
      .mockRejectedValueOnce(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    const ticks: { type: string; chapterId?: number }[] = [];
    api.streamGeneration({
      bookId: 'book-A',
      modelKey: 'kokoro-v1',
      chapterIds: [7],
      onTick: (t) => ticks.push(t as { type: string; chapterId?: number }),
    });
    await new Promise((r) => setTimeout(r, 800));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    /* After the first fetch succeeds with one tick, reconnect is triggered.
       The second fetch rejects with AbortError, the catch returns
       { shouldReconnect: false }, and the terminal block fires with
       chapter_failed + idle. */
    expect(ticks.map((t) => t.type)).toEqual(['progress', 'chapter_failed', 'idle']);
    expect(ticks[1].chapterId).toBe(7);
  });
});
