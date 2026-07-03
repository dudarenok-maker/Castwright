/* GET /api/gpu/devices — proxies the sidecar's /devices endpoint, which
   enumerates visible CUDA cards ({uuid,idx,name,total_mb,free_mb}). Returns
   {devices:[],cpu:true} when the sidecar is down so the caller gets a safe
   empty list rather than an error. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';
import { setLastKnownGpuDevices } from '../gpu/gpu-device-list-state.js';
import { fetchSidecarDevices } from '../gpu/fetch-sidecar-devices.js';

export const gpuDevicesRouter = Router();

const PROBE_TIMEOUT_MS = 2_000;

type ResidentEntry = { engine: string; actual_card: number | null; stale_reason?: string };

gpuDevicesRouter.get('/devices', async (_req: Request, res: Response) => {
  const result = await fetchSidecarDevices();
  if (!result) {
    return res.json({ devices: [], cpu: true });
  }
  setLastKnownGpuDevices(result.devices.map((d) => ({ uuid: d.uuid, idx: d.idx })));
  const url = getResolvedSidecarUrl();
  const merged = await mergeResidentData(url, result.devices);
  return res.json({ devices: merged, cpu: result.cpu });
});

/** Best-effort merge of /health gpus[] resident/stale_reason/torch_reserved_mb
    onto the static /devices list. A /health failure (timeout, unreachable)
    degrades gracefully to the devices-only shape — resident data is a
    nice-to-have annotation, never a reason to fail the whole response.

    /health's gpus[] carries a SYNTHETIC idx:-1 "unindexed (cpu / ORT / CT2)"
    entry whenever an engine has actually fallen back to CPU (or otherwise
    landed off any real card) — that's where stale_reason:'cpu_fallback'
    lives (main.py's _build_gpus_payload). The static /devices list from
    the sidecar's own /devices route only ever enumerates REAL indexed CUDA
    cards, so a naive per-idx merge silently drops this bucket and the
    cpu_fallback badge can never reach the frontend (reproduced on real
    hardware during Plan 2a's on-box acceptance: a Kokoro engine pinned to
    an out-of-range cuda:9 correctly falls back to CPU sidecar-side, but the
    picker showed no badge at all). Append it as its own device-shaped entry
    — deriveStaleReason (advanced.tsx) already scans every gpuDevices[]
    entry's resident[] regardless of idx, so no frontend change is needed
    beyond this. override-row.tsx's device <select> options are built from
    `cuda:${d.idx}`, so idx:-1 must never leak into a selectable option —
    filtered there, not here (this stays a pure pass-through of whatever
    /health reports). */
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
    const gpus = health.gpus ?? [];
    const byIdx = new Map(gpus.map((g) => [g.idx as number, g]));
    const merged = devices.map((d) => {
      const g = byIdx.get(d.idx);
      if (!g) return d;
      return {
        ...d,
        resident: g.resident,
        torchReservedMb: g.torch_reserved_mb,
      };
    });
    const unindexed = gpus.find(
      (g) => g.idx === -1 && Array.isArray(g.resident) && (g.resident as unknown[]).length > 0,
    );
    if (unindexed) {
      merged.push({
        uuid: '',
        idx: -1,
        name: (unindexed.name as string) ?? 'unindexed (cpu / ORT / CT2)',
        total_mb: 0,
        free_mb: 0,
        resident: unindexed.resident as ResidentEntry[],
        torchReservedMb: unindexed.torch_reserved_mb as number | undefined,
      });
    }
    return merged;
  } catch {
    return devices;
  }
}
