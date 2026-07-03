/* Shared "fetch the sidecar's live CUDA device list" helper — the one place
   every caller that needs {uuid,idx,name,total_mb,free_mb} + the cpu-fallback
   flag goes through, instead of each route re-implementing its own
   fetch-with-2s-abort-timeout-and-safe-json-parse (gpu-devices.ts and
   gpu-uuid.ts previously carried two independent copies that had already
   drifted — only one of them called setLastKnownGpuDevices). Returns null on
   any failure (timeout, unreachable, non-2xx) so a caller can distinguish
   "couldn't reach the sidecar" from "reached it, zero cards" — the two mean
   different things for the `cpu` fallback-availability flag. */

import { getResolvedSidecarUrl } from '../workspace/user-settings.js';

const PROBE_TIMEOUT_MS = 2_000;

export interface SidecarDevice {
  uuid: string;
  idx: number;
  name: string;
  total_mb: number;
  free_mb: number;
}

export interface SidecarDevicesResponse {
  devices: SidecarDevice[];
  cpu: boolean;
}

export async function fetchSidecarDevices(): Promise<SidecarDevicesResponse | null> {
  const url = getResolvedSidecarUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${url}/devices`, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    if (!upstream.ok) return null;
    const body = (await upstream.json().catch(() => null)) as Partial<SidecarDevicesResponse> | null;
    if (!body) return null;
    return { devices: body.devices ?? [], cpu: body.cpu ?? true };
  } catch {
    clearTimeout(timer);
    return null;
  }
}
