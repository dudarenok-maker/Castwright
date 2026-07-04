/* Last-known per-engine (kokoro/coqui/qwen) runtime device, mirroring
   vram-state.ts's cache shape. Populated from the sidecar's side-14 `devices`
   map (server/src/routes/sidecar-health.ts) every REACHABLE health poll — an
   unreachable poll must not downgrade a known-good reading, so `undefined` is
   a no-op and only `null` (an old sidecar, or a malformed body) resets to
   'unknown'. Consumed synchronously by engine-device.ts's engineDeviceIsGpu()
   so the GPU semaphore and the pre-load eviction guard both read the same
   ground truth. */

import type { SidecarDeviceMap } from '../routes/sidecar-health.js';

export type EngineDeviceFamily = 'cuda' | 'rocm' | 'directml' | 'mps' | 'cpu' | 'unknown';

const TRACKED_ENGINES = ['kokoro', 'coqui', 'qwen'] as const;
type TrackedEngine = (typeof TRACKED_ENGINES)[number];

function emptyState(): Record<TrackedEngine, EngineDeviceFamily> {
  return { kokoro: 'unknown', coqui: 'unknown', qwen: 'unknown' };
}

let lastKnown: Record<TrackedEngine, EngineDeviceFamily> = emptyState();

function isTrackedEngine(engine: string): engine is TrackedEngine {
  return (TRACKED_ENGINES as readonly string[]).includes(engine);
}

/** Update from a health poll. `undefined` = unreachable poll (no-op, keeps
    prior state). `null` = reachable but no usable devices map (old sidecar,
    or a body `normaliseDevices` rejected) — resets every engine to
    'unknown', never silently invents a family. A concrete map's per-engine
    `null` slot (a family `normaliseDevices` couldn't recognize) also maps to
    'unknown'. */
export function setLastKnownEngineDevices(devices: SidecarDeviceMap | null | undefined): void {
  if (devices === undefined) return;
  if (devices === null) {
    lastKnown = emptyState();
    return;
  }
  const next = emptyState();
  for (const engine of TRACKED_ENGINES) {
    next[engine] = (devices[engine] ?? 'unknown') as EngineDeviceFamily;
  }
  lastKnown = next;
}

/** Synchronous read. Any engine outside {kokoro, coqui, qwen} (e.g. the
    cloud-only 'gemini') always reads back 'unknown' — matches
    costForEngine/engineDeviceIsGpu's existing "no registered device knob"
    convention. */
export function getLastKnownEngineDevice(engine: string): EngineDeviceFamily {
  return isTrackedEngine(engine) ? lastKnown[engine] : 'unknown';
}

export function _resetEngineDevicesForTests(): void {
  lastKnown = emptyState();
}
