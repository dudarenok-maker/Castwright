import type { Middleware, MiddlewareAPI } from '@reduxjs/toolkit';
import { api, type QaRepairTick } from '../lib/api';
import { qaRepairActions, type QaRepairRequest } from './qa-repair-slice';
import { chaptersActions } from './chapters-slice';
import { notificationsActions } from './notifications-slice';

/* Plan 179 — drives a per-chapter audio-QA scan-and-repair in the background,
   so the run survives the Listen row that started it unmounting. Same shape as
   `splice-runner-middleware` (the repair runs THROUGH the fs-26 splice engine
   server-side): one SSE per chapter, a deduped progress toast while it runs, a
   summary toast at the end, and `markChapterAudioUpdated` so the Listen row
   picks up the new duration and cache-busts the audio.

   Unlike splice this does NOT enqueue an A/B revision: a repair spans whichever
   characters happened to own the flagged sentences, and `revisions` is keyed by
   a single characterId. The server still writes the `.previous.*` rollback. */

export function qaRepairRunnerMiddleware(): Middleware {
  return (store) => (next) => (action) => {
    const result = next(action);
    const a = action as { type?: string; payload?: unknown };
    if (a.type === 'qaRepair/start') {
      void runRepair(store, a.payload as QaRepairRequest);
    }
    return result;
  };
}

async function runRepair(mw: MiddlewareAPI, req: QaRepairRequest): Promise<void> {
  const dispatch = mw.dispatch;
  const { bookId, chapterId } = req;
  const toastKey = `qa-repair-${bookId}-${chapterId}`;

  dispatch(
    notificationsActions.pushToast({
      kind: 'info',
      message: `Checking chapter ${chapterId} for bad lines…`,
      dedupeKey: toastKey,
    }),
  );

  let repairedCount = 0;
  let failure: string | null = null;

  await api.streamQaRepair({
    bookId,
    chapterId,
    onTick: (ev: QaRepairTick) => {
      if (ev.type === 'warning' && ev.message) {
        /* The advisory this consumer exists for. `clearMismatchedDesignedVoices`
           dropped a reused designed voice whose baked manifest language differs
           from the book's, so the repair will re-record those lines in a
           DIFFERENT voice than the one the user picked. The repair is non-fatal
           and still proceeds, which is exactly why a silent drop was wrong.
           Deduped by code, matching generation-stream-runner's `warning` arm. */
        dispatch(
          notificationsActions.pushToast({
            kind: 'warn',
            message: ev.message,
            dedupeKey: `qa-repair-warning:${ev.code ?? ev.message}`,
          }),
        );
      } else if (ev.type === 'qa_scan') {
        dispatch(
          notificationsActions.pushToast({
            kind: 'info',
            message:
              ev.flaggedCount === 0
                ? `Chapter ${chapterId}: nothing flagged.`
                : `Chapter ${chapterId}: re-recording ${ev.flaggedCount} line${
                    ev.flaggedCount === 1 ? '' : 's'
                  }…`,
            dedupeKey: toastKey,
          }),
        );
      } else if (ev.type === 'qa_repair_complete') {
        repairedCount = ev.repaired?.length ?? 0;
        /* Refresh the Listen row — a re-record changes duration, and the
           renderedAt stamp is what cache-busts the audio element. */
        dispatch(
          chaptersActions.markChapterAudioUpdated({
            chapterId,
            durationSec: ev.durationSec,
            renderedAt: String(Date.now()),
          }),
        );
      } else if (ev.type === 'chapter_failed') {
        failure = ev.errorReason;
      }
    },
  });

  dispatch(notificationsActions.dismissByKey(toastKey));
  dispatch(qaRepairActions.finish(req));
  dispatch(
    notificationsActions.pushToast({
      kind: failure ? 'error' : 'info',
      message: failure
        ? `Chapter ${chapterId} repair failed — ${failure}`
        : repairedCount > 0
          ? `Chapter ${chapterId}: re-recorded ${repairedCount} line${repairedCount === 1 ? '' : 's'}.`
          : `Chapter ${chapterId}: nothing needed re-recording.`,
      dedupeKey: `${toastKey}-done`,
    }),
  );
}
