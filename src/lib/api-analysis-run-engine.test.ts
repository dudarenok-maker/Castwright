/* #3084 wave 3d review pass 4 (J) — the run engine/card the server stamps on its phase events once a
 * fallback switch has happened (`analysisEngine` / `analysisGpu`) reaches `onPhase` over the real SSE
 * wire, on both readers (full-book and the subset/Retry route). Reuses the fetch + ReadableStream SSE
 * harness of api-cast-merge-base-warning.test.ts. */

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

const SWITCHED_PHASE = JSON.stringify({ kind: 'phase', phaseId: 0, progress: 0.3, model: 'llama3', engine: 'local', analysisEngine: 'local', analysisGpu: 'cuda:0' });
const PLAIN_PHASE = JSON.stringify({ kind: 'phase', phaseId: 0, progress: 0.1 });
const RESULT_FRAME = JSON.stringify({ kind: 'result', response: {} });

describe('analysisEngine / analysisGpu reach onPhase over the real SSE wire', () => {
  it('realAnalyseManuscript (full-book route)', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(sseResponse([PLAIN_PHASE, SWITCHED_PHASE, RESULT_FRAME]));
    const phases: Array<Record<string, unknown>> = [];
    await api.analyseManuscript('mns-1', { onPhase: (p) => phases.push(p) });
    expect(phases[0]).toMatchObject({ phaseId: 0, analysisEngine: undefined, analysisGpu: undefined });
    expect(phases[1]).toMatchObject({ phaseId: 0, analysisEngine: 'local', analysisGpu: 'cuda:0' });
  });

  it('realRunAnalysisForChapters (subset route)', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(sseResponse([PLAIN_PHASE, SWITCHED_PHASE, RESULT_FRAME]));
    const phases: Array<Record<string, unknown>> = [];
    await api.runAnalysisForChapters('mns-1', [1], { onPhase: (p) => phases.push(p) });
    expect(phases[0]).toMatchObject({ analysisEngine: undefined, analysisGpu: undefined });
    expect(phases[1]).toMatchObject({ analysisEngine: 'local', analysisGpu: 'cuda:0' });
  });

  it('realRunAnalysisForChapters sends the start origin in the POST body (#3774)', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(sseResponse([RESULT_FRAME])).mockResolvedValueOnce(sseResponse([RESULT_FRAME]));
    await api.runAnalysisForChapters('mns-1', [1], { origin: 'include' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({ chapterIds: [1], origin: 'include' });
    await api.runAnalysisForChapters('mns-1', [1]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).origin).toBeUndefined();
  });

  it('an unrecognised engine value is dropped, not trusted', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(
      sseResponse([JSON.stringify({ kind: 'phase', phaseId: 0, progress: 0.2, analysisEngine: 'carrier-pigeon' }), RESULT_FRAME]),
    );
    const phases: Array<Record<string, unknown>> = [];
    await api.analyseManuscript('mns-1', { onPhase: (p) => phases.push(p) });
    expect(phases[0].analysisEngine).toBeUndefined();
  });
});
