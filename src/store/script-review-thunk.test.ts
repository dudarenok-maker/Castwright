import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/api', () => ({
  api: {
    reviewScript: vi.fn(),
    attachScriptReview: vi.fn(),
    getScriptReviewState: vi.fn(),
    discardScriptReview: vi.fn(),
    resolveScriptReviewOps: vi.fn(),
    patchScriptReviewSelection: vi.fn(),
  },
  // Re-derived here (mirrors analysis-stream-middleware.test.ts's identical
  // AnalysisError pattern) so `err instanceof ReviewScriptError` inside
  // script-review-thunk.ts's own code resolves against the SAME class
  // reference this mock factory exports — a plain vi.fn()-based stub
  // couldn't satisfy an instanceof check.
  ReviewScriptError: class ReviewScriptError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  },
}));

import { configureStore } from '@reduxjs/toolkit';
import { api, ReviewScriptError } from '../lib/api';
import type { ReviewScriptOpts } from '../lib/api';
import { runReviewScript, hydrateScriptReview, attachToRunningReview, discardReview, retryReviewScript } from './script-review-thunk';
import { scriptReviewActions, scriptReviewSlice } from './script-review-slice';
import { notificationsActions } from './notifications-slice';

describe('runReviewScript', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets active, forwards onPhase progress, then clears in finally on success', async () => {
    vi.mocked(api.reviewScript).mockImplementation(
      async (_bookId: string, opts: ReviewScriptOpts = {}) => {
        opts.onPhase?.({ progress: 0.5 });
        opts.onPhase?.({ progress: 1 });
        return { reviewedChapters: 0, totalOps: 0 };
      },
    );
    const dispatch = vi.fn();
    await runReviewScript('b1', { dispatch, wholeBook: true, model: 'gemma', sentences: [], characterIds: new Set<string>(), manuscriptId: 'ms-1' });
    const types = dispatch.mock.calls.map((c) => c[0].type);
    expect(types).toContain(scriptReviewActions.setActive.type);
    expect(types).toContain(scriptReviewActions.updateProgress.type); // fired from onPhase
    const lastProg = dispatch.mock.calls.map((c) => c[0]).filter((a) => a.type === scriptReviewActions.updateProgress.type).pop();
    // Task 9 — onPhase now unconditionally stamps `now: Date.now()`.
    expect(lastProg.payload).toEqual({ bookId: 'b1', progress: 1, now: expect.any(Number) });
    expect(types[types.length - 1]).toBe(scriptReviewActions.clear.type);
  });

  it('clears in finally even when the API throws', async () => {
    vi.mocked(api.reviewScript).mockRejectedValue(new Error('boom'));
    const dispatch = vi.fn();
    await runReviewScript('b1', { dispatch, wholeBook: true, model: 'gemma', sentences: [], characterIds: new Set<string>(), manuscriptId: 'ms-1' });
    const types = dispatch.mock.calls.map((c) => c[0].type);
    expect(types[types.length - 1]).toBe(scriptReviewActions.clear.type);
  });

  it('forwards label/chapterIndex/totalChapters/estRemainingMs from onPhase into updateProgress', async () => {
    vi.mocked(api.reviewScript).mockImplementation(
      async (_bookId: string, opts: ReviewScriptOpts = {}) => {
        opts.onPhase?.({
          progress: 0.5,
          label: 'Reviewing script',
          chapterIndex: 2,
          totalChapters: 3,
          estRemainingMs: 20_000,
        });
        return { reviewedChapters: 0, totalOps: 0 };
      },
    );
    const dispatch = vi.fn();
    await runReviewScript('b1', {
      dispatch,
      wholeBook: true,
      model: 'gemma',
      sentences: [],
      characterIds: new Set<string>(),
      manuscriptId: 'ms-1',
    });
    const progressCalls = dispatch.mock.calls
      .map((c) => c[0])
      .filter((a) => a.type === scriptReviewActions.updateProgress.type);
    expect(progressCalls[0].payload).toEqual({
      bookId: 'b1',
      progress: 0.5,
      label: 'Reviewing script',
      chapterIndex: 2,
      totalChapters: 3,
      estRemainingMs: 20_000,
      // Task 9 — onPhase now unconditionally stamps `now: Date.now()`.
      now: expect.any(Number),
    });
  });

  /* Regression for the code-review-workflow finding: a clean run that
     finds nothing to change (zero ops, zero failures) must still dispatch
     setReview with empty arrays — that's what drives
     ScriptReviewDiff's "No suggestions found" empty state
     (data-testid="script-review-empty"). An earlier draft of the
     cancellation fix accidentally gated this dispatch on
     appliable/unappliable being non-empty, silently suppressing it. */
  it('a clean review with zero ops still dispatches setReview so the empty state can show', async () => {
    vi.mocked(api.reviewScript).mockImplementation(
      async (_bookId: string, opts: ReviewScriptOpts = {}) => {
        opts.onPhase?.({ progress: 1 });
        return { reviewedChapters: 1, totalOps: 0 };
      },
    );
    const dispatch = vi.fn();
    await runReviewScript('b1', {
      dispatch, wholeBook: true, model: 'gemma', sentences: [], characterIds: new Set<string>(), manuscriptId: 'ms-1',
    });
    expect(dispatch).toHaveBeenCalledWith(
      scriptReviewActions.setReview({ bookId: 'b1', ops: [], unappliable: [], manuscriptId: 'ms-1', versionByChapter: {} }),
    );
  });
});

