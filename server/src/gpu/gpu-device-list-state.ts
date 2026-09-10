/* Last-known GPU device list, mirroring vram-state.ts's pattern: resolveKnob
   (config/resolver.ts) is a SYNCHRONOUS function called throughout the
   codebase, but the sidecar's live device list is only fetchable async
   (GET /api/gpu/devices). Rather than make resolveKnob async (which would
   ripple through dozens of call sites), the resolver reconciles a stored
   'cuda-uuid:<uuid>' override against this cache instead — accepting that
   the reconcile is only as fresh as the last successful sidecar poll, same
   staleness tradeoff vram-state.ts's lastKnownVram already accepts. */

export interface GpuDeviceInfo {
  uuid: string;
  idx: number;
}

let lastKnownGpuDevices: GpuDeviceInfo[] = [];
// #3061 review N5 — an empty array is ambiguous between "nobody has ever
// probed" and "probed, and the box genuinely has zero GPUs". Every writer
// here represents a real (successful) probe result, so this flag flips true
// the moment any of them runs, independent of whether the result was
// empty — giving `ensureGpuDeviceListWarm` something to check other than
// array length.
let warmed = false;

export function setLastKnownGpuDevices(devices: GpuDeviceInfo[]): void {
  lastKnownGpuDevices = devices;
  warmed = true;
}

export function getLastKnownGpuDevices(): GpuDeviceInfo[] {
  return lastKnownGpuDevices;
}

/** Whether a real probe has ever populated this cache — true even when that
    probe came back with zero devices. Distinct from `getLastKnownGpuDevices
    ().length > 0`, which cannot tell "never probed" apart from "probed, zero
    GPUs" (#3061 review N5). */
export function hasWarmedGpuDeviceList(): boolean {
  return warmed;
}

/** Test-only: put the cache back in its pre-probe state. Tests that mean
    "nobody has warmed this yet" must use this rather than
    `setLastKnownGpuDevices([])`, which now marks the cache warmed (with
    zero devices) rather than unwarmed. */
export function resetGpuDeviceListWarmForTests(): void {
  lastKnownGpuDevices = [];
  warmed = false;
}
