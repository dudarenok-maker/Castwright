/* Plan 82 — coverage for the retryExport thunk that re-fires a failed
   export using the wire context carried on the ExportQueueItem. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { exportsSlice, type ExportsState } from './exports-slice';
import { retryExport } from './exports-middleware';
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
