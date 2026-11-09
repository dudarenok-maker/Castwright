/* GET /api/gpu/queue — surfaces GPU queue depth + live per-device VRAM so the
   frontend top-bar pill can prefix "Queued (N ahead) ·" when a session is
   waiting behind another's synth call for GPU capacity. Polled on the same
   30 s cadence as /api/sidecar/health by useTtsLifecycle().

   vram-aware placement (Task 10) migrated this off the deleted gpuSemaphore:
   `queueDepth` now comes from the sidecar client's no-capacity poll-wait
   counter (server/src/tts/sidecar.ts, getCapacityWaiterCount()), and
   `devices` is a live read of server/src/gpu/capacity-probe.ts. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { getCapacityWaiterCount } from '../tts/sidecar.js';
import { capacityProbe, type ComputeDevice } from '../gpu/capacity-probe.js';
import { getLastTtsAutoFree, type TtsAutoFreeNotice } from '../gpu/tts-auto-free-notice.js';

export const gpuQueueRouter = Router();

export interface GpuQueueState {
  queueDepth: number;
  devices: ComputeDevice[];
  /** #4066 — the last time a voice design or a Quality op unloaded resident
      TTS models to free VRAM (gpu/tts-auto-free-notice.ts), or null. The
      frontend shows the "unloaded to free VRAM" notice once per new seq. */
  lastTtsAutoFree: TtsAutoFreeNotice | null;
}

/* Extracted so the /api/diagnostics aggregator (fs-18) can reuse it
   in-process. */
export async function readGpuQueueState(): Promise<GpuQueueState> {
  return {
    queueDepth: getCapacityWaiterCount(),
    devices: await capacityProbe.read(),
    lastTtsAutoFree: getLastTtsAutoFree(),
  };
}

gpuQueueRouter.get('/queue', async (_req: Request, res: Response) => {
  res.json(await readGpuQueueState());
});
