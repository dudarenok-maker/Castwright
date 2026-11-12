/* Suggestions routes — list, dismiss, and accept merge suggestions.

   Suggestions are written by the analysis runs (the dedup pass today) and kept
   across runs in the per-book `cast-merge-suggestions.json` sibling file. These routes let the
   cast-review UI surface and act on them without touching cast.json directly.

   GET  /:bookId/cast/merge-suggestions           → { suggestions }
   POST /:bookId/cast/merge-suggestions/dismiss   → 200 (removes one pair, records a
                                                    durable "not the same person")
   POST /:bookId/cast/merge-suggestions/accept    → 200 (merges + removes pair)

   bookDir resolution mirrors cast-merge.ts: `findBookByBookId`, 404 when the
   book is absent for accept/dismiss; the GET returns an empty list when the
   book or file is absent (safe for a stale bookId the UI may hold); it lists
   only pairs whose two ids are live rows in cast.json. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId } from '../workspace/scan.js';
import { BOOK_GONE, withBookOp } from '../workspace/book-op-lock.js';
import {
  loadSuggestions,
  dismissSuggestionDurably,
  removeSuggestionPairsLocked,
} from '../store/cast-merge-suggestions.js';
import { withCastLock } from '../workspace/cast-lock.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import {
  isLockAcquisitionTimeout,
  LOCK_CONTENTION_REQUEST_ERROR,
  requestFailureMessageFs,
} from '../workspace/file-lock.js';
import { performCastMerge, didCastMergeApply } from './cast-merge.js';
import { castIdentityBusyRefusal } from './book-state.js';

export const castMergeSuggestionsRouter = Router();

interface SuggestionBody {
  sourceId?: unknown;
  targetId?: unknown;
}

/* GET /:bookId/cast/merge-suggestions
   Returns the current suggestion list.  Returns { suggestions: [] } when the
   book doesn't exist or has no file — the UI can safely call this on any
   bookId without needing a prior existence check. */
castMergeSuggestionsRouter.get(
  '/:bookId/cast/merge-suggestions',
  async (req: Request, res: Response) => {
    const { bookId } = req.params;

    const located = await findBookByBookId(bookId);
    if (!located) return res.json({ suggestions: [] });

    /* Only pairs whose two ids are both live rows in the current cast: a stored
       pair naming a deleted or merged-away row cannot be acted on (accept 404s)
       and is pruned by the next run's reconcile, not before. A lock-free read —
       this route writes nothing. */
    const file = await loadSuggestions(located.bookDir);
    const cast = await readJson<{ characters?: Array<{ id: string }> }>(castJsonPath(located.bookDir));
    const live = new Set((cast?.characters ?? []).map((c) => c.id));
    return res.json({
      suggestions: file.suggestions.filter((s) => live.has(s.sourceId) && live.has(s.targetId)),
    });
  },
);

/* POST /:bookId/cast/merge-suggestions/dismiss
   A durable "not the same person" decision (#4031): records the pair in
   cast-id-history, writes the `notLinkedTo` edge on each row, and removes the
   pair from the suggestions file — all under the cast lock. No-op for a pair
   that is not present. */
castMergeSuggestionsRouter.post(
  '/:bookId/cast/merge-suggestions/dismiss',
  async (req: Request, res: Response) => {
    const { bookId } = req.params;
    const body = (req.body ?? {}) as SuggestionBody;
    const sourceId = typeof body.sourceId === 'string' ? body.sourceId.trim() : '';
    const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';

    if (!sourceId || !targetId) {
      return res.status(400).json({ error: 'sourceId and targetId are required.' });
    }

    try {
      /* #3711 — book-op outermost so the write lands in the book's current folder. */
      const outcome = await withBookOp(bookId, (located) =>
        dismissSuggestionDurably(located.bookDir, bookId, sourceId, targetId, (m) =>
          console.warn(`[cast-merge-suggestions] ${m}`),
        ),
      );
      if (outcome === BOOK_GONE) return res.status(404).json({ error: 'Book not found.' });
      return res.json({});
    } catch (err) {
      console.error('[cast-merge-suggestions] dismiss failed', err);
      return res
        .status(500)
        .json({ error: requestFailureMessageFs(err, 'Could not dismiss the suggestion.') });
    }
  },
);

/* POST /:bookId/cast/merge-suggestions/accept
   Performs the merge (sourceId folded into targetId — targetId is the
   canonical survivor, matching the MergeSuggestion contract), then drops the
   suggestion from the file so it never resurfaces. */
