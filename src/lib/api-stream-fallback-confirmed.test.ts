/* #3208 (plan 3026 step 1, fixes #3029) — realStreamGeneration must thread
 * fallbackConfirmed into the generation POST body, including on reconnect.
 * The client-side dispatcher/runner already pass the flag down; this pins
 * that it actually reaches the real HTTP request body, not just a mock's
 * call arguments. */

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

describe('realStreamGeneration fallbackConfirmed', () => {
  it('sends fallbackConfirmed in the POST body when set', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(sseResponse([JSON.stringify({ type: 'idle' })]));
    const cancel = api.streamGeneration({
      bookId: 'book-A',
      modelKey: 'kokoro-v1',
      chapterIds: [1],
      force: true,
      queueEntryId: 'e1',
      fallbackConfirmed: true,
      onTick: () => {},
    });
    await new Promise((r) => setTimeout(r, 25));
    cancel();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).fallbackConfirmed).toBe(true);
  });

  it('omits fallbackConfirmed from the POST body when not set', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(sseResponse([JSON.stringify({ type: 'idle' })]));
    const cancel = api.streamGeneration({
      bookId: 'book-A',
      modelKey: 'kokoro-v1',
      chapterIds: [1],
      force: true,
      queueEntryId: 'e1',
      onTick: () => {},
    });
    await new Promise((r) => setTimeout(r, 25));
    cancel();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('fallbackConfirmed');
  });

  it('carries fallbackConfirmed through a reconnect POST', async () => {
    const { api } = await import('./api');
    fetchMock
      .mockResolvedValueOnce(sseResponse([JSON.stringify({ type: 'progress', progress: 0.3 })]))
      .mockResolvedValueOnce(sseResponse([JSON.stringify({ type: 'idle' })]));
    const cancel = api.streamGeneration({
      bookId: 'book-A',
      modelKey: 'kokoro-v1',
      chapterIds: [1],
      force: true,
      queueEntryId: 'e1',
      fallbackConfirmed: true,
      onTick: () => {},
    });
    /* Wait long enough for backoff (500ms) + second fetch + tick parsing. */
    await new Promise((r) => setTimeout(r, 800));
    cancel();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fallbackConfirmed).toBe(true);
  });
});
