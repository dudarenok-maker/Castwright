/* Pairs with docs/features/NNN-design-full-cast.md.

   The per-book design mutex serializes designs for one book (so two designs of
   the same stable voiceId can't corrupt the sidecar embedding / audition cache)
   while letting different books run in parallel. The busy registry ref-counts
   analysis (main + subset can coexist) and tracks single design jobs. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  withDesignLock,
  markAnalysisBusy,
  clearAnalysisBusy,
  isAnalysisBusy,
  markDesignBusy,
  clearDesignBusy,
  isDesignBusy,
  isOtherBookDesignBusy,
  _designChainsSizeForTests,
} from './design-lock.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

/* retry: 0 — ops-46/#2028's documented hazard: the R5 tests below assert on
   `_designChainsSizeForTests()`, module-level mutable state keyed by a fixed
   bookDir string. Under the suite-wide retry:1, an attempt-1 failure leaks
   its mutation (a chain entry left over) and attempt 2 reads that leftover
   state and passes for the wrong reason — the exact shape the file-lock.ts
   `withKeyLock` suite already guards against with this same idiom. */
describe('withDesignLock', { retry: 0 }, () => {
  it('serializes overlapping designs for the SAME book', async () => {
    const order: string[] = [];
    const a = withDesignLock('bookA', async () => {
      order.push('a:start');
      await tick();
      order.push('a:end');
    });
    const b = withDesignLock('bookA', async () => {
      order.push('b:start');
      await tick();
      order.push('b:end');
    });
    await Promise.all([a, b]);
    /* b must not start until a finished. */
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('runs DIFFERENT books in parallel', async () => {
    const order: string[] = [];
    const a = withDesignLock('bookA', async () => {
      order.push('a:start');
      await tick();
      order.push('a:end');
    });
    const b = withDesignLock('bookB', async () => {
      order.push('b:start');
      await tick();
      order.push('b:end');
    });
    await Promise.all([a, b]);
    /* Both start before either ends (interleaved). */
    expect(order.slice(0, 2).sort()).toEqual(['a:start', 'b:start']);
  });

  it('releases the lock even when the critical section throws', async () => {
    await expect(
      withDesignLock('bookC', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    /* A subsequent design for the same book still runs. */
    let ran = false;
    await withDesignLock('bookC', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('R5: cleans up the per-book chain entry once it settles, for a lone call (no permanent leak)', async () => {
    /* Independent review finding (R5, PR #2126): the tail-cleanup check
       compared the map's stored value against `gate`, but the map actually
       stores `prior.then(() => gate, () => gate)` — a DIFFERENT promise
       object — so the comparison was always false and the entry was never
       deleted. One settled promise accumulated per book, forever. */
    const bookDir = 'design-lock-cleanup-lone-R5';
    const before = _designChainsSizeForTests();
    await withDesignLock(bookDir, async () => {});
    expect(_designChainsSizeForTests()).toBe(before);
  });

  it('R5: cleans up after a chain of overlapping waiters for the same book, not just a lone call', async () => {
    const bookDir = 'design-lock-cleanup-chain-R5';
    const before = _designChainsSizeForTests();
    const a = withDesignLock(bookDir, async () => {
      await tick();
    });
    const b = withDesignLock(bookDir, async () => {
      await tick();
    });
    await Promise.all([a, b]);
    /* Both waiters have settled — the chain tail must clean up, leaving no
       trace of this bookDir in the map. */
    expect(_designChainsSizeForTests()).toBe(before);
  });

  it('a non-tail cleanup can never let a later arrival run concurrently with the still-holding waiter it queued behind (F2, PR #2126 review)', async () => {
    /* Guards the OTHER way the tail check in the `finally` block can go
       wrong: an eager, unconditional delete (`if (designChains.get(bookDir))
       designChains.delete(bookDir)`, dropping the `=== chained` comparison
       entirely) leaves all 8 OTHER tests in this file green — none of them
       assert on mutual exclusion once a THIRD caller arrives after the
       first of two queued waiters settles — yet it genuinely breaks the
       lock: A holds and releases while B is still queued behind it; A's
       cleanup wrongly deletes the chain entry anyway (it is not the tail);
       a later arrival C then reads an empty map and starts immediately,
       overlapping B's still-in-flight critical section. */
    const bookDir = 'design-lock-eager-delete-guard-F2';
    let active = 0;
    let maxActive = 0;
    const enter = () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
    };
    const leave = () => {
      active -= 1;
    };

    let releaseA!: () => void;
    const aGate = new Promise<void>((r) => {
      releaseA = r;
    });
    let releaseB!: () => void;
    const bGate = new Promise<void>((r) => {
      releaseB = r;
    });

    const a = withDesignLock(bookDir, async () => {
      enter();
      await aGate;
      leave();
    });
    const b = withDesignLock(bookDir, async () => {
      enter();
      await bGate;
      leave();
    });

    releaseA();
    await a;
    /* Flush a real macrotask so B's chained wait resolves and B actually
       enters its critical section (and parks on bGate) before C shows up —
       B must be genuinely mid-flight, not merely queued, for the next check
       to be meaningful. A plain microtask race here would be timing-
       sensitive in the wrong way; a real setTimeout tick isn't. */
    await tick();
    expect(active).toBe(1); // sanity: B alone is holding at this point

    const c = withDesignLock(bookDir, async () => {
      enter();
      await tick();
      leave();
    });
    /* Give C's own chained wait a real macrotask to resolve BEFORE B
       releases. Under the correct tail-only cleanup C is still queued
       behind B's still-live chain entry and must not have entered yet;
       under the eager-delete mutation the entry was already gone (deleted
       by A even though it wasn't the tail), so C starts immediately. */
    await tick();
    const activeWhileBStillHolds = active;

    releaseB();
    await Promise.all([b, c]);

    expect(activeWhileBStillHolds).toBe(1);
    expect(maxActive).toBe(1);
  });
});

describe('busy registry', () => {
  beforeEach(() => {
    clearDesignBusy('b');
    while (isAnalysisBusy('b')) clearAnalysisBusy('b');
  });

  it('analysis is ref-counted (main + subset coexist)', () => {
    markAnalysisBusy('b');
    markAnalysisBusy('b');
    expect(isAnalysisBusy('b')).toBe(true);
    clearAnalysisBusy('b');
    expect(isAnalysisBusy('b')).toBe(true); // still held by the second
    clearAnalysisBusy('b');
    expect(isAnalysisBusy('b')).toBe(false);
  });

  it('design busy is a simple set', () => {
    expect(isDesignBusy('b')).toBe(false);
    markDesignBusy('b');
    expect(isDesignBusy('b')).toBe(true);
    clearDesignBusy('b');
    expect(isDesignBusy('b')).toBe(false);
  });
});

describe('isOtherBookDesignBusy', () => {
  afterEach(() => {
    clearDesignBusy('/a');
    clearDesignBusy('/b');
  });

  it('ignores the querying book, sees other books', () => {
    expect(isOtherBookDesignBusy('/a')).toBe(false);
    markDesignBusy('/a');
    expect(isOtherBookDesignBusy('/a')).toBe(false); // self excluded
    markDesignBusy('/b');
    expect(isOtherBookDesignBusy('/a')).toBe(true); // other book busy
  });
});
