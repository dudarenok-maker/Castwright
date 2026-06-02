/* GET /api/library — walks the workspace books/ tree and returns the
   author → series → book hierarchy used by the frontend library view.

   GET /api/library/active-analyses — walks the same tree and returns
   every book's resumable analysis snapshot (paused or halted), sorted
   most-recently-written first. The library layout's cold-boot effect
   hits this so the top-bar AnalysisPill appears immediately on a
   refresh — without the user having to navigate to the specific
   book's analysing route first to discover it. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { scanLibrary } from '../workspace/scan.js';
import { scanActiveAnalyses } from '../workspace/active-analyses.js';

export const libraryRouter = Router();

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
