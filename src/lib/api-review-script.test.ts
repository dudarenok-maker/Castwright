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

describe('realCancelScriptReview', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('POSTs to the cancel endpoint and returns the parsed result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, cancelled: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { api } = await import('./api');
    const result = await api.cancelScriptReview('bk');
    expect(result).toEqual({ ok: true, cancelled: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/books/bk/script-review/cancel', { method: 'POST' });
  });
});

describe('realAttachScriptReview', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('resolves to null on a 404 instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const { api } = await import('./api');
    const result = await api.attachScriptReview('bk', { chapterId: 1 });
    expect(result).toBeNull();
  });

  it('replays buffered ops events on a successful join', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ kind: 'ops', chapterId: 1, ops: [{ id: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' }] }),
      JSON.stringify({ kind: 'result', done: true, reviewedChapters: 1, totalOps: 1 }),
    ])));
    const { api } = await import('./api');
    const ops: Array<{ chapterId: number; ops: unknown[] }> = [];
    const result = await api.attachScriptReview('bk', { chapterId: 1, onOps: (e) => ops.push(e) });
    expect(ops).toEqual([{ chapterId: 1, ops: [{ id: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' }] }]);
    expect(result).toEqual({ reviewedChapters: 1, totalOps: 1 });
  });

  it('throws a cancelled-coded ReviewScriptError when the joined stream ends in a cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ kind: 'error', code: 'cancelled', message: 'Review cancelled.' }),
    ])));
    const { api, ReviewScriptError } = await import('./api');
    let caught: unknown;
    try {
      await api.attachScriptReview('bk', { chapterId: 1 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReviewScriptError);
    expect((caught as InstanceType<typeof ReviewScriptError>).code).toBe('cancelled');
  });
});
