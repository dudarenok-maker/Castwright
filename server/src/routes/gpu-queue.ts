/* GET /api/gpu/queue — surfaces the GpuSemaphore's current state so the
   frontend top-bar pill can prefix "Queued (N ahead) ·" when a session
   is waiting behind another's analyzer or sidecar call. Polled on the
   same 30 s cadence as /api/sidecar/health by useTtsLifecycle().

   Concerns are deliberately split from /api/sidecar/health: the
   semaphore covers BOTH analyzer (Ollama chat) and sidecar
   (/synthesize) ops, so a sidecar-health response can't represent its
   full state. A separate endpoint keeps each surface answering exactly
   one question. */

import { Router, type Request, type Response } from 'express';
import { gpuSemaphore } from '../gpu/semaphore.js';

export const gpuQueueRouter = Router();

gpuQueueRouter.get('/queue', (_req: Request, res: Response) => {
  res.json({
    depth: gpuSemaphore.queueDepth,
    inFlight: gpuSemaphore.inFlight,
    /* `max` is the legacy field the frontend pill reads; kept aliased to the
       token budget so the existing shape never breaks. `budget`/`usedTokens`
       are additive — the VRAM-weighted view for diagnostics. */
    max: gpuSemaphore.maxConcurrency,
    budget: gpuSemaphore.budget,
    usedTokens: gpuSemaphore.usedTokens,
  });
});
