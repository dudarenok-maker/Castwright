import { Router, type Request, type Response } from 'express';
import { getResolvedTourCompletedAt, writeTourCompletedAt } from '../workspace/user-settings.js';

export const tourRouter = Router();

tourRouter.get('/status', (_req: Request, res: Response) => {
  res.json({ completedAt: getResolvedTourCompletedAt() });
});

tourRouter.post('/complete', async (_req: Request, res: Response) => {
  const ts = new Date().toISOString();
  await writeTourCompletedAt(ts);
  res.json({ completedAt: ts });
});
