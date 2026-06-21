// server/src/routes/series-memory.ts
// GET /api/library/series-memory?author=<a>&series=<s>
// Returns SeriesMemoryDetail (200) or 404 when below threshold / not found.

import { Router, type Request, type Response } from 'express';
import { buildSeriesInputs } from '../workspace/scan.js';
import { deriveSeriesMemory } from '../workspace/series-memory.js';

export const seriesMemoryRouter = Router();

seriesMemoryRouter.get('/series-memory', async (req: Request, res: Response) => {
  const author = String(req.query.author ?? '').trim();
  const series = String(req.query.series ?? '').trim();
  if (!author || !series) {
    res.status(400).json({ error: 'author and series query params are required' });
    return;
  }
  try {
    const inputs = await buildSeriesInputs(author, series);
    const detail = deriveSeriesMemory(inputs);
    if (!detail) {
      res.status(404).json({ error: 'No series memory for this series.' });
      return;
    }
    res.json(detail);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message || 'series-memory failed' });
  }
});
