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

describe('chapter-failed frames — phase reaches onChapterFailed (plan 285 T1)', () => {
  /* Both readers copy the frame's fields into the callback argument one by
     one, so a new field is dropped unless each parser names it. */
  const FAILED_FRAME = JSON.stringify({
    kind: 'chapter-failed',
    chapterId: 4,
    message: 'cast failed',
    code: 'analyzer-timeout',
    remediation: 'retry',
    phase: 'cast',
  });
  const RESULT_FRAME = JSON.stringify({
    kind: 'result',
    response: { characters: [], chapters: [], sentences: [] },
  });

  it('main stream parser passes phase to onChapterFailed', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(sseResponse([FAILED_FRAME, RESULT_FRAME]));
    const seen: Array<{ chapterId: number; phase?: string }> = [];
    await api.analyseManuscript('mns-1', { onChapterFailed: (e) => seen.push(e) }).catch(() => undefined);
    expect(seen).toHaveLength(1);
    expect(seen[0].phase).toBe('cast');
  });

  it('subset stream parser passes phase to onChapterFailed', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(sseResponse([FAILED_FRAME, RESULT_FRAME]));
    const seen: Array<{ chapterId: number; phase?: string }> = [];
    await api
      .runAnalysisForChapters('mns-1', [4], { onChapterFailed: (e) => seen.push(e) })
      .catch(() => undefined);
    expect(seen).toHaveLength(1);
    expect(seen[0].phase).toBe('cast');
  });
});

describe('#3435 refusal codes map to AnalysisError(message, code)', () => {
  function refusedResponse(body: Record<string, unknown>): Response {
    return {
      ok: false,
      status: 409,
      statusText: 'Conflict',
      body: null,
      text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response;
  }
  const MAIN_RUNNING = {
    error: 'main_analysis_running',
    draining: false,
    message: 'The analysis is still running on this book. Pause it first, then try again.',
  };
  const SUBSET_RUNNING = {
    error: 'subset_analysis_running',
    message: 'A chapter retry is running on this book. Wait for it to finish, then resume the analysis.',
  };
  const MAIN_DRAINING = {
    error: 'main_analysis_running',
    draining: true,
    message: 'The analysis on this book is still stopping. Try again in a moment.',
  };

  it('realRunAnalysisForChapters maps a 409 main_analysis_running body to AnalysisError(message, code)', async () => {
    const { api, AnalysisError } = await import('./api');
    fetchMock.mockResolvedValueOnce(refusedResponse(MAIN_RUNNING));
    const err = await api.runAnalysisForChapters('mns-1', [4], {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AnalysisError);
    expect((err as InstanceType<typeof AnalysisError>).code).toBe('main_analysis_running');
    expect((err as Error).message).toBe(MAIN_RUNNING.message);
  });

  it('realAnalyseManuscript maps 409 subset_analysis_running and main_analysis_running', async () => {
    const { api, AnalysisError } = await import('./api');
    for (const body of [SUBSET_RUNNING, MAIN_DRAINING]) {
      fetchMock.mockResolvedValueOnce(refusedResponse(body));
      const err = await api.analyseManuscript('mns-1', {}).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AnalysisError);
      expect((err as InstanceType<typeof AnalysisError>).code).toBe(body.error);
      expect((err as Error).message).toBe(body.message);
    }
  });

  it('the same codes as SSE error frames map to the same AnalysisError', async () => {
    const { api, AnalysisError } = await import('./api');
    const frame = (b: Record<string, unknown>) =>
      JSON.stringify({ kind: 'error', code: b.error, message: b.message, draining: b.draining });
    fetchMock.mockResolvedValueOnce(sseResponse([frame(MAIN_RUNNING)]));
    const subsetErr = await api.runAnalysisForChapters('mns-1', [4], {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(subsetErr).toBeInstanceOf(AnalysisError);
    expect((subsetErr as InstanceType<typeof AnalysisError>).code).toBe('main_analysis_running');
    expect((subsetErr as Error).message).toBe(MAIN_RUNNING.message);
    for (const body of [SUBSET_RUNNING, MAIN_DRAINING]) {
      fetchMock.mockResolvedValueOnce(sseResponse([frame(body)]));
      const err = await api.analyseManuscript('mns-1', {}).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AnalysisError);
      expect((err as InstanceType<typeof AnalysisError>).code).toBe(body.error);
      expect((err as Error).message).toBe(body.message);
    }
  });
});
