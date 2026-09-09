/* GET /api/gpu/trip-status — Task 16/16.5 (#1230 item 2, #2974). Surfaces the
   outcome of the most recent code-43 streak trip (server/src/gpu/auto-revert.ts,
   fed by sidecar-supervisor.ts's onTrip) so the frontend can show the
   "auto-reverted: ..." or "not tied to a specific GPU card... manual
   investigation" toast without polling tripEvent() itself (which the client
   has no route to at all — it's an in-process supervisor method). Returns
   `null` when nothing has tripped since this server booted. */
import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { getTripStatus, type TripStatus } from '../gpu/auto-revert.js';

export const gpuTripStatusRouter = Router();

gpuTripStatusRouter.get('/trip-status', (_req: Request, res: Response) => {
  const status: TripStatus | null = getTripStatus();
  res.json(status);
});
