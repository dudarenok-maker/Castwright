/* #3437 — a superseded analysis run's cache writes are dropped inside the queued op.
   Deterministic: deferred promises only, no timing sleeps. */

import { existsSync } from 'node:fs';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { enqueuePathOp } from '../workspace/state-io.js';
import {
  __resetRunEpochsForTests,
  beginRunEpoch,
  runWithRunEpoch,
} from './analysis-run-epoch.js';
import {
  cachePath,
  clearAnalysisCache,
  mutateAnalysisCache,
  saveAnalysisCache,
  loadAnalysisCache,
  type AnalysisCache,
} from './analysis-cache.js';

const IDS = ['epoch-a', 'epoch-b', 'epoch-c', 'epoch-d'];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const takes = { 2: [{ characterId: 'c1', text: 'hi' }] } as never;

let logSpy: { mock: { calls: unknown[][] }; mockRestore: () => void };
const logged = (): string[] => logSpy.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  __resetRunEpochsForTests();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  logSpy.mockRestore();
  for (const id of IDS) await clearAnalysisCache(id);
});

describe('analysis cache run-epoch fence (#3437)', () => {
  it('(a) a stale run straggler patch and save never land after a newer run cleared', async () => {
    const id = 'epoch-a';
    const f1 = beginRunEpoch(id);
    const gate = deferred();
    const run1 = runWithRunEpoch(f1, async () => {
      await gate.promise;
      const patched = mutateAnalysisCache(id, { createIfAbsent: true, chapters: takes });
      const saved = saveAnalysisCache(id, { version: 1, chapters: takes } as unknown as AnalysisCache);
      await Promise.all([patched, saved]);
    });
    const f2 = beginRunEpoch(id);
    await runWithRunEpoch(f2, () => clearAnalysisCache(id));
    gate.resolve();
    await run1;
    expect(existsSync(cachePath(id))).toBe(false);
    expect(logged()).toContain(
      `[analysis] dropped stale-run write: analysis cache patch manuscript="${id}" runEpoch=1 current=2`,
    );
    expect(logged()).toContain(
      `[analysis] dropped stale-run write: analysis cache save manuscript="${id}" runEpoch=1 current=2`,
    );
  });

  it('(a2) a stale run clear is dropped too', async () => {
    const id = 'epoch-d';
    await mutateAnalysisCache(id, { createIfAbsent: true, chapters: takes });
    const f1 = beginRunEpoch(id);
    beginRunEpoch(id);
    await runWithRunEpoch(f1, () => clearAnalysisCache(id));
    expect(existsSync(cachePath(id))).toBe(true);
    expect(logged().some((l) => l.includes('analysis cache clear'))).toBe(true);
  });

  it('(b) a patch queued BEFORE the bump is dropped when it runs after it (in-op check)', async () => {
    const id = 'epoch-b';
    const release = deferred();
    const slow = enqueuePathOp(cachePath(id), () => release.promise);
    const f1 = beginRunEpoch(id);
    const patched = runWithRunEpoch(f1, () =>
      mutateAnalysisCache(id, { createIfAbsent: true, chapters: takes }),
    );
    beginRunEpoch(id); // f2 registers while f1's patch is still queued
    release.resolve();
    await slow;
    expect(await patched).toBeNull();
    expect(existsSync(cachePath(id))).toBe(false);
    expect(logged()).toContain(
      `[analysis] dropped stale-run write: analysis cache patch manuscript="${id}" runEpoch=1 current=2`,
    );
  });

  it('(c) current-run and no-fence writes still land', async () => {
    const id = 'epoch-c';
    const f1 = beginRunEpoch(id);
    await runWithRunEpoch(f1, () =>
      mutateAnalysisCache(id, { createIfAbsent: true, chapters: takes }),
    );
    expect(existsSync(cachePath(id))).toBe(true);
    await clearAnalysisCache(id); // no fence
    expect(existsSync(cachePath(id))).toBe(false);
    beginRunEpoch(id); // a newer run exists; a fence-less caller is unaffected
    await mutateAnalysisCache(id, { createIfAbsent: true, chapters: takes });
    expect(Object.keys((await loadAnalysisCache(id)).chapters)).toEqual(['2']);
    expect(logged().filter((l) => l.includes('dropped stale-run write'))).toEqual([]);
  });
});
