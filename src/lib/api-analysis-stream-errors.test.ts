/* #3198 — the two analysis SSE readers (`realAnalyseManuscript`,
 * `realRunAnalysisForChapters`) must reject with an `AnalysisError` carrying
 * a CONNECTION-level code (src/lib/analysis-stream-codes.ts) rather than a
 * plain `Error`, because the stream middleware classifies on that code:
 * `stream_no_result` is a quiet close, `stream_failed` is terminal. Pass 5
 * measured that reverting api.ts wholesale left 5008/5008 green — every
 * middleware test builds its own error, so nothing checked what api.ts
 * actually throws. These drive the real readers over a stubbed `fetch` (the
 * harness api-cast-merge-base-warning.test.ts already uses).
 *
 * Mutation per case: revert the named throw site to `throw new Error(...)`
 * → `toBeInstanceOf(AnalysisError)` reddens. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ANALYSIS_STREAM_FAILED, ANALYSIS_STREAM_NO_RESULT } from './analysis-stream-codes';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A 200 whose body emits the given SSE frames then closes cleanly. */
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
    text: () => Promise.resolve(''),
  } as unknown as Response;
}

function failedResponse(status: number): Response {
  return {
    ok: false,
    status,
    statusText: 'Internal Server Error',
    body: null,
    text: () => Promise.resolve(''),
  } as unknown as Response;
}

const PHASE_FRAME = JSON.stringify({ kind: 'phase', phaseId: 0, progress: 0.5 });

describe('realAnalyseManuscript — connection-level failure codes', () => {
  it('a clean 200 that ends without a result frame rejects with AnalysisError code stream_no_result', async () => {
    const { api, AnalysisError } = await import('./api');
    fetchMock.mockResolvedValueOnce(sseResponse([PHASE_FRAME]));
    const err = await api.analyseManuscript('mns-1', {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AnalysisError);
    expect((err as InstanceType<typeof AnalysisError>).code).toBe(ANALYSIS_STREAM_NO_RESULT);
    expect((err as Error).message).toBe('Analysis stream ended without a result event.');
  });

  it('a non-2xx response rejects with AnalysisError code stream_failed naming the status', async () => {
    const { api, AnalysisError } = await import('./api');
    fetchMock.mockResolvedValueOnce(failedResponse(500));
    const err = await api.analyseManuscript('mns-1', {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AnalysisError);
    expect((err as InstanceType<typeof AnalysisError>).code).toBe(ANALYSIS_STREAM_FAILED);
    expect((err as Error).message).toBe('Analysis stream failed (500).');
  });
});

describe('realRunAnalysisForChapters — the same two codes on the subset route', () => {
  /* The middleware subscribes through this reader for `kind: 'subset'`
     snapshots, and the subset route ends WITHOUT a result frame by design
     when other chapters still need retry — so this reader, of the two, is
     the one that actually produces `stream_no_result` in normal use. Pass 5
     🟡 22: it still threw plain `Error` at both sites. */
  it('a clean 200 that ends without a result frame rejects with AnalysisError code stream_no_result', async () => {
    const { api, AnalysisError } = await import('./api');
    fetchMock.mockResolvedValueOnce(sseResponse([PHASE_FRAME]));
    const err = await api.runAnalysisForChapters('mns-1', [4], {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AnalysisError);
    expect((err as InstanceType<typeof AnalysisError>).code).toBe(ANALYSIS_STREAM_NO_RESULT);
    expect((err as Error).message).toBe('Subset analysis stream ended without a result event.');
  });

  it('a non-2xx response rejects with AnalysisError code stream_failed naming the status', async () => {
    const { api, AnalysisError } = await import('./api');
    fetchMock.mockResolvedValueOnce(failedResponse(503));
    const err = await api.runAnalysisForChapters('mns-1', [4], {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AnalysisError);
    expect((err as InstanceType<typeof AnalysisError>).code).toBe(ANALYSIS_STREAM_FAILED);
    expect((err as Error).message).toBe('Subset analysis failed (503).');
  });
});
