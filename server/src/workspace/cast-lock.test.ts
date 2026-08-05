import { describe, it, expect, vi, afterEach } from 'vitest';
import { withCastLock, withCastLocks } from './cast-lock.js';
/* Namespace import so vi.spyOn can intercept the call cast-lock.ts makes
   internally — Vite's SSR transform rewrites it to a property access resolved
   at call time. Do NOT reach for vi.mock('./file-lock.js') instead; that
   replaces the module and the spy stops observing real acquisition. */
import * as fileLock from './file-lock.js';
import { __chainsSizeForTest } from './file-lock.js';
import { castJsonPath } from './paths.js';

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('withCastLocks', () => {
  /* Sorting is the ONLY thing standing between the 8 two-book sites and a
     permanent, diagnostic-free hang, so it gets two tests that genuinely fail
     without it. An earlier draft of this plan tested it by awaiting two
     withCastLocks calls SEQUENTIALLY and asserting they ran in call order —
     which is true with or without .sort(), with or without any lock at all.
     That is the placebo shape this whole PR exists to prevent. */

  /* #1981 fix-round Finding 1 — restoration MUST NOT depend on the test
     body reaching its last statement. A `spy.mockRestore()` at the end of
     a test with no afterEach never runs if an earlier assertion throws,
     which leaves `fileLock.withKeyLock` mocked to a no-op passthrough for
     every later test in this file — silently disarming their own
     mutation-detection power exactly when a regression would need it.
     Reproduced: with `.sort()` removed from withCastLocks, a full-file run
     reported the AB/BA deadlock test below as PASSING while the same test
     in isolation failed 3/3 — because the preceding sorted-order test threw
     first and left the spy live. */
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('acquires keys in sorted order within a single call', async () => {
    const acquired: string[] = [];
    vi.spyOn(fileLock, 'withKeyLock').mockImplementation(
      async (key: string, fn: () => Promise<unknown>) => {
        acquired.push(key);
        return fn();
      },
    );
    await withCastLocks(['/w/b', '/w/a'], async () => undefined);
    expect(acquired).toEqual([castJsonPath('/w/a'), castJsonPath('/w/b')]);

    acquired.length = 0;
    await withCastLocks(['/w/a', '/w/b'], async () => undefined);
    expect(acquired).toEqual([castJsonPath('/w/a'), castJsonPath('/w/b')]);
  });

  it('does not deadlock when two callers pass the books in opposite orders', async () => {
    /* THE test for .sort(). Both hold their first lock across an await before
       asking for the second — the classic AB/BA setup. Without sorting this
       hangs forever; withKeyLock has no timeout. */
    const hold = async () => {
      await settle();
      return 'ok';
    };
    const raced = await Promise.race([
      Promise.all([
        withCastLocks(['/w/a', '/w/b'], hold),
        withCastLocks(['/w/b', '/w/a'], hold),
      ]),
      new Promise((r) => setTimeout(() => r('DEADLOCK'), 2000)),
    ]);
    expect(raced).toEqual(['ok', 'ok']);
  });

  it('dedupes a repeated book instead of self-deadlocking', async () => {
    /* A non-reentrant mutex acquired twice on one key wedges forever.
       library-cast-override can legitimately pass source === target. */
    const done = await Promise.race([
      withCastLocks(['/w/same', '/w/same'], async () => 'ran'),
      new Promise((r) => setTimeout(() => r('DEADLOCK'), 1000)),
    ]);
    expect(done).toBe('ran');
  });

  it('releases when the critical section throws', async () => {
    await expect(
      withCastLock('/w/x', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    /* A leaked lock would hang this second acquisition. */
    const after = await Promise.race([
      withCastLock('/w/x', async () => 'ok'),
      new Promise((r) => setTimeout(() => r('LEAKED'), 1000)),
    ]);
    expect(after).toBe('ok');
  });

  it('runs waiters in FIFO order without overlapping them', async () => {
    /* `seen.push(n)` as the FIRST statement would run in map order with or
       without a lock. Record entry AND exit so overlap is observable. */
    const seen: string[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        withCastLock('/w/fifo', async () => {
          seen.push(`enter${n}`);
          await settle();
          seen.push(`exit${n}`);
        }),
      ),
    );
    expect(seen).toEqual(['enter1', 'exit1', 'enter2', 'exit2', 'enter3', 'exit3']);
  });

  it('refuses an empty book list rather than running unlocked', async () => {
    /* reduceRight over [] returns the initial value, so the critical section
       would run with no lock acquired at all. */
    await expect(withCastLocks([], async () => 'ran')).rejects.toThrow();
  });

  it('drops the map entry once the last holder settles', async () => {
    const before = __chainsSizeForTest();
    await withCastLock('/w/cleanup', async () => 'done');
    expect(__chainsSizeForTest()).toBe(before);
  });
});
