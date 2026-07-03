/* fs-54 — pins the Export pill's completion-linger contract: a book's last
   non-terminal job going done/failed sets a linger snapshot that clears
   after EXPORT_LINGER_MS, clears immediately if a new export starts on the
   same book first, and cancelled never lingers. Modeled on
   cast-design-stream-middleware.test.ts's fake-timer shape — same passive
   "does the snapshot still match what I set?" guard, no timer-handle
   bookkeeping (the reference middleware doesn't have any either). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { exportsSlice, exportsActions } from './exports-slice';
import { createExportPillMiddleware } from './export-pill-middleware';
import type { BookExportJob } from '../lib/types';

function makeJob(overrides: Partial<BookExportJob> = {}): BookExportJob {
  return {
    id: 'exp_1',
    bookId: 'b1',
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
  };
}

function makeStore() {
  return configureStore({
    reducer: { exports: exportsSlice.reducer },
    middleware: (getDefault) =>
      getDefault().concat(createExportPillMiddleware({ lingerMs: 5000 })),
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('exportPillMiddleware', () => {
  it("sets a done linger when a book's last non-terminal job finishes", () => {
    const store = makeStore();
    const job = makeJob({ status: 'in_progress' });
    store.dispatch(exportsActions.exportStarted(job));
    store.dispatch(exportsActions.exportUpdated({ ...job, status: 'done', progress: 1 }));
    expect(store.getState().exports.linger['b1']).toEqual({ state: 'done' });
  });

  it('sets a failed linger on failure', () => {
    const store = makeStore();
    const job = makeJob({ status: 'in_progress' });
    store.dispatch(exportsActions.exportStarted(job));
    store.dispatch(
      exportsActions.exportUpdated({ ...job, status: 'failed', errorReason: 'boom' }),
    );
    expect(store.getState().exports.linger['b1']).toEqual({ state: 'failed' });
  });

  it('does not linger while another non-terminal job for the same book remains', () => {
    const store = makeStore();
    const jobA = makeJob({ id: 'exp_a', status: 'in_progress' });
    const jobB = makeJob({ id: 'exp_b', status: 'in_progress' });
    store.dispatch(exportsActions.exportStarted(jobA));
    store.dispatch(exportsActions.exportStarted(jobB));
    store.dispatch(exportsActions.exportUpdated({ ...jobA, status: 'done', progress: 1 }));
    expect(store.getState().exports.linger['b1']).toBeUndefined();
  });

  it('clears the linger after the configured duration', () => {
    const store = makeStore();
    const job = makeJob({ status: 'in_progress' });
    store.dispatch(exportsActions.exportStarted(job));
    store.dispatch(exportsActions.exportUpdated({ ...job, status: 'done', progress: 1 }));
    vi.advanceTimersByTime(5001);
    expect(store.getState().exports.linger['b1']).toBeUndefined();
  });

  it('clears the linger immediately when a new export starts on the same book', () => {
    const store = makeStore();
    const job = makeJob({ status: 'in_progress' });
    store.dispatch(exportsActions.exportStarted(job));
    store.dispatch(exportsActions.exportUpdated({ ...job, status: 'done', progress: 1 }));
    expect(store.getState().exports.linger['b1']).toEqual({ state: 'done' });

    store.dispatch(exportsActions.exportStarted(makeJob({ id: 'exp_2', status: 'in_progress' })));
    expect(store.getState().exports.linger['b1']).toBeUndefined();
  });

  it('never lingers on cancelled', () => {
    const store = makeStore();
    const job = makeJob({ status: 'in_progress' });
    store.dispatch(exportsActions.exportStarted(job));
    store.dispatch(
      exportsActions.exportUpdated({
        ...job,
        status: 'cancelled',
        errorReason: 'Cancelled by user.',
      }),
    );
    expect(store.getState().exports.linger['b1']).toBeUndefined();
  });
});
