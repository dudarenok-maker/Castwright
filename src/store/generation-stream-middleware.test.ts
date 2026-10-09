// Pairs with docs/features/archive/111-queue-worker-pool.md (wave 3).
//
// The plan-111 middleware is no longer a stream-opener — the queue dispatcher
// is the sole opener and the runner self-drives ticks. This middleware now
// owns: EXPLICIT-START ENQUEUE (on the `ui/requestStartGeneration` intent ONLY,
// enqueue the viewed book's pending chapters so the dispatcher drains them —
// plan 137 made this explicit so opening/re-opening a book never auto-starts),
// the HALT path, and the plan-114 PROFILE-REGEN PREVIEW GATE (open the A/B
// player when the previewed chapter completes). These tests cover exactly those.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { chaptersSlice, previewChapterComplete } from './chapters-slice';
import { manuscriptSlice } from './manuscript-slice';
import { uiSlice } from './ui-slice';
import { changeLogSlice } from './change-log-slice';
import { castSlice } from './cast-slice';
import { revisionsSlice } from './revisions-slice';
import { notificationsSlice } from './notifications-slice';
import { librarySlice } from './library-slice';
import { analysisSlice, analysisActions } from './analysis-slice';
import { queueSlice } from './queue-slice';
import { accountSlice } from './account-slice';
import { generationStreamMiddleware } from './generation-stream-middleware';
import { revisionPlayerMiddleware } from './revision-player-middleware';
import { createStreamRunner, type StreamRunner } from './generation-stream-runner';
import type { Chapter } from '../lib/types';

const streamGenerationMock = vi.fn();
const cancelMock = vi.fn();
const pauseGenerationMock = vi.fn();
const { pollRevisionsMock, getChapterAudioPreviousMock } = vi.hoisted(() => ({
  pollRevisionsMock: vi.fn(),
  getChapterAudioPreviousMock: vi.fn(),
}));
let fetchMock: ReturnType<typeof vi.fn>;

vi.mock('../lib/api', () => ({
  api: {
    streamGeneration: (args: unknown) => {
      streamGenerationMock(args);
      return cancelMock;
    },
    pauseGeneration: (args: unknown) => {
      pauseGenerationMock(args);
      return Promise.resolve();
    },
    pollRevisions: (args: unknown) => pollRevisionsMock(args),
    getChapterAudioPrevious: (args: unknown) => getChapterAudioPreviousMock(args),
  },
}));

/* enqueueQueueEntries POSTs /api/queue/enqueue via global fetch. Capture the
   body so tests can assert what got auto-enqueued; echo it back as the
   snapshot so the queue slice updates. */
function jsonResp(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

beforeEach(() => {
  streamGenerationMock.mockClear();
  cancelMock.mockClear();
  pauseGenerationMock.mockClear();
  fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
    const entries = init?.body ? (JSON.parse(init.body).entries ?? []) : [];
    return jsonResp({ entries, paused: false });
  });
  vi.stubGlobal('fetch', fetchMock);
});

function makeStore(opts: { watcher?: boolean } = {}) {
  let runner: StreamRunner | null = null;
  const getRunner = (): StreamRunner => runner!;
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      chapters: chaptersSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      changeLog: changeLogSlice.reducer,
      cast: castSlice.reducer,
      revisions: revisionsSlice.reducer,
      notifications: notificationsSlice.reducer,
      library: librarySlice.reducer,
      analysis: analysisSlice.reducer,
      queue: queueSlice.reducer,
      account: accountSlice.reducer,
    },
    middleware: (gd) =>
      gd().concat(...(opts.watcher ? [revisionPlayerMiddleware] : []), generationStreamMiddleware(getRunner)),
  });
  runner = createStreamRunner(store);
  return { store, getRunner };
}

const ch = (id: number, overrides: Partial<Chapter> = {}): Chapter =>
  ({
    id,
    title: `Chapter ${id}`,
    duration: '00:00',
    state: 'queued',
    progress: 0,
    characters: { narrator: 'queued' },
    ...overrides,
  }) as Chapter;

/* Mirror Layout's per-book hydration: claim the book, then set its rows.
   `queue.loaded` must be true so the enqueue-on-work gate (and a future
   dispatcher) treat the queue as authoritative. */
function seedBook(store: ReturnType<typeof makeStore>['store'], bookId: string, chapters: Chapter[]) {
  store.dispatch(queueSlice.actions.setSnapshot({ entries: [], paused: false }));
  store.dispatch(chaptersSlice.actions.setCurrentBookId(bookId));
  store.dispatch(chaptersSlice.actions.setChapters(chapters));
}

function enqueueCalls() {
  return fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/queue/enqueue'));
}

