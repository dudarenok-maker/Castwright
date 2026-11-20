/* #3437 step 1 - both analysis job runners run their whole body inside the job's run-epoch
   fence (`job.runEpoch`), and run unfenced when the job has none (a hand-built harness job).
   Driven through the real `runMainAnalyzerJob` / `runSubsetAnalyzerJob` via the shared
   harness; a Phase-0 / Phase-1 hook reads the ambient fence and stops the run. The mock
   blocks are the ones the harness header requires. */
import { describe, it, expect, vi, afterAll, afterEach } from 'vitest';
import { rmSync } from 'node:fs';

const WORKSPACE = vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs');
  const os = process.getBuiltinModule('node:os');
  const path = process.getBuiltinModule('node:path');
  process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-3437-epoch-ws-'));
  return process.env.WORKSPACE_DIR;
});
afterAll(() => rmSync(WORKSPACE, { recursive: true, force: true }));

import {
  NARR,
  cleanupBook,
  getLastJob,
  mkBook,
  resetHarness,
  run,
  setPhase0Hook,
  setPhase1Hook,
  type HarnessBook,
} from './__test-helpers__/analysis-job-harness.js';
import {
  __resetRunEpochsForTests,
  beginRunEpoch,
  currentRunEpochFence,
  type RunEpochFence,
} from '../store/analysis-run-epoch.js';

vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return { ...actual, readJson: vi.fn(actual.readJson) };
});
vi.mock('../store/cast-id-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/cast-id-history.js')>();
  return { ...actual, retireCharacterId: vi.fn(actual.retireCharacterId) };
});
vi.mock('./ollama-health.js', () => ({
  detectOllamaDevice: vi.fn(async () => 'cuda'),
  unloadResidentOllama: vi.fn(async () => {}),
}));
vi.mock('../gpu/analyzer-device-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gpu/analyzer-device-state.js')>()),
  setLastKnownAnalyzerDevice: vi.fn(),
}));
vi.mock('../analyzer/select-analyzer.js', async () => {
  const actual = await vi.importActual<typeof import('../analyzer/select-analyzer.js')>(
    '../analyzer/select-analyzer.js',
  );
  return {
    ...actual,
    selectAnalyzerForPhase: (opts: { phase: 'phase0' | 'phase1' }) => {
      const g = globalThis as Record<string, unknown>;
      if (opts.phase === 'phase1' && g.__single_matcher_phase1) return g.__single_matcher_phase1;
      return actual.selectAnalyzerForPhase(opts as Parameters<typeof actual.selectAnalyzerForPhase>[0]);
    },
    isPerPhaseModelSelectionActive: () =>
      Boolean((globalThis as Record<string, unknown>).__single_matcher_pipelined),
  };
});

/** Records the ambient fence the first time a phase hook fires, then stops the run like a user Stop. */
function recordAndStop(seen: Array<RunEpochFence | undefined>): () => Promise<void> {
  return async () => {
    seen.push(currentRunEpochFence());
    getLastJob()?.controller.abort();
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  };
}

describe('#3437 - job runners run inside the job run-epoch fence', () => {
  const books: HarnessBook[] = [];
  afterEach(async () => {
    resetHarness();
    setPhase0Hook(undefined);
    setPhase1Hook(undefined);
    __resetRunEpochsForTests();
    for (const b of books.splice(0)) await cleanupBook(b);
  });

  describe.each(['main', 'subset'] as const)('%s runner', (kind) => {
    it('the body sees job.runEpoch as the ambient fence', async () => {
      const b = mkBook([NARR]);
      books.push(b);
      const seen: Array<RunEpochFence | undefined> = [];
      setPhase0Hook(recordAndStop(seen));
      setPhase1Hook(recordAndStop(seen));
      let fence: RunEpochFence | undefined;
      await run(b.manuscriptId, b.bookDir, kind, undefined, {
        onJob: (job) => {
          fence = beginRunEpoch(b.manuscriptId);
          job.runEpoch = fence;
        },
      });
      expect(fence).toEqual({ manuscriptId: b.manuscriptId, epoch: 1 });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toBe(fence);
      /* The context does not leak out of the run. */
      expect(currentRunEpochFence()).toBeUndefined();
    });

    it('a job with no runEpoch runs unfenced', async () => {
      const b = mkBook([NARR]);
      books.push(b);
      const seen: Array<RunEpochFence | undefined> = [];
      setPhase0Hook(recordAndStop(seen));
      setPhase1Hook(recordAndStop(seen));
      await run(b.manuscriptId, b.bookDir, kind);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toBeUndefined();
    });
  });
});
