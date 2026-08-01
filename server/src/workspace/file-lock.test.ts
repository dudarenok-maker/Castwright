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
