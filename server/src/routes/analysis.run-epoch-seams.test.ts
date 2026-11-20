/* #3437 - run-epoch seams driven through the route that no other test reaches (review pass 1
   of #4549, the surviving mutants):
   - a subset Retry's REGISTRATION bumps the manuscript's run epoch. A main run that has left
     the writer registry (the drain deadline passed while one of its units was still running)
     no longer refuses a subset POST; that unit's late saves must then be dropped, and only the
     subset registration's bump makes them stale;
   - Start fresh's `castConfirmed` un-confirm drops itself when a newer run registered between
     this run's registration and that write.
   The mock blocks are the ones the harness header (`__test-helpers__/analysis-job-harness.ts`)
   requires, as in analysis.fresh-straggler-epoch.test.ts. */
import { describe, it, expect, vi, afterAll, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';

const WORKSPACE = vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs');
  const os = process.getBuiltinModule('node:os');
  const path = process.getBuiltinModule('node:path');
  process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-3437-seams-ws-'));
  /* Never let a stray unmocked call reach a live model. */
  process.env.OLLAMA_URL ??= 'http://127.0.0.1:1';
  return process.env.WORKSPACE_DIR;
});
afterAll(() => rmSync(WORKSPACE, { recursive: true, force: true }));

/* Armed by a case: runs inside `clearAffectedRefs` (Start fresh's step just before the un-confirm). */
const seam = vi.hoisted(() => ({ duringClearRefs: null as null | (() => void) }));

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
import { cachePath, saveAnalysisCache, ANALYSIS_CACHE_VERSION } from '../store/analysis-cache.js';
import { beginRunEpoch, isRunEpochStale, runWithRunEpoch } from '../store/analysis-run-epoch.js';

vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return { ...actual, readJson: vi.fn(actual.readJson) };
});
vi.mock('../store/cast-id-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/cast-id-history.js')>();
  return { ...actual, retireCharacterId: vi.fn(actual.retireCharacterId) };
});
vi.mock('../store/cast-merges.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/cast-merges.js')>();
  return {
    ...actual,
    clearAffectedRefs: (...a: Parameters<typeof actual.clearAffectedRefs>) => {
      const hook = seam.duringClearRefs;
      seam.duringClearRefs = null;
      hook?.();
      return actual.clearAffectedRefs(...a);
    },
  };
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
      if (opts.phase === 'phase0' && g.__seams_phase0) return g.__seams_phase0;
      return actual.selectAnalyzerForPhase(
        opts as Parameters<typeof actual.selectAnalyzerForPhase>[0],
      );
    },
    isPerPhaseModelSelectionActive: () =>
      Boolean((globalThis as Record<string, unknown>).__single_matcher_pipelined),
  };
});

const MARK = 'RUN1-STRAGGLER';
const readText = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');

describe('#3437 - run-epoch seams driven through the route', () => {
  const books: HarnessBook[] = [];
  const orig = process.env.STAGE2_COVERAGE_RETRIES;
  afterEach(async () => {
    resetHarness();
    delete (globalThis as Record<string, unknown>).__seams_phase0;
    setPhase0Hook(undefined);
    seam.duringClearRefs = null;
    vi.restoreAllMocks();
    if (orig === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
    else process.env.STAGE2_COVERAGE_RETRIES = orig;
    for (const b of books.splice(0)) await cleanupBook(b);
  });

  function setup(): { app: express.Express; book: HarnessBook } {
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    const book = mkBook([]);
    books.push(book);
    (globalThis as Record<string, unknown>)[PHASE1_GLOBAL] = sel(phase1(FRESH_ID), 'phase1-model');
    (globalThis as Record<string, unknown>).__seams_phase0 = sel(phase0(roster), 'phase0-model');
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);
    return { app, book };
  }

  it("a subset Retry registering after a main run left the writer registry makes that run's late save stale", async () => {
    const { app, book } = setup();
    const { manuscriptId } = book;
    /* The main run: the newest run for the book, and (as after its drain deadline) holding no
       writer-registry slot, so the subset POST below is not refused. */
    const mainFence = beginRunEpoch(manuscriptId);
    expect(isRunEpochStale(mainFence)).toBe(false);

    const res = await request(app).post(`/api/manuscripts/${manuscriptId}/analysis/chapters`).send({ chapterIds: [1] });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('main_analysis_running');

    /* Registering the subset job bumped the epoch: the main run's fence is now stale. */
    expect(isRunEpochStale(mainFence)).toBe(true);
    const log = vi.spyOn(console, 'log');
    await runWithRunEpoch(mainFence, () =>
      saveAnalysisCache(manuscriptId, {
        version: ANALYSIS_CACHE_VERSION,
        stage1: { characters: [], chapters: [{ id: 1, title: MARK }] },
        chapters: {},
      }),
    );
    expect(readText(cachePath(manuscriptId))).not.toContain(MARK);
    expect(log.mock.calls.some((c) => String(c[0]).includes('dropped stale-run write: analysis cache save'))).toBe(true);
  }, 60_000);

  it('Start fresh superseded before its un-confirm leaves the book confirmed; the control un-confirms it', async () => {
    const { app, book } = setup();
    const statePath = join(book.bookDir, '.audiobook', 'state.json');
    const confirmed = (): boolean => JSON.parse(readText(statePath)).castConfirmed === true;
    expect(confirmed()).toBe(true);

    /* Superseded: a newer run registers between this run's registration and its un-confirm. */
    seam.duringClearRefs = () => {
      beginRunEpoch(book.manuscriptId);
    };
    const stale = await request(app).post(`/api/manuscripts/${book.manuscriptId}/analysis`).send({ fresh: true });
    expect(stale.status).toBe(200);
    expect(seam.duringClearRefs).toBeNull(); // the seam fired
    expect(confirmed()).toBe(true);

    /* Control, at the current epoch: Start fresh un-confirms. */
    const control = await request(app).post(`/api/manuscripts/${book.manuscriptId}/analysis`).send({ fresh: true });
    expect(control.status).toBe(200);
    expect(JSON.parse(readText(statePath)).castConfirmed).toBe(false);
  }, 60_000);
});
