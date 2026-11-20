/* #3437 step 1 - the per-manuscript analysis run epoch (leaf module). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  __resetRunEpochsForTests,
  beginRunEpoch,
  currentRunEpochFence,
  isRunEpochStale,
  runWithRunEpoch,
  staleRunWriteDropped,
} from './analysis-run-epoch.js';
import { AnalysisAbortedError, StaleRunEpochError } from '../analyzer/errors.js';

beforeEach(() => __resetRunEpochsForTests());
afterEach(() => vi.restoreAllMocks());

describe('beginRunEpoch / isRunEpochStale', () => {
  it('counts per manuscript id: 1 then 2', () => {
    expect(beginRunEpoch('m1')).toEqual({ manuscriptId: 'm1', epoch: 1 });
    expect(beginRunEpoch('m1')).toEqual({ manuscriptId: 'm1', epoch: 2 });
  });

  it('a fence goes stale once a newer one begins for the SAME id', () => {
    const f1 = beginRunEpoch('m1');
    expect(isRunEpochStale(f1)).toBe(false);
    beginRunEpoch('m1');
    expect(isRunEpochStale(f1)).toBe(true);
  });

  it('a fence stays current when a DIFFERENT id begins', () => {
    const f1 = beginRunEpoch('m1');
    const other = beginRunEpoch('m2');
    expect(other.epoch).toBe(1);
    expect(isRunEpochStale(f1)).toBe(false);
  });

  it('no fence is never stale', () => {
    expect(isRunEpochStale(undefined)).toBe(false);
  });
});

describe('runWithRunEpoch / currentRunEpochFence', () => {
  it('is undefined outside a run', () => {
    expect(currentRunEpochFence()).toBeUndefined();
  });

  it('holds the fence across an await, a setTimeout and a chained then', async () => {
    const fence = beginRunEpoch('m1');
    const seen: unknown[] = [];
    await runWithRunEpoch(fence, async () => {
      seen.push(currentRunEpochFence());
      await Promise.resolve();
      seen.push(currentRunEpochFence());
      await new Promise<void>((r) =>
        setTimeout(() => {
          seen.push(currentRunEpochFence());
          r();
        }, 5),
      );
      await Promise.resolve().then(() => {
        seen.push(currentRunEpochFence());
      });
    });
    expect(seen).toHaveLength(4);
    for (const s of seen) expect(s).toBe(fence);
    expect(currentRunEpochFence()).toBeUndefined();
  });

  it('two concurrent runs each see their own fence', async () => {
    const fa = beginRunEpoch('a');
    const fb = beginRunEpoch('b');
    const seen: Record<string, unknown[]> = { a: [], b: [] };
    const body = (k: 'a' | 'b', ms: number) => async () => {
      seen[k]!.push(currentRunEpochFence());
      await new Promise((r) => setTimeout(r, ms));
      seen[k]!.push(currentRunEpochFence());
    };
    await Promise.all([runWithRunEpoch(fa, body('a', 10)), runWithRunEpoch(fb, body('b', 2))]);
    expect(seen.a).toEqual([fa, fa]);
    expect(seen.b).toEqual([fb, fb]);
  });
});

describe('staleRunWriteDropped', () => {
  it('returns true and logs the exact line when stale', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const f1 = beginRunEpoch('m"1');
    beginRunEpoch('m"1');
    expect(staleRunWriteDropped(f1, 'cache patch')).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      '[analysis] dropped stale-run write: cache patch manuscript="m\\"1" runEpoch=1 current=2',
    );
  });

  it('returns false and logs nothing when current or undefined', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = beginRunEpoch('m1');
    expect(staleRunWriteDropped(f, 'x')).toBe(false);
    expect(staleRunWriteDropped(undefined, 'x')).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('StaleRunEpochError', () => {
  it('is an AnalysisAbortedError', () => {
    const e = new StaleRunEpochError();
    expect(e).toBeInstanceOf(AnalysisAbortedError);
    expect(e.name).toBe('StaleRunEpochError');
  });
});
