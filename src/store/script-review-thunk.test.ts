import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/api', () => ({
  api: {
    reviewScript: vi.fn(),
    getScriptReviewState: vi.fn(),
    discardScriptReview: vi.fn(),
    resolveScriptReviewOps: vi.fn(),
    patchScriptReviewSelection: vi.fn(),
  },
}));

import { api } from '../lib/api';
import type { ReviewScriptOpts } from '../lib/api';
import { runReviewScript, hydrateScriptReview, attachToRunningReview } from './script-review-thunk';
import { scriptReviewActions } from './script-review-slice';

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
    expect(lastProg.payload).toEqual({ bookId: 'b1', progress: 1 });
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
    });
  });
});

function makeFakeStore(initial: { manuscriptId: string | null; characters: Array<{ id: string }>; sentences: unknown[] }) {
  let state = {
    manuscript: { manuscriptId: initial.manuscriptId, sentences: initial.sentences },
    cast: { characters: initial.characters },
  };
  const listeners: Array<() => void> = [];
  return {
    getState: () => state as never,
    subscribe: (fn: () => void) => { listeners.push(fn); return () => {}; },
    setManuscriptReady: (manuscriptId: string, sentences: unknown[], characters: Array<{ id: string }>) => {
      state = { manuscript: { manuscriptId, sentences }, cast: { characters } };
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

describe('attachToRunningReview', () => {
  it('seeds progress from the replay buffer instead of resetting to 0', async () => {
    const dispatch = vi.fn();
    vi.mocked(api.reviewScript).mockResolvedValue({ reviewedChapters: 0, totalOps: 0 } as never);
    const runningState = {
      kind: 'running' as const,
      chapterId: undefined,
      replay: {
        opsEvents: [{ chapterId: 1, ops: [{ id: 1, op: 'strip_tag', newText: 'Hi', rationale: 'r' }] }],
        chapterFailedEvents: [],
        checkpointEvents: [{ chapterId: 1, version: 5 }],
        lastPhase: { progress: 0.4, label: 'Reviewing script' },
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
    expect(dispatch).toHaveBeenCalledWith(
      scriptReviewActions.setActive(expect.objectContaining({ bookId: 'book-1', progress: 0.4 })),
    );
    expect(dispatch).not.toHaveBeenCalledWith(scriptReviewActions.setActive(expect.objectContaining({ progress: 0 })));
  });

  it('dispatches setReview with the ops/versions delivered by the join\'s own replay — not double-counted with the GET /state snapshot', async () => {
    const dispatch = vi.fn();
    // Simulates Task 2's attachSubscriber: the join POST replays every
    // buffered event through the SAME onOps/onCheckpoint callbacks a live
    // stream would use. attachToRunningReview must rely on THIS, not on
    // pre-seeding from runningState.replay, or each op would count twice.
    vi.mocked(api.reviewScript).mockImplementation(async (_bookId: string, opts: ReviewScriptOpts = {}) => {
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
});
