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
  /** Free VRAM at the time of the last successful sidecar poll, per
      `fetch-sidecar-devices.ts`'s `SidecarDevice.free_mb` — the same
      staleness tradeoff as `idx`/`uuid` above. Feeds
      `auto-revert-selection.ts`'s target choice so a code-43 revert can land
      on a card that actually has room, not just "auto" (which re-resolves to
      the same undersized card and loops). */
  freeMb: number;
}

let lastKnownGpuDevices: GpuDeviceInfo[] = [];

export function setLastKnownGpuDevices(devices: GpuDeviceInfo[]): void {
  lastKnownGpuDevices = devices;
}

export function getLastKnownGpuDevices(): GpuDeviceInfo[] {
  return lastKnownGpuDevices;
}
