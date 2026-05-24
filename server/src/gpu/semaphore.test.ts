/* GpuSemaphore — VRAM-weighted FIFO arbitration around the analyzer +
   sidecar GPU call sites. Guarantees this spec pins:

   1. Capacity:    `new GpuSemaphore(2)` admits two cost-1 acquires
                   concurrently and forces the third to wait until one
                   releases.
   2. FIFO order:  acquires that block on a full semaphore release in the
                   order they queued — A finishes, B runs, C waits; B
                   releases, C runs; etc.
   3. Queue depth: `queueDepth` reflects waiters not yet running and
                   ticks down on every release while waiters exist.
   4. Weighting:   `acquire(cost)` takes `cost` tokens of the budget — two
                   cost-2 ops fit a budget-4 semaphore, a third waits; a
                   cost > budget clamps to the budget (never deadlocks).
   5. Back-compat: budget = N with every acquire at cost 1 behaves exactly
                   like the old count semaphore with max = N.

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

  it('does not leak tokens on double-release of a weighted hold', async () => {
    /* A cost-3 hold double-released must free exactly 3 tokens, not 6 —
       otherwise `usedTokens` would underflow and the semaphore would
       over-admit. */
    const sem = new GpuSemaphore(4);
    const release = await sem.acquire(3);
    expect(sem.usedTokens).toBe(3);
    release();
    release();
    expect(sem.usedTokens).toBe(0);
    expect(sem.inFlight).toBe(0);
  });
});

describe('GpuSemaphore — VRAM-weighted acquire', () => {
  it('admits acquires whose summed cost fits the budget and queues the rest', async () => {
    const sem = new GpuSemaphore(4);

    /* Two cost-2 acquires fit (2 + 2 = 4). */
    const releaseA = await sem.acquire(2);
    const releaseB = await sem.acquire(2);
    expect(sem.usedTokens).toBe(4);
    expect(sem.inFlight).toBe(2);
    expect(sem.queueDepth).toBe(0);

    /* A third cost-2 would overcommit (4 + 2 > 4) → queues. */
    let cResolved = false;
    const cPromise = sem.acquire(2).then((rel) => {
      cResolved = true;
      return rel;
    });
    await flush();
    expect(cResolved).toBe(false);
    expect(sem.usedTokens).toBe(4);
    expect(sem.queueDepth).toBe(1);

    /* Releasing A frees 2 tokens → C wakes and takes them. */
    releaseA();
    await flush();
    expect(cResolved).toBe(true);
    expect(sem.usedTokens).toBe(4);
    expect(sem.queueDepth).toBe(0);

    const releaseC = await cPromise;
    releaseB();
    releaseC();
    expect(sem.usedTokens).toBe(0);
    expect(sem.inFlight).toBe(0);
  });

  it('clamps cost > budget down to the budget so it never deadlocks', async () => {
    const sem = new GpuSemaphore(4);

    /* cost 10 on a budget-4 semaphore behaves as cost 4 — it runs alone and
       releasing it returns the full budget. */
    const release = await sem.acquire(10);
    expect(sem.usedTokens).toBe(4);
    expect(sem.inFlight).toBe(1);

    /* Anything else must wait while the over-budget op holds everything. */
    let nextResolved = false;
    const nextPromise = sem.acquire(1).then((rel) => {
      nextResolved = true;
      return rel;
    });
    await flush();
    expect(nextResolved).toBe(false);

    release();
    await flush();
    expect(nextResolved).toBe(true);
    const next = await nextPromise;
    expect(sem.usedTokens).toBe(1);
    next();
    expect(sem.usedTokens).toBe(0);
  });

  it('clamps cost < 1 up to 1', async () => {
    const sem = new GpuSemaphore(2);
    const release = await sem.acquire(0);
    expect(sem.usedTokens).toBe(1);
    release();
    expect(sem.usedTokens).toBe(0);
  });

  it('head-of-line blocks: a cheap later waiter cannot jump an expensive head that does not fit', async () => {
    /* Budget 4, fully held by two cost-2 holders (A1, A2). B (cost 3) queues
       at the head; C (cost 1) queues behind it. Release ONE holder → 2 tokens
       free. B (3) still doesn't fit, so it stays blocked — and FIFO means C
       (which WOULD fit the 2 free tokens) must NOT jump ahead of B. Nothing
       wakes until B can run. */
    const sem = new GpuSemaphore(4);
    const order: string[] = [];

    const releaseA1 = await sem.acquire(2);
    const releaseA2 = await sem.acquire(2);
    expect(sem.usedTokens).toBe(4);

    const bPromise = sem.acquire(3).then((rel) => {
      order.push('B');
      return rel;
    });
    const cPromise = sem.acquire(1).then((rel) => {
      order.push('C');
      return rel;
    });
    await flush();
    expect(order).toEqual([]);
    expect(sem.queueDepth).toBe(2);

    /* Free 2 tokens — not enough for B (3). C must stay blocked behind B. */
    releaseA1();
    await flush();
    expect(order).toEqual([]);
    expect(sem.usedTokens).toBe(2);
    expect(sem.queueDepth).toBe(2);

    /* Free the other 2 → 4 free. B fits (3) and wakes first; C then fits the
       remaining 1. FIFO order: B before C. */
    releaseA2();
    await flush();
    expect(order).toEqual(['B', 'C']);
    expect(sem.usedTokens).toBe(4);

    const releaseB = await bPromise;
    const releaseC = await cPromise;
    releaseB();
    releaseC();
    expect(sem.usedTokens).toBe(0);
    expect(sem.inFlight).toBe(0);
  });

  describe('backward-compat: budget = N + cost 1 === old count semaphore max = N', () => {
    it('serialises at budget 1', async () => {
      const sem = new GpuSemaphore(1);
      const completed: string[] = [];
      const runWorker = async (label: string): Promise<void> => {
        const release = await sem.acquire(); // default cost 1
        completed.push(label);
        await Promise.resolve();
        release();
      };
      await Promise.all([runWorker('A'), runWorker('B'), runWorker('C')]);
      expect(completed).toEqual(['A', 'B', 'C']);
    });

    it('admits exactly 2 concurrently at budget 2', async () => {
      const sem = new GpuSemaphore(2);
      const releaseA = await sem.acquire();
      const releaseB = await sem.acquire();
      expect(sem.inFlight).toBe(2);
      expect(sem.queueDepth).toBe(0);

      let cResolved = false;
      sem.acquire().then(() => {
        cResolved = true;
      });
      await flush();
      expect(cResolved).toBe(false);
      expect(sem.queueDepth).toBe(1);

      releaseA();
      await flush();
      expect(cResolved).toBe(true);
      releaseB();
    });

    it('exposes budget via maxConcurrency for the poolWidth default', () => {
      expect(new GpuSemaphore(1).maxConcurrency).toBe(1);
      expect(new GpuSemaphore(4).maxConcurrency).toBe(4);
      expect(new GpuSemaphore(4).budget).toBe(4);
    });
  });
});
