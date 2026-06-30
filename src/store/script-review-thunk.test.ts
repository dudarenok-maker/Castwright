import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/api', () => ({
  api: {
    reviewScript: vi.fn(),
  },
}));
vi.mock('../lib/script-review-apply', () => ({
  planApply: () => ({ appliable: [], unappliable: [] }),
}));

import { api } from '../lib/api';
import type { ReviewScriptOpts } from '../lib/api';
import { runReviewScript } from './script-review-thunk';
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
});
