/* GET /api/gpu/devices — proxies the sidecar's /devices endpoint, which
   enumerates visible CUDA cards ({uuid,idx,name,total_mb,free_mb}). Returns
   {devices:[],cpu:true} when the sidecar is down so the caller gets a safe
   empty list rather than an error. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';

export const gpuDevicesRouter = Router();

const PROBE_TIMEOUT_MS = 2_000;

gpuDevicesRouter.get('/devices', async (_req: Request, res: Response) => {
  const url = getResolvedSidecarUrl();
  const target = `${url}/devices`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const upstream = await fetch(target, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    if (!upstream.ok) {
      return res.json({ devices: [], cpu: true });
    }
    const body = (await upstream.json().catch(() => ({ devices: [], cpu: true }))) as {
      devices: unknown[];
      cpu: boolean;
    };
    return res.json(body);
  } catch {
    clearTimeout(timer);
    return res.json({ devices: [], cpu: true });
  }
});
