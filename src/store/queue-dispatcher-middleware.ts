/* Plan 102 — queue dispatcher middleware.
 *
 * Drains the workspace queue (queue-slice mirror of <workspace>/.queue.json)
 * one chapter at a time. The contract is intentionally narrow so the shared
 * StreamRunner keeps owning the SSE lifecycle:
 *
 *   1. Pick the head queued entry.
 *   2a. SAME-BOOK (entry.bookId === slice's currentBookId): dispatch
 *       chaptersActions.regenerateChapter/Character; the
 *       generation-stream-middleware reconciles and opens the SSE via the
 *       runner (the slice round-trip drives per-chapter UI feedback +
 *       pending-revision enqueue).
 *   2b. CROSS-BOOK (Wave 4b — plan 102 Should #6): open the SSE DIRECTLY via
 *       the shared runner with an explicit spec. We do NOT dispatch a
 *       regenerate action — that would mutate the currently-VIEWED book's
 *       chapter rows (the slice holds the viewed book, not the streaming
 *       one). The slice's applyGenerationTick cross-book guard
 *       (chapters-slice.ts) drops per-chapter ticks for the non-viewed book;
 *       the runner's activeStream snapshot keeps the global top-bar pill
 *       moving regardless of which book is on screen.
 *   3. When the SSE finishes (idle tick → activeStream cleared), DELETE the
 *      entry from the server queue. The resulting setSnapshot fires tick()
 *      again, which picks the next entry (or stops).
 *
 * Local state (inFlightEntryId) is the source of truth for "which entry did
 * I dispatch/open generation for." The server-side status field stays
 * "queued" the whole way; we never call /start. A book can have several
 * queued entries, so the runner's open-state ("a stream is open, for which
 * book") is not enough to know WHICH entry just finished — inFlightEntryId
 * provides that id-level correlation.
 *
 * Bug fix surface (per plan 102 doc):
 *   - bug #1: regenerate-during-regenerate no longer drops in-flight work.
 *     The 10 regen sites append to the queue; the dispatcher serialises them.
 *   - bug #2: cross-book sequencing now drains without per-book navigation
 *     (Wave 4b, this file's cross-book branch). */

import type { Middleware, MiddlewareAPI } from '@reduxjs/toolkit';
import { chaptersActions, type ChaptersState } from './chapters-slice';
import { queueActions, type QueueState } from './queue-slice';
import { cancelQueueEntry } from './queue-thunks';
import type { UiState } from './ui-slice';
import type { AppDispatch } from './index';
import type { StreamRunner } from './generation-stream-runner';

interface DispatcherRootState {
  ui: UiState;
  chapters: ChaptersState;
  queue: QueueState;
}

export function queueDispatcherMiddleware(getRunner: () => StreamRunner): Middleware {
  return (storeApi: MiddlewareAPI) => {
    /* Which entry did the dispatcher last fire generation for. The entry is
       DELETEd from the server queue when the SSE completes (idle tick →
       clearActiveStream). Null between drains. */
    let inFlightEntryId: string | null = null;

    const dispatch = storeApi.dispatch as AppDispatch;

    const tick = (): void => {
      const state = storeApi.getState() as DispatcherRootState;
      const { queue, chapters, ui } = state;

      /* Cold-boot gate — wait for the initial GET /api/queue before doing
         anything. Without this, an empty pre-load snapshot would tempt the
         dispatcher to do nothing (correct) but also masks the "is the queue
         authoritative yet?" question for tests. */
      if (!queue.loaded) return;

      /* Queue-global pause stops the drain at the next boundary. The
         in-flight chapter (if any) finishes — the runner handles its own
         teardown — but the dispatcher won't pick up the next entry while
         paused. */
      if (queue.paused) return;

      /* If an SSE handle is open, wait for it to drain. This covers both
         (a) our own generation that's still in flight, and (b) any other
         open path the generation-stream-middleware drove (e.g. cold-boot
         auto-resume of slice-queued chapters). We never run two SSEs at
         once. */
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
             because we never call /start, but be defensive); or 404 —
             already gone (idempotent). Swallow either way; the queue
             snapshot will catch up on the next /api/queue hit. */
        });
        return;
      }

      /* Find the next entry whose status is 'queued'. Skip 'failed' /
         'paused' entries — those linger for the user to inspect or act on
         manually, the dispatcher doesn't touch them. */
      const head = queue.entries.find((e) => e.status === 'queued');
      if (!head) return;

      inFlightEntryId = head.id;

      if (chapters.currentBookId === head.bookId) {
        /* SAME-BOOK. Dispatch the regenerate; the generation-stream-
           middleware reacts: sets pendingRegen, reconciles, opens the SSE
           for the chapter / character target via the runner. */
        if (head.scope === 'character' && head.characterId) {
          /* Per-character-in-chapter entries dispatch regenerateCharacter
             scoped to a single chapter. Multi-chapter character regen is
             expanded at enqueue time into one entry per chapter so each is
             independently reorderable in the modal. */
          dispatch(
            chaptersActions.regenerateCharacter({
              characterId: head.characterId,
              chapterIds: [head.chapterId],
            }),
          );
        } else {
          dispatch(chaptersActions.regenerateChapter({ chapterId: head.chapterId, scope: 'this' }));
        }
        return;
      }

      /* CROSS-BOOK (Wave 4b). Open the SSE directly via the shared runner —
         no regenerate dispatch (it would clobber the viewed book's rows).
         The runner seeds a cross-book activeStream snapshot (the slice holds
         the wrong book, so it can't derive counters from rows) and the first
         tick's run* aggregates refresh it. queueEntryId correlates the
         server's per-chapter ticks back to this row. */
      getRunner().open(
        head.bookId,
        ui.ttsModelKey,
        { chapterIds: [head.chapterId], force: true },
        { queueEntryId: head.id },
      );
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
        /* Defer to a microtask so the generation-stream-middleware reconcile
           completes first — its setActiveStream / clearActiveStream calls
           land before we re-read chapters.activeStream. */
        queueMicrotask(() => tick());
      }
      return result;
    };
  };
}
