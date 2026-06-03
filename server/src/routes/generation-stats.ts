/* GET /api/generation/stats — live generation-throughput snapshot.

   Feeds the dev top-bar RTF pill so the user can self-monitor generation speed
   without grepping logs. Returns the rolling-window snapshot from the
   `generation-stats` accumulator (all-null when idle / nothing recorded yet).
   Read-only and book-agnostic: the workspace runs one GPU, so a single global
   throughput figure is the right granularity. */

import { Router } from 'express';
import { getGenerationStats } from '../tts/generation-stats.js';
import { readTelemetry } from '../tts/resource-telemetry.js';

export const generationStatsRouter = Router();

generationStatsRouter.get('/stats', (_req, res) => {
  res.json(getGenerationStats());
});

/* fs-20 — GET /api/generation/telemetry?limit= — per-run resource telemetry
   (RTF + VRAM + host RAM per chapter), newest-first. Mounted on the existing
   generationStatsRouter so it shares the /api/generation prefix. Best-effort:
   a read failure surfaces as an empty list rather than a 500 (the admin panel
   keeps its last-good snapshot). */
generationStatsRouter.get('/telemetry', async (req, res) => {
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : undefined;
  const records = await readTelemetry(limit).catch(() => []);
  res.json({ records });
});
