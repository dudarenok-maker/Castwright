/* Plan 2 §2.1 — translate between a frontend-facing 'cuda:N' device-knob
   value and the canonical 'cuda-uuid:<uuid>' form persisted to disk, so a
   stored assignment survives index renumbering across a box's restarts. */

import { fetchSidecarDevices } from '../gpu/fetch-sidecar-devices.js';
import { setLastKnownGpuDevices } from '../gpu/gpu-device-list-state.js';

/** 'cuda:N' -> 'cuda-uuid:<uuid>' using the CURRENT live device list. Returns
    the input unchanged if it isn't a bare 'cuda:N' form, or if no card at
    that index is currently visible (stored as-is; reconciled on next read).
    Also warms the shared last-known-device-list cache (gpu-device-list-state.ts)
    that resolveKnob's own UUID reconcile reads — a PUT that writes a
    cuda-uuid: override is exactly the moment that cache most needs to be
    fresh, so the write and the cache warm share this one fetch. */
export async function toUuidForm(value: string): Promise<string> {
  const m = /^cuda:(\d+)$/.exec(value);
  if (!m) return value;
  const idx = Number(m[1]);
  const result = await fetchSidecarDevices();
  if (!result) return value;
  setLastKnownGpuDevices(result.devices.map((d) => ({ uuid: d.uuid, idx: d.idx })));
  const card = result.devices.find((d) => d.idx === idx);
  return card ? `cuda-uuid:${card.uuid}` : value;
}
