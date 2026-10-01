/* #3427 — enqueuePathOp chain mechanics. Pins the tail-identity cleanup: the
   map entry is removed only by the op that still owns the tail. An
   unconditional delete lets a later call run beside an op that is still
   queued, landing out of order. */

import { describe, it, expect } from 'vitest';
import { enqueuePathOp } from './state-io.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('enqueuePathOp (#3427)', () => {
  it('a call made after an earlier op settles still waits for a still-queued op', async () => {
    const landed: string[] = [];
    const a = enqueuePathOp('/p/chain-1', async () => {
      await sleep(10);
      landed.push('A');
    });
    const b = enqueuePathOp('/p/chain-1', async () => {
      await sleep(60);
      landed.push('B');
    });
    await a; // A settled; B is queued/in flight
    const c = enqueuePathOp('/p/chain-1', async () => {
      landed.push('C');
    });
    await Promise.all([b, c]);
    expect(landed).toEqual(['A', 'B', 'C']);
  });

  it('a failed op rejects its own caller but does not wedge later ops', async () => {
    const bad = enqueuePathOp('/p/chain-2', async () => {
      throw new Error('boom');
    });
    const ok = enqueuePathOp('/p/chain-2', async () => undefined);
    await expect(bad).rejects.toThrow('boom');
    await expect(ok).resolves.toBeUndefined();
  });
});
