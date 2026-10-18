/* POST /api/books/:bookId/cast/tier

   Sets or clears ttsModelKey ('qwen3-tts-1.7b' | null) across every cast
   member sharing a voiceId in the same series as the anchor book. Reuses
   applyTierToCastFiles (voices.ts) and findAuthorSeriesForBookId
   (series-cast-scan.ts) — the standalone-exclusion logic is internal to
   forEachMatchingCastCharacter, so this handler needs no isStandalone read.

   Body:  { voiceId: string, ttsModelKey: 'qwen3-tts-1.7b' | null }
   Response: { updated: number }

   Mounted at /api/books in app.ts, so the handler path is RELATIVE
   (/:bookId/cast/tier). */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { peekBook } from '../workspace/book-op-lock.js';
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

  const seriesInfo = await findAuthorSeriesForBookId(bookId);
  const updated = await applyTierToCastFiles(
    voiceId.trim(),
    ttsModelKey as 'qwen3-tts-1.7b' | null,
    seriesInfo ?? undefined,
  );

  return res.json({ updated });
});
