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
import type { ListenStatsFile } from '../workspace/listen-stats.js';
import {
  buildLibraryStats,
  buildContinueListening,
  type BookStatsInput,
} from '../workspace/listen-stats-aggregate.js';

export const libraryRouter = Router();

type ResumeBookmark = {
  chapterId: number;
  currentSec: number;
  updatedAt: string;
  chapterUuid?: string;
  /* fs-15 shelf controls — explicit Continue-listening flags. */
  finished?: boolean;
  hidden?: boolean;
};
type MappedChapter = { id: number; uuid?: string; duration?: string; excluded?: boolean; held?: boolean };

async function assembleBookInputs(): Promise<BookStatsInput[]> {
  const books = await collectBooks(); // [{ bookDir, state }]
  return Promise.all(
    books.map(async ({ bookDir, state }) => {
      const bookId = state.bookId;
      const resume = await readJson<ResumeBookmark>(listenProgressJsonPath(bookDir));
      const statsFile = await readJson<ListenStatsFile>(listenStatsJsonPath(bookDir));
      const chapters: MappedChapter[] = (state.chapters ?? []).map((c) => ({
        id: c.id,
        uuid: c.uuid,
        duration: c.duration,
        excluded: c.excluded,
        held: c.held,
      }));
      // PL1 — resolve the resume bookmark's chapterUuid -> the chapter's CURRENT id
      // (mirror GET /listen-progress in book-state.ts). A restructure shifts positional ids.
      let resumeObject: { chapterId: number; currentSec: number; updatedAt: string } | null = null;
      if (resume) {
        let resumeChapterId = resume.chapterId;
        if (resume.chapterUuid) {
          const match = chapters.find((c) => c.uuid === resume.chapterUuid);
          if (match) resumeChapterId = match.id;
        }
        resumeObject = { chapterId: resumeChapterId, currentSec: resume.currentSec, updatedAt: resume.updatedAt };
      }
      return {
        bookId,
        title: state.title ?? bookId,
        series: state.series ?? null,
        isStandalone: state.isStandalone ?? !state.series,
        chapters: chapters.map(({ id, duration, excluded, held }) => ({
          id,
          duration,
          excluded,
          held,
        })),
        resume: resumeObject,
        statsFile: statsFile ?? null,
        /* fs-15 shelf controls — explicit flags drive auto-hide + finished stats. */
        finished: resume?.finished,
        hidden: resume?.hidden,
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
