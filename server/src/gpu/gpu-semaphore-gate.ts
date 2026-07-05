/* Shared "skip the GPU semaphore when off-GPU" idiom (srv-56). Every caller
   that arbitrates GPU access for an engine that CAN run off-GPU (TTS synth,
   Qwen voice design, ASR, the speaker embed, the analyzer) needs the exact
   same shape: acquire a weighted token when the engine is confirmed running
   on-GPU, skip the semaphore entirely otherwise. A returned cost of 0 would
   NOT achieve the skip on its own — GpuSemaphore.acquire()'s clampCost floors
   any cost below 1 back up to 1 — so the call site must branch before
   acquiring, not just pass a zero cost. Centralized here after PR #1324 added
   three more copies of this same branch (on top of three pre-existing,
   differently-shaped ones) and its own review had to catch one of the new
   copies leaving the acquire ungated by hand. */

import { gpuSemaphore, GpuSemaphore } from './semaphore.js';

/** Acquire a GPU semaphore token only when `onGpu` is true; otherwise skip
    the semaphore entirely and resolve to `null`. Callers `await` this and
    invoke the returned release function (if non-null) in a `finally`,
    exactly like a direct `sem.acquire()` call. `sem` defaults to the
    module-level singleton — pass an injected instance for tests. */
export async function acquireGpuTokenIfOnGpu(
  onGpu: boolean,
  cost: number,
  sem: GpuSemaphore = gpuSemaphore,
): Promise<(() => void) | null> {
  return onGpu ? await sem.acquire(cost) : null;
}