// Task 9 — drive activityState/model/engine/fallbackActive from onPhase,
// upgrade activityState to 'streaming' on a genuine heartbeat, and surface
// a Retry toast on a model_load_failed error.
describe('runReviewScript — activity/model fields + streaming heartbeat + Retry (Task 9)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards activityState/model/engine from onPhase, and sets fallbackActive when fallbackReason is present', async () => {
    vi.mocked(api.reviewScript).mockImplementation(
      async (_bookId: string, opts: ReviewScriptOpts = {}) => {
        opts.onPhase?.({
          progress: 0.4,
          activityState: 'loading',
          model: 'qwen3.5:9b',
          engine: 'local',
          fallbackReason: 'ollama unreachable',
        });
        return { reviewedChapters: 0, totalOps: 0 };
      },
    );
    const dispatch = vi.fn();
    await runReviewScript('b1', {
      dispatch, wholeBook: true, model: 'gemma', sentences: [], characterIds: new Set<string>(), manuscriptId: 'ms-1',
    });
    const progressCalls = dispatch.mock.calls
      .map((c) => c[0])
      .filter((a) => a.type === scriptReviewActions.updateProgress.type);
    expect(progressCalls[0].payload).toEqual(
      expect.objectContaining({
        bookId: 'b1',
        progress: 0.4,
        activityState: 'loading',
        model: 'qwen3.5:9b',
        engine: 'local',
        fallbackActive: true,
        now: expect.any(Number),
      }),
    );
  });

  it('does not set fallbackActive when onPhase carries no fallbackReason', async () => {
    vi.mocked(api.reviewScript).mockImplementation(
      async (_bookId: string, opts: ReviewScriptOpts = {}) => {
        opts.onPhase?.({ progress: 0.4, activityState: 'waiting' });
        return { reviewedChapters: 0, totalOps: 0 };
      },
    );
    const dispatch = vi.fn();
    await runReviewScript('b1', {
      dispatch, wholeBook: true, model: 'gemma', sentences: [], characterIds: new Set<string>(), manuscriptId: 'ms-1',
    });
    const progressCalls = dispatch.mock.calls
      .map((c) => c[0])
      .filter((a) => a.type === scriptReviewActions.updateProgress.type);
    expect(progressCalls[0].payload.fallbackActive).toBeUndefined();
  });

  it('onHeartbeat({streaming:true}) dispatches updateProgress with activityState "streaming", reusing the last onPhase progress so the bar does not move', async () => {
    vi.mocked(api.reviewScript).mockImplementation(
      async (_bookId: string, opts: ReviewScriptOpts = {}) => {
        opts.onPhase?.({ progress: 0.6, activityState: 'waiting' });
        opts.onHeartbeat?.({ chapterId: 1, streaming: true });
        return { reviewedChapters: 0, totalOps: 0 };
      },
    );
    const dispatch = vi.fn();
    await runReviewScript('b1', {
      dispatch, wholeBook: true, model: 'gemma', sentences: [], characterIds: new Set<string>(), manuscriptId: 'ms-1',
    });
    const progressCalls = dispatch.mock.calls
      .map((c) => c[0])
      .filter((a) => a.type === scriptReviewActions.updateProgress.type);
    expect(progressCalls).toHaveLength(2);
    expect(progressCalls[1].payload).toEqual({
      bookId: 'b1',
      progress: 0.6, // lastProgress from the preceding onPhase — the bar does not move
      activityState: 'streaming',
      now: expect.any(Number),
    });
  });

  it('a bare waiting heartbeat ({streaming:false}) does NOT dispatch an extra updateProgress', async () => {
    vi.mocked(api.reviewScript).mockImplementation(
      async (_bookId: string, opts: ReviewScriptOpts = {}) => {
        opts.onPhase?.({ progress: 0.3, activityState: 'waiting' });
        opts.onHeartbeat?.({ chapterId: 1, streaming: false });
        return { reviewedChapters: 0, totalOps: 0 };
      },
    );
    const dispatch = vi.fn();
    await runReviewScript('b1', {
      dispatch, wholeBook: true, model: 'gemma', sentences: [], characterIds: new Set<string>(), manuscriptId: 'ms-1',
    });
    const progressCalls = dispatch.mock.calls
      .map((c) => c[0])
      .filter((a) => a.type === scriptReviewActions.updateProgress.type);
    expect(progressCalls).toHaveLength(1); // only the onPhase dispatch — the heartbeat was a no-op
  });

  it('a model_load_failed ReviewScriptError pushes a toast carrying a serializable retryReview scope', async () => {
    vi.mocked(api.reviewScript).mockRejectedValue(
      new ReviewScriptError('Model failed to load.', 'model_load_failed'),
    );
    const dispatch = vi.fn();
    await runReviewScript('b1', {
      dispatch, wholeBook: false, chapterId: 3, model: 'gemma', sentences: [], characterIds: new Set<string>(), manuscriptId: 'ms-1',
    });
    const toastCall = dispatch.mock.calls.find(([a]) => a.type === notificationsActions.pushToast.type);
    expect(toastCall?.[0].payload).toEqual(
      expect.objectContaining({
        kind: 'error',
        message: 'Model failed to load.',
        retryReview: { bookId: 'b1', wholeBook: false, chapterId: 3, model: 'gemma' },
      }),
    );
  });

  it('a model_load_failed retryReview omits chapterId for a whole-book run', async () => {
    vi.mocked(api.reviewScript).mockRejectedValue(
      new ReviewScriptError('Model failed to load.', 'model_load_failed'),
    );
    const dispatch = vi.fn();
    await runReviewScript('b1', {
      dispatch, wholeBook: true, model: 'gemma', sentences: [], characterIds: new Set<string>(), manuscriptId: 'ms-1',
    });
    const toastCall = dispatch.mock.calls.find(([a]) => a.type === notificationsActions.pushToast.type);
    expect(toastCall?.[0].payload.retryReview).toEqual({ bookId: 'b1', wholeBook: true, model: 'gemma' });
  });
});

describe('attachToRunningReview — activity/model fields + streaming heartbeat (Task 9)', () => {
  it('mirrors onPhase\'s activityState/model/engine/fallbackActive fields', async () => {
    vi.mocked(api.attachScriptReview).mockImplementation(
      async (_bookId: string, opts: ReviewScriptOpts = {}) => {
        opts.onPhase?.({
          progress: 0.7,
          activityState: 'waiting',
          model: 'qwen3.5:9b',
          engine: 'gemini',
          fallbackReason: 'local unreachable',
        });
        return { reviewedChapters: 0, totalOps: 0 } as never;
      },
    );
    const dispatch = vi.fn();
    await attachToRunningReview(
      'book-1',
      { chapterId: 5, replay: { lastPhase: null } },
      { dispatch, sentences: [], characterIds: new Set(), manuscriptId: 'ms-1' },
    );
    const progressCalls = dispatch.mock.calls
      .map((c) => c[0])
      .filter((a) => a.type === scriptReviewActions.updateProgress.type);
    expect(progressCalls[0].payload).toEqual(
      expect.objectContaining({
        activityState: 'waiting',
        model: 'qwen3.5:9b',
        engine: 'gemini',
        fallbackActive: true,
      }),
    );
  });

  it('onHeartbeat({streaming:true}) dispatches a streaming updateProgress using the last onPhase progress', async () => {
    vi.mocked(api.attachScriptReview).mockImplementation(
      async (_bookId: string, opts: ReviewScriptOpts = {}) => {
        opts.onPhase?.({ progress: 0.5 });
        opts.onHeartbeat?.({ chapterId: 5, streaming: true });
        return { reviewedChapters: 0, totalOps: 0 } as never;
      },
    );
    const dispatch = vi.fn();
    await attachToRunningReview(
      'book-1',
      { chapterId: 5, replay: { lastPhase: null } },
      { dispatch, sentences: [], characterIds: new Set(), manuscriptId: 'ms-1' },
    );
    const progressCalls = dispatch.mock.calls
      .map((c) => c[0])
      .filter((a) => a.type === scriptReviewActions.updateProgress.type);
    expect(progressCalls).toHaveLength(2);
    expect(progressCalls[1].payload).toEqual(
      expect.objectContaining({ progress: 0.5, activityState: 'streaming' }),
    );
  });
});

