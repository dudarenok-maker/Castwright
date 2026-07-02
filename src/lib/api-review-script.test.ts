import { describe, it, expect, vi, beforeEach } from 'vitest';

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) { for (const e of events) c.enqueue(encoder.encode(`data: ${e}\n\n`)); c.close(); },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('realReviewScript — chapter-failed is surfaced', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('calls onChapterFailed and still resolves on a chapter-failed-only stream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ kind: 'phase', phaseId: 0, progress: 0, label: 'Reviewing — chapter 2', chapterId: 2 }),
      JSON.stringify({ kind: 'chapter-failed', chapterId: 2, message: 'Chapter 2 is too large — split it first.' }),
      JSON.stringify({ kind: 'result', done: true, reviewedChapters: 0, totalOps: 0 }),
    ])));
    const { api } = await import('./api');
    const failed: Array<{ chapterId: number; message: string }> = [];
    const res = await api.reviewScript('bk', { chapterId: 2, onChapterFailed: (e) => failed.push(e) });
    expect(failed).toEqual([{ chapterId: 2, message: 'Chapter 2 is too large — split it first.' }]);
    expect(res.totalOps).toBe(0);
  });
});

describe('realReviewScript — chapter/ETA fields', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('parses chapterIndex/totalChapters/estRemainingMs from a phase event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({
        kind: 'phase',
        progress: 0.33,
        label: 'Reviewing script',
        chapterId: 2,
        chapterIndex: 2,
        totalChapters: 3,
        estRemainingMs: 20_000,
      }),
      JSON.stringify({ kind: 'result', done: true, reviewedChapters: 1, totalOps: 0 }),
    ])));
    const { api } = await import('./api');
    const phases: Array<{ chapterIndex?: number; totalChapters?: number; estRemainingMs?: number }> = [];
    await api.reviewScript('bk', { onPhase: (e) => phases.push(e) });
    expect(phases[0]).toMatchObject({ chapterIndex: 2, totalChapters: 3, estRemainingMs: 20_000 });
  });
});
