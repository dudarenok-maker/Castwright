/* fs-33 / fs-34 — api.detectEmotions SSE parsing + api.removeQwenVariant DELETE.
   Mocks fetch with a streaming Response (same harness as
   api-stream-reconnect.test.ts). */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function sseResponse(frames: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
      controller.close();
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    body: stream,
    text: () => Promise.resolve(''),
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

describe('api.detectEmotions', () => {
  it('parses phase + annotation events and returns the terminal result', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        JSON.stringify({ kind: 'phase', phaseId: 0, progress: 0.5, label: 'ch1', chapterId: 1 }),
        JSON.stringify({
          kind: 'annotation',
          chapterId: 1,
          annotations: [{ sentenceId: 2, emotion: 'angry' }],
        }),
        JSON.stringify({ kind: 'result', done: true, annotatedChapters: 1, totalAnnotations: 1 }),
      ]),
    );

    const phases: number[] = [];
    const annotations: Array<{ chapterId: number; n: number }> = [];
    const result = await api.detectEmotions('book-1', {
      onPhase: (e) => phases.push(e.progress),
      onAnnotation: (e) => annotations.push({ chapterId: e.chapterId, n: e.annotations.length }),
    });

    expect(phases).toContain(0.5);
    expect(annotations).toEqual([{ chapterId: 1, n: 1 }]);
    expect(result).toEqual({ annotatedChapters: 1, totalAnnotations: 1 });
  });

  it('throws a coded DetectEmotionsError on a no_attribution error event', async () => {
    const { api, DetectEmotionsError } = await import('./api');
    fetchMock.mockResolvedValueOnce(
      sseResponse([JSON.stringify({ kind: 'error', code: 'no_attribution', message: 'run analysis' })]),
    );
    await expect(api.detectEmotions('book-1')).rejects.toMatchObject({
      name: 'DetectEmotionsError',
      code: 'no_attribution',
    });
    expect(DetectEmotionsError).toBeTruthy();
  });

  it('maps a 404 to a not_found DetectEmotionsError', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(sseResponse([], 404));
    await expect(api.detectEmotions('nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('api.removeQwenVariant', () => {
  it('issues a DELETE to the emotion-variant route', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    await api.removeQwenVariant('book-1', 'maerin', 'angry');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/books/book-1/cast/maerin/emotion-variant/angry');
    expect(init.method).toBe('DELETE');
  });

  it('throws with the server error detail on failure', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'bad emotion' }),
    });
    await expect(api.removeQwenVariant('book-1', 'maerin', 'furious')).rejects.toThrow(/bad emotion/);
  });
});