describe('retryReviewScript (Task 9)', () => {
  beforeEach(() => vi.clearAllMocks());

  function fakeGetState(overrides: { manuscriptId: string | null; bookId?: string | null; characters: Array<{ id: string }>; sentences: unknown[] }) {
    const bookId = overrides.bookId === undefined ? 'book-1' : overrides.bookId;
    return () =>
      ({
        manuscript: { bookId, manuscriptId: overrides.manuscriptId, sentences: overrides.sentences },
        cast: { characters: overrides.characters },
      }) as never;
  }

  it('re-invokes runReviewScript with the retry scope and the CURRENT live manuscript/cast snapshot', async () => {
    vi.mocked(api.reviewScript).mockResolvedValue({ reviewedChapters: 0, totalOps: 0 });
    const dispatch = vi.fn();
    const getState = fakeGetState({
      manuscriptId: 'ms-2',
      characters: [{ id: 'c1' }],
      sentences: [{ id: 1, chapterId: 3, text: 'Hi', characterId: 'c1' }],
    });

    const thunk = retryReviewScript('book-1', { wholeBook: false, chapterId: 3, model: 'gemma' });
    const launched = await thunk(dispatch, getState);
    // retryReviewScript fires-and-forgets runReviewScript (a plain async
    // function, not itself dispatched) — give its internal setActive/api
    // call a tick to land.
    await new Promise((r) => setTimeout(r, 0));

    expect(launched).toBe(true);
    expect(api.reviewScript).toHaveBeenCalledWith(
      'book-1',
      expect.objectContaining({ chapterId: 3, model: 'gemma' }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      scriptReviewActions.setActive({ bookId: 'book-1', progress: 0, label: 'Reviewing script' }),
    );
  });

  it('no-ops when the manuscript/cast for the book are not loaded, and reports it did not launch', async () => {
    const dispatch = vi.fn();
    const getState = fakeGetState({ manuscriptId: null, characters: [], sentences: [] });

    const thunk = retryReviewScript('book-1', { wholeBook: true, model: 'gemma' });
    const launched = await thunk(dispatch, getState);

    expect(launched).toBe(false);
    expect(api.reviewScript).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

// Finding 5 (PR review round 4): `bookId` now drives snapshotIfReady's
// manuscript.bookId===bookId guard — a fake store used by hydrateScriptReview
// tests must carry a `bookId` on its manuscript slice that matches (or
// deliberately mismatches, for the cross-book guard test) the bookId the
// hydration call under test uses. Default 'book-1' matches every existing
// test's `hydrateScriptReview('book-1', ...)` call.
function makeFakeStore(initial: {
  manuscriptId: string | null;
  characters: Array<{ id: string }>;
  sentences: unknown[];
  bookId?: string | null;
}) {
  const bookId = initial.bookId === undefined ? 'book-1' : initial.bookId;
  let state = {
    manuscript: { bookId, manuscriptId: initial.manuscriptId, sentences: initial.sentences },
    cast: { characters: initial.characters },
  };
  const listeners: Array<() => void> = [];
  return {
    getState: () => state as never,
    subscribe: (fn: () => void) => { listeners.push(fn); return () => {}; },
    setManuscriptReady: (manuscriptId: string, sentences: unknown[], characters: Array<{ id: string }>, readyBookId = 'book-1') => {
      state = { manuscript: { bookId: readyBookId, manuscriptId, sentences }, cast: { characters } };
      listeners.forEach((l) => l());
    },
  };
}

describe('hydrateScriptReview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dispatches hydrateBucket from a ledger-only state response, waiting for manuscript+cast readiness first', async () => {
    const dispatch = vi.fn();
    const fakeStore = makeFakeStore({ manuscriptId: null, characters: [], sentences: [] });
    vi.mocked(api.getScriptReviewState).mockResolvedValue({
      kind: 'ledger',
      entries: { '1': { manuscriptId: 'ms-1', version: 5, ops: [{ id: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' }], selected: { '1:1:strip_tag': false }, completedAt: '2026-01-01' } },
    });

    const promise = hydrateScriptReview('book-1', { dispatch, getState: fakeStore.getState, subscribe: fakeStore.subscribe });
    // Not resolved yet — manuscript/cast aren't ready.
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatch).not.toHaveBeenCalled();

    fakeStore.setManuscriptReady('ms-1', [{ id: 1, chapterId: 1, text: 'Hi tag', characterId: 'c1' }], [{ id: 'c1' }]);
    await promise;

    expect(dispatch).toHaveBeenCalledWith(
      scriptReviewActions.hydrateBucket(
        expect.objectContaining({
          bookId: 'book-1',
          manuscriptId: 'ms-1',
          versionByChapter: { 1: 5 },
          selected: expect.objectContaining({ '1:1:strip_tag': false }),
        }),
      ),
    );
  });

  it('resolves immediately without dispatching when the ledger has no entries', async () => {
    const dispatch = vi.fn();
    const fakeStore = makeFakeStore({ manuscriptId: 'ms-1', characters: [{ id: 'c1' }], sentences: [] });
    vi.mocked(api.getScriptReviewState).mockResolvedValue({ kind: 'ledger', entries: {} });

    await hydrateScriptReview('book-1', { dispatch, getState: fakeStore.getState, subscribe: fakeStore.subscribe });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('tags ops with their own chapter entry id and falls back to !DEFAULT_OFF for ops with no persisted override', async () => {
    const dispatch = vi.fn();
    const fakeStore = makeFakeStore({
      manuscriptId: 'ms-1',
      characters: [{ id: 'c1' }],
      sentences: [
        { id: 1, chapterId: 1, text: 'Hi tag', characterId: 'c1' },
        { id: 2, chapterId: 2, text: 'Whisper this', characterId: 'c1' },
        { id: 3, chapterId: 2, text: 'Wrong speaker', characterId: 'c1' },
      ],
    });
    vi.mocked(api.getScriptReviewState).mockResolvedValue({
      kind: 'ledger',
      entries: {
        '1': {
          manuscriptId: 'ms-1',
          version: 5,
          ops: [{ id: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' }],
          // Explicit persisted override — this op's `selected` must match it exactly.
          selected: { '1:1:strip_tag': false },
          completedAt: '2026-01-01',
        },
        '2': {
          manuscriptId: 'ms-1',
          version: 7,
          ops: [
            { id: 2, op: 'fix_emotion', emotion: 'whisper', rationale: 'r' },
            { id: 3, op: 'reattribute', characterId: 'c1', rationale: 'r' },
          ],
          // No persisted override for either op — both fall back to !DEFAULT_OFF.has(op).
          selected: {},
          completedAt: '2026-01-02',
        },
      },
    });

    await hydrateScriptReview('book-1', { dispatch, getState: fakeStore.getState, subscribe: fakeStore.subscribe });

    expect(dispatch).toHaveBeenCalledWith(
      scriptReviewActions.hydrateBucket(
        expect.objectContaining({
          bookId: 'book-1',
          manuscriptId: 'ms-1',
          versionByChapter: { 1: 5, 2: 7 },
          selected: expect.objectContaining({
            '1:1:strip_tag': false, // explicit override, honored as-is
            '2:2:fix_emotion': true, // no override, fix_emotion not in DEFAULT_OFF -> true
            '2:3:reattribute': false, // no override, reattribute IS in DEFAULT_OFF -> false
          }),
        }),
      ),
    );

    const dispatched = dispatch.mock.calls.map((c) => c[0]).find((a) => a.type === scriptReviewActions.hydrateBucket.type);
    const opsById = new Map(dispatched.payload.ops.map((o: { id: number; chapterId: number }) => [o.id, o.chapterId]));
    expect(opsById.get(1)).toBe(1); // chapter-1 op keeps chapter 1
    expect(opsById.get(2)).toBe(2); // chapter-2 op keeps chapter 2 (not hoisted to a shared/last chapterId)
    expect(opsById.get(3)).toBe(2);
  });

  /* Round-3 review Critical Finding 2 — GET /state used to return EITHER a
     running job's replay OR the ledger entries, never both, so a chapter
     outside a currently-running job's scope was invisible to a hydrating
     client for the job's entire duration. The fix has the server always
     include ledger `entries` alongside a `kind:'running'` response;
     hydrateScriptReview must process BOTH: hydrateBucket for the ledger
     entries (any chapter NOT covered by the running job) followed by
     attachToRunningReview's own setReview for the running job's chapter —
     and the two must MERGE into one bucket with both chapters' data, not
     clobber each other. Uses a real scriptReviewSlice-backed store (not a
     bare dispatch spy) so the merge is verified on actual reducer state,
     not just on which actions fired. */
  it('when kind is "running" with non-empty entries, hydrates the ledger entries AND attaches to the running job — the final bucket carries BOTH chapters\' data', async () => {
    const store = configureStore({ reducer: { scriptReview: scriptReviewSlice.reducer } });
    const fakeStore = makeFakeStore({
      manuscriptId: 'ms-1',
      characters: [{ id: 'c1' }],
      sentences: [
        { id: 1, chapterId: 3, text: 'Chapter three line.', characterId: 'c1' },
        { id: 2, chapterId: 7, text: 'Chapter seven line.', characterId: 'c1' },
      ],
    });
    vi.mocked(api.getScriptReviewState).mockResolvedValue({
      kind: 'running',
      // Finding 6 (PR review round 4): the DTO's running variant is now an
      // ARRAY of running jobs (a book can have two concurrent single-chapter
      // jobs) rather than a single {chapterId, replay} pair.
      running: [
        {
          chapterId: 7,
          replay: {
            opsEvents: [],
            chapterFailedEvents: [],
            checkpointEvents: [],
            lastPhase: null,
            result: null,
            errorEvent: null,
          },
        },
      ],
      // Chapter 3's finding is already persisted, outside the running
      // chapter-7 job's own scope.
      entries: {
        '3': {
          manuscriptId: 'ms-1',
          version: 2,
          ops: [{ id: 1, op: 'strip_tag', newText: 'Chapter three fixed', rationale: 'r' }],
          selected: {},
          completedAt: '2026-01-01',
        },
      },
    });
    // attachToRunningReview's join replays the running job's own chapter's
    // ops via api.reviewScript's onOps/onCheckpoint callbacks.
    vi.mocked(api.attachScriptReview).mockImplementation(async (_bookId: string, opts: ReviewScriptOpts = {}) => {
      opts.onCheckpoint?.({ chapterId: 7, version: 1 });
      opts.onOps?.({ chapterId: 7, ops: [{ id: 2, op: 'strip_tag', newText: 'Chapter seven fixed', rationale: 'r' }] });
      return { reviewedChapters: 1, totalOps: 1 } as never;
    });

    await hydrateScriptReview('book-1', {
      dispatch: store.dispatch,
      getState: fakeStore.getState as never,
      subscribe: fakeStore.subscribe,
    });

    const bucket = store.getState().scriptReview.byBook['book-1'];
    expect(bucket).toBeDefined();
    const chapterIds = new Set(bucket!.ops.map((o) => o.chapterId));
    // Both chapter 3 (from the ledger hydrateBucket) and chapter 7 (from the
    // running job's own setReview) must be present in the SAME bucket.
    expect(chapterIds.has(3)).toBe(true);
    expect(chapterIds.has(7)).toBe(true);
    expect(bucket!.versionByChapter).toEqual({ 3: 2, 7: 1 });
  });

  /* Round-4 review Finding 5 — waitForManuscriptAndCast/snapshotIfReady used
     to read the GLOBAL manuscript/cast slices with no check they actually
     belonged to the bookId hydration was called for. If the user switched
     books while this was waiting, a still-pending subscription could
     resolve with a DIFFERENT book's manuscript/cast data, corrupting this
     book's script-review bucket. snapshotIfReady now guards on
     state.manuscript.bookId===bookId (mirroring src/routes/index.tsx's
     existing manuscriptMatchesBook check) — proves the hydration does NOT
     resolve/dispatch while the live manuscript belongs to a different book,
     and DOES once it matches. */
  it('does not resolve/dispatch while state.manuscript.bookId belongs to a different book, and does once it matches', async () => {
    const dispatch = vi.fn();
    const fakeStore = makeFakeStore({ manuscriptId: null, characters: [], sentences: [], bookId: null });
    vi.mocked(api.getScriptReviewState).mockResolvedValue({
      kind: 'ledger',
      entries: { '1': { manuscriptId: 'ms-1', version: 5, ops: [{ id: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' }], selected: {}, completedAt: '2026-01-01' } },
    });

    const promise = hydrateScriptReview('book-A', { dispatch, getState: fakeStore.getState, subscribe: fakeStore.subscribe });
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatch).not.toHaveBeenCalled();

    // Manuscript/cast become ready — but for a DIFFERENT book (book-B). The
    // hydration for book-A must keep waiting, not corrupt book-A's bucket
    // with book-B's live sentences.
    fakeStore.setManuscriptReady('ms-1', [{ id: 1, chapterId: 1, text: 'Hi tag', characterId: 'c1' }], [{ id: 'c1' }], 'book-B');
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatch).not.toHaveBeenCalled();

    // Now the SAME book (book-A) becomes ready — hydration resolves.
    fakeStore.setManuscriptReady('ms-1', [{ id: 1, chapterId: 1, text: 'Hi tag', characterId: 'c1' }], [{ id: 'c1' }], 'book-A');
    await promise;

    expect(dispatch).toHaveBeenCalledWith(
      scriptReviewActions.hydrateBucket(expect.objectContaining({ bookId: 'book-A', manuscriptId: 'ms-1' })),
    );
  });

  /* Round-4 review Finding 6 — GET /state's `running` variant is now an
     ARRAY (two different chapters' single-chapter jobs can legitimately run
     concurrently for the same book). hydrateScriptReview must attach to
     EVERY job in the array and MERGE all of them into the same bucket. */
  it('attaches to multiple concurrently-running jobs from the running array and merges both into the bucket', async () => {
    const store = configureStore({ reducer: { scriptReview: scriptReviewSlice.reducer } });
    const fakeStore = makeFakeStore({
      manuscriptId: 'ms-1',
      characters: [{ id: 'c1' }],
      sentences: [
        { id: 1, chapterId: 5, text: 'Chapter five line.', characterId: 'c1' },
        { id: 2, chapterId: 9, text: 'Chapter nine line.', characterId: 'c1' },
      ],
    });
    vi.mocked(api.getScriptReviewState).mockResolvedValue({
      kind: 'running',
      running: [
        { chapterId: 5, replay: { opsEvents: [], chapterFailedEvents: [], checkpointEvents: [], lastPhase: null, result: null, errorEvent: null } },
        { chapterId: 9, replay: { opsEvents: [], chapterFailedEvents: [], checkpointEvents: [], lastPhase: null, result: null, errorEvent: null } },
      ],
      entries: {},
    });
    vi.mocked(api.attachScriptReview).mockImplementation(async (_bookId: string, opts: ReviewScriptOpts = {}) => {
      // Both joins replay through the same api.attachScriptReview mock —
      // key off the requested chapterId (threaded via opts) to reply with
      // each job's own ops, so the two attaches don't cross-contaminate.
      const chapterId = opts.chapterId;
      if (chapterId === 5) {
        opts.onCheckpoint?.({ chapterId: 5, version: 1 });
        opts.onOps?.({ chapterId: 5, ops: [{ id: 1, op: 'strip_tag', newText: 'Five fixed', rationale: 'r' }] });
      } else if (chapterId === 9) {
        opts.onCheckpoint?.({ chapterId: 9, version: 1 });
        opts.onOps?.({ chapterId: 9, ops: [{ id: 2, op: 'strip_tag', newText: 'Nine fixed', rationale: 'r' }] });
      }
      return { reviewedChapters: 1, totalOps: 1 } as never;
    });

    await hydrateScriptReview('book-1', {
      dispatch: store.dispatch,
      getState: fakeStore.getState as never,
      subscribe: fakeStore.subscribe,
    });

    const bucket = store.getState().scriptReview.byBook['book-1'];
    expect(bucket).toBeDefined();
    const chapterIds = new Set(bucket!.ops.map((o) => o.chapterId));
    expect(chapterIds.has(5)).toBe(true);
    expect(chapterIds.has(9)).toBe(true);
    expect(bucket!.versionByChapter).toEqual({ 5: 1, 9: 1 });
  });

  /* Round-5 review Findings 1/2 — setActive/clear used to live inside
     attachToRunningReview, dispatched once PER job. With 2+ concurrently-
     running jobs for the same book, activeStreams (keyed only by bookId) got
     cleared by whichever job finished FIRST while a sibling job was still
     genuinely streaming — silently re-enabling the Review Script button and
     dropping the progress pill mid-run. setActive/clear now live in
     hydrateScriptReview instead: setActive fires exactly ONCE up front
     (seeded from the first running job's replay.lastPhase), and clear fires
     exactly ONCE, only after EVERY job in the batch has settled. Uses two
     independently-controllable promises so the test can resolve the FASTER
     job first and prove `clear` still waits for the SLOWER one. */
  it('dispatches setActive exactly once (seeded from the first job\'s replay) and clear exactly once, only after ALL concurrent jobs settle', async () => {
    const dispatch = vi.fn();
    const fakeStore = makeFakeStore({
      manuscriptId: 'ms-1',
      characters: [{ id: 'c1' }],
      sentences: [
        { id: 1, chapterId: 5, text: 'Chapter five line.', characterId: 'c1' },
        { id: 2, chapterId: 9, text: 'Chapter nine line.', characterId: 'c1' },
      ],
    });
    vi.mocked(api.getScriptReviewState).mockResolvedValue({
      kind: 'running',
      running: [
        { chapterId: 5, replay: { lastPhase: { progress: 0.2, label: 'Reviewing script' } } },
        { chapterId: 9, replay: { lastPhase: null } },
      ],
      entries: {},
    });

    let resolveFive!: () => void;
    let resolveNine!: () => void;
    const fivePromise = new Promise<void>((r) => {
      resolveFive = r;
    });
    const ninePromise = new Promise<void>((r) => {
      resolveNine = r;
    });
    vi.mocked(api.attachScriptReview).mockImplementation(async (_bookId: string, opts: ReviewScriptOpts = {}) => {
      if (opts.chapterId === 5) await fivePromise;
      else if (opts.chapterId === 9) await ninePromise;
      return { reviewedChapters: 1, totalOps: 0 } as never;
    });
    // Finding 2 — waitForManuscriptAndCast (via snapshotIfReady's getState()
    // read) used to run once PER running job. Spy on getState to prove it's
    // called exactly once for this 2-job batch, not twice.
    const getStateSpy = vi.fn(fakeStore.getState);

    const promise = hydrateScriptReview('book-1', {
      dispatch,
      getState: getStateSpy,
      subscribe: fakeStore.subscribe,
    });

    // Give setActive + the initial join POSTs a tick to fire.
    await new Promise((r) => setTimeout(r, 10));
    const setActiveCalls = dispatch.mock.calls.filter((c) => c[0].type === scriptReviewActions.setActive.type);
    expect(setActiveCalls).toHaveLength(1);
    expect(setActiveCalls[0][0].payload).toEqual(
      expect.objectContaining({ bookId: 'book-1', progress: 0.2, label: 'Reviewing script' }),
    );

    // Resolve the FASTER job (chapter 5) first — clear must NOT fire yet,
    // since chapter 9's job is still streaming. This is the exact bug this
    // fix closes: the old per-job clear would have fired here.
    resolveFive();
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatch.mock.calls.some((c) => c[0].type === scriptReviewActions.clear.type)).toBe(false);

    // Resolve the SLOWER job — now clear fires, exactly once.
    resolveNine();
    await promise;
    const clearCalls = dispatch.mock.calls.filter((c) => c[0].type === scriptReviewActions.clear.type);
    expect(clearCalls).toHaveLength(1);
    // snapshotIfReady resolves immediately (manuscript/cast already ready),
    // so one waitForManuscriptAndCast call reads getState() exactly once —
    // two calls (the pre-fix per-job behavior) would read it twice.
    expect(getStateSpy).toHaveBeenCalledTimes(1);
  });
});

describe('runReviewScript — version delivery', () => {
  it('accumulates versionByChapter from onCheckpoint events and stamps them onto the final setReview dispatch', async () => {
    const dispatch = vi.fn();
    vi.mocked(api.reviewScript).mockImplementation(async (_bookId: string, opts: ReviewScriptOpts = {}) => {
      opts.onCheckpoint?.({ chapterId: 1, version: 7 });
      opts.onOps?.({ chapterId: 1, ops: [{ id: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' }] });
      return { reviewedChapters: 1, totalOps: 1 } as never;
    });
    await runReviewScript('book-1', {
      dispatch, wholeBook: false, chapterId: 1, model: 'test-model',
      sentences: [{ id: 1, chapterId: 1, text: 'Hi tag', characterId: 'c1' }],
      characterIds: new Set(['c1']),
      manuscriptId: 'ms-1',
    });
    expect(dispatch).toHaveBeenCalledWith(
      scriptReviewActions.setReview(
        expect.objectContaining({ bookId: 'book-1', manuscriptId: 'ms-1', versionByChapter: { 1: 7 } }),
      ),
    );
  });
});

/* Regression for the code-review-workflow finding: a successful join that
   resolves with zero new ops (e.g. a reattach whose remaining stream
   contributed nothing new) must still dispatch setReview with empty
   arrays — an earlier draft of the cancellation fix accidentally gated
   this on appliable/unappliable being non-empty, making a genuinely
   clean reattach indistinguishable from a silent failure. */
describe('attachToRunningReview — empty successful join (fs-58 follow-up #1481)', () => {
  it('a join that resolves with zero new ops still dispatches setReview', async () => {
    const dispatch = vi.fn();
    vi.mocked(api.attachScriptReview).mockResolvedValue({ reviewedChapters: 1, totalOps: 0 } as never);

    await attachToRunningReview(
      'book-1',
      { chapterId: 5, replay: { lastPhase: null } },
      { dispatch, sentences: [], characterIds: new Set(), manuscriptId: 'ms-1' },
    );

    expect(dispatch).toHaveBeenCalledWith(
      scriptReviewActions.setReview({ bookId: 'book-1', ops: [], unappliable: [], manuscriptId: 'ms-1', versionByChapter: {} }),
    );
  });
});

// Round-5 review Findings 1/2 — attachToRunningReview used to dispatch
// setActive on entry and clear in its own `finally`, so hydrateScriptReview's
// Promise.all over N concurrently-running jobs for the same book dispatched
// setActive/clear N times each — and since activeStreams is keyed only by
// bookId, the FASTEST job to finish cleared the shared progress pill while a
// sibling job was still genuinely streaming. setActive/clear now live
// exclusively in hydrateScriptReview (once per hydration batch, not once per
// job) — see the 'hydrateScriptReview' describe block below for the seeding/
// batching coverage that replaces the two assertions removed from here.
describe('attachToRunningReview', () => {
  it('does NOT dispatch setActive or clear itself — that is hydrateScriptReview\'s job now', async () => {
    const dispatch = vi.fn();
    vi.mocked(api.attachScriptReview).mockResolvedValue({ reviewedChapters: 0, totalOps: 0 } as never);
    const runningState = {
      chapterId: undefined,
      replay: { lastPhase: { progress: 0.4, label: 'Reviewing script' } },
    };
    await attachToRunningReview('book-1', runningState, {
      dispatch,
      sentences: [{ id: 1, chapterId: 1, text: 'Hi tag', characterId: 'c1' }],
      characterIds: new Set(['c1']),
      manuscriptId: 'ms-1',
    });
    const types = dispatch.mock.calls.map((c) => c[0].type);
    expect(types).not.toContain(scriptReviewActions.setActive.type);
    expect(types).not.toContain(scriptReviewActions.clear.type);
  });

  it('dispatches setReview with the ops/versions delivered by the join\'s own replay — not double-counted with the GET /state snapshot', async () => {
    const dispatch = vi.fn();
    // Simulates Task 2's attachSubscriber: the join POST replays every
    // buffered event through the SAME onOps/onCheckpoint callbacks a live
    // stream would use. attachToRunningReview must rely on THIS, not on
    // pre-seeding from runningState.replay, or each op would count twice.
    vi.mocked(api.attachScriptReview).mockImplementation(async (_bookId: string, opts: ReviewScriptOpts = {}) => {
      opts.onCheckpoint?.({ chapterId: 1, version: 5 });
      opts.onOps?.({ chapterId: 1, ops: [{ id: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' }] });
      return { reviewedChapters: 1, totalOps: 1 } as never;
    });
    const runningState = {
      kind: 'running' as const,
      chapterId: undefined,
      replay: {
        // Deliberately non-empty (same op/version the mock below replays —
        // that's fine, detection doesn't rely on the values differing).
        // attachToRunningReview's type no longer even exposes these fields
        // (see RunningReviewState below), so this object only typechecks
        // because it's assigned to a variable first, not an inline literal
        // (TS skips excess-property checks on variables) — if
        // attachToRunningReview regressed to reading opsEvents/
        // checkpointEvents from BOTH this snapshot and the mock's replay,
        // the op would be pushed into allOps twice and the ops.length===1
        // assertion below would fail. The assertion is what catches the
        // regression, not any value mismatch.
        opsEvents: [{ chapterId: 1, ops: [{ id: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' }] }],
        chapterFailedEvents: [],
        checkpointEvents: [{ chapterId: 1, version: 5 }],
        lastPhase: { progress: 0.9, label: 'Reviewing script' },
        result: null,
        errorEvent: null,
      },
    };
    await attachToRunningReview('book-1', runningState, {
      dispatch,
      sentences: [{ id: 1, chapterId: 1, text: 'Hi tag', characterId: 'c1' }],
      characterIds: new Set(['c1']),
      manuscriptId: 'ms-1',
    });
    const setReviewCall = dispatch.mock.calls.find(([action]) => action.type === 'scriptReview/setReview');
    expect(setReviewCall?.[0].payload).toEqual(
      expect.objectContaining({ bookId: 'book-1', manuscriptId: 'ms-1', versionByChapter: { 1: 5 } }),
    );
    // The critical assertion: exactly ONE copy of the op, not two.
    expect(setReviewCall?.[0].payload.ops).toHaveLength(1);
  });

  /* Round-4 review Finding 2 — attachToRunningReview had no `catch`, unlike
     its sibling runReviewScript (which pushes an error toast). A rejected
     join POST (e.g. the network drops, or the TOCTOU race documented above
     falls through to a failing create) would propagate as an unhandled
     rejection with no user-visible feedback. (Round-5 review Findings 1/2:
     `clear` no longer fires from here at all — see the batch-level assertion
     in the 'hydrateScriptReview' describe block below.) */
  it('dispatches an error toast when the join POST rejects, mirroring runReviewScript\'s catch path', async () => {
    const dispatch = vi.fn();
    vi.mocked(api.attachScriptReview).mockRejectedValue(new Error('join failed'));
    const runningState = {
      chapterId: undefined,
      replay: { lastPhase: null },
    };
    await attachToRunningReview('book-1', runningState, {
      dispatch,
      sentences: [],
      characterIds: new Set<string>(),
      manuscriptId: 'ms-1',
    });
    const toastCall = dispatch.mock.calls.find(([action]) => action?.type === notificationsActions.pushToast.type);
    expect(toastCall?.[0].payload).toEqual(expect.objectContaining({ kind: 'error', message: 'join failed' }));
  });
});

describe('attachToRunningReview — reattach-race hardening (fs-58 follow-up #1481)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('on a null (404) attach result, falls back to a fresh ledger re-read via mergeHydratedBucket instead of starting a fresh review', async () => {
    const dispatch = vi.fn();
    vi.mocked(api.attachScriptReview).mockResolvedValue(null);
    vi.mocked(api.getScriptReviewState).mockResolvedValue({
      kind: 'ledger',
      entries: {
        '5': {
          manuscriptId: 'ms-1',
          version: 3,
          ops: [{ id: 1, op: 'strip_tag', newText: 'Five fixed', rationale: 'r' }],
          selected: {},
          completedAt: '2026-01-01',
        },
      },
    });

    await attachToRunningReview(
      'book-1',
      { chapterId: 5, replay: { lastPhase: null } },
      {
        dispatch,
        sentences: [{ id: 1, chapterId: 5, text: 'Five fixed', characterId: 'c1' }],
        characterIds: new Set(['c1']),
        manuscriptId: 'ms-1',
      },
    );

    expect(dispatch).toHaveBeenCalledWith(
      scriptReviewActions.mergeHydratedBucket(
        expect.objectContaining({ bookId: 'book-1', manuscriptId: 'ms-1', versionByChapter: { 5: 3 } }),
      ),
    );
    expect(dispatch.mock.calls.some((c) => c[0].type === scriptReviewActions.setReview.type)).toBe(false);
    // Critically NOT hydrateBucket — that reducer replaces the bucket
    // wholesale, which is exactly the race this mode:'merge' fix closes
    // (see the regression test below for the actual race scenario).
    expect(dispatch.mock.calls.some((c) => c[0].type === scriptReviewActions.hydrateBucket.type)).toBe(false);
    expect(dispatch.mock.calls.some((c) => c[0].type === scriptReviewActions.clear.type)).toBe(false);
  });

  /* Regression for the code-review-workflow finding on this PR: the 404
     fallback used to dispatch hydrateBucket, a wholesale per-book replace.
     hydrateScriptReview's Promise.all can reattach MULTIPLE concurrently-
     running jobs for the same book (e.g. chapters 5 and 9). If chapter 5's
     job hits the TOCTOU race (its attach 404s) while chapter 9's job is
     still genuinely streaming, chapter 5's fallback GET /state can return
     a ledger snapshot that doesn't yet include chapter 9 (it hasn't
     checkpointed yet) — and if that fallback's dispatch resolves AFTER
     chapter 9's own setReview, a wholesale replace would silently wipe
     chapter 9's just-set ops back out of the store, even though they're
     safely checkpointed server-side. Drives BOTH attachToRunningReview
     calls against a REAL store (not a dispatch spy) and asserts the final
     state carries both chapters regardless of which settles last. */
  it('a concurrently-reattaching sibling job\'s ops survive the 404 fallback\'s dispatch landing after it', async () => {
    const store = configureStore({ reducer: { scriptReview: scriptReviewSlice.reducer } });

    // Chapter 5 hits the TOCTOU race: its attach 404s (null), and its
    // fallback ledger read is a snapshot taken BEFORE chapter 9 checkpoints
    // (i.e. it only has chapter 5's own entry).
    vi.mocked(api.attachScriptReview).mockImplementation(async (_bookId: string, opts: ReviewScriptOpts = {}) => {
      if (opts.chapterId === 5) return null;
      // Chapter 9's job is still genuinely streaming — resolves normally
      // with its own ops, driving the ordinary setReview path.
      opts.onCheckpoint?.({ chapterId: 9, version: 1 });
      opts.onOps?.({ chapterId: 9, ops: [{ id: 2, op: 'strip_tag', newText: 'Nine fixed', rationale: 'r' }] });
      return { reviewedChapters: 1, totalOps: 1 } as never;
    });
    let resolveGetState!: (v: Awaited<ReturnType<typeof api.getScriptReviewState>>) => void;
    vi.mocked(api.getScriptReviewState).mockImplementation(
      () => new Promise((resolve) => { resolveGetState = resolve; }),
    );

    const sentences = [
      { id: 1, chapterId: 5, text: 'Five fixed', characterId: 'c1' },
      { id: 2, chapterId: 9, text: 'Nine fixed', characterId: 'c1' },
    ];
    const opts = { dispatch: store.dispatch, sentences, characterIds: new Set(['c1']), manuscriptId: 'ms-1' };

    const chapter5 = attachToRunningReview('book-1', { chapterId: 5, replay: { lastPhase: null } }, opts);
    const chapter9 = attachToRunningReview('book-1', { chapterId: 9, replay: { lastPhase: null } }, opts);

    // Let chapter 9's job settle (dispatches setReview) BEFORE chapter 5's
    // fallback GET /state resolves — the exact ordering that used to lose
    // chapter 9's ops under the old hydrateBucket-replace behavior.
    await chapter9;
    expect(store.getState().scriptReview.byBook['book-1']?.ops.map((o) => o.chapterId)).toEqual([9]);

    resolveGetState({
      kind: 'ledger',
      entries: {
        '5': {
          manuscriptId: 'ms-1',
          version: 3,
          ops: [{ id: 1, op: 'strip_tag', newText: 'Five fixed', rationale: 'r' }],
          selected: {},
          completedAt: '2026-01-01',
        },
      },
    });
    await chapter5;

    const finalChapterIds = store.getState().scriptReview.byBook['book-1']?.ops.map((o) => o.chapterId).sort();
    expect(finalChapterIds).toEqual([5, 9]);
  });

  it('never dispatches clear itself, even on error — clear stays hoisted in hydrateScriptReview (round-5 fix, must not regress)', async () => {
    const dispatch = vi.fn();
    vi.mocked(api.attachScriptReview).mockRejectedValue(new Error('boom'));

    await attachToRunningReview(
      'book-1',
      { chapterId: 5, replay: { lastPhase: null } },
      { dispatch, sentences: [], characterIds: new Set(), manuscriptId: 'ms-1' },
    );

    expect(dispatch.mock.calls.some((c) => c[0].type === scriptReviewActions.clear.type)).toBe(false);
  });

  it('a cancelled-coded ReviewScriptError is swallowed without a toast', async () => {
    const dispatch = vi.fn();
    vi.mocked(api.attachScriptReview).mockRejectedValue(new ReviewScriptError('Review cancelled.', 'cancelled'));

    await attachToRunningReview(
      'book-1',
      { chapterId: 5, replay: { lastPhase: null } },
      { dispatch, sentences: [], characterIds: new Set(), manuscriptId: 'ms-1' },
    );

    expect(dispatch.mock.calls.some((c) => c[0].type === notificationsActions.pushToast.type)).toBe(false);
  });

  /* Regression for the code-review-workflow finding: a cancel that lands
     AFTER this join's own chapter already finished and checkpointed must
     not throw those away — design spec §2 explicitly promises cancelling
     never discards a chapter that finished checkpointing before the
     cancel. Simulates the join's replay delivering onCheckpoint/onOps
     (the chapter genuinely finished) before the stream's final event is
     the cancelled error (a sibling job's cancel, or this same job's own
     terminal event racing the client's read of it). */
  it('a cancelled-coded ReviewScriptError still dispatches setReview for whatever this join already accumulated', async () => {
    const dispatch = vi.fn();
    vi.mocked(api.attachScriptReview).mockImplementation(async (_bookId: string, opts: ReviewScriptOpts = {}) => {
      opts.onCheckpoint?.({ chapterId: 5, version: 3 });
      opts.onOps?.({ chapterId: 5, ops: [{ id: 1, op: 'strip_tag', newText: 'Five fixed', rationale: 'r' }] });
      throw new ReviewScriptError('Review cancelled.', 'cancelled');
    });

    await attachToRunningReview(
      'book-1',
      { chapterId: 5, replay: { lastPhase: null } },
      {
        dispatch,
        sentences: [{ id: 1, chapterId: 5, text: 'Five fixed', characterId: 'c1' }],
        characterIds: new Set(['c1']),
        manuscriptId: 'ms-1',
      },
    );

    expect(dispatch.mock.calls.some((c) => c[0].type === notificationsActions.pushToast.type)).toBe(false);
    expect(dispatch).toHaveBeenCalledWith(
      scriptReviewActions.setReview(
        expect.objectContaining({ bookId: 'book-1', manuscriptId: 'ms-1', versionByChapter: { 5: 3 } }),
      ),
    );
    const setReviewCall = dispatch.mock.calls.find(([a]) => a.type === scriptReviewActions.setReview.type);
    expect(setReviewCall?.[0].payload.ops).toHaveLength(1);
  });

  /* Regression for the code-review-workflow finding: onOps fires live per
     completed chunk, independent of whether the whole chapter finishes —
     but the server deliberately skips the checkpoint for a chapter still
     IN FLIGHT when the abort lands (design spec §4.1), so that chapter
     never gets a versionByChapter entry. Ops for such a chapter must be
     filtered out, not surfaced as if they were safely saved — only
     chapter 5 (checkpointed) should survive; chapter 9's partial ops
     (streamed but never checkpointed) must not. */
  it('a cancelled-coded ReviewScriptError filters out ops from a chapter that was still in flight (never checkpointed)', async () => {
    const dispatch = vi.fn();
    vi.mocked(api.attachScriptReview).mockImplementation(async (_bookId: string, opts: ReviewScriptOpts = {}) => {
      opts.onCheckpoint?.({ chapterId: 5, version: 3 });
      opts.onOps?.({ chapterId: 5, ops: [{ id: 1, op: 'strip_tag', newText: 'Five fixed', rationale: 'r' }] });
      // Chapter 9's chunk 1 streamed live, but the run is cancelled before
      // chapter 9 ever gets a checkpoint — no onCheckpoint call for it.
      opts.onOps?.({ chapterId: 9, ops: [{ id: 2, op: 'strip_tag', newText: 'Nine partial', rationale: 'r' }] });
      throw new ReviewScriptError('Review cancelled.', 'cancelled');
    });

    await attachToRunningReview(
      'book-1',
      { replay: { lastPhase: null } },
      {
        dispatch,
        sentences: [
          { id: 1, chapterId: 5, text: 'Five fixed', characterId: 'c1' },
          { id: 2, chapterId: 9, text: 'Nine partial', characterId: 'c1' },
        ],
        characterIds: new Set(['c1']),
        manuscriptId: 'ms-1',
      },
    );

    const setReviewCall = dispatch.mock.calls.find(([a]) => a.type === scriptReviewActions.setReview.type);
    expect(setReviewCall).toBeDefined();
    expect(setReviewCall?.[0].payload.ops.map((o: { chapterId: number }) => o.chapterId)).toEqual([5]);
    expect(setReviewCall?.[0].payload.versionByChapter).toEqual({ 5: 3 });
  });
});

describe('runReviewScript — cancellation (fs-58 follow-up #1481)', () => {
  it('a cancelled-coded ReviewScriptError is swallowed without a toast, and clear still fires', async () => {
    const dispatch = vi.fn();
    vi.mocked(api.reviewScript).mockRejectedValue(new ReviewScriptError('Review cancelled.', 'cancelled'));

    await runReviewScript('book-1', {
      dispatch, wholeBook: true, model: 'test-model', sentences: [], characterIds: new Set(), manuscriptId: 'ms-1',
    });

    expect(dispatch.mock.calls.some((c) => c[0].type === notificationsActions.pushToast.type)).toBe(false);
    const types = dispatch.mock.calls.map((c) => c[0].type);
    expect(types[types.length - 1]).toBe(scriptReviewActions.clear.type);
  });

  /* Regression for the code-review-workflow finding: chapters that
     finished and checkpointed before a whole-book (or per-chapter) run
     was cancelled must still show up, not silently vanish until reload —
     the same guarantee attachToRunningReview's own fix (above) provides
     for the reattach path. */
  it('a cancelled-coded ReviewScriptError still dispatches setReview for whatever chapters already checkpointed before the cancel', async () => {
    const dispatch = vi.fn();
    vi.mocked(api.reviewScript).mockImplementation(async (_bookId: string, opts: ReviewScriptOpts = {}) => {
      opts.onCheckpoint?.({ chapterId: 1, version: 1 });
      opts.onOps?.({ chapterId: 1, ops: [{ id: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' }] });
      throw new ReviewScriptError('Review cancelled.', 'cancelled');
    });

    await runReviewScript('book-1', {
      dispatch,
      wholeBook: true,
      model: 'test-model',
      sentences: [{ id: 1, chapterId: 1, text: 'Hi', characterId: 'c1' }],
      characterIds: new Set(['c1']),
      manuscriptId: 'ms-1',
    });

    expect(dispatch.mock.calls.some((c) => c[0].type === notificationsActions.pushToast.type)).toBe(false);
    expect(dispatch).toHaveBeenCalledWith(
      scriptReviewActions.setReview(
        expect.objectContaining({ bookId: 'book-1', manuscriptId: 'ms-1', versionByChapter: { 1: 1 } }),
      ),
    );
    // clear still fires last, from the finally block, even on this path.
    const types = dispatch.mock.calls.map((c) => c[0].type);
    expect(types[types.length - 1]).toBe(scriptReviewActions.clear.type);
  });

  /* Regression for the code-review-workflow finding: chapter 3's chunk 1
     streamed live via onOps, but the run is cancelled before chapter 3
     ever gets a checkpoint — the server skips it entirely (design spec
     §4.1: "nothing about the in-flight chapter survives a cancel"). Only
     chapter 1 (checkpointed) should survive; chapter 3's partial ops
     must not appear as if they were safely saved. */
  it('a cancelled-coded ReviewScriptError filters out ops from a chapter that was still in flight (never checkpointed)', async () => {
    const dispatch = vi.fn();
    vi.mocked(api.reviewScript).mockImplementation(async (_bookId: string, opts: ReviewScriptOpts = {}) => {
      opts.onCheckpoint?.({ chapterId: 1, version: 1 });
      opts.onOps?.({ chapterId: 1, ops: [{ id: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' }] });
      opts.onOps?.({ chapterId: 3, ops: [{ id: 2, op: 'strip_tag', newText: 'Three partial', rationale: 'r' }] });
      throw new ReviewScriptError('Review cancelled.', 'cancelled');
    });

    await runReviewScript('book-1', {
      dispatch,
      wholeBook: true,
      model: 'test-model',
      sentences: [
        { id: 1, chapterId: 1, text: 'Hi', characterId: 'c1' },
        { id: 2, chapterId: 3, text: 'Three partial', characterId: 'c1' },
      ],
      characterIds: new Set(['c1']),
      manuscriptId: 'ms-1',
    });

    const setReviewCall = dispatch.mock.calls.find(([a]) => a.type === scriptReviewActions.setReview.type);
    expect(setReviewCall).toBeDefined();
    expect(setReviewCall?.[0].payload.ops.map((o: { chapterId: number }) => o.chapterId)).toEqual([1]);
    expect(setReviewCall?.[0].payload.versionByChapter).toEqual({ 1: 1 });
  });
});

describe('discardReview', () => {
  it('calls the discard API then removes only the given chapters from the bucket', async () => {
    const dispatch = vi.fn();
    vi.mocked(api.discardScriptReview).mockResolvedValue(undefined);
    await discardReview('book-1', [3, 4], { dispatch });
    expect(api.discardScriptReview).toHaveBeenCalledWith('book-1', [3, 4]);
    expect(dispatch).toHaveBeenCalledWith(
      scriptReviewActions.removeChaptersLocally({ bookId: 'book-1', chapterIds: [3, 4] }),
    );
  });
});
