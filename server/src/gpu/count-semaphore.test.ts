/* CountSemaphore — the plain FIFO count core extracted from GpuSemaphore
   (see semaphore.ts), with the VRAM token/cost weighting removed: every
   acquire is cost 1. This spec pins:

   1. Capacity:    `new CountSemaphore(2)` admits two acquires concurrently
                   and forces the third to wait until one releases.
   2. FIFO order:  acquires that block on a full semaphore grant in the
                   order they queued.
   3. Queue depth: `queueDepth` reflects waiters not yet running and ticks
                   down on every release while waiters exist.
   4. resize:      growing immediately drains queued waiters that now fit;
                   shrinking leaves in-flight holders untouched.
   5. Abort:       a queued waiter removed via AbortSignal rejects with an
                   AbortError and leaks no slots; an already-aborted signal
                   rejects immediately; a granted acquire ignores a later
                   abort. */

import { describe, it, expect } from 'vitest';
import { CountSemaphore } from './count-semaphore.js';

/** Helper: a queued microtask flush, so a Promise resolved by a release fn
    settles before the next assertion. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('CountSemaphore', () => {
  it('admits up to `max` acquires concurrently and queues the rest', async () => {
    const sem = new CountSemaphore(2);

    const releaseA = await sem.acquire();
    const releaseB = await sem.acquire();
    expect(sem.inFlight).toBe(2);
    expect(sem.queueDepth).toBe(0);

    let cResolved = false;
    const cPromise = sem.acquire().then((rel) => {
      cResolved = true;
      return rel;
    });
    await flush();
    expect(cResolved).toBe(false);
    expect(sem.inFlight).toBe(2);
    expect(sem.queueDepth).toBe(1);

    releaseA();
    await flush();
    expect(cResolved).toBe(true);
    expect(sem.inFlight).toBe(2);
    expect(sem.queueDepth).toBe(0);

    const releaseC = await cPromise;
    releaseB();
    releaseC();
    expect(sem.inFlight).toBe(0);
    expect(sem.queueDepth).toBe(0);
  });

  it('serialises max=1 acquires in strict FIFO order', async () => {
    const sem = new CountSemaphore(1);
    const completed: string[] = [];

    const runWorker = async (label: string): Promise<void> => {
      const release = await sem.acquire();
      completed.push(label);
      await Promise.resolve();
      release();
    };

    const aDone = runWorker('A');
    const bDone = runWorker('B');
    const cDone = runWorker('C');
    const dDone = runWorker('D');

    await Promise.all([aDone, bDone, cDone, dDone]);
    expect(completed).toEqual(['A', 'B', 'C', 'D']);
  });

  it('reports queue depth that ticks down on each release', async () => {
    const sem = new CountSemaphore(1);

    const releaseA = await sem.acquire();
    expect(sem.inFlight).toBe(1);
    expect(sem.queueDepth).toBe(0);

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

    releaseA();
    await flush();
    expect(bRunning).toBe(true);
    expect(cRunning).toBe(false);
    expect(sem.queueDepth).toBe(1);

    const releaseB = await bPromise;
    releaseB();
    await flush();
    expect(cRunning).toBe(true);
    expect(sem.queueDepth).toBe(0);

    const releaseC = await cPromise;
    releaseC();
    expect(sem.inFlight).toBe(0);
  });

  it('treats double-release as a no-op so finally blocks are safe to chain', async () => {
    const sem = new CountSemaphore(1);
    const release = await sem.acquire();
    release();
    release();
    expect(sem.inFlight).toBe(0);

    const next = await sem.acquire();
    expect(sem.inFlight).toBe(1);
    next();
  });
});

describe('CountSemaphore — abortable acquire', () => {
  it('aborting a queued waiter rejects with AbortError and leaks no slots', async () => {
    const sem = new CountSemaphore(1);
    const held = await sem.acquire(); // occupies the only slot
    const ac = new AbortController();
    const queued = sem.acquire({ signal: ac.signal }); // must queue
    expect(sem.queueDepth).toBe(1);

    ac.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(sem.queueDepth).toBe(0); // waiter removed
    expect(sem.inFlight).toBe(1); // only `held` still holds

    // The semaphore is still healthy: releasing the holder grants a fresh acquire.
    held();
    const next = await sem.acquire(); // must resolve, not hang
    next();
    expect(sem.inFlight).toBe(0);
  });

  it('acquire with an already-aborted signal rejects immediately and takes no slot', async () => {
    const sem = new CountSemaphore(2);
    const ac = new AbortController();
    ac.abort();
    await expect(sem.acquire({ signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(sem.inFlight).toBe(0);
  });

  it('a synchronously granted acquire ignores a later abort', async () => {
    const sem = new CountSemaphore(2);
    const ac = new AbortController();
    const release = await sem.acquire({ signal: ac.signal }); // granted immediately (slot free)
    expect(sem.inFlight).toBe(1);
    ac.abort(); // must NOT throw or double-settle
    expect(sem.inFlight).toBe(1);
    release();
    expect(sem.inFlight).toBe(0);
  });
});

describe('CountSemaphore.resize', () => {
  it('growing the max immediately drains a queued waiter that now fits', async () => {
    const sem = new CountSemaphore(1);
    const r1 = await sem.acquire(); // used=1, full
    let granted = false;
    const p2 = sem.acquire().then((rel) => {
      granted = true;
      return rel;
    }); // queues (1+1 > 1)
    await flush();
    expect(granted).toBe(false);
    expect(sem.queueDepth).toBe(1);

    sem.resize(2); // now 1+1 <= 2 -> waiter granted without any release
    await flush();
    expect(granted).toBe(true);
    expect(sem.inFlight).toBe(2);
    expect(sem.max).toBe(2);

    r1();
    (await p2)();
    expect(sem.inFlight).toBe(0);
  });

  it('shrinking leaves in-flight holders untouched; new acquires wait until it drains under', async () => {
    const sem = new CountSemaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire(); // used=2
    sem.resize(1); // max=1 but in-flight stays 2 (holders untouched)
    expect(sem.max).toBe(1);
    expect(sem.inFlight).toBe(2);

    let granted = false;
    const p3 = sem.acquire().then((rel) => {
      granted = true;
      return rel;
    });
    await flush();
    expect(granted).toBe(false); // 2 > 1 -> must wait
    r1();
    await flush();
    expect(granted).toBe(false); // still 1 in flight == max 1
    r2();
    await flush();
    expect(granted).toBe(true); // now under max
    (await p3)();
  });

  it('clamps to >= 1 and is a no-op when unchanged', async () => {
    const sem = new CountSemaphore(2);
    sem.resize(2);
    expect(sem.max).toBe(2);
    sem.resize(0);
    expect(sem.max).toBe(1);
    sem.resize(-5);
    expect(sem.max).toBe(1);
  });
});
