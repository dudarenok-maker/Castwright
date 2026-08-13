/* #2185 review, item 3 — the `payload.kind === 'warning'` branch in both
 * `realAnalyseManuscript` and `realRunAnalysisForChapters` was pinned by
 * NOTHING: deleting either branch left the whole suite green. Reuses the
 * `fetch` + `ReadableStream` SSE harness from api-stream-reconnect.test.ts
 * to drive a real `cast_merge_base_stale` warning frame through both
 * readers and assert `onWarning` actually fires with the right payload.
 *
 * Both readers get their own test, not just one: two of the five server-side
 * emitting sites (analysis.ts) are on the SUBSET route
 * (`realRunAnalysisForChapters`), so the full-book reader alone would leave
 * that half of the design's own emitting surface untested. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Build a Response whose body emits the given SSE frames then closes —
    mirrors api-stream-reconnect.test.ts's sseResponse helper. */
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

const WARNING_FRAME = JSON.stringify({
  kind: 'warning',
  code: 'cast_merge_base_stale',
  message:
    'Another change to this book’s cast landed while the analysis was running. ' +
    'The analysis result was applied on top of the older cast, so that change may have been overwritten.',
});
const RESULT_FRAME = JSON.stringify({ kind: 'result', response: {} });

describe('cast_merge_base_stale reaches onWarning over the real SSE wire', () => {
  it('realAnalyseManuscript (full-book route) fires onWarning with the code + message', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(sseResponse([WARNING_FRAME, RESULT_FRAME]));

    const warnings: { code: string; message: string }[] = [];
    await api.analyseManuscript('mns-1', { onWarning: (w) => warnings.push(w) });

    expect(warnings).toEqual([
      {
        code: 'cast_merge_base_stale',
        message:
          'Another change to this book’s cast landed while the analysis was running. ' +
          'The analysis result was applied on top of the older cast, so that change may have been overwritten.',
      },
    ]);
  });

  it('realRunAnalysisForChapters (subset route) fires onWarning with the code + message', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(sseResponse([WARNING_FRAME, RESULT_FRAME]));

    const warnings: { code: string; message: string }[] = [];
    await api.runAnalysisForChapters('mns-1', [1, 2], { onWarning: (w) => warnings.push(w) });

    expect(warnings).toEqual([
      {
        code: 'cast_merge_base_stale',
        message:
          'Another change to this book’s cast landed while the analysis was running. ' +
          'The analysis result was applied on top of the older cast, so that change may have been overwritten.',
      },
    ]);
  });
});
