/* #3437 - the end-to-end regression for "Start fresh gets a displaced run's last chapters
   written back over it", driven through the real route.

   Run 1 is a main analysis whose Phase-1 call for chapter 1 is parked on a deferred that
   IGNORES the abort signal (a model call that does not observe the job's signal). A
   `fresh: true` POST (run 2) displaces it: it aborts run 1, registers itself (bumping the
   per-manuscript run epoch) and resets the book (cache cleared, manuscript-edits.json
   removed). Only then does run 1's call return. Its cache patch and its manuscript-edits
   roll must be dropped by the epoch fence, and run 2 must not see an error from it.

   Run 2 is held in Phase 0 until the stale writes have been judged, so every assertion on
   disk compares against exactly what the Start-fresh reset left. Every wait is on an
   observable (a deferred a mock opens, a log line, a file) - no sleeps. The mock blocks are
   the ones the harness header (`__test-helpers__/analysis-job-harness.ts`) requires. */
import { describe, it, expect, vi, afterAll, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';

const WORKSPACE = vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs');
  const os = process.getBuiltinModule('node:os');
  const path = process.getBuiltinModule('node:path');
  process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-3437-straggler-ws-'));
  /* Never let a stray unmocked call reach a live model. */
  process.env.OLLAMA_URL ??= 'http://127.0.0.1:1';
  return process.env.WORKSPACE_DIR;
});
afterAll(() => rmSync(WORKSPACE, { recursive: true, force: true }));

import {
  FRESH_ID,
  PHASE1_GLOBAL,
  cleanupBook,
  mkBook,
  phase0,
  phase1,
  resetHarness,
  roster,
  sel,
  setPhase0Hook,
  type HarnessBook,
} from './__test-helpers__/analysis-job-harness.js';
import { analysisRouter } from './analysis.js';
import { cachePath } from '../store/analysis-cache.js';
import { manuscriptEditsJsonPath } from '../workspace/paths.js';
import type { Analyzer } from '../analyzer/index.js';

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
    /* The route resolves BOTH phases through this; the test owns both selections. */
    selectAnalyzerForPhase: (opts: { phase: 'phase0' | 'phase1' }) => {
      const g = globalThis as Record<string, unknown>;
      if (opts.phase === 'phase1' && g.__single_matcher_phase1) return g.__single_matcher_phase1;
      if (opts.phase === 'phase0' && g.__fse_phase0) return g.__fse_phase0;
      return actual.selectAnalyzerForPhase(
        opts as Parameters<typeof actual.selectAnalyzerForPhase>[0],
      );
    },
    isPerPhaseModelSelectionActive: () =>
      Boolean((globalThis as Record<string, unknown>).__single_matcher_pipelined),
  };
});

/* ---- helpers -------------------------------------------------------------- */

const MARK = 'RUN1-STRAGGLER';

function deferred(): { promise: Promise<void>; open: () => void; opened: () => boolean } {
  let open!: () => void;
  let isOpen = false;
  const promise = new Promise<void>((r) => {
    open = () => {
      isOpen = true;
      r();
    };
  });
  return { promise, open, opened: () => isOpen };
}

interface SseEvent {
  kind: string;
  code?: string;
  [k: string]: unknown;
}
const sseFrames = (text: string): SseEvent[] =>
  text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)) as SseEvent);

const readText = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');

