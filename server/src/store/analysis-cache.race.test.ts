/* Regression test: same-tick cache-write race (plan 88 / tmpSeq guard).
   Task 2.5 of the flaky-test-release-hardening plan.

   Context: `writeJsonAtomic` in state-io.ts uses a monotonic `tmpSeq`
   counter so two calls arriving in the same millisecond (same `Date.now()`,
   same `process.pid`) don't collide on the temp-file name. Without it, both
   Phase 0 and Phase 1 of the pipelined analyzer would pick the same temp
   path, one would rename it away, and the other's `renameWithRetry` would
   throw ENOENT on a now-missing temp file.

   Why a no-throw assertion is too weak: a broken impl that reuses one temp
   filename also resolves both promises and leaves a loadable file (last-
   write-wins). The real invariant is that two concurrent writes use DISTINCT
   temp paths. We assert that directly, and validate via a red-on-regression
   run. */

import { describe, it, expect, afterEach, vi } from 'vitest';

/* Capture the temp source paths that `rename` is called with. We mock
   node:fs/promises at the module level (same pattern as state-io.test.ts)
   so that atomic-rename.ts's `import { rename }` picks up our intercept. */
const renamed: string[] = [];

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    rename: async (src: string | URL, dest: string | URL): Promise<void> => {
      renamed.push(String(src)); // capture the temp source path
      return actual.rename(src as never, dest as never);
    },
  };
});

/* Import AFTER vi.mock so analysis-cache.ts (and state-io.ts / atomic-rename.ts
   transitively) pick up the mocked rename binding. */
const { saveAnalysisCache, clearAnalysisCache } = await import('./analysis-cache.js');

const id = `race-${process.pid}`;

afterEach(async () => {
  vi.restoreAllMocks();
  renamed.length = 0; // reset captured paths between runs
  await clearAnalysisCache(id);
});

describe('analysis-cache concurrent same-tick writes (tmpSeq race)', () => {
  it('two saves in the same tick write to DISTINCT temp paths (no shared-temp corruption)', async () => {
    await Promise.all([
      saveAnalysisCache(id, { chapters: {} }),
      saveAnalysisCache(id, { chapters: {} }),
    ]);

    // The two same-tick writes MUST have used different temp files (tmpSeq).
    // A broken impl (no seq counter) would reuse the same temp path and this
    // assertion would fail: Set.size(1) !== length(2).
    expect(renamed.length).toBe(2);
    expect(new Set(renamed).size).toBe(renamed.length);
  });
});
