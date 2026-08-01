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
   out flipping retry:1 suite-wide instead. */
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