castMergeSuggestionsRouter.post(
  '/:bookId/cast/merge-suggestions/accept',
  async (req: Request, res: Response) => {
    const { bookId } = req.params;
    const body = (req.body ?? {}) as SuggestionBody;
    const sourceId = typeof body.sourceId === 'string' ? body.sourceId.trim() : '';
    const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';

    if (!sourceId || !targetId) {
      return res.status(400).json({ error: 'sourceId and targetId are required.' });
    }
    if (sourceId === targetId) {
      return res.status(400).json({ error: 'sourceId and targetId must differ.' });
    }

    /* #3711 — book-op outermost, held across the merge AND the follow-up
       dismiss (both write the book folder). The existing curated-failure seam
       below runs INSIDE the callback unchanged; a book-op acquisition timeout
       (which never reached it) is curated by the outer catch. */
    let outcome;
    try {
      outcome = await withBookOp(bookId, async ({ bookDir, state }) => {
        /* R55 — refused while an analysis runs, checked inside this book-op span. */
        const busy = castIdentityBusyRefusal(bookId);
        if (busy) return res.status(409).json(busy);
        let merged: Awaited<ReturnType<typeof performCastMerge>>;
        try {
          merged = await performCastMerge({ bookId, bookDir, state, sourceId, targetId });
        } catch (err) {
          /* #2260 round 4 (C1) — a `LockAcquisitionTimeoutError` out of
         `performCastMerge` is DEFERRED, not aborting (#4031 C3: so is ANY other
         failure of the history write, e.g. an EPERM): it is parked at the
         retirement site and rethrown only once cast.json, manuscript-edits
         .json, the analysis cache and the `cast-merges` journal have all been
         written (see that function's own deferred-rethrow comment, which
         states this as a contract on its callers). So at THAT point the merge
         is fully applied and `sourceId` is gone from cast.json — but the
         `removeSuggestionPairsLocked` below is skipped, and `loadSuggestions` does no
         roster filtering, so the suggestion survives for a character that no
         longer exists. Pressing Accept again then 404s on
         `performCastMerge`'s own `if (!source)` guard and skips the dismiss
         again: stuck until the user hits Dismiss or re-analyses.

         Dismissing here is correct precisely BECAUSE the merge landed — this
         is the same "finish the writes, then let it surface" shape
         `performCastMerge` uses internally, applied at the frame that owns
         this write. Run unconditionally it would be wrong: a merge that
         genuinely failed (404 on an unknown id, an EPERM out of the cast.json
         write) must keep its suggestion.

         FINAL ROUND (B1) — but the ERROR CLASS alone does not say the merge
         landed, and round 4's comment asserted that it did. `performCastMerge`
         is itself `withCastLock(bookDir, …)`, so this class reaches here from
         two opposite states: the OUTER acquisition expiring (the callback never
         ran — cast.json untouched, `sourceId` still live) and the deferred
         rethrow (fully applied). `removeSuggestionPairsLocked` is a plain
         load-filter-`writeJsonAtomic`, so on the first of those a user who hit
         Accept while something else held `cast:<bookDir>` — ordinary
         contention, the exact condition #2260 exists to surface — lost the
         suggestion for a merge that never happened, with only a re-analysis to
         bring it back. So the mark, not the class, is the condition:
         `didCastMergeApply` is stamped on the parked error at the deferred
         rethrow and nowhere else. It fails closed, which is the recoverable
         direction — an unmarked timeout keeps its suggestion, and the user can
         simply press Accept again once the other operation finishes.

         Its own failure is swallowed deliberately — the timeout is the more
         informative error and must be what the user sees, and a failed
         dismiss is no worse than not attempting one. */
          if (didCastMergeApply(err)) {
            try {
              await withCastLock(bookDir, () =>
                removeSuggestionPairsLocked(bookDir, [[sourceId, targetId]]),
              );
            } catch (dismissErr) {
              console.warn(
                '[cast-merge-suggestions] merge applied but the suggestion could not be dismissed',
                dismissErr,
              );
            }
          }
          const e = err as { status?: number; error?: string };
          if (e.status && e.error) {
            return res.status(e.status).json({ error: e.error });
          }
          /* #2292 (owner decision), CORRECTED in review round 5 — mirrors the
         sibling `POST /cast/merge` handler, including the retraction. The
         claim recorded here through round 4 ("a throw without `{status,
         error}` used to reach Express 5's default handler and come back as
         `500 text/html`") was FALSE: `app.ts:350` registers `errorHandler`
         last, so such a throw has always answered `500 {"error":"Internal
         server error."}`. The `text/html` came from the fixtures' bare router.

         The real delta was the words, and `err.message` was the wrong ones —
         it hands a LAN client the lock key, hence the absolute path of the
         user's workspace. Curated body for the lock-timeout class, generic
         body for everything else; the full error still goes to the log. See
         `cast-merge.ts`'s handler for the long version. */
          console.error('[cast-merge-suggestions] accept failed', err);
          return res
            .status(500)
            .json({ error: requestFailureMessageFs(err, 'Internal server error.') });
        }

        /* Drop the suggestion only after a successful merge. This lock can still
           time out AFTER the merge applied; the outer catch then answers the curated
           "reload to see whether it landed" 500 (the `didCastMergeApply` marker
           above does not cover this site). */
        await withCastLock(bookDir, () =>
          removeSuggestionPairsLocked(bookDir, [[sourceId, targetId]]),
        );
        /* #4031 M7 — the merged cast, as `POST /cast/merge` answers it: the client
           mirrors it (`applyMerge`) rather than saving its own pre-merge slice. */
        return res.json({ characters: merged.characters });
      });
    } catch (err) {
      if (!isLockAcquisitionTimeout(err)) throw err;
      console.error('[cast-merge-suggestions] accept failed', err);
      return res.status(500).json({ error: LOCK_CONTENTION_REQUEST_ERROR });
    }
    if (outcome === BOOK_GONE) return res.status(404).json({ error: 'Book not found.' });
    return outcome;
  },
);
