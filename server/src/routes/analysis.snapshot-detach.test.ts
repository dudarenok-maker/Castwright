/* #3174 (G1) — the four detached (`void …`) cold-boot snapshot writes in
   analysis.ts (`persistRunningSnapshot`, the stale-snapshot delete IIFE, and
   `persistTerminalSnapshot` for both 'paused' and 'halted') all route through
   `withVerifiedBookDir` / `tryResolveVerifiedBookDir`. Those, in turn, share
   `resolveVerifiedBookDir`'s slow path: when the candidate book dir can't be
   trusted, it calls `getOrHydrateManuscript`, which can itself throw (e.g. an
   fs failure inside `ensureWorkspace`'s `mkdirSync`) BEFORE any inner
   write/delete ever runs. Before the fix, none of the four call sites caught
   that outer rejection — each is `void`'d, so the throw became an
   `unhandledRejection` at the process level instead of a logged, contained
   failure.

   This suite forces that slow-path throw by mocking `getOrHydrateManuscript`
   to reject for a flagged manuscript id (mirroring the
   analysis.setup-throw.test.ts idiom) and pointing each job at a bookDir that
   doesn't exist on disk (so `existsSync` in the fast path is false and
   `resolveVerifiedBookDir` always falls through to the slow path). */

import { describe, it, expect, vi, afterEach } from 'vitest';

const REJECT_ON_HYDRATE = new Set<string>();

vi.mock('../store/manuscripts.js', async () => {
  const actual = await vi.importActual<typeof import('../store/manuscripts.js')>('../store/manuscripts.js');
  return {
    ...actual,
    getOrHydrateManuscript: async (id: string) => {
      if (REJECT_ON_HYDRATE.has(id)) {
        throw new Error('simulated ensureWorkspace mkdirSync failure');
      }
      return actual.getOrHydrateManuscript(id);
    },
  };
});

import { trackForReplay, endJob, __testRegisterJobForTest, type AnalysisJob } from './analysis.js';

function buildJob(manuscriptId: string, kind: 'main' | 'subset' = 'main'): AnalysisJob {
  return {
    controller: new AbortController(),
    subscribers: new Set(),
    manuscriptId,
    kind,
    bookDir: `C:/nonexistent-book-dir/${manuscriptId}`,
    engine: 'gemini',
    replay: {
      logs: [],
      lastPhase: null,
      lastEta: null,
      lastCastUpdate: null,
      failedByChapterId: new Map(),
      lastSeriesPrior: null,
      warnings: new Map(),
    },
    lastDiskWriteAt: 0,
  } as unknown as AnalysisJob;
}

/* Every detached snapshot write settles on its own microtask/macrotask
   queue turn — wait a few ticks so the rejection (unhandled, before the
   fix) or the containment catch (after the fix) has had a chance to run
   before asserting. */
async function flushDetached(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('#3174 G1 — detached analysis-state snapshot writes contain a slow-path resolve failure', () => {
  afterEach(() => {
    REJECT_ON_HYDRATE.clear();
  });

  it('persistRunningSnapshot (via trackForReplay phase event): no unhandled rejection, warns, job unaffected', async () => {
    const manuscriptId = `test-g1-running-${Date.now()}-${Math.random()}`;
    REJECT_ON_HYDRATE.add(manuscriptId);
    const job = buildJob(manuscriptId);

    let unhandledRejection: unknown = null;
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejection = reason;
    };
    process.on('unhandledRejection', onUnhandledRejection);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      trackForReplay(job, { kind: 'phase', phaseId: 1, progress: 0.5, label: 'Phase 1' });
      await flushDetached();

      expect(unhandledRejection).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        '[analysis-state] running snapshot resolve failed',
        expect.any(Error),
      );
      // The job's own state is untouched by the failed write.
      expect(job.replay.lastPhase?.phaseId).toBe(1);
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
      warnSpy.mockRestore();
    }
  });

  it('the stale-snapshot delete IIFE (via endJob, kind:"result"): no unhandled rejection, warns', async () => {
    const manuscriptId = `test-g1-delete-${Date.now()}-${Math.random()}`;
    REJECT_ON_HYDRATE.add(manuscriptId);
    const job = buildJob(manuscriptId, 'main');
    __testRegisterJobForTest(job);

    let unhandledRejection: unknown = null;
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejection = reason;
    };
    process.on('unhandledRejection', onUnhandledRejection);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      endJob(job, { kind: 'result' });
      await flushDetached();

      expect(unhandledRejection).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        '[analysis-state] stale snapshot delete failed',
        expect.any(Error),
      );
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
      warnSpy.mockRestore();
    }
  });

  it('persistTerminalSnapshot("paused") (via endJob, kind:"error"/code:"aborted"): no unhandled rejection, warns', async () => {
    const manuscriptId = `test-g1-paused-${Date.now()}-${Math.random()}`;
    REJECT_ON_HYDRATE.add(manuscriptId);
    const job = buildJob(manuscriptId, 'main');
    __testRegisterJobForTest(job);

    let unhandledRejection: unknown = null;
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejection = reason;
    };
    process.on('unhandledRejection', onUnhandledRejection);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      endJob(job, { kind: 'error', code: 'aborted', message: 'Analysis paused.' });
      await flushDetached();

      expect(unhandledRejection).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        '[analysis-state] terminal snapshot resolve failed',
        expect.any(Error),
      );
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
      warnSpy.mockRestore();
    }
  });

  it('persistTerminalSnapshot("halted") (via endJob, kind:"error"): no unhandled rejection, warns', async () => {
    const manuscriptId = `test-g1-halted-${Date.now()}-${Math.random()}`;
    REJECT_ON_HYDRATE.add(manuscriptId);
    const job = buildJob(manuscriptId, 'main');
    __testRegisterJobForTest(job);

    let unhandledRejection: unknown = null;
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejection = reason;
    };
    process.on('unhandledRejection', onUnhandledRejection);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      endJob(job, { kind: 'error', code: 'cast_incomplete', message: 'synthetic halt' });
      await flushDetached();

      expect(unhandledRejection).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        '[analysis-state] terminal snapshot resolve failed',
        expect.any(Error),
      );
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
      warnSpy.mockRestore();
    }
  });
});
