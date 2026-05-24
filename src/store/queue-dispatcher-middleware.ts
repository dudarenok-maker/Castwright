/* Plan 102 + plan 111 — queue dispatcher middleware (worker pool).
 *
 * Drains the workspace queue (queue-slice mirror of <workspace>/.queue.json)
 * with up to N concurrent workers (N = the `generationWorkers` user setting,
 * default 2). The dispatcher is the SOLE stream-opener — the old
 * generation-stream-middleware `hasWork` "generating override" is gone, so
 * every run flows through the persisted queue.
 *
 * Each tick:
 *   1. RECONCILE COMPLETIONS — for every entry we claimed whose book no longer
 *      has an open stream, the run finished: DELETE it from the server queue.
 *   2. FILL TO N — claim up to (N − inFlight) queued entries from the flat
 *      queue across books, grouping same-book claims into ONE stream (the
 *      server's bounded pool fans those chapters out; two streams for one book
 *      would abort each other). Skip books already streaming. For the VIEWED
 *      book, flip its rows (regenerateChapterIds / regenerateCharacter) so the
 *      Generate view reflects the run; cross-book opens are direct.
 *
 * Correctness:
 *   - No double-claim: middleware + queueMicrotask run single-threaded; we add
 *     to `inFlight` synchronously before any await, and the runner's per-book
 *     singleton is the second guard.
 *   - No regen loop: an entry is DELETEd only AFTER its book's stream closes
 *     (the chapter is `done` by then); a done row is never re-claimed (entry
 *     gone) nor re-enqueued (the enqueue-on-work observer only enqueues
 *     queued/in_progress rows).
 *   - Same-book no-abort: same-book claims coalesce into one stream, so we
 *     never fire a second forced request that aborts the first. */

import type { Middleware, MiddlewareAPI } from '@reduxjs/toolkit';
import { chaptersActions, type ChaptersState } from './chapters-slice';
import { queueActions, type QueueState, type QueueEntry } from './queue-slice';
import { cancelQueueEntry } from './queue-thunks';
import type { UiState } from './ui-slice';
import type { AppDispatch } from './index';
import type { StreamRunner } from './generation-stream-runner';

interface DispatcherRootState {
  ui: UiState;
  chapters: ChaptersState;
  queue: QueueState;
  /* Optional so lean test stores without the account slice still work; the
     worker count falls back to the default (2). */
  account?: { generationWorkers?: number };
}

const DEFAULT_WORKERS = 2;

export function queueDispatcherMiddleware(getRunner: () => StreamRunner): Middleware {
  return (storeApi: MiddlewareAPI) => {
    /* Entries the dispatcher has opened a stream for, mapped to their book.
       An entry is removed when its book's stream closes (the run finished).
       The book mapping survives the entry leaving the queue snapshot, so we
       can still DELETE it. */
    const inFlight = new Map<string, string>();

    /* Entries we've fired a DELETE for but haven't yet seen leave the queue
       snapshot (the server round-trip is async). They must NOT be re-claimed
       in the same/next tick — that's the infinite-regen trap: a `done`
       chapter's entry, still present in the snapshot, would otherwise be
       picked up and re-generated. Pruned once the snapshot catches up. */
    const completed = new Set<string>();

    const dispatch = storeApi.dispatch as AppDispatch;

    const tick = (): void => {
      const state = storeApi.getState() as DispatcherRootState;
      const { queue, chapters, ui } = state;
      const runner = getRunner();

      /* Cold-boot gate — wait for the initial GET /api/queue. */
      if (!queue.loaded) return;

      /* Prune the pending-deletion set once the snapshot no longer lists an
         entry — the server DELETE landed, so it's safe to forget. */
      if (completed.size > 0) {
        const live = new Set(queue.entries.map((e) => e.id));
        for (const id of [...completed]) if (!live.has(id)) completed.delete(id);
      }

      /* STEP 1 — reconcile completions. An entry whose book has no open stream
         finished (or was torn down). DELETE it and remember it as pending so
         STEP 2 can't re-claim it before the snapshot catches up. */
      for (const [entryId, bookId] of [...inFlight.entries()]) {
        if (!runner.hasOpenStreamForBook(bookId)) {
          inFlight.delete(entryId);
          completed.add(entryId);
          void dispatch(cancelQueueEntry(entryId)).catch(() => {
            /* 404 already-gone / 409 in_progress — idempotent; the next
               /api/queue snapshot reconciles. */
          });
        }
      }

      /* Queue-global pause stops NEW fills at the next boundary (in-flight
         streams finish via their own idle teardown). */
      if (queue.paused) return;

      /* STEP 2 — fill up to N workers. */
      const workers = state.account?.generationWorkers ?? DEFAULT_WORKERS;
      let slots = workers - inFlight.size;
      if (slots <= 0) return;

      /* Claim queued entries in order, grouped by book. Skip books already
         streaming (one stream per book) and entries already in flight. */
      const claimedByBook = new Map<string, QueueEntry[]>();
      for (const e of queue.entries) {
        if (slots <= 0) break;
        if (e.status !== 'queued') continue;
        if (inFlight.has(e.id)) continue;
        if (completed.has(e.id)) continue;
        if (runner.hasOpenStreamForBook(e.bookId)) continue;
        const group = claimedByBook.get(e.bookId);
        if (group) {
          group.push(e);
        } else {
          claimedByBook.set(e.bookId, [e]);
        }
        slots--;
      }

      for (const [bookId, entries] of claimedByBook) {
        for (const e of entries) inFlight.set(e.id, bookId);
        const chapterIds = [...new Set(entries.map((e) => e.chapterId))];

        /* VIEWED book — flip rows so the Generate view shows the run. These
           dispatches no longer trigger an open (the override is gone); they
           only update slice rows + (for character scope) enqueue the
           pending-revision stub via the generation-stream-middleware. */
        if (chapters.currentBookId === bookId) {
          const thisChapters = entries
            .filter((e) => e.scope !== 'character')
            .map((e) => e.chapterId);
          if (thisChapters.length > 0) {
            dispatch(chaptersActions.regenerateChapterIds({ chapterIds: thisChapters }));
          }
          for (const e of entries) {
            if (e.scope === 'character' && e.characterId) {
              dispatch(
                chaptersActions.regenerateCharacter({
                  characterId: e.characterId,
                  chapterIds: [e.chapterId],
                }),
              );
            }
          }
        }

        /* Open ONE stream per book covering the claimed chapters (the server
           pool fans them out). queueEntryId correlates the first entry. */
        runner.open(
          bookId,
          ui.ttsModelKey,
          { chapterIds, force: true },
          { queueEntryId: entries[0].id },
        );
      }
    };

    return (next) => (action) => {
      const result = next(action);
      const a = action as { type?: string };
      const type = a?.type;
      /* React to anything that could change the dispatcher's decision:
         - queue/setSnapshot — entries or paused flag changed.
         - chapters/setActiveStream + clearActiveStream — a stream opened/closed.
         - chapters/setCurrentBookId + hydrateFromBookState — the viewed book
           changed (affects which claims flip rows). */
      if (
        type === queueActions.setSnapshot.type ||
        type === 'chapters/setActiveStream' ||
        type === 'chapters/clearActiveStream' ||
        type === 'chapters/setCurrentBookId' ||
        type === 'chapters/hydrateFromBookState'
      ) {
        /* Defer to a microtask so the runner's setActiveStream / clear lands
           before we re-read the open-stream set. */
        queueMicrotask(() => tick());
      }
      return result;
    };
  };
}