describe('generationStreamMiddleware — enqueue-on-work (explicit-start intent)', () => {
  it('enqueues the viewed book’s non-excluded queued/in_progress chapters on requestStartGeneration', async () => {
    const { store } = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [
      ch(1, { state: 'done', progress: 1 }),
      ch(2, { state: 'in_progress', progress: 0.3 }),
      ch(3, { state: 'queued' }),
      ch(4, { state: 'queued', excluded: true }),
    ]);
    store.dispatch(uiSlice.actions.requestStartGeneration());
    await Promise.resolve();
    const calls = enqueueCalls();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const body = JSON.parse(calls[calls.length - 1][1].body);
    /* Only the non-excluded, not-done rows (2 + 3), scope 'this', deterministic ids. */
    expect(body.entries.map((e: { chapterId: number }) => e.chapterId).sort()).toEqual([2, 3]);
    expect(body.entries.every((e: { scope: string }) => e.scope === 'this')).toBe(true);
    expect(body.entries.map((e: { id: string }) => e.id)).toContain('autowork-b1-2');
    /* Never opens a stream directly — the dispatcher does that. */
    expect(streamGenerationMock).not.toHaveBeenCalled();
  });

  it('skips "Not queued" (held) chapters on requestStartGeneration (Bug 1: Resume must not re-add them)', async () => {
    /* The user deleted ch3 from the queue → it's held. A later Resume /
       auto-work trigger must leave it out, or the delete is futile. */
    const { store } = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [
      ch(2, { state: 'queued' }),
      ch(3, { state: 'queued', held: true }),
    ]);
    store.dispatch(uiSlice.actions.requestStartGeneration());
    await Promise.resolve();
    const calls = enqueueCalls();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const body = JSON.parse(calls[calls.length - 1][1].body);
    expect(body.entries.map((e: { chapterId: number }) => e.chapterId)).toEqual([2]);
  });

  it('does NOT enqueue when the queue is globally paused (guard holds even on explicit start)', async () => {
    const { store } = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(queueSlice.actions.setSnapshot({ entries: [], paused: true }));
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    store.dispatch(chaptersSlice.actions.setChapters([ch(1, { state: 'queued' })]));
    store.dispatch(uiSlice.actions.requestStartGeneration());
    await Promise.resolve();
    expect(enqueueCalls()).toHaveLength(0);
  });

  it('does NOT re-enqueue chapters already represented in the queue', async () => {
    const { store } = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(
      queueSlice.actions.setSnapshot({
        entries: [
          {
            id: 'existing-b1-1',
            bookId: 'b1',
            chapterId: 1,
            scope: 'this',
            status: 'queued',
            order: 0,
            addedAt: '2026-01-01T00:00:00Z',
          },
        ],
        paused: false,
      }),
    );
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    store.dispatch(chaptersSlice.actions.setChapters([ch(1, { state: 'queued' })]));
    store.dispatch(uiSlice.actions.requestStartGeneration());
    await Promise.resolve();
    /* Chapter 1 is already queued → nothing new enqueued. */
    const lastBody = enqueueCalls()
      .map((c) => JSON.parse(c[1].body))
      .pop();
    if (lastBody) expect(lastBody.entries).toHaveLength(0);
  });

  it('does NOT enqueue while a local analysis is alive on the same book (reverse-analyzer guard holds on explicit start)', async () => {
    const { store } = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(
      analysisActions.setActiveStream({
        bookId: 'b1',
        engine: 'local',
        state: 'running',
        model: 'qwen3.5:4b',
        phase: 'phase1',
        done: 1,
        total: 5,
        lastTickAt: Date.now(),
      } as never),
    );
    seedBook(store, 'b1', [ch(1, { state: 'queued' })]);
    store.dispatch(uiSlice.actions.requestStartGeneration());
    await Promise.resolve();
    expect(enqueueCalls()).toHaveLength(0);
  });

  it('DOES enqueue on explicit start when the analysis is remote (gemini — no GPU contention)', async () => {
    const { store } = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(
      analysisActions.setActiveStream({
        bookId: 'b1',
        engine: 'gemini',
        state: 'running',
        model: 'gemini-3.1-flash-lite',
        phase: 'phase1',
        done: 1,
        total: 5,
        lastTickAt: Date.now(),
      } as never),
    );
    seedBook(store, 'b1', [ch(1, { state: 'queued' })]);
    store.dispatch(uiSlice.actions.requestStartGeneration());
    await Promise.resolve();
    expect(enqueueCalls().length).toBeGreaterThanOrEqual(1);
  });

  it('fe-46 — stamps fallbackConfirmed on every fresh entry when the proceed-anyway payload is set', async () => {
    const { store } = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'queued' }), ch(2, { state: 'queued' })]);
    store.dispatch(uiSlice.actions.requestStartGeneration({ fallbackConfirmed: true }));
    await Promise.resolve();
    const calls = enqueueCalls();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const body = JSON.parse(calls[calls.length - 1][1].body);
    expect(body.entries).toHaveLength(2);
    expect(body.entries.every((e: { fallbackConfirmed?: boolean }) => e.fallbackConfirmed === true)).toBe(
      true,
    );
  });

  it('fe-46 — omits fallbackConfirmed when requestStartGeneration has no payload', async () => {
    const { store } = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'queued' })]);
    store.dispatch(uiSlice.actions.requestStartGeneration());
    await Promise.resolve();
    const calls = enqueueCalls();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const body = JSON.parse(calls[calls.length - 1][1].body);
    expect(body.entries[0].fallbackConfirmed).toBeUndefined();
  });

  it('fe-46 — an already-queued chapter is left unstamped even on a proceed-anyway trigger', async () => {
    const { store } = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(
      queueSlice.actions.setSnapshot({
        entries: [
          {
            id: 'existing-b1-1',
            bookId: 'b1',
            chapterId: 1,
            scope: 'this',
            status: 'queued',
            order: 0,
            addedAt: '2026-01-01T00:00:00Z',
          },
        ],
        paused: false,
      }),
    );
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    store.dispatch(
      chaptersSlice.actions.setChapters([ch(1, { state: 'queued' }), ch(2, { state: 'queued' })]),
    );
    store.dispatch(uiSlice.actions.requestStartGeneration({ fallbackConfirmed: true }));
    await Promise.resolve();
    const lastBody = enqueueCalls()
      .map((c) => JSON.parse(c[1].body))
      .pop();
    /* Only chapter 2 is fresh — chapter 1 is already queued and stays untouched. */
    expect(lastBody.entries).toHaveLength(1);
    expect(lastBody.entries[0].chapterId).toBe(2);
    expect(lastBody.entries[0].fallbackConfirmed).toBe(true);
  });
});

