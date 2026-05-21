/* Plan 82 — Retry/Download thunks for the Export queue rail.

   `retryExport` re-fires a failed export with the same wire params the
   adapter stamped onto the queue row (format + destination, the only
   fields BookExportRequest carries). Dispatches `exportDismissed` first
   so the failed row vanishes; the new job appears at the top via
   `exportStarted` once the server accepts the POST.

   The download path doesn't need a thunk — the row click handler in
   src/views/listen.tsx builds the /download URL or assigns item.url
   directly. Only retry needs to chain dismiss + api.createBookExport. */

import type { Dispatch } from '@reduxjs/toolkit';
import { api } from '../lib/api';
import type { BookExportRequest } from '../lib/types';
import { exportsActions } from './exports-slice';

export interface RetryExportArgs {
  bookId: string;
  exportId: string;
  format: BookExportRequest['format'];
  destination: BookExportRequest['destination'];
  /* Informational — surfaced in the row, NOT part of the wire request.
     The server decides the actual sync folder from user settings. */
  syncPath?: string;
}

export function retryExport(args: RetryExportArgs) {
  return async (dispatch: Dispatch) => {
    dispatch(
      exportsActions.exportDismissed({ bookId: args.bookId, exportId: args.exportId }),
    );
    const job = await api.createBookExport(args.bookId, {
      format: args.format,
      destination: args.destination,
    });
    dispatch(exportsActions.exportStarted(job));
    return job;
  };
}
