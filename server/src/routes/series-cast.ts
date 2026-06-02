/* GET /api/books/:bookId/series-cast

   Returns the full cast of every OTHER confirmed book that shares the
   target book's (author, series) pair — full cast.json fidelity (lines,
   voiceStyle, overrideTtsVoices, ttsEngine, voiceId, color, …), the same
   shape `getBookState` returns for the open book.

   Powers the "Rebaseline the series" modal's whole-series aggregation:
   the modal merges these SIBLING characters onto the anchor book's own
   cast (deduped by the series-override write key, `voiceId ?? id`) so a
   character who appears only in a later volume is still selectable, and
   principal-cast line counts reflect the series total — not just one
   representative book.

   Thin wrapper around scanSeriesFullCharactersForBookId(). The target
   book itself, standalones, unconfirmed casts, and books in a different
   series are excluded by the underlying scan. Returns 200 with an empty
   list for a book outside any series so the modal can degrade to its
   anchor-only cast instead of treating it as an error. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { scanSeriesFullCharactersForBookId } from '../workspace/series-full-cast-scan.js';

export const seriesCastRouter = Router();

seriesCastRouter.get('/:bookId/series-cast', async (req: Request, res: Response) => {
  const { bookId } = req.params;
  if (!bookId) return res.status(400).json({ error: 'bookId is required.' });

  try {
    const records = await scanSeriesFullCharactersForBookId(bookId);
    /* Tag each character with its source book so a future consumer can
       show provenance; the modal only needs the character fields. */
    const characters = records.map((r) => ({
      ...r.character,
      sourceBookId: r.bookId,
      sourceBookTitle: r.bookTitle,
    }));
    return res.json({ characters });
  } catch (e) {
    console.error('[series-cast] scan failed', e);
    return res.status(500).json({ error: (e as Error).message || 'Series cast scan failed.' });
  }
});
