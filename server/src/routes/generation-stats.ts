/* GET /api/generation/stats — live generation-throughput snapshot.

   Feeds the dev top-bar RTF pill so the user can self-monitor generation speed
   without grepping logs. Returns the rolling-window snapshot from the
   `generation-stats` accumulator (all-null when idle / nothing recorded yet).
   Read-only and book-agnostic: the workspace runs one GPU, so a single global
   throughput figure is the right granularity. */

import { Router } from 'express';
import { getGenerationStats } from '../tts/generation-stats.js';

export const generationStatsRouter = Router();

generationStatsRouter.get('/stats', (_req, res) => {
  res.json(getGenerationStats());
});
