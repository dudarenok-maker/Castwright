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
import { runReviewScript, hydrateScriptReview } from './script-review-thunk';
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
    await runReviewScript('b1', { dispatch, wholeBook: true, model: 'gemma', sentences: [], characterIds: new Set<string>() });
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
    await runReviewScript('b1', { dispatch, wholeBook: true, model: 'gemma', sentences: [], characterIds: new Set<string>() });
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
});
