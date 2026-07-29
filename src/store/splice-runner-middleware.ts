import type { Middleware, MiddlewareAPI } from '@reduxjs/toolkit';
import { api, type SpliceTick } from '../lib/api';
import { spliceActions, type SpliceBatchRequest } from './splice-slice';
import { revisionsActions } from './revisions-slice';
import { chaptersActions } from './chapters-slice';
import { notificationsActions } from './notifications-slice';

/* fs-26 — drives a per-character splice batch in the background: one splice SSE
   per chapter, sequentially, so the work survives the Fix-audio modal closing.
   Per chapter it enqueues a pending A/B revision, and on completion flips it
   playable + refreshes the Listen row (duration + cache-bust). A best-effort
   progress toast gives an at-a-glance global readout; the `splice` slice is the
   durable source the modal reads while open. */

const controllers = new Map<string, AbortController>();

export function spliceRunnerMiddleware(): Middleware {
  return (store) => (next) => (action) => {
    const result = next(action);
    const a = action as { type?: string; payload?: unknown };
    if (a.type === 'splice/startBatch') {
      void runBatch(store, a.payload as SpliceBatchRequest);
    } else if (a.type === 'splice/cancelBatch') {
      const id = (a.payload as { id: string }).id;
      controllers.get(id)?.abort();
      controllers.delete(id);
    }
    return result;
  };
}

async function runBatch(mw: MiddlewareAPI, req: SpliceBatchRequest): Promise<void> {
  const dispatch = mw.dispatch;
  const controller = new AbortController();
  controllers.set(req.id, controller);

  const firstName = req.characterName.split(' ')[0] || req.characterName;
  const toastKey = `splice-${req.bookId}-${req.characterId}`;
  const total = req.chapterIds.length;
  const progressToast = (processed: number) =>
    dispatch(
      notificationsActions.pushToast({
        kind: 'info',
        message: `Fixing ${firstName}: ${processed}/${total} chapter${total === 1 ? '' : 's'}`,
        dedupeKey: toastKey,
      }),
    );

  progressToast(0);
  let succeeded = 0;
  let failed = 0;

  for (const chapterId of req.chapterIds) {
    if (controller.signal.aborted) break;
    const revisionId = `splice-${req.bookId}-${chapterId}-${req.characterId}`;
    dispatch(
      revisionsActions.enqueuePending({
        id: revisionId,
        chapterId,
        characterId: req.characterId,
        playable: false,
        hasPreviousAudio: true,
        triggeredBy:
          req.mode === 'remix' ? `Loudness fix (${firstName})` : `Re-record (${firstName})`,
        segments: [],
      }),
    );

    let ok = false;
    await api.streamSplice({
      bookId: req.bookId,
      chapterId,
      mode: req.mode,
      characterId: req.characterId,
      ...(req.mode === 'remix'
        ? { gainDb: req.gainDb }
        : {
            modelKey: req.modelKey,
            ...(req.segmentIndices ? { segmentIndices: req.segmentIndices } : {}),
          }),
      signal: controller.signal,
      onTick: (ev: SpliceTick) => {
        if (ev.type === 'warning' && ev.message) {
          /* Non-fatal run-setup advisory (today: a non-English book's reused
             designed voices were cleared because their baked manifest language
             differs from the book's). The splice still proceeds, but the user
             MUST see it — a silently cleared voice re-records the line in a
             voice the user never chose. Same shape and dedupe strategy as
             generation-stream-runner's `warning` arm; deduped by code so a
             multi-chapter batch can't stack one toast per chapter. */
          dispatch(
            notificationsActions.pushToast({
              kind: 'warn',
              message: ev.message,
              dedupeKey: `splice-warning:${ev.code ?? ev.message}`,
            }),
          );
        }
        if (ev.type === 'splice_complete') {
          ok = true;
          dispatch(revisionsActions.markRevisionPlayable({ chapterId }));
          /* Refresh the Listen row: re-record changes duration, a gain remix
             doesn't — the renderedAt stamp is what cache-busts the audio. Guarded on
             `currentBookId`, matching qa-repair-runner-middleware: `chapters` is keyed by
             bare `chapterId` alone (ids repeat 1..N across every book), so a splice that
             finishes after the user has navigated to a DIFFERENT book would otherwise
             stamp that other book's same-numbered chapter with this splice's duration. */
          if (mw.getState().chapters.currentBookId === req.bookId) {
            dispatch(
              chaptersActions.markChapterAudioUpdated({
                chapterId,
                durationSec: ev.durationSec,
                renderedAt: String(Date.now()),
              }),
            );
          }
        }
      },
    });

    dispatch(spliceActions.recordChapterResult({ id: req.id, ok }));
    if (ok) succeeded += 1;
    else failed += 1;
    if (!controller.signal.aborted) progressToast(succeeded + failed);
  }

  controllers.delete(req.id);
  dispatch(spliceActions.finishBatch({ id: req.id }));
  dispatch(notificationsActions.dismissByKey(toastKey));

  if (!controller.signal.aborted) {
    const verb = req.mode === 'remix' ? 'Boosted' : 'Re-recorded';
    dispatch(
      notificationsActions.pushToast({
        kind: failed > 0 ? 'warn' : 'info',
        message:
          failed > 0
            ? `${verb} ${firstName} in ${succeeded}/${total} chapters — ${failed} failed. Review in the revisions panel.`
            : `${verb} ${firstName} in ${succeeded} chapter${succeeded === 1 ? '' : 's'}. Review in the revisions panel.`,
        dedupeKey: `${toastKey}-done`,
      }),
    );
  }
}
