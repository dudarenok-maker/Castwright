/* Shared off-GPU semaphore-skip idiom (srv-56). Pins the two behaviours every
   call site relies on: an off-GPU engine never touches the semaphore at all
   (no token consumed, release is a no-op null), and an on-GPU engine acquires
   through the given semaphore instance at the given cost. */

import { describe, it, expect } from 'vitest';
import { GpuSemaphore } from './semaphore.js';
import { acquireGpuTokenIfOnGpu } from './gpu-semaphore-gate.js';

describe('acquireGpuTokenIfOnGpu', () => {
  it('skips the semaphore entirely when onGpu is false — no token consumed', async () => {
    const sem = new GpuSemaphore(1);
    const release = await acquireGpuTokenIfOnGpu(false, 1, sem);
    expect(release).toBeNull();
    expect(sem.usedTokens).toBe(0);
    // A second off-GPU caller isn't blocked by the first — proves no token was held.
    const release2 = await acquireGpuTokenIfOnGpu(false, 1, sem);
    expect(release2).toBeNull();
  });

  it('acquires through the given semaphore at the given cost when onGpu is true', async () => {
    const sem = new GpuSemaphore(4);
    const release = await acquireGpuTokenIfOnGpu(true, 3, sem);
    expect(release).not.toBeNull();
    expect(sem.usedTokens).toBe(3);
    release!();
    expect(sem.usedTokens).toBe(0);
  });

  it('defaults to the module-level gpuSemaphore singleton when no instance is passed', async () => {
    const release = await acquireGpuTokenIfOnGpu(false, 1);
    expect(release).toBeNull();
  });
});
