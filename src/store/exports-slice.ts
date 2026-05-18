/* Per-book export job tracker. Drives the Listen view's Export modal and
   the `ExportQueue` rail beneath the Listen view.

   Shape:
   - `byBookId[bookId]` — newest-first list of jobs for that book. The
     modal pushes a job on `createBookExport`, polls `getBookExport` and
     dispatches `exportProgressed` / `exportSucceeded` / `exportFailed`
     as the server reports back.
   - `lanUrls` — non-loopback IPv4 URLs the server is reachable on.
     Hydrated once when the modal opens so the user can scan the QR to
     download the audiobook to their Android phone over Wi-Fi. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { BookExportJob } from '../lib/types';

export interface ExportsState {
  byBookId: Record<string, BookExportJob[]>;
  lanUrls: string[];
  lanPort: number | null;
}

const initialState: ExportsState = {
  byBookId: {},
  lanUrls: [],
  lanPort: null,
};

export const exportsSlice = createSlice({
  name: 'exports',
  initialState,
  reducers: {
    /* Newest-first prepend so the modal's "current export" view shows the
       latest job at the top of the queue without filtering. */
    exportStarted: (s, a: PayloadAction<BookExportJob>) => {
      const job = a.payload;
      const list = s.byBookId[job.bookId] ?? (s.byBookId[job.bookId] = []);
      list.unshift(job);
    },

    /* Patch in-place on poll updates. We accept the full BookExportJob
       payload because the server is the source of truth for every
       transient field — partial merges would just risk drift. */
    exportUpdated: (s, a: PayloadAction<BookExportJob>) => {
      const job = a.payload;
      const list = s.byBookId[job.bookId];
      if (!list) {
        s.byBookId[job.bookId] = [job];
        return;
      }
      const idx = list.findIndex((j) => j.id === job.id);
      if (idx < 0) list.unshift(job);
      else list[idx] = job;
    },

    /* Remove a job from the rail. The modal exposes this via a "Dismiss"
       button on done/failed rows. */
    exportDismissed: (s, a: PayloadAction<{ bookId: string; exportId: string }>) => {
      const list = s.byBookId[a.payload.bookId];
      if (!list) return;
      s.byBookId[a.payload.bookId] = list.filter((j) => j.id !== a.payload.exportId);
    },

    lanUrlsHydrated: (s, a: PayloadAction<{ urls: string[]; port: number }>) => {
      s.lanUrls = a.payload.urls;
      s.lanPort = a.payload.port;
    },
  },
});

export const exportsActions = exportsSlice.actions;