/* Explicit-start enqueue gate (plan 137 — "opening a book auto-starts generation"
   fix). A book only enters the queue on the explicit `requestStartGeneration`
   intent (the "Approve cast & start generating" click). Walking the real
   post-analysis stage flow (analysing → confirm → ready/manuscript →
   ready/generate) proves the queue stays empty until that explicit click — and
   that merely reaching the Generate view never enqueues. */
describe('generationStreamMiddleware — explicit-start enqueue gate', () => {
  /* Mirror the route's onComplete: land the analysis (chapters seeded while the
     stage is still 'analysing'), then flip the stage to 'confirm'. */
  function seedAnalysed(
    store: ReturnType<typeof makeStore>['store'],
    bookId: string,
    chapters: Chapter[],
  ) {
    store.dispatch(uiSlice.actions.startNewBook());
    store.dispatch(uiSlice.actions.manuscriptUploaded({ bookId, manuscriptId: null }));
    store.dispatch(queueSlice.actions.setSnapshot({ entries: [], paused: false }));
    store.dispatch(
      chaptersSlice.actions.hydrateFromAnalysis({ bookId, chapters, sentences: [] } as never),
    );
    store.dispatch(uiSlice.actions.analysisComplete({ bookId }));
  }

  it('does NOT enqueue when analysis completes (stage analysing → confirm)', async () => {
    const { store } = makeStore();
    seedAnalysed(store, 'b1', [ch(1, { state: 'queued' }), ch(2, { state: 'queued' })]);
    await Promise.resolve();
    expect(enqueueCalls()).toHaveLength(0);
  });

  it('does NOT enqueue on cast confirmation (stage ready/cast landing)', async () => {
    const { store } = makeStore();
    seedAnalysed(store, 'b1', [ch(1, { state: 'queued' })]);
    store.dispatch(uiSlice.actions.confirmCast());
    await Promise.resolve();
    expect(store.getState().ui.stage).toMatchObject({ kind: 'ready', view: 'cast' });
    expect(enqueueCalls()).toHaveLength(0);
  });

  it('does NOT enqueue merely by reaching the Generate view (changeView without explicit start)', async () => {
    const { store } = makeStore();
    seedAnalysed(store, 'b1', [ch(1, { state: 'queued' }), ch(2, { state: 'queued' })]);
    store.dispatch(uiSlice.actions.confirmCast());
    store.dispatch(uiSlice.actions.changeView('generate'));
    await Promise.resolve();
    expect(store.getState().ui.stage).toMatchObject({ kind: 'ready', view: 'generate' });
    expect(enqueueCalls()).toHaveLength(0);
  });

  it('DOES enqueue once the user explicitly starts generating (requestStartGeneration)', async () => {
    const { store } = makeStore();
    seedAnalysed(store, 'b1', [ch(1, { state: 'queued' }), ch(2, { state: 'queued' })]);
    store.dispatch(uiSlice.actions.confirmCast());
    store.dispatch(uiSlice.actions.changeView('generate'));
    store.dispatch(uiSlice.actions.requestStartGeneration());
    await Promise.resolve();
    const calls = enqueueCalls();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const body = JSON.parse(calls[calls.length - 1][1].body);
    expect(body.entries.map((e: { chapterId: number }) => e.chapterId).sort()).toEqual([1, 2]);
  });
});

