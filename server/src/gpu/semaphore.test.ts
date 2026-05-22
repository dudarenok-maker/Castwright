/* GpuSemaphore — FIFO arbitration around the analyzer + sidecar GPU
   call sites. Three contract guarantees this spec pins:

   1. Capacity:    `new GpuSemaphore(2)` admits two acquires concurrently
                   and forces the third to wait until one releases.
   2. FIFO order:  acquires that block on a full semaphore release in the
                   order they queued — A finishes, B runs, C waits; B
                   releases, C runs; etc.
   3. Queue depth: `queueDepth` reflects waiters not yet running and
                   ticks down on every release while waiters exist.

   These guarantees feed the frontend pill's "Queued (N ahead) ·"
   prefix (see src/lib/use-tts-lifecycle.ts + src/components/layout.tsx),
   so a regression in any of them silently breaks the parallel-sessions
   UX. */

import { describe, it, expect } from 'vitest';
import { GpuSemaphore } from './semaphore.js';

/** Helper: a queued microtask flush, so a Promise resolved by a
    release fn settles before the next assertion. Cheaper than waiting
    on a setTimeout(0) shim — Vitest's default node env executes
    microtasks synchronously after `await Promise.resolve()`. */
async function flush(): Promise<void> {
  /* Two micro-ticks: one for the release-fn shift(), one for the
     newly-resolved waiter's `.then(...)` continuation to run. */
  await Promise.resolve();
  await Promise.resolve();
}

describe('GpuSemaphore', () => {
  it('admits up to `max` acquires concurrently and queues the rest', async () => {
    const sem = new GpuSemaphore(2);

    /* First two acquires resolve immediately — synchronous slot grab. */
    const releaseA = await sem.acquire();
    const releaseB = await sem.acquire();
    expect(sem.inFlight).toBe(2);
    expect(sem.queueDepth).toBe(0);

    /* Third acquire queues; tracked but not yet resolved. */
    let cResolved = false;
    const cPromise = sem.acquire().then((rel) => {
      cResolved = true;
      return rel;
    });
    await flush();
    expect(cResolved).toBe(false);
    expect(sem.inFlight).toBe(2);
    expect(sem.queueDepth).toBe(1);

    /* Releasing A passes the slot to C without bumping the in-flight
       count (still 2 — A's slot is now C's). */
    releaseA();
    await flush();
    expect(cResolved).toBe(true);
    expect(sem.inFlight).toBe(2);
    expect(sem.queueDepth).toBe(0);

    /* Drain: release B + C; the counter must end at 0. */
    const releaseC = await cPromise;
    releaseB();
    releaseC();
    expect(sem.inFlight).toBe(0);
    expect(sem.queueDepth).toBe(0);
  });

  it('serialises max=1 acquires in strict FIFO order', async () => {
    const sem = new GpuSemaphore(1);
    const completed: string[] = [];

    /* Kick off a worker that acquires, records its label, then
       releases on a follow-up tick. Returned promise resolves when the
       worker has fully released its slot. */
    const runWorker = async (label: string): Promise<void> => {
      const release = await sem.acquire();
      completed.push(label);
      /* Yield a microtask before releasing so the next-in-line waiter
         visibly sequences after this one rather than racing. */
      await Promise.resolve();
      release();
    };

    /* A acquires immediately (slot was empty); B/C/D queue behind it. */
    const aDone = runWorker('A');
    const bDone = runWorker('B');
    const cDone = runWorker('C');
    const dDone = runWorker('D');

    await Promise.all([aDone, bDone, cDone, dDone]);
    expect(completed).toEqual(['A', 'B', 'C', 'D']);
  });

  it('reports queue depth that ticks down on each release', async () => {
    const sem = new GpuSemaphore(1);

    const releaseA = await sem.acquire();
    expect(sem.inFlight).toBe(1);
    expect(sem.queueDepth).toBe(0);

    /* Two waiters pile up behind A. Resolved-tracking flags so we can
       check that each waiter only runs when the slot is actually
       handed to it. */
    let bRunning = false;
    let cRunning = false;
    const bPromise = sem.acquire().then((rel) => {
      bRunning = true;
      return rel;
    });
    const cPromise = sem.acquire().then((rel) => {
      cRunning = true;
      return rel;
    });
    await flush();
    expect(sem.queueDepth).toBe(2);
    expect(bRunning).toBe(false);
    expect(cRunning).toBe(false);

    /* Release A → B advances to running, depth ticks from 2 to 1. */
    releaseA();
    await flush();
    expect(bRunning).toBe(true);
    expect(cRunning).toBe(false);
    expect(sem.queueDepth).toBe(1);

    /* Release B → C advances, depth → 0. */
    const releaseB = await bPromise;
    releaseB();
    await flush();
    expect(cRunning).toBe(true);
    expect(sem.queueDepth).toBe(0);

    /* Drain. */
    const releaseC = await cPromise;
    releaseC();
    expect(sem.inFlight).toBe(0);
  });

  it('treats double-release as a no-op so finally blocks are safe to chain', async () => {
    /* Both call sites invoke release() inside a try/finally; a defensive
       second call (e.g. the caller wraps acquire() in a helper that also
       releases) must not double-count. Without this guard a max=1
       semaphore would over-release and never block, defeating the
       arbitration. */
    const sem = new GpuSemaphore(1);
    const release = await sem.acquire();
    release();
    release();
    expect(sem.inFlight).toBe(0);

    /* The slot is genuinely free — next acquire resolves immediately. */
    const next = await sem.acquire();
    expect(sem.inFlight).toBe(1);
    next();
  });
});
