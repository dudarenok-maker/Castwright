/* Plan 82 — Retry/Download thunks for the Export queue rail.

   `retryExport` re-fires a failed export with the same wire params the
   adapter stamped onto the queue row (format + destination, plus the
   three caption fields when format === 'captions' — fs-52 final-review
   fix; the server 400s a captions POST missing them). Dispatches
   `exportDismissed` first so the failed row vanishes; the new job
   appears at the top via `exportStarted` once the server accepts the
   POST. This dismiss-before-POST ordering (and the lack of a .catch on
   the original POST) predates fs-52 — see git blame on this file
   (plan 82, commits 00744332 / f7811e94) — so it's left as-is for the
   general case; the try/catch added below is a minimal safety net so a
   failed retry POST surfaces a toast instead of an unhandled rejection,
   not a redesign of the retry-UX.

   The download path doesn't need a thunk — the row click handler in
   src/views/listen.tsx builds the /download URL or assigns item.url
   directly. Only retry needs to chain dismiss + api.createBookExport. */

import type { Dispatch, Middleware, AnyAction } from '@reduxjs/toolkit';
import { api } from '../lib/api';
import type { BookExportJob, BookExportRequest } from '../lib/types';
import { exportsActions } from './exports-slice';
import { notificationsActions } from './notifications-slice';

export interface RetryExportArgs {
  bookId: string;
  exportId: string;
  format: BookExportRequest['format'];
  destination: BookExportRequest['destination'];
  /* Informational — surfaced in the row, NOT part of the wire request.
     The server decides the actual sync folder from user settings. */
  syncPath?: string;
  /* fs-52 final-review fix — required by the server whenever
     format === 'captions'; omitted from the wire body otherwise
     (mirrors the ExportPrefill submit-payload pattern in
     export-audiobook.tsx's handleSubmit). */
  captionFileFormat?: 'srt' | 'vtt';
  captionGranularity?: 'line' | 'sentence' | 'word';
  captionScope?: 'whole-book' | 'per-chapter';
}

export function retryExport(args: RetryExportArgs) {
  return async (dispatch: Dispatch) => {
    dispatch(
      exportsActions.exportDismissed({ bookId: args.bookId, exportId: args.exportId }),
    );
    try {
      const job = await api.createBookExport(args.bookId, {
        format: args.format,
        destination: args.destination,
        ...(args.format === 'captions'
          ? {
              captionFileFormat: args.captionFileFormat,
              captionGranularity: args.captionGranularity,
              captionScope: args.captionScope,
            }
          : {}),
      });
      dispatch(exportsActions.exportStarted(job));
      return job;
    } catch (e) {
      dispatch(
        notificationsActions.pushToast({
          kind: 'error',
          message: `Retry failed: ${e instanceof Error ? e.message : String(e)}`,
          dedupeKey: 'export-retry-failed',
        }),
      );
      return undefined;
    }
  };
}

/* ── Self-driving export poll middleware ───────────────────────────────
   The export modal used to be the only poller (a useEffect keyed on the
   active job id). That froze the queue-rail bars whenever the modal was
   closed or the Listen view unmounted, and meant a rail-initiated Retry
   never advanced. This middleware makes polling a store-level concern:
   whenever a non-terminal job lives in `exports.byBookId`, it polls that
   job until terminal, dispatching `exportUpdated`. The modal and the rail
   become pure views of the slice — inherently synced and truthful.

   It also owns the end of a cancel (#2303): a job seen running that turns
   `cancelled` leaves the slice here, so that happens with the modal closed or
   the Listen view left behind. */

const TERMINAL: ReadonlySet<BookExportJob['status']> = new Set(['done', 'failed', 'cancelled']);
export const EXPORT_POLL_INTERVAL_MS = 800;

interface ExportsPollableState {
  exports: { byBookId: Record<string, BookExportJob[]> };
}

/* The actions that can carry a job's new status into the slice. */
const STATUS_ACTIONS: ReadonlySet<string> = new Set([
  'exports/exportUpdated',
  'exports/exportsHydrated',
]);

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

    const allJobs = (): BookExportJob[] =>
      Object.values((store.getState() as ExportsPollableState).exports.byBookId).flat();

    /* Only a user's DELETE ends a job `cancelled`, so drop the row and, when
       its files had already reached the sync folder, say so (#4228). */
    const settleCancelled = (job: BookExportJob) => {
      store.dispatch(exportsActions.exportDismissed({ bookId: job.bookId, exportId: job.id }));
      if (job.syncPath) {
        store.dispatch(
          notificationsActions.pushToast({
            kind: 'info',
            message: `Export cancelled, but its files were already copied to your sync folder (${job.syncPath}).`,
            dedupeKey: 'export-cancel-synced',
          }),
        );
      }
    };

    return (next) => (action) => {
      const type = (action as AnyAction)?.type;
      /* Read before `next`: which jobs were still running until this action. */
      const running = STATUS_ACTIONS.has(type)
        ? new Set(
            allJobs()
              .filter((j) => !TERMINAL.has(j.status))
              .map((j) => j.id),
          )
        : undefined;
      const result = next(action);
      if (running) {
        for (const job of allJobs()) {
          if (job.status === 'cancelled' && running.has(job.id)) settleCancelled(job);
        }
      }
      if (typeof type === 'string' && POLL_TRIGGER_ACTIONS.has(type)) reconcile();
      return result;
    };
  };
}

/** Singleton wired into the store in `src/store/index.ts`. */
export const exportPollMiddleware: Middleware = createExportPollMiddleware();

/** One out-of-turn read of a job, so its row shows a status change (a cancel
    click) without waiting for the next poll. A job that left the slice while the
    read was pending stays gone. A failed read is left to the poll. */
export function refreshExport(bookId: string, exportId: string) {
  return async (dispatch: Dispatch, getState: () => unknown) => {
    try {
      const job = await api.getBookExport(bookId, exportId);
      const list = (getState() as ExportsPollableState).exports.byBookId[bookId];
      if (list?.some((j) => j.id === exportId)) dispatch(exportsActions.exportUpdated(job));
    } catch {
      /* swallow */
    }
  };
}

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
