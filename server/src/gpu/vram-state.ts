export type Accelerator = 'cuda' | 'cpu' | 'unknown';
export interface VramState {
  accelerator: Accelerator;
  totalMb: number | null;
}

/* Last-known VRAM, mirroring the Qwen-install-state cache: only a REACHABLE
   probe updates it, so a transient sidecar respawn (when eviction must still
   decide) doesn't downgrade a known-good reading. `null` resets to "never
   probed"; `undefined` is an unreachable poll (no-op). CUDA presence is inferred
   from a non-null vram_total_mb (the sidecar reports it iff CUDA). */
let lastKnownVram: VramState = { accelerator: 'unknown', totalMb: null };

export function setLastKnownVram(next: { totalMb: number | null } | null | undefined): void {
  if (next === undefined) return;
  if (next === null) {
    lastKnownVram = { accelerator: 'unknown', totalMb: null };
    return;
  }
  lastKnownVram = {
    totalMb: next.totalMb,
    accelerator: next.totalMb != null ? 'cuda' : 'cpu',
  };
}

export function getLastKnownVram(): VramState {
  return lastKnownVram;
}