describe('#3437 - a Start fresh drops the displaced run\'s straggler writes (through the route)', () => {
  const books: HarnessBook[] = [];
  const orig = process.env.STAGE2_COVERAGE_RETRIES;
  afterEach(async () => {
    resetHarness();
    delete (globalThis as Record<string, unknown>).__fse_phase0;
    setPhase0Hook(undefined);
    vi.restoreAllMocks();
    if (orig === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
    else process.env.STAGE2_COVERAGE_RETRIES = orig;
    for (const b of books.splice(0)) await cleanupBook(b);
  });

  it('run 1\'s late cache patch and edits roll are dropped; run 2 sees no error from run 1', async () => {
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    const book = mkBook([]); // three chapters, a registered manuscript, no prior cast
    books.push(book);
    const { manuscriptId, bookDir } = book;
    const editsPath = manuscriptEditsJsonPath(bookDir);
    /* What the Start-fresh reset must remove (run 1 left it behind). */
    writeFileSync(editsPath, JSON.stringify({ sentences: [] }));

    const log = vi.spyOn(console, 'log');
    const logged = (needle: string): number =>
      log.mock.calls.filter((c) => c.map(String).join(' ').includes(needle)).length;

    /* Run 1's Phase-1 call for chapter 1 parks here and ignores the abort signal. */
    const run1InChapter = deferred();
    const run1Release = deferred();
    const run2InPhase0 = deferred();
    const run2Release = deferred();
    let activeRun: 1 | 2 = 1;

    const straggler: Analyzer = {
      ...phase1(FRESH_ID),
      runStage2Chapter: (async (_m: string, chapterId: number) => {
        if (!run1InChapter.opened()) {
          run1InChapter.open();
          await run1Release.promise; // deliberately not tied to any signal
          return {
            sentences: [
              { id: chapterId * 100 + 1, chapterId, characterId: FRESH_ID, confidence: 0.9, text: MARK },
            ],
          };
        }
        return phase1(FRESH_ID).runStage2Chapter(_m, chapterId, '', undefined as never);
      }) as unknown as Analyzer['runStage2Chapter'],
    };
    (globalThis as Record<string, unknown>)[PHASE1_GLOBAL] = sel(straggler, 'phase1-model');
    (globalThis as Record<string, unknown>).__fse_phase0 = sel(phase0(roster), 'phase0-model');
    /* Run 1's Phase 0 passes straight through; run 2's parks until the test lets it go. */
    setPhase0Hook(async () => {
      if (activeRun !== 2) return;
      run2InPhase0.open();
      await run2Release.promise;
    });

    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);
    const url = `/api/manuscripts/${manuscriptId}/analysis`;

    /* Run 1, until it is parked inside chapter 1's model call. */
    const run1 = request(app).post(url).send({}).then((r) => r);
    await run1InChapter.promise;

    /* Run 2: Start fresh. It aborts run 1 and resets the book before its first Phase-0 call. */
    activeRun = 2;
    const run2 = request(app).post(url).send({ fresh: true }).then((r) => r);
    await run2InPhase0.promise;
    expect(existsSync(editsPath)).toBe(false); // the reset has happened

    /* Run 1's call finally returns, after the reset. Wait until run 1 has drained: that
       log line is the barrier for "the straggler's whole save path has run", dropped or not. */
    run1Release.open();
    await vi.waitFor(() => expect(logged(`[analysis] main run drained manuscript=${manuscriptId}`)).toBe(1), {
      timeout: 10_000,
      interval: 10,
    });
    /* run 1's own stream is over (it was displaced); it may end `aborted`. */
    const run1Res = await run1;
    expect(sseFrames(run1Res.text).filter((e) => e.kind === 'error').every((e) => e.code === 'aborted')).toBe(true);

    /* The straggler wrote nothing back over run 2's reset. */
    expect(readText(cachePath(manuscriptId))).not.toContain(MARK);
    expect(readText(editsPath)).not.toContain(MARK);
    expect(existsSync(editsPath)).toBe(false);
    expect(logged(`[analysis] dropped stale-run write: analysis cache patch manuscript=${JSON.stringify(manuscriptId)}`)).toBeGreaterThan(0);
    expect(logged(`[analysis] dropped stale-run write: manuscript-edits roll manuscript=${JSON.stringify(manuscriptId)}`)).toBeGreaterThan(0);

    /* Let run 2 finish: it completes cleanly, with no error frame from run 1, and its own
       writes carry none of run 1's take. */
    run2Release.open();
    const run2Res = await run2;
    const frames = sseFrames(run2Res.text);
    expect(frames.filter((e) => e.kind === 'error')).toEqual([]);
    expect(frames.some((e) => e.kind === 'result')).toBe(true);
    expect(readText(cachePath(manuscriptId))).not.toContain(MARK);
    expect(readText(editsPath)).not.toContain(MARK);
  }, 60_000);
});
