/* Plan 102 — realStreamGeneration auto-reconnects on unexpected SSE end.
 *
 * Two scenarios verified:
 *   1. Stream ends cleanly with no `idle` tick after at least one real tick →
 *      reconnect once, deliver the next batch of ticks.
 *   2. Stream ends with an `idle` tick → no reconnect (queue drained naturally).
 *   3. Caller cancels via the returned canceller → no reconnect, even if no
 *      idle tick was seen (user-initiated stop).
 *
 * Mocks `fetch` to return a streaming Response whose ReadableStream emits a
 * controlled sequence of SSE frames, then closes. The reconnect strategy
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
});
