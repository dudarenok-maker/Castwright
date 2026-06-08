/* Plan 82 — Retry/Download thunks for the Export queue rail.

   `retryExport` re-fires a failed export with the same wire params the
   adapter stamped onto the queue row (format + destination, the only
   fields BookExportRequest carries). Dispatches `exportDismissed` first
   so the failed row vanishes; the new job appears at the top via
   `exportStarted` once the server accepts the POST.

   The download path doesn't need a thunk — the row click handler in
   src/views/listen.tsx builds the /download URL or assigns item.url
   directly. Only retry needs to chain dismiss + api.createBookExport. */

import type { Dispatch, Middleware, AnyAction } from '@reduxjs/toolkit';
import { api } from '../lib/api';
import type { BookExportJob, BookExportRequest } from '../lib/types';
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

/* ── Self-driving export poll middleware ───────────────────────────────
   The export modal used to be the only poller (a useEffect keyed on the
   active job id). That froze the queue-rail bars whenever the modal was
   closed or the Listen view unmounted, and meant a rail-initiated Retry
   never advanced. This middleware makes polling a store-level concern:
   whenever a non-terminal job lives in `exports.byBookId`, it polls that
   job until terminal, dispatching `exportUpdated`. The modal and the rail
   become pure views of the slice — inherently synced and truthful. */

const TERMINAL: ReadonlySet<BookExportJob['status']> = new Set(['done', 'failed', 'cancelled']);
export const EXPORT_POLL_INTERVAL_MS = 800;

interface ExportsPollableState {
  exports: { byBookId: Record<string, BookExportJob[]> };
}

const POLL_TRIGGER_ACTIONS: ReadonlySet<string> = new Set([
  'exports/exportStarted',
  'exports/exportUpdated',
  'exports/exportsHydrated',
  'exports/exportDismissed',
]);

/** Factory so tests can inject a stub `getExport` + a short interval. */
export function createExportPollMiddleware(opts?: {
  getExport?: (bookId: string, exportId: string) => Promise<BookExportJob>;
  intervalMs?: number;
}): Middleware {
  const getExport = opts?.getExport ?? ((b: string, e: string) => api.getBookExport(b, e));
  const intervalMs = opts?.intervalMs ?? EXPORT_POLL_INTERVAL_MS;

  return (store) => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const findJob = (bookId: string, exportId: string): BookExportJob | undefined =>
      (store.getState() as ExportsPollableState).exports.byBookId[bookId]?.find(
        (j) => j.id === exportId,
      );

    const stop = (exportId: string) => {
      const h = timers.get(exportId);
      if (h !== undefined) {
        clearTimeout(h);
        timers.delete(exportId);
      }
    };

    const ensure = (bookId: string, exportId: string) => {
      if (timers.has(exportId)) return;
      const tick = async () => {
        if (!findJob(bookId, exportId)) return stop(exportId);
        try {
          const job = await getExport(bookId, exportId);
          if (!findJob(bookId, exportId)) return stop(exportId); // dismissed mid-flight
          store.dispatch(exportsActions.exportUpdated(job));
          if (TERMINAL.has(job.status)) return stop(exportId);
        } catch {
          /* swallow — reschedule below so a transient failure self-heals */
        }
        const cur = findJob(bookId, exportId);
        if (cur && !TERMINAL.has(cur.status)) {
          timers.set(exportId, setTimeout(tick, intervalMs));
        } else {
          stop(exportId);
        }
      };
      timers.set(exportId, setTimeout(tick, intervalMs));
    };

    const reconcile = () => {
      const byBookId = (store.getState() as ExportsPollableState).exports.byBookId;
      const live = new Set<string>();
      for (const [bookId, list] of Object.entries(byBookId)) {
        for (const job of list) {
          if (!TERMINAL.has(job.status)) {
            live.add(job.id);
            ensure(bookId, job.id);
          }
        }
      }
      for (const id of [...timers.keys()]) {
        if (!live.has(id)) stop(id);
      }
    };

    return (next) => (action) => {
      const result = next(action);
      const type = (action as AnyAction)?.type;
      if (typeof type === 'string' && POLL_TRIGGER_ACTIONS.has(type)) reconcile();
      return result;
    };
  };
}

/** Singleton wired into the store in `src/store/index.ts`. */
export const exportPollMiddleware: Middleware = createExportPollMiddleware();

/** Listen-mount rehydrate: pull the server's job list for a book and seed
    the slice. The poll middleware then advances any non-terminal rows. */
export function hydrateBookExports(bookId: string) {
  return async (dispatch: Dispatch) => {
    try {
      const jobs = await api.listBookExports(bookId);
      dispatch(exportsActions.exportsHydrated({ bookId, jobs }));
    } catch {
      /* swallow — the rail just stays empty if the list fetch fails */
    }
  };
}
