/* fs-54 — Export status-pill completion linger. Watches `exports/exportUpdated`
   for a job transitioning into a terminal state; when a book's LAST
   non-terminal job goes `done`/`failed`, records a brief linger snapshot
   (exports-slice's `linger` state) so the global Export pill can show
   "Export done" / "Export failed" for a few seconds even if the user isn't
   on that book's Listen view. `cancelled` never lingers — it's a result of
   the user's own dismiss/retry action, not something to notify about after
   the fact.

   Modeled on cast-design-stream-middleware.ts's terminal-summary pattern: a
   passive setTimeout that no-ops if the snapshot it set has since been
   replaced or cleared — no timer-handle bookkeeping to cancel (the Design
   pill's own reference middleware doesn't do that either; it just re-checks
   state when the timer fires). A NEW export starting on a book while a
   linger is showing clears it immediately so live progress isn't shadowed
   by a stale summary — the now-orphaned pending timeout's own no-op check
   handles cleanup for the timer that was about to fire anyway. */

import type { Middleware, AnyAction } from '@reduxjs/toolkit';
import { exportsActions } from './exports-slice';
import type { BookExportJob } from '../lib/types';

/** ms the terminal "Export done"/"Export failed" summary lingers before the
    pill clears — matches the Design pill's SUMMARY_LINGER_MS
    (cast-design-stream-middleware.ts). */
export const EXPORT_LINGER_MS = 5000;

const TERMINAL: ReadonlySet<BookExportJob['status']> = new Set(['done', 'failed', 'cancelled']);

interface ExportsRootState {
  exports: {
    byBookId: Record<string, BookExportJob[]>;
    linger: Record<string, { state: 'done' | 'failed' }>;
  };
}

/** Factory so tests can inject a short linger duration. */
export function createExportPillMiddleware(opts?: { lingerMs?: number }): Middleware {
  const lingerMs = opts?.lingerMs ?? EXPORT_LINGER_MS;

  return (store) => (next) => (action) => {
    const result = next(action);
    const a = action as AnyAction;

    if (a.type === exportsActions.exportUpdated.type) {
      const job = a.payload as BookExportJob;
      if (job.status === 'done' || job.status === 'failed') {
        const jobs = (store.getState() as ExportsRootState).exports.byBookId[job.bookId] ?? [];
        const stillRunning = jobs.some((j) => !TERMINAL.has(j.status));
        if (!stillRunning) {
          const terminalState = job.status;
          store.dispatch(
            exportsActions.exportLingerSet({ bookId: job.bookId, state: terminalState }),
          );
          setTimeout(() => {
            const state = store.getState() as ExportsRootState;
            if (state.exports.linger[job.bookId]?.state === terminalState) {
              store.dispatch(exportsActions.exportLingerCleared({ bookId: job.bookId }));
            }
          }, lingerMs);
        }
      }
    }

    if (a.type === exportsActions.exportStarted.type) {
      const job = a.payload as BookExportJob;
      const state = store.getState() as ExportsRootState;
      if (state.exports.linger[job.bookId]) {
        store.dispatch(exportsActions.exportLingerCleared({ bookId: job.bookId }));
      }
    }

    return result;
  };
}

/** Singleton wired into the store in `src/store/index.ts`. */
export const exportPillMiddleware: Middleware = createExportPillMiddleware();
