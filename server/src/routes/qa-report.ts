/* GET /api/books/:bookId/qa-report (fs-51)
   Composes the audio QA aggregation (Task 5's buildAudioQaReport, reading
   segments.json + verdict files) with the existing config-drift detector
   (getRevisionsForBook) into one per-book report. Both reads are pure /
   disk-derived — this route persists nothing new. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId } from '../workspace/scan.js';
import { buildAudioQaReport } from '../audio/qa-report.js';
import { getRevisionsForBook } from './revisions.js';

export const qaReportRouter = Router();

qaReportRouter.get('/:bookId/qa-report', async (req: Request, res: Response) => {
  const { bookId } = req.params;
  const located = await findBookByBookId(bookId);
  if (!located) {
    res.status(404).json({ error: 'Book not found' });
    return;
  }
  const { bookDir, state } = located;

  const [audio, revisions] = await Promise.all([
    buildAudioQaReport(bookDir, state.chapters),
    getRevisionsForBook(bookId),
  ]);

  const drift = revisions?.drift ?? [];
  const counts = { mild: 0, moderate: 0, severe: 0 } as Record<'mild' | 'moderate' | 'severe', number>;
  for (const event of drift) counts[event.severity] += 1;

  res.json({
    bookId,
    generatedAt: new Date().toISOString(),
    chaptersTotal: state.chapters.length,
    ...audio,
    configDrift: { counts, events: drift },
  });
});