/* Regression (plan 137): re-opening a book that was mid-generation must NEVER
   re-enqueue its chapters. The reopen path that used to silently restart
   generation is openBook(status:'generating') → Layout per-book hydration
   (hydrateFromBookState seeds every non-completed chapter as 'queued') → the
   stage settles on the Generate view. None of those passive steps may enqueue —
   only an explicit requestStartGeneration may. */
describe('generationStreamMiddleware — reopen never re-enqueues (plan 137)', () => {
  /* The real Layout hydration reducer: completed slugs → 'done', everything
     else → 'queued'. This is the exact shape that used to trip the old gate. */
  function hydrateReopen(store: ReturnType<typeof makeStore>['store'], bookId: string) {
    store.dispatch(queueSlice.actions.setSnapshot({ entries: [], paused: false }));
    store.dispatch(
      chaptersSlice.actions.hydrateFromBookState({
        bookId,
        chapters: [
          { id: 1, slug: 'ch-1', title: 'Chapter 1' },
          { id: 2, slug: 'ch-2', title: 'Chapter 2' },
          { id: 3, slug: 'ch-3', title: 'Chapter 3' },
        ],
        completedSlugs: ['ch-1'],
        characters: [{ id: 'narrator' }],
      } as never),
    );
  }

  it('does NOT enqueue when re-opening a generating book and hydrating from disk', async () => {
    const { store } = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    hydrateReopen(store, 'b1');
    await Promise.resolve();
    /* ch-2 + ch-3 were seeded 'queued' by hydration, but no explicit start fired. */
    expect(store.getState().chapters.chapters.filter((c) => c.state === 'queued')).toHaveLength(2);
    expect(store.getState().ui.stage).toMatchObject({ kind: 'ready', view: 'generate' });
    expect(enqueueCalls()).toHaveLength(0);
  });

  it('still does NOT enqueue after a subsequent Generate-tab click (changeView)', async () => {
    const { store } = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    hydrateReopen(store, 'b1');
    store.dispatch(uiSlice.actions.changeView('cast'));
    store.dispatch(uiSlice.actions.changeView('generate'));
    await Promise.resolve();
    expect(enqueueCalls()).toHaveLength(0);
  });
});

describe('generationStreamMiddleware — halt + preview gate', () => {
  it('requestStreamHalt pauses every open book on the server and tears all streams down', () => {
    const { store, getRunner } = makeStore();
    /* Directly open two cross-book streams via the runner (the dispatcher's
       job in production; here we just need open streams to halt). */
    getRunner().open('b1', 'kokoro-v1', { chapterIds: [1], force: true }, { chapterId: 1 });
    getRunner().open('b2', 'kokoro-v1', { chapterIds: [2], force: true }, { chapterId: 2 });
    expect(getRunner().openBookCount()).toBe(2);

    store.dispatch(chaptersSlice.actions.requestStreamHalt());

    expect(pauseGenerationMock).toHaveBeenCalledTimes(2);
    expect(cancelMock).toHaveBeenCalledTimes(2);
    expect(getRunner().openBookCount()).toBe(0);
  });

});

