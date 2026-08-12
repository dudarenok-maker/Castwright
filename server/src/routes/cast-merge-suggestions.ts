/* Suggestions routes — list, dismiss, and accept diminutive merge suggestions.

   Suggestions are written by the dedup pass (Task 10) and stored in the
   per-book `cast-merge-suggestions.json` sibling file. These routes let the
   cast-review UI surface and act on them without touching cast.json directly.

   GET  /:bookId/cast/merge-suggestions           → { suggestions }
   POST /:bookId/cast/merge-suggestions/dismiss   → 200 (removes one pair)
   POST /:bookId/cast/merge-suggestions/accept    → 200 (merges + removes pair)

   bookDir resolution mirrors cast-merge.ts: `findBookByBookId`, 404 when the
   book is absent for accept/dismiss; the GET returns an empty list when the
   book or file is absent (safe for a stale bookId the UI may hold). */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId } from '../workspace/scan.js';
import { loadSuggestions, dismissSuggestion } from '../store/cast-merge-suggestions.js';
import { isLockAcquisitionTimeout, LOCK_CONTENTION_REQUEST_ERROR } from '../workspace/file-lock.js';
import { performCastMerge } from './cast-merge.js';

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

    const file = await loadSuggestions(located.bookDir);
    return res.json(file);
  },
);

/* POST /:bookId/cast/merge-suggestions/dismiss
   Removes the matching (sourceId, targetId) pair from the suggestions file.
   No-op when the pair is not present. */
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

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });

    await dismissSuggestion(located.bookDir, sourceId, targetId);
    return res.json({});
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

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const { bookDir, state } = located;

    try {
      await performCastMerge({ bookId, bookDir, state, sourceId, targetId });
    } catch (err) {
      /* #2260 round 4 (C1) — a `LockAcquisitionTimeoutError` out of
         `performCastMerge` is DEFERRED, not aborting: it is parked at the
         retirement site and rethrown only once cast.json, manuscript-edits
         .json, the analysis cache and the `cast-merges` journal have all been
         written (see that function's own deferred-rethrow comment, which
         states this as a contract on its callers). So at THIS point the merge
         is fully applied and `sourceId` is gone from cast.json — but the
         `dismissSuggestion` below is skipped, and `loadSuggestions` does no
         roster filtering, so the suggestion survives for a character that no
         longer exists. Pressing Accept again then 404s on
         `performCastMerge`'s own `if (!source)` guard and skips the dismiss
         again: stuck until the user hits Dismiss or re-analyses.

         Dismissing here is correct precisely BECAUSE the merge landed — this
         is the same "finish the writes, then let it surface" shape
         `performCastMerge` uses internally, applied at the frame that owns
         this write. Discriminated on the error class rather than run
         unconditionally: a merge that genuinely failed (404 on an unknown
         id, an EPERM out of the cast.json write) must keep its suggestion.

         Its own failure is swallowed deliberately — the timeout is the more
         informative error and must be what the user sees, and a failed
         dismiss is no worse than not attempting one. */
      if (isLockAcquisitionTimeout(err)) {
        try {
          await dismissSuggestion(bookDir, sourceId, targetId);
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
      if (isLockAcquisitionTimeout(err)) {
        return res.status(500).json({ error: LOCK_CONTENTION_REQUEST_ERROR });
      }
      return res.status(500).json({ error: 'Internal server error.' });
    }

    /* Drop the suggestion only after a successful merge. */
    await dismissSuggestion(bookDir, sourceId, targetId);
    return res.json({});
  },
);
