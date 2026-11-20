/* #3436 — generation, chapter splice and audio-QA repair are refused with a 409 `book_busy`
   while an analysis job is live for the book. The client surfaces the SERVER'S SENTENCE as the
   failure reason, not the raw JSON body. A non-busy failure keeps its status-prefixed shape. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SENTENCE =
  'This book is busy (analysing). Rendering audio is refused while it is analysing, so this was not started. Wait for the analysis to finish, then try again.';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const busyRes = () =>
  new Response(JSON.stringify({ error: SENTENCE, code: 'book_busy' }), {
    status: 409,
    headers: { 'Content-Type': 'application/json' },
  });
const serverError = () => new Response('boom', { status: 500, statusText: 'Internal Server Error' });

type Tick = { type: string; errorReason?: string | null; errorCode?: string };

describe('book_busy from a render start', () => {
  it('generation: chapter_failed carries the server sentence, then idle', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(busyRes());
    const ticks: Tick[] = [];
    const cancel = api.streamGeneration({
      bookId: 'book-A',
      modelKey: 'kokoro-v1',
      chapterIds: [1],
      force: false,
      onTick: (t: Tick) => ticks.push(t),
    });
    await vi.waitFor(() => expect(ticks.map((t) => t.type)).toEqual(['chapter_failed', 'idle']));
    cancel();
    expect(ticks[0].errorReason).toBe(SENTENCE);
    /* the queue dispatcher keys on this to keep the entry queued instead of failing it (#3436) */
    expect(ticks[0].errorCode).toBe('book-busy');
  });

  it('generation: a non-busy start failure carries no book-busy code', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(serverError());
    const ticks: Tick[] = [];
    const cancel = api.streamGeneration({
      bookId: 'book-A',
      modelKey: 'kokoro-v1',
      chapterIds: [1],
      force: false,
      onTick: (t: Tick) => ticks.push(t),
    });
    await vi.waitFor(() => expect(ticks.map((t) => t.type)).toEqual(['chapter_failed', 'idle']));
    cancel();
    expect(ticks[0].errorCode).toBeUndefined();
  });

  it('splice: chapter_failed carries the server sentence', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(busyRes());
    const ticks: Tick[] = [];
    await api.streamSplice({
      bookId: 'book-A',
      chapterId: 1,
      mode: 'remix',
      characterId: 'amy',
      gainDb: 3,
      onTick: (t: Tick) => ticks.push(t),
    });
    expect(ticks).toEqual([{ type: 'chapter_failed', chapterId: 1, errorReason: SENTENCE }]);
  });

  it('qa-repair: chapter_failed carries the server sentence', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(busyRes());
    const ticks: Tick[] = [];
    await api.streamQaRepair({ bookId: 'book-A', chapterId: 1, onTick: (t: Tick) => ticks.push(t) });
    expect(ticks).toEqual([{ type: 'chapter_failed', chapterId: 1, errorReason: SENTENCE }]);
  });

  it('control: a non-busy failure keeps the status-prefixed reason', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(serverError());
    const ticks: Tick[] = [];
    await api.streamSplice({
      bookId: 'book-A',
      chapterId: 1,
      mode: 'remix',
      characterId: 'amy',
      gainDb: 3,
      onTick: (t: Tick) => ticks.push(t),
    });
    expect(ticks[0].errorReason).toBe('Splice failed (500): boom');
  });
});