describe('plan 286 — previewChapterComplete', () => {
  const F = '000000000000001-a';
  const PREVIEW = { bookId: 'b1', characterId: 'marlow', previewChapterId: 3, remainingChapterIds: [4], reason: 'voice', note: '' };
  function seedPreview(store: ReturnType<typeof makeStore>['store']) {
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    store.dispatch(chaptersSlice.actions.setChapters([ch(3, { state: 'done', duration: '05:00' })]));
    store.dispatch(castSlice.actions.hydrateCharacters([{ id: 'marlow', name: 'Marlow' } as never]));
    store.dispatch(uiSlice.actions.setPreviewRegen(PREVIEW as never));
  }
  const recorded = (id = 'revision:3:1700') => ({ bookId: 'b1', fileId: F, rev: 1, pending: [{ id, chapterId: 3, characterId: 'marlow', segments: [], origin: 'server' }], dismissed: [], acceptedSelections: {}, timeline: {}, drift: [] });
  const empty = () => ({ bookId: 'b1', fileId: F, rev: 1, pending: [], dismissed: [], acceptedSelections: {}, timeline: {}, drift: [] });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const toasts = (store: ReturnType<typeof makeStore>['store']) => store.getState().notifications.toasts.map((t) => t.message);
  beforeEach(() => { pollRevisionsMock.mockReset(); getChapterAudioPreviousMock.mockReset(); });
  afterEach(() => vi.useRealTimers());

  it('active book + recorded entry → refetch, then open that server entry', async () => {
    const { store } = makeStore(); seedPreview(store);
    pollRevisionsMock.mockResolvedValueOnce(recorded());
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'recorded' }));
    await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'revision:3:1700', chapterId: 3 }));
    expect(getChapterAudioPreviousMock).not.toHaveBeenCalled();
  });
  it('a completion on the book while an arrival arm is pending opens it once (one refetch)', async () => {
    const { store } = makeStore(); seedPreview(store);
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' })); // arrival arms; the preview has not finished
    pollRevisionsMock.mockResolvedValue(recorded());
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'recorded' }));
    await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'revision:3:1700', chapterId: 3 }));
    await tick();
    expect(pollRevisionsMock).toHaveBeenCalledTimes(1);
  });
  it("'failed' (preserved, unrecorded) → no refetch; previous metadata decides the stub", async () => {
    const { store } = makeStore(); seedPreview(store);
    getChapterAudioPreviousMock.mockResolvedValueOnce({ url: 'blob:a', durationSec: 1, peaks: [], sampleRate: 1, segments: [] });
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'failed' }));
    await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
    expect(pollRevisionsMock).not.toHaveBeenCalled();
    expect(store.getState().ui.previewRegen?.stub).toMatchObject({ chapterId: 3, hasPreviousAudio: true, playable: true });
  });
  it("'none' (a first render) → no refetch, a stub with no kept take", async () => {
    const { store } = makeStore(); seedPreview(store);
    getChapterAudioPreviousMock.mockResolvedValueOnce(null);
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
    await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
    expect(pollRevisionsMock).not.toHaveBeenCalled();
    expect(store.getState().ui.previewRegen?.stub?.hasPreviousAudio).toBe(false);
    expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'none', stubFallback: true });
  });
  it("OD29 — 'recorded' on its own book, but the refetch finds no entry → dropped as resolved elsewhere, never a stub", async () => {
    const { store } = makeStore(); seedPreview(store);
    pollRevisionsMock.mockResolvedValueOnce(empty());
    getChapterAudioPreviousMock.mockResolvedValue(null); // a stub, if one were (wrongly) built, would open cleanly
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'recorded' }));
    await vi.waitFor(() => expect(store.getState().ui.previewRegen).toBeNull());
    expect(store.getState().ui.openRevision).toBeNull();
    expect(getChapterAudioPreviousMock).not.toHaveBeenCalled();
    expect(toasts(store)).toEqual(['This preview was resolved elsewhere']);
  });
  it('a failed refetch does not open a stub straight away; the retry succeeding opens the entry', async () => {
    vi.useFakeTimers();
    const { store } = makeStore(); seedPreview(store);
    pollRevisionsMock.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(recorded());
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'recorded' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().ui.openRevision).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'revision:3:1700', chapterId: 3 }));
  });
  it('a doubly-failed refetch still opens the stub', async () => {
    vi.useFakeTimers();
    const { store } = makeStore(); seedPreview(store);
    pollRevisionsMock.mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('y'));
    getChapterAudioPreviousMock.mockResolvedValueOnce(null);
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'recorded' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().ui.openRevision).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
    expect(store.getState().revisions.pending).toEqual([]);
  });
  it('a previous-metadata GET that throws → stub with hasPreviousAudio:false', async () => {
    const { store } = makeStore(); seedPreview(store);
    getChapterAudioPreviousMock.mockRejectedValueOnce(new Error('500'));
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'failed' }));
    await vi.waitFor(() => expect(store.getState().ui.previewRegen?.stub?.hasPreviousAudio).toBe(false));
  });
  it('a non-active book → "Preview ready in ‹title›" toast and nothing opens', async () => {
    const { store } = makeStore(); seedPreview(store);
    store.dispatch(librarySlice.actions.hydrate({ authors: [{ name: 'A', series: [{ name: 'S', books: [{ bookId: 'other', title: 'Other Book' }] }] }] } as never));
    store.dispatch(previewChapterComplete({ bookId: 'other', chapterId: 3, reviewOutcome: 'recorded' }));
    expect(toasts(store)).toEqual(['Preview ready in Other Book']);
    expect(store.getState().ui.openRevision).toBeNull();
    expect(pollRevisionsMock).not.toHaveBeenCalled();
  });
  it('OD27 — a non-active completion marks the matching preview finished', async () => {
    const { store } = makeStore(); seedPreview(store);
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
    expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'none', stubFallback: false });
    expect(store.getState().ui.openRevision).toBeNull();
  });
  it('OD28 — an active completion marks the preview finished too, so after a close the next arrival re-opens it', async () => {
    const { store } = makeStore(); seedPreview(store);
    getChapterAudioPreviousMock.mockResolvedValue(null);
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
    await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
    expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'none', stubFallback: true });
    store.dispatch(uiSlice.actions.setOpenRevision(null)); // the player's close
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' })); // arrival
    await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
    expect(getChapterAudioPreviousMock).toHaveBeenCalledTimes(2);
  });
  it("OD27 — arriving back at the preview book re-opens a first render ('none') as a stub — never dropped", async () => {
    const { store } = makeStore(); seedPreview(store); // chapters.currentBookId is already 'b1'
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
    getChapterAudioPreviousMock.mockResolvedValueOnce(null);
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' })); // arrival
    await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
    expect(store.getState().ui.previewRegen?.stub).toMatchObject({ chapterId: 3, hasPreviousAudio: false });
  });
  it('OD27 — arriving back opens the recorded server entry when there is one', async () => {
    const { store } = makeStore(); seedPreview(store);
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'recorded' }));
    expect(pollRevisionsMock).not.toHaveBeenCalled(); // not on completion elsewhere
    pollRevisionsMock.mockResolvedValueOnce(recorded());
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'revision:3:1700', chapterId: 3 }));
  });
  it("OD29 — arriving back after a 'recorded' completion elsewhere, with no entry now, drops the preview with one notice", async () => {
    const { store } = makeStore(); seedPreview(store);
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'recorded' }));
    pollRevisionsMock.mockResolvedValueOnce(empty());
    getChapterAudioPreviousMock.mockResolvedValue(null); // a stub, if one were (wrongly) built, would open cleanly
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    await vi.waitFor(() => expect(store.getState().ui.previewRegen).toBeNull());
    expect(store.getState().ui.openRevision).toBeNull();
    expect(getChapterAudioPreviousMock).not.toHaveBeenCalled();
    expect(toasts(store).filter((m) => m === 'This preview was resolved elsewhere')).toHaveLength(1);
  });
  it('OD28/OD29 — leaving the book while the arrival refetch is in flight leaves the preview re-openable', async () => {
    const { store } = makeStore(); seedPreview(store);
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'recorded' }));
    let release!: (v: unknown) => void;
    pollRevisionsMock.mockReturnValueOnce(new Promise((r) => (release = r)));
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' })); // arrival: the refetch starts
    await vi.waitFor(() => expect(pollRevisionsMock).toHaveBeenCalledTimes(1));
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' })); // leave before it lands
    release(empty());
    await tick();
    expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'recorded', stubFallback: false });
    expect(toasts(store)).not.toContain('This preview was resolved elsewhere');
  });
  it("OD27 — the re-open waits for the arriving book's chapters", async () => {
    const { store } = makeStore(); seedPreview(store);
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b2'));
    store.dispatch(chaptersSlice.actions.setChapters([ch(9, { state: 'done', duration: '01:00' })])); // b2's chapters
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
    getChapterAudioPreviousMock.mockResolvedValue(null);
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' })); // arrival; chapters still b2's
    await tick();
    expect(store.getState().ui.openRevision).toBeNull();
    /* b1's hydrate lands: rows first, then the book id the gate keys on (the
       real per-book hydrate sets both in one action). */
    store.dispatch(chaptersSlice.actions.setChapters([ch(3, { state: 'done', duration: '05:00' })]));
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
  });
  it("A8 — an active completion waits for its own book's chapters (chapter ids repeat across books)", async () => {
    const { store } = makeStore(); seedPreview(store); // active b1
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b2'));
    store.dispatch(chaptersSlice.actions.setChapters([ch(3, { state: 'done', duration: '09:00' })])); // ANOTHER book's chapter 3
    getChapterAudioPreviousMock.mockResolvedValue(null);
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
    await tick();
    expect(store.getState().ui.openRevision).toBeNull();
    expect(getChapterAudioPreviousMock).not.toHaveBeenCalled();
    expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'none', stubFallback: true });
    store.dispatch(chaptersSlice.actions.setChapters([ch(3, { state: 'done', duration: '05:00' })]));
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
    expect(getChapterAudioPreviousMock).toHaveBeenCalledWith({ bookId: 'b1', chapterId: 3, duration: '05:00' });
  });
  it('OD27 — no re-open on arrival without a finished preview', async () => {
    const { store } = makeStore(); seedPreview(store);
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' })); // no completion happened
    await tick();
    expect(store.getState().ui.openRevision).toBeNull();
    expect(getChapterAudioPreviousMock).not.toHaveBeenCalled();
    expect(pollRevisionsMock).not.toHaveBeenCalled();
  });
  it('OD28 — never opens over a player the user has open; it opens once that player closes', async () => {
    const { store } = makeStore(); seedPreview(store);
    store.dispatch(uiSlice.actions.setOpenRevision({ kind: 'server', revisionId: 'r-x', chapterId: 5 }));
    getChapterAudioPreviousMock.mockResolvedValue(null);
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
    await tick();
    expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'r-x', chapterId: 5 });
    expect(getChapterAudioPreviousMock).not.toHaveBeenCalled();
    store.dispatch(uiSlice.actions.setOpenRevision(null)); // the user closes it
    await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
  });
  it('OD28 — a stub that cannot be built yet (character not loaded) leaves the preview re-openable', async () => {
    const { store } = makeStore(); seedPreview(store);
    store.dispatch(castSlice.actions.hydrateCharacters([]));
    getChapterAudioPreviousMock.mockResolvedValue(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
    await vi.waitFor(() => expect(getChapterAudioPreviousMock).toHaveBeenCalled());
    await tick();
    const warned = warn.mock.calls.length; // read before mockRestore, which clears mock.calls in vitest 5
    warn.mockRestore();
    expect(warned).toBeGreaterThan(0);
    expect(store.getState().ui.openRevision).toBeNull();
    expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'none', stubFallback: true });
    store.dispatch(castSlice.actions.hydrateCharacters([{ id: 'marlow', name: 'Marlow' } as never]));
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
  });
  it('the stub never enters the revisions cache and survives a poll', async () => {
    const { store } = makeStore(); seedPreview(store);
    getChapterAudioPreviousMock.mockResolvedValueOnce(null);
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
    await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
    /* Asserted BEFORE the poll: a stub dispatched into the cache (mutation 4)
       would be wiped by the rev-9 poll's adoption below, masking it. */
    expect(store.getState().revisions.pending).toEqual([]);
    store.dispatch(revisionsSlice.actions.applyPoll({ ...empty(), rev: 9 }));
    expect(store.getState().revisions.pending).toEqual([]);
    expect(store.getState().ui.previewRegen?.stub).toBeDefined();
    expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' });
  });
  /* A1 (pass 4) — openPreview re-checks after its awaits. Each test holds one
     await open with a manual promise, changes the state the guard reads, then
     releases it. */
  it('A1 — a player the user opens during the refetch window is not replaced', async () => {
    const { store } = makeStore(); seedPreview(store);
    let release!: (v: unknown) => void;
    pollRevisionsMock.mockReturnValueOnce(new Promise((r) => (release = r)));
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'recorded' }));
    await vi.waitFor(() => expect(pollRevisionsMock).toHaveBeenCalledTimes(1));
    store.dispatch(uiSlice.actions.setOpenRevision({ kind: 'server', revisionId: 'r-x', chapterId: 5 })); // the user opens another take
    release(recorded()); // the refetch lands WITH an entry for chapter 3
    await tick();
    expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'r-x', chapterId: 5 });
    expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'recorded', stubFallback: true }); // the OD28 marker is kept
  });
  it('A1 — a player the user opens during the previous-audio GET is not replaced by the stub', async () => {
    const { store } = makeStore(); seedPreview(store);
    let release!: (v: unknown) => void;
    getChapterAudioPreviousMock.mockReturnValueOnce(new Promise((r) => (release = r)));
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
    await vi.waitFor(() => expect(getChapterAudioPreviousMock).toHaveBeenCalledTimes(1));
    store.dispatch(uiSlice.actions.setOpenRevision({ kind: 'server', revisionId: 'r-x', chapterId: 5 }));
    release(null);
    await tick();
    expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'r-x', chapterId: 5 });
    expect(store.getState().ui.previewRegen?.stub).toBeUndefined();
    expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'none', stubFallback: true });
  });
  it('A1 — moving to book B during the GET builds no stub there; returning to the preview book re-opens it', async () => {
    const { store } = makeStore(); seedPreview(store);
    let release!: (v: unknown) => void;
    getChapterAudioPreviousMock.mockResolvedValue(null);
    getChapterAudioPreviousMock.mockReturnValueOnce(new Promise((r) => (release = r)));
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
    await vi.waitFor(() => expect(getChapterAudioPreviousMock).toHaveBeenCalledTimes(1));
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' })); // no player open on b2
    release(null);
    await tick();
    expect(store.getState().ui.openRevision).toBeNull();
    expect(store.getState().ui.previewRegen?.stub).toBeUndefined();
    expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'none', stubFallback: true });
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' })); // arrival: the kept marker re-opens it
    await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' }));
  });
});

