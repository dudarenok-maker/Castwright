/* Plan 2 §2.1 — translate between a frontend-facing 'cuda:N' device-knob
   value and the canonical 'cuda-uuid:<uuid>' form persisted to disk, so a
   stored assignment survives index renumbering across a box's restarts.

   There is no existing in-process "getGpuDevices" helper to import — the
   `gpu-devices.ts` router fetches the sidecar's /devices endpoint directly
   (route handlers aren't called in-process here). This mirrors that same
   fetch pattern rather than inventing a new one. */

import { getResolvedSidecarUrl } from '../workspace/user-settings.js';

const PROBE_TIMEOUT_MS = 2_000;

interface SidecarGpuDevice {
  uuid: string;
  idx: number;
}

async function fetchSidecarDevices(): Promise<SidecarGpuDevice[]> {
  const url = getResolvedSidecarUrl();
  const target = `${url}/devices`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const upstream = await fetch(target, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    if (!upstream.ok) return [];
    const body = (await upstream.json().catch(() => ({ devices: [] }))) as { devices?: SidecarGpuDevice[] };
    return body.devices ?? [];
  } catch {
    clearTimeout(timer);
    return [];
  }
}

/** 'cuda:N' -> 'cuda-uuid:<uuid>' using the CURRENT live device list. Returns
    the input unchanged if it isn't a bare 'cuda:N' form, or if no card at
    that index is currently visible (stored as-is; reconciled on next read). */
export async function toUuidForm(value: string): Promise<string> {
  const m = /^cuda:(\d+)$/.exec(value);
  if (!m) return value;
  const idx = Number(m[1]);
  const devices = await fetchSidecarDevices();
  const card = devices.find((d) => d.idx === idx);
  return card ? `cuda-uuid:${card.uuid}` : value;
}
