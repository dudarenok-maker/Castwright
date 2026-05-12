/* GET /api/library — walks the workspace books/ tree and returns the
   author → series → book hierarchy used by the frontend library view. */

import { Router, type Request, type Response } from 'express';
import { scanLibrary } from '../workspace/scan.js';

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