/* OD30 (pass 4) — INTEGRATION: the generation middleware AND the player
   watcher in one store, in production order, with a non-empty cache for the
   preview's chapter. The unit stores above install no watcher, so they cannot
   see the race between the stub and its open (watcher rule 1 dropping the
   stub, rule 2 hiding its player); this describe exists for that. */
describe('plan 286 — OD30: an existing entry for the chapter wins over the stub (generation middleware + watcher)', () => {
  const F = '000000000000001-a';
  const PREVIEW = { bookId: 'b1', characterId: 'marlow', previewChapterId: 3, remainingChapterIds: [4], reason: 'voice', note: '' };
  const cached = { bookId: 'b1', fileId: F, rev: 1, pending: [{ id: 'revision:3:1700', chapterId: 3, characterId: 'marlow', segments: [], origin: 'server' as const }], dismissed: [], acceptedSelections: {}, timeline: {}, drift: [] };
  function integratedStore() {
    const { store } = makeStore({ watcher: true });
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    store.dispatch(chaptersSlice.actions.setChapters([ch(3, { state: 'done', duration: '05:00' })]));
    store.dispatch(castSlice.actions.hydrateCharacters([{ id: 'marlow', name: 'Marlow' } as never]));
    store.dispatch(revisionsSlice.actions.applyPoll(cached)); // the active cache already holds an entry for chapter 3
    store.dispatch(uiSlice.actions.setPreviewRegen(PREVIEW as never));
    return store;
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const opensTheEntry = async (store: ReturnType<typeof integratedStore>, outcome: 'recorded' | 'none' | 'failed') => {
    await vi.waitFor(() => expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'revision:3:1700', chapterId: 3 }));
    const pv = store.getState().ui.previewRegen;
    expect(pv).toMatchObject({ bookId: 'b1', previewChapterId: 3 }); // still the preview: the layout opens it in preview mode, so Approve runs the fan-out (Task 22)
    expect(pv?.stub).toBeUndefined();
    expect(pv?.completed).toEqual({ reviewOutcome: outcome, stubFallback: false });
    expect(store.getState().notifications.toasts).toEqual([]);
  };
  beforeEach(() => { pollRevisionsMock.mockReset(); getChapterAudioPreviousMock.mockReset(); });
  afterEach(() => vi.useRealTimers());

  it.each(['none', 'failed'] as const)("'%s' with a cached entry for the chapter opens that entry, not a stub", async (outcome) => {
    const store = integratedStore();
    getChapterAudioPreviousMock.mockResolvedValue(null);
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: outcome }));
    await opensTheEntry(store, outcome);
    expect(pollRevisionsMock).not.toHaveBeenCalled(); // OD29: no refetch for these outcomes; the CACHED entry won
  });
  it("'recorded' whose refetch fails twice, with a cached entry for the chapter, opens that entry, not a stub", async () => {
    vi.useFakeTimers();
    const store = integratedStore();
    pollRevisionsMock.mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('y'));
    getChapterAudioPreviousMock.mockResolvedValue(null);
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'recorded' }));
    await vi.advanceTimersByTimeAsync(1000);
    await opensTheEntry(store, 'recorded');
    expect(pollRevisionsMock).toHaveBeenCalledTimes(2);
  });
  it("A1 — moving to book B during the GET does not close the player the user opened on B", async () => {
    const store = integratedStore();
    let release!: (v: unknown) => void;
    getChapterAudioPreviousMock.mockReturnValueOnce(new Promise((r) => (release = r)));
    store.dispatch(previewChapterComplete({ bookId: 'b1', chapterId: 3, reviewOutcome: 'none' }));
    await vi.waitFor(() => expect(getChapterAudioPreviousMock).toHaveBeenCalledTimes(1));
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
    store.dispatch(revisionsSlice.actions.applyServerState({ bookId: 'b2', fileId: F, rev: 1, pending: [{ id: 'rB', chapterId: 2, characterId: 'c', segments: [] }], dismissed: [], acceptedSelections: {}, timeline: {} }));
    store.dispatch(uiSlice.actions.setOpenRevision({ kind: 'server', revisionId: 'rB', chapterId: 2 })); // B's own player, which the watcher keeps (rB is cached)
    release(null);
    await tick();
    expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'rB', chapterId: 2 });
    expect(store.getState().ui.previewRegen?.stub).toBeUndefined();
    expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'none', stubFallback: true });
  });
});
