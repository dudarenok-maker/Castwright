/* Plan 82 — coverage for the retryExport thunk that re-fires a failed
   export using the wire context carried on the ExportQueueItem. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { exportsSlice, exportsActions, type ExportsState } from './exports-slice';
import { retryExport, createExportPollMiddleware } from './exports-middleware';
import type { BookExportJob } from '../lib/types';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    createBookExport: vi.fn(),
  },
}));

const makeJob = (overrides: Partial<BookExportJob> = {}): BookExportJob => ({
  id: 'exp_new',
  bookId: 'demo__sa__test',
  format: 'mp3-zip',
  destination: 'download',
  status: 'in_progress',
  filename: 'Test.zip',
  sizeBytes: null,
  progress: 0,
  downloadUrl: null,
  syncPath: null,
  errorReason: null,
  createdAt: '2025-01-01T00:00:00Z',
  completedAt: null,
  ...overrides,
});

function makeStore(seed: ExportsState) {
  return configureStore({
    reducer: { exports: exportsSlice.reducer },
    preloadedState: { exports: seed },
  });
}

describe('retryExport thunk', () => {
  beforeEach(() => {
    vi.mocked(api.createBookExport).mockReset();
  });

  it('dismisses the failed row and re-fires createBookExport with the original wire params', async () => {
    const failed = makeJob({ id: 'exp_fail', status: 'failed', errorReason: 'transient 502' });
    const fresh = makeJob({ id: 'exp_new', status: 'in_progress' });
    vi.mocked(api.createBookExport).mockResolvedValueOnce(fresh);

    const store = makeStore({
      byBookId: { [failed.bookId]: [failed] },
      lanUrls: [],
      lanPort: null,
    });

    await retryExport({
      bookId: failed.bookId,
      exportId: failed.id,
      format: 'mp3-zip',
      destination: 'download',
    })(store.dispatch);

    expect(api.createBookExport).toHaveBeenCalledWith(failed.bookId, {
      format: 'mp3-zip',
      destination: 'download',
    });
    const list = store.getState().exports.byBookId[failed.bookId] ?? [];
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('exp_new');
    expect(list[0].status).toBe('in_progress');
  });

  it('returns the new job for callers that want to chain off it', async () => {
    const failed = makeJob({ id: 'exp_fail', status: 'failed' });
    const fresh = makeJob({ id: 'exp_retry', status: 'in_progress' });
    vi.mocked(api.createBookExport).mockResolvedValueOnce(fresh);

    const store = makeStore({
      byBookId: { [failed.bookId]: [failed] },
      lanUrls: [],
      lanPort: null,
    });

    const returned = await retryExport({
      bookId: failed.bookId,
      exportId: failed.id,
      format: 'm4b',
      destination: 'sync-folder',
    })(store.dispatch);

    expect(returned).toEqual(fresh);
  });
});

/* Poll middleware — reuses the `makeJob` factory above (defaults to bookId
   'demo__sa__test'); these tests pin a fixed 'b1' bookId + 'exp_1' id so
   they read straight from byBookId['b1'][0]. */
function makePollStore(getExport: (b: string, e: string) => Promise<BookExportJob>) {
  return configureStore({
    reducer: { exports: exportsSlice.reducer },
    middleware: (gd) => gd().concat(createExportPollMiddleware({ getExport, intervalMs: 100 })),
  });
}

describe('export poll middleware', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('polls a started in_progress job until it reaches done', async () => {
    const getExport = vi
      .fn()
      .mockResolvedValueOnce(makeJob({ id: 'exp_1', bookId: 'b1', status: 'in_progress', progress: 0.5 }))
      .mockResolvedValueOnce(makeJob({ id: 'exp_1', bookId: 'b1', status: 'done', progress: 1 }));
    const store = makePollStore(getExport);
    store.dispatch(
      exportsActions.exportStarted(makeJob({ id: 'exp_1', bookId: 'b1', status: 'in_progress', progress: 0 })),
    );
    await vi.advanceTimersByTimeAsync(120);
    expect(store.getState().exports.byBookId['b1'][0].progress).toBe(0.5);
    await vi.advanceTimersByTimeAsync(120);
    expect(store.getState().exports.byBookId['b1'][0].status).toBe('done');
    await vi.advanceTimersByTimeAsync(300);
    expect(getExport).toHaveBeenCalledTimes(2); // no polls after terminal
  });

  it('does not resurrect a job dismissed while a poll was in flight', async () => {
    const getExport = vi
      .fn()
      .mockResolvedValue(makeJob({ id: 'exp_1', bookId: 'b1', status: 'in_progress', progress: 0.5 }));
    const store = makePollStore(getExport);
    store.dispatch(exportsActions.exportStarted(makeJob({ id: 'exp_1', bookId: 'b1', status: 'in_progress' })));
    store.dispatch(exportsActions.exportDismissed({ bookId: 'b1', exportId: 'exp_1' }));
    await vi.advanceTimersByTimeAsync(300);
    expect(store.getState().exports.byBookId['b1'] ?? []).toHaveLength(0);
  });
});
