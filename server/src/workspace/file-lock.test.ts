import { describe, it, expect } from 'vitest';
import { withKeyLock } from './file-lock.js';

/* ops-46 (#2028), Narrow option: withKeyLock's `chains` Map (file-lock.ts:5)
   is module-level mutable state keyed by a fixed string — exactly the shape
   that turned a genuine red-phase test green while landing #2001's fix
   (attempt 1 fails and leaks its key into `chains`; the suite's global
   retry:1 re-runs attempt 2 against that already-mutated map, so it can pass
   for the wrong reason). retry:0 here means a red-phase test against this
   file's state is never silently rescued by the suite-wide retry — see
   CONTRIBUTING.md's "When you ship a change" section (the "#2028" note) and
   server/vitest.config.ts's retryHazardReporter for the survey that ruled
   out flipping retry:1 suite-wide instead.

   PR #2049 review, Finding 7 — this is NOT the only file sharing the shape.
   `routes/script-review.ts:278-279` declares two module-level Maps
   (`mainScriptReviewJobByBook`, `subsetScriptReviewJobByChapter`); its test
   sets `bookId` once in `beforeAll` and reuses it as the key, has zero
   `afterEach`, and releases sit after assertions with no `try`/`finally`.
   It is not currently exploitable, though — independently verified:
   disabling its 409-conflict producer to probe for a silent false-green
   times out loudly under both retry:1 and --retry=0, it does not pass. So
   the accurate claim is narrower than "no sibling shares this shape": no
   sibling was found where the leak actually produces a SILENT pass —
   script-review.ts just doesn't clear the fix-now bar on the evidence
   available. */
describe('withKeyLock', { retry: 0 }, () => {
  it('serializes critical sections sharing a key', async () => {
    const order: string[] = [];
    const slow = withKeyLock('book-1', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a-end');
    });
    const fast = withKeyLock('book-1', async () => {
      order.push('b-start');
      order.push('b-end');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('runs different keys concurrently', async () => {
    const order: string[] = [];
    const a = withKeyLock('book-1', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a-end');
    });
    const b = withKeyLock('book-2', async () => {
      order.push('b-start');
      order.push('b-end');
    });
    await Promise.all([a, b]);
    expect(order.slice(0, 2).sort()).toEqual(['a-start', 'b-start']);
    expect(order.indexOf('b-end')).toBeLessThan(order.indexOf('a-end'));
  });

  it('releases the lock when fn throws', async () => {
    await expect(withKeyLock('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const ran = await withKeyLock('k', async () => 'ok');
    expect(ran).toBe('ok');
  });
});

/* #2260 — withKeyLock's acquisition timeout. cast-lock.ts rules 1 and 4 both
   deadlock the mutex with no timeout and no diagnostic; these pin the fix.
   retry:0 for the same reason as the suite above: a red-phase test against
   this file's module-level `chains` state must never be silently rescued by
   the suite-wide retry. */
describe('withKeyLock acquisition timeout (#2260)', { retry: 0 }, () => {
  it('throws instead of hanging when acquisition deadlocks, naming the key', async () => {
    const key = 'deadlock-key';
    /* First holder never releases -- stands in for a cast-lock.ts rule 1/4
       violation, where the true first holder is itself blocked forever
       waiting on a second lock held by whoever is queued behind it here. */
    void withKeyLock(key, () => new Promise<void>(() => {}));

    let secondRan = false;
    await expect(
      withKeyLock(key, async () => { secondRan = true; }, 50),
    ).rejects.toThrow(/deadlock-key/);
    /* Trap 1: the critical section must never run on the timeout path. */
    expect(secondRan).toBe(false);
  });

  it('does not fire for legitimate contention comfortably under budget', async () => {
    const key = 'contended-key';
    const order: string[] = [];
    const slow = withKeyLock(key, async () => {
      order.push('slow-start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('slow-end');
    }, 500);
    const fast = withKeyLock(key, async () => {
      order.push('fast-start');
      order.push('fast-end');
    }, 500);
    await Promise.all([slow, fast]);
    expect(order).toEqual(['slow-start', 'slow-end', 'fast-start', 'fast-end']);
  });

  it('does not poison the key after a timeout -- a later call still works once the holder finishes', async () => {
    const key = 'unpoisoned-key';
    const order: string[] = [];
    /* The real holder -- NOT permanently stuck, unlike the deadlock test
       above. It finishes on its own, comfortably after the waiter below has
       already timed out. This is the case review Finding 2 called out: a
       first holder that never releases makes "a later call still works"
       provable only by barging past a still-running holder, which proves
       the opposite of what this test claims -- a neutralisation proof, not
       coverage. */
    const holder = withKeyLock(key, async () => {
      order.push('first-start');
      await new Promise((r) => setTimeout(r, 150));
      order.push('first-end');
      return 'first-done';
    });

    /* Comfortably shorter than the holder's 150ms hold, so this one times out
       while the holder is still running. */
    await expect(
      withKeyLock(key, async () => 'never', 20),
    ).rejects.toThrow(/unpoisoned-key/);

    /* A fresh acquisition of the SAME key, started after the timeout above
       already threw and returned, must still queue behind the still-running
       holder and succeed once it finishes -- neither barge past it (Finding
       1's mutual-exclusion break) nor hang forever (Trap 2's poisoning). */
    const result = await withKeyLock(key, async () => {
      order.push('third-start');
      return 'ok-after-timeout';
    }, 2000);

    expect(result).toBe('ok-after-timeout');
    expect(order).toEqual(['first-start', 'first-end', 'third-start']);
    await holder;
  });

  it('does not let a later caller barge past a still-running holder after an earlier waiter times out', async () => {
    /* Case review Finding 3 -- the regression test for Finding 1. Nothing in
       the tests above pins ordering strictly enough to catch a `chains`
       cleanup on the timeout path that deletes the wrong thing: a subsequent
       caller must queue behind the ACTUAL holder, not merely "eventually
       succeed" (which a barge-past-and-race outcome can also produce by
       accident once the holder happens to finish first). */
    const key = 'mutex-key';
    const order: string[] = [];
    const holder = withKeyLock(key, async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 200));
      order.push('a-end');
    });

    /* Times out well before the holder's 200ms hold ends. */
    await expect(
      withKeyLock(key, async () => { order.push('b-ran'); }, 20),
    ).rejects.toThrow(/mutex-key/);

    /* Started immediately after the waiter's rejection -- the holder is
       still running at this point. */
    const later = withKeyLock(key, async () => {
      order.push('d-start');
      order.push('d-end');
    });

    await Promise.all([holder, later]);

    expect(order).toEqual(['a-start', 'a-end', 'd-start', 'd-end']);
    expect(order).not.toContain('b-ran');
  });
});
