/* GET /api/gpu/devices — proxies the sidecar's /devices endpoint, which
   enumerates visible CUDA cards ({uuid,idx,name,total_mb,free_mb}). Returns
   {devices:[],cpu:true} when the sidecar is down so the caller gets a safe
   empty list rather than an error. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';
import { setLastKnownGpuDevices } from '../gpu/gpu-device-list-state.js';

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
      devices: Array<{ uuid: string; idx: number; name: string; total_mb: number; free_mb: number }>;
      cpu: boolean;
    };
    setLastKnownGpuDevices(body.devices.map((d) => ({ uuid: d.uuid, idx: d.idx })));
    const merged = await mergeResidentData(url, body.devices);
    return res.json({ devices: merged, cpu: body.cpu });
  } catch {
    clearTimeout(timer);
    return res.json({ devices: [], cpu: true });
  }
});

/** Best-effort merge of /health gpus[] resident/stale_reason/torch_reserved_mb
    onto the static /devices list. A /health failure (timeout, unreachable)
    degrades gracefully to the devices-only shape — resident data is a
    nice-to-have annotation, never a reason to fail the whole response. */
async function mergeResidentData(
  sidecarUrl: string,
  devices: Array<{ uuid: string; idx: number; name: string; total_mb: number; free_mb: number }>,
) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(`${sidecarUrl}/health`, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return devices;
    const health = (await res.json().catch(() => ({}))) as { gpus?: Array<Record<string, unknown>> };
    const byIdx = new Map((health.gpus ?? []).map((g) => [g.idx as number, g]));
    return devices.map((d) => {
      const g = byIdx.get(d.idx);
      if (!g) return d;
      return {
        ...d,
        resident: g.resident,
        torchReservedMb: g.torch_reserved_mb,
      };
    });
  } catch {
    return devices;
  }
}
