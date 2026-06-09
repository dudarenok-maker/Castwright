/* Task 3 — cast-design API: scope/variantTasks payload + variant_designed event.
   Tests `realStartCastDesign` (POST body) and `readCastDesignStream` (event
   parsing) via the exported internals, following the same fetch-stub pattern
   as api-detect-emotions.test.ts and api-stream-reconnect.test.ts. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function idleResponse(): Response {
  const encoder = new TextEncoder();
  const frame = JSON.stringify({ type: 'idle', done: 0, total: 0, skipped: 0, failures: [] });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: stream,
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: stream,
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

describe('realStartCastDesign', () => {
  it('forwards scope + variantTasks in the POST body', async () => {
    fetchMock.mockResolvedValueOnce(idleResponse());
    const { realStartCastDesign } = await import('./api');
    await realStartCastDesign(
      'book-1',
      {
        characterIds: ['a'],
        modelKey: 'qwen3-tts-0.6b',
        scope: 'both',
        variantTasks: [{ characterId: 'a', emotions: ['angry'] }],
      },
      {},
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      characterIds: ['a'],
      modelKey: 'qwen3-tts-0.6b',
      scope: 'both',
      variantTasks: [{ characterId: 'a', emotions: ['angry'] }],
    });
  });
});

describe('readCastDesignStream', () => {
  it('maps variant_designed to onVariantDesigned', async () => {
    const got: unknown[] = [];
    const res = sseResponse([
      JSON.stringify({
        type: 'variant_designed',
        characterId: 'a',
        emotion: 'angry',
        voiceId: 'qwen-a__angry',
      }),
      JSON.stringify({ type: 'idle', done: 1, total: 1, skipped: 0, failures: [] }),
    ]);
    const { readCastDesignStream } = await import('./api');
    await readCastDesignStream(res, { onVariantDesigned: (e) => got.push(e) });
    expect(got).toEqual([{ characterId: 'a', emotion: 'angry', voiceId: 'qwen-a__angry' }]);
  });
});
