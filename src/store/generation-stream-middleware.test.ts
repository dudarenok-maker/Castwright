// Pairs with docs/features/archive/111-queue-worker-pool.md (wave 3).
//
// The plan-111 middleware is no longer a stream-opener — the queue dispatcher
// is the sole opener and the runner self-drives ticks. This middleware now
// owns: EXPLICIT-START ENQUEUE (on the `ui/requestStartGeneration` intent ONLY,
// enqueue the viewed book's pending chapters so the dispatcher drains them —
// plan 137 made this explicit so opening/re-opening a book never auto-starts),
// the HALT path, and the plan-114 PROFILE-REGEN PREVIEW GATE (open the A/B
// player when the previewed chapter completes). These tests cover exactly those.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { chaptersSlice } from './chapters-slice';
import { manuscriptSlice } from './manuscript-slice';
import { uiSlice } from './ui-slice';
import { changeLogSlice } from './change-log-slice';
import { castSlice } from './cast-slice';
import { revisionsSlice } from './revisions-slice';
import { analysisSlice, analysisActions } from './analysis-slice';
import { queueSlice } from './queue-slice';
import { accountSlice } from './account-slice';
import { generationStreamMiddleware } from './generation-stream-middleware';
import { createStreamRunner, type StreamRunner } from './generation-stream-runner';
import type { Chapter } from '../lib/types';

const streamGenerationMock = vi.fn();
const cancelMock = vi.fn();
const pauseGenerationMock = vi.fn();
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

function makeStore() {
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
      analysis: analysisSlice.reducer,
      queue: queueSlice.reducer,
      account: accountSlice.reducer,
    },
    middleware: (gd) => gd().concat(generationStreamMiddleware(getRunner)),
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

  it('does NOT enqueue on cast confirmation (stage ready/manuscript review)', async () => {
    const { store } = makeStore();
    seedAnalysed(store, 'b1', [ch(1, { state: 'queued' })]);
    store.dispatch(uiSlice.actions.confirmCast());
    await Promise.resolve();
    expect(store.getState().ui.stage).toMatchObject({ kind: 'ready', view: 'manuscript' });
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

  it('opens a playable A/B stub when the PREVIEWED chapter completes', () => {
    const { store } = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(
      castSlice.actions.setCharacters([
        { id: 'marlow', name: 'Marlow', isNarrator: false } as never,
      ]),
    );
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    store.dispatch(chaptersSlice.actions.setChapters([ch(3, { state: 'in_progress' })]));
    store.dispatch(
      uiSlice.actions.setPreviewRegen({
        characterId: 'marlow',
        previewChapterId: 3,
        remainingChapterIds: [4, 5],
        reason: 'voice',
        note: '',
      }),
    );
    /* chapter_complete for the preview chapter → markRevisionPlayable. The
       middleware builds the playable stub fresh and opens the diff player. */
    store.dispatch(revisionsSlice.actions.markRevisionPlayable({ chapterId: 3 }));
    const pending = store.getState().revisions.pending;
    expect(pending.some((p) => p.chapterId === 3 && p.characterId === 'marlow' && p.playable)).toBe(
      true,
    );
    expect(store.getState().ui.showRevisionPlayer).toBe(true);
  });

  it('does NOT open a preview when a chapter completes outside a preview (plain regen, no A/B gate)', () => {
    const { store } = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    store.dispatch(chaptersSlice.actions.setChapters([ch(3, { state: 'in_progress' })]));
    /* No previewRegen → a completing chapter just lands; no stub, no player. */
    store.dispatch(revisionsSlice.actions.markRevisionPlayable({ chapterId: 3 }));
    expect(store.getState().revisions.pending).toHaveLength(0);
    expect(store.getState().ui.showRevisionPlayer).toBe(false);
  });
});
