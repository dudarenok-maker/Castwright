/* Reducer-only tests for the exports slice. The polling + thunk behaviour
   lives inside the modal component and is covered there. */

import { describe, it, expect } from 'vitest';
import { exportsSlice, exportsActions, type ExportsState } from './exports-slice';
import type { BookExportJob } from '../lib/types';

const makeJob = (overrides: Partial<BookExportJob> = {}): BookExportJob => ({
  id: 'exp_1',
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

const initial: ExportsState = { byBookId: {}, lanUrls: [], lanPort: null };

describe('exportsSlice', () => {
  it('prepends a job to byBookId on exportStarted', () => {
    const job = makeJob();
    const s = exportsSlice.reducer(initial, exportsActions.exportStarted(job));
    expect(s.byBookId[job.bookId]).toEqual([job]);
  });

  it('exportUpdated patches an existing job in place', () => {
    const job = makeJob({ progress: 0.1 });
    let s = exportsSlice.reducer(initial, exportsActions.exportStarted(job));
    s = exportsSlice.reducer(s, exportsActions.exportUpdated({ ...job, progress: 0.5 }));
    expect(s.byBookId[job.bookId][0].progress).toBe(0.5);
    expect(s.byBookId[job.bookId].length).toBe(1);
  });

  it('exportUpdated prepends when the job is unknown', () => {
    const known = makeJob({ id: 'exp_known' });
    const unknown = makeJob({ id: 'exp_unknown' });
    let s = exportsSlice.reducer(initial, exportsActions.exportStarted(known));
    s = exportsSlice.reducer(s, exportsActions.exportUpdated(unknown));
    expect(s.byBookId[known.bookId].map(j => j.id)).toEqual(['exp_unknown', 'exp_known']);
  });

  it('exportDismissed drops the matching job', () => {
    const job = makeJob();
    let s = exportsSlice.reducer(initial, exportsActions.exportStarted(job));
    s = exportsSlice.reducer(s, exportsActions.exportDismissed({ bookId: job.bookId, exportId: job.id }));
    expect(s.byBookId[job.bookId]).toEqual([]);
  });

  it('lanUrlsHydrated replaces the URL list and port', () => {
    const s = exportsSlice.reducer(initial, exportsActions.lanUrlsHydrated({
      urls: ['http://192.168.1.42:8080'],
      port: 8080,
    }));
    expect(s.lanUrls).toEqual(['http://192.168.1.42:8080']);
    expect(s.lanPort).toBe(8080);
  });
});
