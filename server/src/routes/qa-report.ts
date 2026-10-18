/* GET /api/books/:bookId/qa-report (fs-51)
   Composes the audio QA aggregation (Task 5's buildAudioQaReport, reading
   segments.json + verdict files) with the existing config-drift detector
   (computeRevisionsForBook) into one per-book report. Both reads are pure /
   disk-derived — this route persists nothing new. The book is resolved once
   here and passed to computeRevisionsForBook directly, rather than calling
   getRevisionsForBook(bookId) and re-walking BOOKS_ROOT a second time. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId } from '../workspace/scan.js';
import { buildAudioQaReport } from '../audio/qa-report.js';
import { computeRevisionsForBook } from './revisions.js';
import { requestFailureMessage } from '../workspace/file-lock.js';
import { revisionsFailureText } from '../workspace/revisions-store.js';
import { triggerScoring, isGenerationActive } from './generation.js';
import { BOOK_GONE, peekBook } from '../workspace/book-op-lock.js';
import { runBookJob } from '../workspace/book-jobs.js';

export const qaReportRouter = Router();

qaReportRouter.get('/:bookId/qa-report', async (req: Request, res: Response) => {
  try {
    const { bookId } = req.params;
    const located = await findBookByBookId(bookId);
    if (!located) {
      res.status(404).json({ error: 'Book not found' });
      return;
    }
    const { bookDir, state } = located;

    const [audio, revisions] = await Promise.all([
      buildAudioQaReport(bookDir, state.chapters),
      computeRevisionsForBook(bookId, bookDir, state),
    ]);

    const drift = revisions.drift;
    const counts = { mild: 0, moderate: 0, severe: 0 } as Record<'mild' | 'moderate' | 'severe', number>;
    for (const event of drift) counts[event.severity] += 1;

    res.json({
      bookId,
      generatedAt: new Date().toISOString(),
      chaptersTotal: state.chapters.length,
      ...audio,
      configDrift: { counts, events: drift },
    });
  } catch (e) {
    console.error('[qa-report] GET failed', e);
    res.status(500).json({ error: requestFailureMessage(e, revisionsFailureText(e, 'Failed to build QA report.')) });
  }
});

/* srv-36 hardening — manual resume for a scoreBook run that got interrupted
   (server restart mid-run) on a book with no more chapters left to render,
   so nothing would otherwise re-trigger it. Fire-and-forget through the
   SAME triggerScoring/scoringInFlight single-flight path the chapter-finalize
   flow uses — a click while a run is already active safely no-ops there. */
qaReportRouter.post('/:bookId/resume-scoring', async (req: Request, res: Response) => {
  try {
    const { bookId } = req.params;
    /* #3711 — `peekBook` is advisory (no lock; it feeds only these early 404/409s). The
       chapter list and folder come from the lease below, resolved under book-op.
       `triggerScoring` registers the long `scoring` job itself and resolves once that
       registration has; this wrapper's token is released only after it, so no move
       can slip between the two. */
    if (!(await peekBook(bookId))) {
      res.status(404).json({ error: 'Book not found' });
      return;
    }
    if (isGenerationActive(bookId)) {
      res.status(409).json({ error: 'Book is currently generating — resume scoring once the run finishes.' });
      return;
    }
    const registered = await runBookJob(bookId, 'scoring', async (lease) => {
      await triggerScoring({
        bookId,
        bookDir: lease.bookDir,
        chapters: lease.state.chapters,
        justFinalizedSlugs: [],
      });
    });
    if (registered === BOOK_GONE) {
      res.status(404).json({ error: 'Book not found' });
      return;
    }
    await registered.done; /* resolves once scoring's own registration has */
    res.status(202).json({ started: true });
  } catch (e) {
    console.error('[qa-report] POST resume-scoring failed', e);
    res.status(500).json({ error: requestFailureMessage(e, 'Failed to resume scoring.') });
  }
});
