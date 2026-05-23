/* Plan 102 Wave 4a — queue dispatcher middleware.
 *
 * Drains the workspace queue (queue-slice mirror of <workspace>/.queue.json)
 * one chapter at a time. The contract is intentionally narrow so the existing
 * generation-stream middleware keeps owning the SSE lifecycle:
 *
 *   1. Pick the head queued entry whose bookId matches the slice's currently
 *      loaded book (same-book gate — cross-book dispatch is Wave 4b).
 *   2. Dispatch chaptersActions.regenerateChapter for that chapter; the
 *      existing middleware opens the SSE for it.
 *   3. When the SSE finishes (idle tick → activeStream cleared), DELETE
 *      the entry from the server queue. The resulting setSnapshot fires
 *      tick() again, which picks the next entry (or stops).
 *
 * Local state (inFlightEntryId) is the source of truth for "which entry
 * did I dispatch a regenerate for." The server-side status field stays
 * "queued" the whole way; we never call /start. The modal infers in-flight
 * visually by correlating the head entry's bookId/chapterId with the
 * chapters slice's activeStream snapshot (Wave 4b).
 *
 * Bug fix surface (per plan 102 doc):
 *   - Regenerate-during-regenerate no longer drops in-flight work.
 *     The 10 regen sites now append to the queue instead of dispatching
 *     regenerateChapter directly. The dispatcher serialises them so the
 *     in-flight chapter keeps streaming uninterrupted. */

import type { Middleware, MiddlewareAPI } from '@reduxjs/toolkit';
import { chaptersActions, type ChaptersState } from './chapters-slice';
import { queueActions, type QueueState } from './queue-slice';
import { cancelQueueEntry } from './queue-thunks';
import type { UiState } from './ui-slice';
import type { AppDispatch } from './index';

interface DispatcherRootState {
  ui: UiState;
  chapters: ChaptersState;
  queue: QueueState;
}

export const queueDispatcherMiddleware: Middleware = (storeApi: MiddlewareAPI) => {
  /* Which entry did the dispatcher last fire regenerateChapter for. The
     entry is DELETEd from the server queue when the SSE completes (idle
     tick → clearActiveStream). Null between drains. */
  let inFlightEntryId: string | null = null;

  const dispatch = storeApi.dispatch as AppDispatch;

  const tick = (): void => {
    const state = storeApi.getState() as DispatcherRootState;
    const { queue, chapters } = state;

    /* Cold-boot gate — wait for the initial GET /api/queue before doing
       anything. Without this, an empty pre-load snapshot would tempt the
       dispatcher to do nothing (correct) but also masks the "is the queue
       authoritative yet?" question for tests. */
    if (!queue.loaded) return;

    /* Queue-global pause stops the drain at the next boundary. The
       in-flight chapter (if any) finishes — the existing middleware
       handles its own teardown — but the dispatcher won't pick up the
       next entry while paused. */
    if (queue.paused) return;

    /* If an SSE handle is open, wait for it to drain. This covers both
       (a) our own regenerate that's still in flight, and (b) any other
       open path the existing middleware drove (e.g. cold-boot auto-
       resume of slice-queued chapters). We never run two SSEs at once. */
    if (chapters.activeStream) return;

    /* activeStream is null. If we were tracking an entry, the chapter
       just completed (or the stream was torn down — pause, halt, etc.).
       DELETE the entry from the server queue then return; the resulting
       setSnapshot re-fires tick() to pick up the next entry. */
    if (inFlightEntryId) {
      const completed = inFlightEntryId;
      inFlightEntryId = null;
      void dispatch(cancelQueueEntry(completed)).catch(() => {
        /* 409 — server thinks the entry is in_progress (shouldn't happen
           on the same-book path because we never call /start, but be
           defensive); or 404 — already gone (idempotent). Swallow either
           way; the queue snapshot will catch up on the next /api/queue
           hit. */
      });
      return;
    }

    /* Find the next entry whose status is 'queued'. Skip 'failed' /
       'paused' entries — those linger for the user to inspect or act on
       manually, the dispatcher doesn't touch them. */
    const head = queue.entries.find((e) => e.status === 'queued');
    if (!head) return;

    /* Wave 4a same-book gate. Wave 4b lifts this — the cross-book
       dispatcher will switch the active book context (or POST
       /generation directly bypassing the existing middleware's gate). */
    if (chapters.currentBookId !== head.bookId) return;

    /* Dispatch the regenerate. The existing generation-stream-middleware
       reacts: sets pendingRegen, reconciles, opens SSE for the chapter. */
    inFlightEntryId = head.id;
    dispatch(chaptersActions.regenerateChapter({ chapterId: head.chapterId, scope: 'this' }));
  };

  return (next) => (action) => {
    const result = next(action);
    const a = action as { type?: string };
    const type = a?.type;
    /* React to anything that could change the dispatcher's decision:
       - queue/setSnapshot — entries or paused flag changed.
       - chapters/setActiveStream + clearActiveStream — SSE opened/closed.
       - chapters/setCurrentBookId + hydrateFromBookState — slice's
         loaded book changed (gate may flip from "wrong book" to "right
         book" without any queue mutation). */
    if (
      type === queueActions.setSnapshot.type ||
      type === 'chapters/setActiveStream' ||
      type === 'chapters/clearActiveStream' ||
      type === 'chapters/setCurrentBookId' ||
      type === 'chapters/hydrateFromBookState'
    ) {
      /* Defer to a microtask so the existing generation-stream-middleware
         reconcile completes first — its setActiveStream / clearActiveStream
         calls land before we re-read chapters.activeStream. */
      queueMicrotask(() => tick());
    }
    return result;
  };
};
