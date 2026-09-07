/* Warm `gpu-device-list-state.ts`'s last-known device list from the sidecar,
   once, if nothing has warmed it yet.

   Lives in its own module rather than in `gpu-device-list-state.ts` so that
   file keeps its zero imports: `config/resolver.ts` imports it on the
   synchronous knob-resolution path, and pulling `fetch-sidecar-devices.ts`
   (→ `workspace/user-settings.ts` → …) in behind it would drag a large
   subgraph into that path for no reason. Callers that actually need the
   cache POPULATED import this; callers that only read it keep importing the
   state module directly.

   #3061 review C1 — this used to be a private helper inside
   `routes/config.ts`, which made it reachable only from `GET /api/config`,
   i.e. only from the Advanced Settings mount effect. Every other consumer of
   the cache (`resolveKnob`'s `cuda-uuid:` reconcile, and now #3058's lazy
   Coqui derive hint) silently read an EMPTY list on a server nobody had
   opened that settings screen on. Extracting it is what lets the generation
   path warm the cache too. */

import { fetchSidecarDevices } from './fetch-sidecar-devices.js';
import { getLastKnownGpuDevices, setLastKnownGpuDevices } from './gpu-device-list-state.js';

/** Populate the last-known GPU device list if it is empty. A no-op once
    anything (this, `GET /api/gpu/devices`, `toUuidForm`) has already warmed
    it, so it costs one sidecar round-trip per process at most on the happy
    path. Never throws: `fetchSidecarDevices` returns null on any failure
    (timeout, unreachable, non-2xx), and a null result leaves the cache empty
    — every caller must still handle the empty case, because a box with no
    sidecar running will always land there. */
export async function ensureGpuDeviceListWarm(): Promise<void> {
  if (getLastKnownGpuDevices().length > 0) return;
  const result = await fetchSidecarDevices();
  if (result) setLastKnownGpuDevices(result.devices.map((d) => ({ uuid: d.uuid, idx: d.idx })));
}
