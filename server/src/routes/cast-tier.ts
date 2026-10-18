/* POST /api/books/:bookId/cast/tier

   Sets or clears ttsModelKey ('qwen3-tts-1.7b' | null) across every cast
   member sharing a voiceId in the same series as the anchor book. Reuses
   applyTierToCastFiles (voices.ts) and findAuthorSeriesForBookId
   (series-cast-scan.ts). A standalone book is written directly (onlyBookDir)
   under its book-op, since the series walker skips standalones.

   Body:  { voiceId: string, ttsModelKey: 'qwen3-tts-1.7b' | null }
   Response: { updated: number }

   Mounted at /api/books in app.ts, so the handler path is RELATIVE
   (/:bookId/cast/tier). */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { BOOK_GONE, peekBook, withBookOp } from '../workspace/book-op-lock.js';
import { findAuthorSeriesForBookId } from '../workspace/series-cast-scan.js';
import { applyTierToCastFiles } from './voices.js';

export const castTierRouter = Router();

castTierRouter.post('/:bookId/cast/tier', async (req: Request, res: Response) => {
  const { bookId } = req.params;
  const { voiceId, ttsModelKey } = (req.body as Record<string, unknown>) ?? {};

  if (typeof voiceId !== 'string' || !voiceId.trim()) {
    return res.status(400).json({ error: 'voiceId required' });
  }
  if (ttsModelKey !== null && ttsModelKey !== 'qwen3-tts-1.7b') {
    return res.status(400).json({ error: 'ttsModelKey must be "qwen3-tts-1.7b" or null' });
  }

  /* #3711 -- a cross-book walker: it takes book-op PER BOOK inside the walk, so
     this handler holds none and its resolve is the lock-free, write-free peek. */
  const located = await peekBook(bookId);
  if (!located) return res.status(404).json({ error: `Book "${bookId}" not found.` });

  if (located.state.isStandalone === true) {
    /* A standalone has no series continuity: the series walker skips every
       standalone (the anchor too) and every standalone shares one synthetic
       series name. Write exactly this book, under its book-op (the
       `onlyBookDir` branch's precondition). */
    const outcome = await withBookOp(bookId, ({ bookDir }) =>
      applyTierToCastFiles(
        voiceId.trim(),
        ttsModelKey as 'qwen3-tts-1.7b' | null,
        undefined,
        bookDir,
      ),
    );
    if (outcome === BOOK_GONE)
      return res.status(404).json({ error: `Book "${bookId}" not found.` });
    return res.json({ updated: outcome });
  }

  const seriesInfo = await findAuthorSeriesForBookId(bookId);
  const updated = await applyTierToCastFiles(
    voiceId.trim(),
    ttsModelKey as 'qwen3-tts-1.7b' | null,
    seriesInfo ?? undefined,
  );

  return res.json({ updated });
});
