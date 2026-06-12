/* GET /api/books/:bookId/series-roster

   Returns the confirmed cast from every prior book that shares the
   target book's (author, series) pair, with the target book itself
   excluded. Powers the Profile Drawer's manual continuity link picker
   so the user can fold a duplicate ("Hartwell Brennan Vale") into the
   canonical name from a prior volume ("Hart") when the auto-matcher's
   name-score floor missed the connection.

   Thin wrapper around scanSeriesCharactersForBookId(). Standalones,
   unconfirmed casts, and books in a different series are excluded by
   the underlying scan (see series-cast-scan.ts). Returns 200 with an
   empty list for books outside any series so the frontend can render a
   stable "no prior characters" state instead of treating it as an
   error. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { scanSeriesCharactersForBookId } from '../workspace/series-cast-scan.js';

export const seriesRosterRouter = Router();

interface RosterEntry {
  id: string;
  name: string;
  bookId: string;
  bookTitle: string;
  voiceId?: string;
  aliases?: string[];
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
}

seriesRosterRouter.get('/:bookId/series-roster', async (req: Request, res: Response) => {
  const { bookId } = req.params;
  if (!bookId) return res.status(400).json({ error: 'bookId is required.' });

  try {
    const records = await scanSeriesCharactersForBookId(bookId);
    const characters: RosterEntry[] = [];
    for (const record of records) {
      if (!record.character.id || !record.character.name) continue;
      characters.push({
        id: record.character.id,
        name: record.character.name,
        bookId: record.bookId,
        bookTitle: record.bookTitle,
        voiceId: record.character.voiceId,
        aliases: record.character.aliases,
        gender: record.character.gender,
        ageRange: record.character.ageRange,
      });
    }
    return res.json({ characters });
  } catch (e) {
    console.error('[series-roster] scan failed', e);
    return res.status(500).json({ error: (e as Error).message || 'Series roster scan failed.' });
  }
});
