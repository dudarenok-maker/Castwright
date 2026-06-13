/* GET /api/library — walks the workspace books/ tree and returns the
   author → series → book hierarchy used by the frontend library view.

   GET /api/library/active-analyses — walks the same tree and returns
   every book's resumable analysis snapshot (paused or halted), sorted
   most-recently-written first. The library layout's cold-boot effect
   hits this so the top-bar AnalysisPill appears immediately on a
   refresh — without the user having to navigate to the specific
   book's analysing route first to discover it.

   GET /api/library/stats — fs-16 stats dashboard aggregation.
   GET /api/library/continue-listening — fs-15 continue-listening rail. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { scanLibrary, collectBooks } from '../workspace/scan.js';
import { scanActiveAnalyses } from '../workspace/active-analyses.js';
import { readJson } from '../workspace/state-io.js';
import { listenProgressJsonPath, listenStatsJsonPath } from '../workspace/paths.js';
import {
  buildLibraryStats,
  buildContinueListening,
  type BookStatsInput,
} from '../workspace/listen-stats-aggregate.js';

export const libraryRouter = Router();

async function assembleBookInputs(): Promise<BookStatsInput[]> {
  const books = await collectBooks(); // [{ bookDir, state }]
  return Promise.all(
    books.map(async ({ bookDir, state }) => {
      const bookId = state.bookId;
      const resume = await readJson<any>(listenProgressJsonPath(bookDir));
      const statsFile = await readJson<any>(listenStatsJsonPath(bookDir));
      const chapters = (state.chapters ?? []).map((c: any) => ({
        id: c.id,
        uuid: c.uuid,
        duration: c.duration,
        excluded: c.excluded,
        held: c.held,
      }));
      // PL1 — resolve the resume bookmark's chapterUuid -> the chapter's CURRENT id
      // (mirror GET /listen-progress in book-state.ts). A restructure shifts positional ids.
      let resumeChapterId = resume?.chapterId;
      if (resume?.chapterUuid) {
        const match = chapters.find((c: any) => c.uuid === resume.chapterUuid);
        if (match) resumeChapterId = match.id;
      }
      return {
        bookId,
        title: state.title ?? bookId,
        series: state.series ?? null,
        isStandalone: state.isStandalone ?? !state.series,
        chapters: chapters.map(({ id, duration, excluded, held }: any) => ({
          id,
          duration,
          excluded,
          held,
        })),
        resume: resume
          ? {
              chapterId: resumeChapterId,
              currentSec: resume.currentSec,
              updatedAt: resume.updatedAt,
            }
          : null,
        statsFile: statsFile ?? null,
      };
    }),
  );
}

libraryRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const library = await scanLibrary();
    res.json(library);
  } catch (e) {
    console.error('[library] scan failed', e);
    res.status(500).json({ error: (e as Error).message || 'Library scan failed.' });
  }
});

libraryRouter.get('/active-analyses', async (_req: Request, res: Response) => {
  try {
    const snapshots = await scanActiveAnalyses();
    res.json({ snapshots });
  } catch (e) {
    console.error('[library] active-analyses scan failed', e);
    res.status(500).json({ error: (e as Error).message || 'Active-analyses scan failed.' });
  }
});

libraryRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    res.json(buildLibraryStats(await assembleBookInputs()));
  } catch (e) {
    console.error('[library] GET stats failed', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

libraryRouter.get('/continue-listening', async (_req: Request, res: Response) => {
  try {
    res.json(buildContinueListening(await assembleBookInputs()));
  } catch (e) {
    console.error('[library] GET continue-listening failed', e);
    res.status(500).json({ error: (e as Error).message });
  }
});
