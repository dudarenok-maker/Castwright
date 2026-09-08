/* Plan 2 §2.1 — translate between a frontend-facing 'cuda:N' device-knob
   value and the canonical 'cuda-uuid:<uuid>' form persisted to disk, so a
   stored assignment survives index renumbering across a box's restarts. */

import { fetchSidecarDevices, type SidecarDevicesResponse } from '../gpu/fetch-sidecar-devices.js';
import { setLastKnownGpuDevices } from '../gpu/gpu-device-list-state.js';

const CUDA_INDEX_RE = /^cuda:(\d+)$/;

/** True for a bare 'cuda:N' value — the only shape toUuidForm() actually
    translates (and therefore the only shape that needs a sidecar device-list
    fetch at all). Exported so a caller patching several device knobs at once
    can decide up front whether it's worth resolving the list, without
    duplicating the pattern. */
export function needsUuidTranslation(value: unknown): value is string {
  return typeof value === 'string' && CUDA_INDEX_RE.test(value);
}

/** 'cuda:N' -> 'cuda-uuid:<uuid>' using the CURRENT live device list. Returns
    the input unchanged if it isn't a bare 'cuda:N' form, or if no card at
    that index is currently visible (stored as-is; reconciled on next read).
    Also warms the shared last-known-device-list cache (gpu-device-list-state.ts)
    that resolveKnob's own UUID reconcile reads — a PUT that writes a
    cuda-uuid: override is exactly the moment that cache most needs to be
    fresh, so the write and the cache warm share this one fetch.

    `prefetchedDevices` lets a caller resolve the sidecar's device list once
    and reuse it across several toUuidForm() calls in the same request
    (e.g. a PUT patching all three tts.*.device knobs at once) instead of
    paying one sidecar round-trip per key — pass `undefined` (the default)
    to fetch fresh here. */
export async function toUuidForm(
  value: string,
  prefetchedDevices?: SidecarDevicesResponse | null,
): Promise<string> {
  const m = CUDA_INDEX_RE.exec(value);
  if (!m) return value;
  const idx = Number(m[1]);
  const result = prefetchedDevices !== undefined ? prefetchedDevices : await fetchSidecarDevices();
  if (!result) return value;
  setLastKnownGpuDevices(result.devices.map((d) => ({ uuid: d.uuid, idx: d.idx })));
  const card = result.devices.find((d) => d.idx === idx);
  return card ? `cuda-uuid:${card.uuid}` : value;
}
