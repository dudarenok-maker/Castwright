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

describe('withDesignLock', () => {
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
