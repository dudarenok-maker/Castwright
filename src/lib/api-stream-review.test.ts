/* Plan 285 — realStreamGeneration threads `review` into the generation POST
   body (nothing sets it in PR 1). Mirrors api-stream-fallback-confirmed.test.ts. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
      controller.close();
    },
  });
  return { ok: true, status: 200, statusText: 'OK', body: stream, text: () => Promise.resolve('') } as unknown as Response;
}

describe('realStreamGeneration review', () => {
  it('sends review in the POST body when set', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(sseResponse([JSON.stringify({ type: 'idle' })]));
    const review = { characterId: 'amy', triggeredBy: 'Amy voice change' };
    const cancel = api.streamGeneration({
      bookId: 'book-A',
      modelKey: 'kokoro-v1',
      chapterIds: [1],
      force: true,
      review,
      onTick: () => {},
    });
    await new Promise((r) => setTimeout(r, 25));
    cancel();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).review).toEqual(review);
  });

  it('omits review when not set', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(sseResponse([JSON.stringify({ type: 'idle' })]));
    const cancel = api.streamGeneration({ bookId: 'book-A', modelKey: 'kokoro-v1', chapterIds: [1], force: true, onTick: () => {} });
    await new Promise((r) => setTimeout(r, 25));
    cancel();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('review');
  });
});
