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
      const e = err as { status?: number; error?: string };
      if (e.status && e.error) {
        return res.status(e.status).json({ error: e.error });
      }
      throw err;
    }

    /* Drop the suggestion only after a successful merge. */
    await dismissSuggestion(bookDir, sourceId, targetId);
    return res.json({});
  },
);
