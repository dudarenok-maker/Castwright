/* Plan 291 (#4031) - route-level acceptance tests for the single fresh<->prior
   cast matcher, driven through the real analysis jobs. This file holds the
   harness smoke test and a self-test per harness helper; the acceptance tests
   (Tasks 15-27) are added on top of `__test-helpers__/analysis-job-harness.ts`.
   The mock blocks below are the ones the harness header requires. */
import { describe, it, expect, vi, afterAll, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Before any import binds BOOKS_ROOT: the harness books live in this workspace. */
const WORKSPACE = vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs');
  const os = process.getBuiltinModule('node:os');
  const path = process.getBuiltinModule('node:path');
  process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-4031-ws-'));
  return process.env.WORKSPACE_DIR;
});
afterAll(() => rmSync(WORKSPACE, { recursive: true, force: true }));

import {
  BODY,
  FRESH_ID,
  NARR,
  PHASE1_GLOBAL,
  PRIOR_ID,
  PRIOR_WREN,
  WREN_FRESH,
  abortAtFirstPhase1,
  blipRemapRead,
  cleanupBook,
  failNextRetirement,
  getLastJob,
  linesById,
  mergeMidRun,
  mkApp,
  mkBook,
  mkJob,
  phase0,
  phase1,
  phase1Script,
  putCast,
  readCache,
  readJson,
  readCast,
  readEdits,
  readHistory,
  readSuggestions,
  recordCastUpdateFrames,
  resetHarness,
  routeVoice,
  run,
  runJob,
  runSubsetRetry,
  sel,
  setNonStoryHook,
  setPhase0Hook,
  setPhase1Hook,
  setPipelined,
  type HarnessBook,
  type Row,
  type Sent,
} from './__test-helpers__/analysis-job-harness.js';
import * as historyStore from '../store/cast-id-history.js';
import * as stateIo from '../workspace/state-io.js';
import request from 'supertest';
import { ANALYSIS_CACHE_VERSION, cachePath, clearAnalysisCache, mutateAnalysisCache, saveAnalysisCache } from '../store/analysis-cache.js';
import { resolveAttributionState } from '../store/attribution-health-io.js';
import { retargetPlanForMerge, userOwnedFingerprint } from '../store/plan-overlay.js';
import { castJsonPath, castMergeSuggestionsJsonPath, makeBookId } from '../workspace/paths.js';
import { withCastLock } from '../workspace/cast-lock.js';
import { LockAcquisitionTimeoutError, withKeyLock } from '../workspace/file-lock.js';
import {
  dedupAndPrepare,
  linkSeriesReuseOnNewRows,
  otherRunsLedger,
  persistDecisionsTransform,
  resolveCurrentIds,
  subsetCompletedAddedOnce,
  runMainAnalyzerJob,
  runSubsetAnalyzerJob,
  type AnalysisJob,
} from './analysis.js';
import { EMPTY_DEDUP_CONSTRAINTS } from '../analyzer/roster-dedup.js';
import { refreshLedger } from '../workspace/analysis-cast-io.js';
import { AnalysisAbortedError } from '../analyzer/errors.js';
import { getManuscript } from '../store/manuscripts.js';
import type { Analyzer } from '../analyzer/index.js';
import type { CharacterOutput } from '../handoff/schemas.js';
import type { MatchPlan } from '../store/reanalysis-types.js';
import type { LibraryCharacterRecord } from '../workspace/library-cast-scan.js';
import type { LinkSeriesReuseOptions } from '../workspace/series-reuse-link.js';

/* Passthrough by default; the harness installs one-shot failures on top. */
vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return { ...actual, readJson: vi.fn(actual.readJson) };
});
/* Passthrough; a test may observe each per-chapter roll (`planned`: was the plan on
   disk when the roll was called). */
const rollSpy = vi.hoisted(() => ({
  isPlanned: undefined as undefined | (() => boolean),
  after: undefined as undefined | ((planned: boolean) => void),
}));
vi.mock('../workspace/edits-roll.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/edits-roll.js')>();
  return {
    ...actual,
    rollManuscriptEdits: async (...a: Parameters<typeof actual.rollManuscriptEdits>) => {
      const planned = rollSpy.isPlanned?.() ?? false;
      const out = await actual.rollManuscriptEdits(...a);
      rollSpy.after?.(planned);
      return out;
    },
  };
});
/* Passthrough; a test may run something between the job calling a cache patch and the patch
   joining the cache op chain (`beforePatch`). */
const cacheSpy = vi.hoisted(() => ({
  beforePatch: undefined as undefined | ((patch: { chapters?: Record<number, unknown> }) => Promise<void>),
}));
vi.mock('../store/analysis-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/analysis-cache.js')>();
  return {
    ...actual,
    mutateAnalysisCache: async (...a: Parameters<typeof actual.mutateAnalysisCache>) => {
      await cacheSpy.beforePatch?.(a[1]);
      return actual.mutateAnalysisCache(...a);
    },
  };
});
vi.mock('../store/cast-id-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/cast-id-history.js')>();
  return { ...actual, retireCharacterId: vi.fn(actual.retireCharacterId) };
});
/* Passthrough; a test may replace what the planned persist returns with the failure
   it documents (`PersistOutcomeError`: the edits write failed after cast.json landed). */
const castIoSpy = vi.hoisted(() => ({
  afterPersist: undefined as undefined | ((outcome: unknown) => unknown),
  /* Throws from the next plan snapshot (`writePlanSnapshot`) while set. */
  failSnapshot: undefined as undefined | (() => Error | undefined),
  /* Called (no throw) once the planned persist has returned. */
  onPersisted: undefined as undefined | (() => void),
}));
vi.mock('../workspace/analysis-cast-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/analysis-cast-io.js')>();
  return {
    ...actual,
    writePlanSnapshot: async (...a: Parameters<typeof actual.writePlanSnapshot>) => {
      const err = castIoSpy.failSnapshot?.();
      if (err) throw err;
      return actual.writePlanSnapshot(...a);
    },
    persistPlannedCast: async (...a: Parameters<typeof actual.persistPlannedCast>) => {
      const out = await actual.persistPlannedCast(...a);
      if (castIoSpy.afterPersist) throw castIoSpy.afterPersist(out);
      castIoSpy.onPersisted?.();
      return out;
    },
  };
});

/* Passthrough; a test may run something inside each `readUserSettings` call, before it reads. */
const settingsSpy = vi.hoisted(() => ({ before: undefined as undefined | (() => Promise<void>) }));
vi.mock('../workspace/user-settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/user-settings.js')>();
  return {
    ...actual,
    readUserSettings: async (...a: Parameters<typeof actual.readUserSettings>) => {
      await settingsSpy.before?.();
      return actual.readUserSettings(...a);
    },
  };
});

/* Passthrough; a test may make the next `updateStateAtDir` throw (`failNext`, one-shot). */
const stateSpy = vi.hoisted(() => ({ failNext: undefined as undefined | Error }));
vi.mock('../workspace/book-state-update.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/book-state-update.js')>();
  return {
    ...actual,
    updateStateAtDir: async (...a: Parameters<typeof actual.updateStateAtDir>) => {
      const err = stateSpy.failNext;
      stateSpy.failNext = undefined;
      if (err) throw err;
      return actual.updateStateAtDir(...a);
    },
  };
});

const { detectOllamaDeviceMock, setLastKnownAnalyzerDeviceMock } = vi.hoisted(() => ({
  detectOllamaDeviceMock: vi.fn(async (): Promise<'cuda' | 'cpu' | 'unknown'> => 'cuda'),
  setLastKnownAnalyzerDeviceMock: vi.fn(),
}));
vi.mock('./ollama-health.js', () => ({
  detectOllamaDevice: detectOllamaDeviceMock,
  unloadResidentOllama: vi.fn(async () => {}),
}));
vi.mock('../gpu/analyzer-device-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gpu/analyzer-device-state.js')>()),
  setLastKnownAnalyzerDevice: setLastKnownAnalyzerDeviceMock,
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
      return actual.selectAnalyzerForPhase(
        opts as Parameters<typeof actual.selectAnalyzerForPhase>[0],
      );
    },
    isPerPhaseModelSelectionActive: () =>
      Boolean((globalThis as Record<string, unknown>).__single_matcher_pipelined),
  };
});

describe('#4031 analysis-job harness', () => {
  const orig = process.env.STAGE2_COVERAGE_RETRIES;
  const books: HarnessBook[] = [];
  const seed = (...a: Parameters<typeof mkBook>): HarnessBook => {
    const b = mkBook(...a);
    books.push(b);
    return b;
  };
  beforeEach(() => {
    process.env.STAGE2_COVERAGE_RETRIES = '0';
  });
  afterEach(async () => {
    resetHarness();
    if (orig === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
    else process.env.STAGE2_COVERAGE_RETRIES = orig;
    for (const b of books.splice(0)) await cleanupBook(b);
  });

  it('smoke: a first analysis of a new book writes its cast', async () => {
    const b = seed([]);
    const events = await run(b.manuscriptId, b.bookDir, 'main');
    const cast = readCast(b.bookDir);
    expect(cast.map((c) => c.id)).toEqual(expect.arrayContaining(['narrator', FRESH_ID]));
    expect(readEdits(b.bookDir).some((s) => s.characterId === FRESH_ID)).toBe(true);
    expect(events.some((e) => e.kind === 'result')).toBe(true);
  });

  it('readers: linesById, readSuggestions and readCache read the surfaces back', async () => {
    const b = seed([{ ...NARR, lines: 4 }, { ...PRIOR_WREN, lines: 7 }]);
    expect(linesById(b.bookDir)).toEqual({ narrator: 4, [PRIOR_ID]: 7 });
    expect(readSuggestions(b.bookDir)).toEqual([]);
    expect(readCache(b.manuscriptId)).toBeNull();
    await run(b.manuscriptId, b.bookDir, 'main');
    expect(readCache(b.manuscriptId)).not.toBeNull();
  });

  it('setPhase0Hook: the hook runs in Phase 0', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN }]);
    const seen: number[] = [];
    setPhase0Hook((id) => {
      seen.push(id);
    });
    await run(b.manuscriptId, b.bookDir, 'main');
    expect(seen.length).toBeGreaterThan(0);
  });

  it('setPipelined: true takes the pipelined path (analysis.ts pipelinedPerPhase), false does not', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const pipelinedLog = (l: typeof log): boolean =>
      l.mock.calls.some((c: unknown[]) => String(c[0]).includes('pipelined phase0='));
    try {
      const off = seed([{ ...NARR }, { ...PRIOR_WREN }]);
      setPipelined(false);
      await run(off.manuscriptId, off.bookDir, 'main');
      expect(pipelinedLog(log)).toBe(false);

      log.mockClear();
      const on = seed([{ ...NARR }, { ...PRIOR_WREN }]);
      setPipelined(true);
      const events = await run(on.manuscriptId, on.bookDir, 'main');
      expect(pipelinedLog(log)).toBe(true);
      expect(events.some((e) => e.kind === 'result')).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('putCast: a whole-slice cast PUT lands on disk', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN }]);
    const res = await putCast(mkApp(), b.bookId, [{ ...NARR }, { ...PRIOR_WREN, name: 'Wren Renamed' }]);
    expect(res.status).toBe(200);
    expect(readCast(b.bookDir).find((c) => c.id === PRIOR_ID)?.name).toBe('Wren Renamed');
  });

  it('routeVoice: the voice route writes the override onto the row', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN }]);
    const res = await routeVoice(mkApp(), b.bookId, PRIOR_ID);
    expect(res.status).toBe(200);
    const row = readCast(b.bookDir).find((c) => c.id === PRIOR_ID);
    expect((row?.overrideTtsVoices as { qwen?: { name: string } }).qwen?.name).toBe(`route-voice-${PRIOR_ID}`);
  });

  it('mergeMidRun: a merge fired from the Phase-0 hook is answered while the run is in flight', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN }, { id: 'w3', name: 'Wrenna', role: 'minor', color: '#222222' }]);
    const m = mergeMidRun(mkApp(), b.bookId, 'w3', PRIOR_ID, 'phase0');
    await run(b.manuscriptId, b.bookDir, 'main');
    const res = await m.done;
    expect(res?.status).toBe(200);
    expect(res?.body.sourceId).toBe('w3');
  });

  it('mergeMidRun: the default Phase-1 branch merges a source that still exists then, a prior-only row included, and 404s one that never did', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN }, { id: 'w3', name: 'Wrenna', role: 'minor', color: '#222222' }]);
    const live = mergeMidRun(mkApp(), b.bookId, PRIOR_ID, 'narrator');
    await run(b.manuscriptId, b.bookDir, 'main');
    expect((await live.done)?.status).toBe(200);

    /* Plan 291 rule 1: the Phase-0b snapshot carries every prior row forward, so a
       prior-only source (w3) is still in cast.json at the first Phase-1 call. (Before
       Task 16 the interim snapshot dropped it and this answered 404.) */
    const c = seed([{ ...NARR }, { ...PRIOR_WREN }, { id: 'w3', name: 'Wrenna', role: 'minor', color: '#222222' }]);
    const carried = mergeMidRun(mkApp(), c.bookId, 'w3', PRIOR_ID);
    await run(c.manuscriptId, c.bookDir, 'main');
    expect((await carried.done)?.status).toBe(200);

    const d = seed([{ ...NARR }, { ...PRIOR_WREN }]);
    const gone = mergeMidRun(mkApp(), d.bookId, 'never-in-the-cast', PRIOR_ID);
    await run(d.manuscriptId, d.bookDir, 'main');
    expect((await gone.done)?.status).toBe(404);
  });

  it('failNextRetirement: the next retirement write throws once', async () => {
    /* A retirement is recorded by the run-start heal of two identically named rows. (A
       surname join no longer retires anything during the run: the plan-applied roster
       already speaks the prior id.) */
    const b = seed([
      { ...NARR },
      { ...PRIOR_WREN, lines: 40 },
      { id: 'w2b', name: 'Wren', role: 'minor', color: '#333333', voiceState: 'generated' },
    ]);
    const fault = failNextRetirement();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await run(b.manuscriptId, b.bookDir, 'main');
    } finally {
      warn.mockRestore();
    }
    expect(fault.calls()).toBe(1);
  });

  it('blipRemapRead: the history read at the remap fails once', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN }], {});
    const blip = await blipRemapRead();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await run(b.manuscriptId, b.bookDir, 'main');
      expect(blip.count()).toBe(1);
    } finally {
      blip.restore();
      warn.mockRestore();
    }
  });

  it('resetHarness: an armed, unfired failNextRetirement does not leak into the next test', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN }]);
    const fault = failNextRetirement();
    resetHarness();
    const err = await historyStore.retireCharacterId(b.bookDir, 'nope-a', 'nope-b', 'user').catch((e: Error) => e);
    expect(String((err as Error)?.message ?? '')).not.toContain('simulated');
    expect(fault.calls()).toBe(0);
  });

  it('resetHarness: an armed blipRemapRead no longer replaces readJson afterwards', async () => {
    const blip = await blipRemapRead();
    const armed = vi.mocked(stateIo.readJson).getMockImplementation();
    resetHarness();
    expect(vi.mocked(stateIo.readJson).getMockImplementation()).not.toBe(armed);
    expect(blip.count()).toBe(0);
  });

  it('abortAtFirstPhase1 stops the run; runSubsetRetry resumes the cache it left, without re-seeding', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN }]);
    setPhase1Hook(abortAtFirstPhase1());
    const stopped = await run(b.manuscriptId, b.bookDir, 'main');
    setPhase1Hook(undefined);
    expect(getLastJob()!.controller.signal.aborted).toBe(true);
    expect(stopped.some((e) => e.kind === 'result')).toBe(false);

    const cache = readCache(b.manuscriptId)!;
    expect(cache.stage1).toBeDefined();
    /* A cached take for a chapter the retry does not run: a re-seed
       (cache := { chapters: {}, stage1 }) would erase it. */
    await saveAnalysisCache(b.manuscriptId, {
      ...cache,
      chapters: {
        ...cache.chapters,
        99: [{ id: 9901, chapterId: 99, characterId: FRESH_ID, confidence: 0.9, text: 'CACHED-SENTINEL' }],
      },
    } as never);

    const phase1Chapters: number[] = [];
    setPhase1Hook((id) => {
      phase1Chapters.push(id);
    });
    const retry = await runSubsetRetry(b);
    expect(phase1Chapters.length).toBeGreaterThan(0); /* the retry did run */
    expect(retry.length).toBeGreaterThan(0);
    expect(JSON.stringify(readCache(b.manuscriptId)!.chapters[99])).toContain('CACHED-SENTINEL');
  });

  it('recordCastUpdateFrames: every cast-update frame is captured as a snapshot', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN }]);
    let rec!: ReturnType<typeof recordCastUpdateFrames>;
    const events = await run(b.manuscriptId, b.bookDir, 'main', undefined, {
      onJob: (j) => {
        rec = recordCastUpdateFrames(j);
      },
    });
    const sent = events.filter((e) => e.kind === 'cast-update');
    expect(sent.length).toBeGreaterThan(0);
    expect(rec.frames).toHaveLength(sent.length);
    expect(rec.frames[0].length).toBeGreaterThan(0);
  });

  it('recordCastUpdateFrames: a captured frame is a deep copy taken at send time', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN }]);
    let rec!: ReturnType<typeof recordCastUpdateFrames>;
    const events = await run(b.manuscriptId, b.bookDir, 'main', undefined, {
      onJob: (j) => {
        rec = recordCastUpdateFrames(j);
      },
    });
    const sentFrame = events.find((e) => e.kind === 'cast-update') as unknown as { characters: Row[] };
    const before = JSON.stringify(rec.frames[0]);
    for (const c of sentFrame.characters) c.name = 'MUTATED AFTER SEND';
    expect(JSON.stringify(rec.frames[0])).toBe(before);
    expect(before).not.toContain('MUTATED AFTER SEND');
  });
});

/* ---- Plan 291 Task 15 - the main job's run start ---------------------------- */

describe('#4031 main job: run start and cache classification', () => {
  const orig = {
    retries: process.env.STAGE2_COVERAGE_RETRIES,
    lag: process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS,
  };
  const books: HarnessBook[] = [];
  const seed = (...a: Parameters<typeof mkBook>): HarnessBook => {
    const b = mkBook(...a);
    books.push(b);
    return b;
  };
  const audiobook = (b: HarnessBook, file: string): string => join(b.bookDir, '.audiobook', file);
  const WREN_DUP: Row = { id: 'w2b', name: 'Wren', role: 'minor', color: '#333333', voiceState: 'generated' };
  const wrenRows = (rows: Row[]): Row[] => rows.filter((r) => r.name === 'Wren');
  beforeEach(() => {
    process.env.STAGE2_COVERAGE_RETRIES = '0';
  });
  afterEach(async () => {
    resetHarness();
    for (const [k, v] of [
      ['STAGE2_COVERAGE_RETRIES', orig.retries],
      ['ANALYZER_PHASE1_MIN_LAG_CHAPTERS', orig.lag],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const b of books.splice(0)) await cleanupBook(b);
  });

  /* The first Phase-1 call of a pipelined run: was Phase 0b's roster already cached? */
  async function stage1AtFirstPhase1(b: HarnessBook): Promise<boolean | undefined> {
    process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS = '0';
    setPipelined(true);
    let seen: boolean | undefined;
    let release!: () => void;
    const firstPhase1 = new Promise<void>((r) => {
      release = r;
    });
    /* The last Phase-0 chapter waits for the first Phase-1 call (or 300ms), so a
       Phase 1 that is NOT held gets in before Phase 0b. */
    setPhase0Hook(async (id) => {
      if (id === 3) await Promise.race([firstPhase1, new Promise((r) => setTimeout(r, 300))]);
    });
    setPhase1Hook(() => {
      seen ??= readCache(b.manuscriptId)?.stage1 !== undefined;
      release();
    });
    await run(b.manuscriptId, b.bookDir, 'main');
    return seen;
  }

  /* A17 is main-only (R14): the subset job builds no Phase-0 watermark, so Phase 1 never pipelines there. */
  it('A17a: with per-phase models on a cast book, no Phase-1 take exists before Phase 0b', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN }]);
    expect(await stage1AtFirstPhase1(b)).toBe(true);
  });

  it('A17a: a first analysis of a new book (no prior, no history) keeps its pipelining', async () => {
    const b = seed([]);
    expect(await stage1AtFirstPhase1(b)).toBe(false);
  });

  it('A17a: the pipelined operator log says held-for-plan only for a held book', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const line = (): string => log.mock.calls.map((c: unknown[]) => String(c[0])).find((l) => l.includes('pipelined phase0=')) ?? '';
    try {
      setPipelined(true);
      const cast = seed([{ ...NARR }, { ...PRIOR_WREN }]);
      await run(cast.manuscriptId, cast.bookDir, 'main');
      expect(line()).toContain('held-for-plan');
      log.mockClear();
      const fresh = seed([]);
      await run(fresh.manuscriptId, fresh.bookDir, 'main');
      expect(line()).not.toContain('held-for-plan');
      expect(line()).toContain('pipelined phase0=');
    } finally {
      log.mockRestore();
    }
  });

  it('R8: a snapshot re-mint reaches the takes a pipelined run made before Phase 0b', async () => {
    /* A first analysis keeps its pipelining, so Phase 1 attributes chapters in the
       analyzer's id space before the plan exists. A row created on disk under that
       same id while the run is in Phase 0 makes the Phase-0b snapshot re-mint the
       run's row, and every take - the ones already made included - must follow. */
    const b = seed([]);
    process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS = '0';
    setPipelined(true);
    let release!: () => void;
    const firstPhase1 = new Promise<void>((r) => {
      release = r;
    });
    setPhase0Hook(async (id) => {
      if (id !== 3) return;
      await Promise.race([firstPhase1, new Promise((r) => setTimeout(r, 300))]);
      writeFileSync(
        join(b.bookDir, '.audiobook', 'cast.json'),
        JSON.stringify({ characters: [{ id: FRESH_ID, name: 'Someone Else', role: 'character' }] }),
      );
    });
    let preplanTakes = 0;
    /* Chapter 3's take is held until the re-mint is on disk (bounded), so at least
       one roll is made after it, carrying the earlier chapters' pre-plan takes. */
    const reminted = (): boolean =>
      readCache(b.manuscriptId)?.matchPlan?.decisions[FRESH_ID]?.kind === 'new' &&
      (readCache(b.manuscriptId)?.matchPlan?.decisions[FRESH_ID] as { id?: string }).id === `${FRESH_ID}-n1`;
    setPhase1Hook(async (chapterId) => {
      release();
      if (chapterId !== 3) return;
      for (let i = 0; i < 100 && !reminted(); i++) await new Promise((r) => setTimeout(r, 20));
    });
    /* The analyzer answers in whatever id space the roster it was given uses: the
       raw id before the plan, the re-minted one after. */
    const speaker = (): string => {
      if (readCache(b.manuscriptId)?.matchPlan) return `${FRESH_ID}-n1`;
      preplanTakes += 1;
      return FRESH_ID;
    };
    /* Every per-chapter roll made once the plan exists: what manuscript-edits.json
       says at that moment (a stopped run leaves exactly that on disk). */
    const postPlanRolls: Array<Record<string, number>> = [];
    const countLines = (): Record<string, number> =>
      (readEdits(b.bookDir) as Array<{ characterId: string }>).reduce<Record<string, number>>(
        (acc, s) => ({ ...acc, [s.characterId]: (acc[s.characterId] ?? 0) + 1 }),
        {},
      );
    /* Sampled on the re-mint (the second patch), not on the plan's presence (the first):
       a roll that lands between the two patches carries no re-mint to follow yet. */
    rollSpy.isPlanned = reminted;
    rollSpy.after = (planned) => {
      if (planned) postPlanRolls.push(countLines());
    };
    try {
      await run(b.manuscriptId, b.bookDir, 'main', { roster: [NARR, WREN_FRESH], speakerId: speaker });
    } finally {
      rollSpy.isPlanned = undefined;
      rollSpy.after = undefined;
    }
    expect(preplanTakes).toBeGreaterThan(0); // the scenario fired: a take predates the plan
    /* The rolls follow the re-mint too: the pre-plan takes they carry never land on
       the raw id, which is now the user's row. */
    expect(postPlanRolls.length).toBeGreaterThan(0);
    for (const rolled of postPlanRolls) {
      expect(rolled[FRESH_ID]).toBeUndefined();
      expect(rolled[`${FRESH_ID}-n1`]).toBeGreaterThan(0);
    }
    const lines = (readEdits(b.bookDir) as Array<{ characterId: string }>).reduce<Record<string, number>>(
      (acc, s) => ({ ...acc, [s.characterId]: (acc[s.characterId] ?? 0) + 1 }),
      {},
    );
    expect(lines[`${FRESH_ID}-n1`]).toBe(9); // three lines in each of three chapters
    expect(lines[FRESH_ID]).toBeUndefined();
  });

  it('A17a: a book with only a merge history is held too', async () => {
    const b = seed([], { w9: PRIOR_ID });
    expect(await stage1AtFirstPhase1(b)).toBe(true);
  });

  /* A16 is main-only (R14): a Re-parse clears the analysis cache (book-state.ts reparse, `clearAnalysisCache` ~:1768), so the next run is a main one. */
  it('A16 (route): Re-parse, then re-analyse - the carryover is in cast.json at run start with its dismissal records', async () => {
    const b = seed([]);
    const olga = {
      id: 'olga',
      name: 'Olga',
      aliases: ['Olya'],
      role: 'minor',
      color: '#444444',
      voiceId: 'v_olga',
      voiceState: 'locked',
    };
    writeFileSync(audiobook(b, 'cast-reuse-carryover.json'), JSON.stringify({ characters: [olga] }));
    const record = { a: 'olga', b: 'olya', at: '2026-11-01T00:00:00.000Z' };
    writeFileSync(
      audiobook(b, 'cast-id-history.json'),
      JSON.stringify({ schema: 1, supersededBy: {}, notSamePerson: [record] }),
    );
    let atStart: Row[] | undefined;
    setPhase0Hook(() => {
      atStart ??= readCast(b.bookDir);
    });
    await run(b.manuscriptId, b.bookDir, 'main');
    expect(atStart?.find((c) => c.id === 'olga')).toMatchObject(olga);
    expect(readJson(b.bookDir, 'cast-id-history.json').notSamePerson).toEqual([record]);
  });

  it('A11 (route): identical names heal at run start, in cast.json and in the history as a heal', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN, lines: 40 }, { ...WREN_DUP }]);
    let atStart: { cast: Row[]; history: Record<string, unknown> } | undefined;
    setPhase0Hook(() => {
      atStart ??= { cast: readCast(b.bookDir), history: readJson(b.bookDir, 'cast-id-history.json') };
    });
    await run(b.manuscriptId, b.bookDir, 'main');
    expect(wrenRows(atStart!.cast).map((r) => r.id)).toEqual([PRIOR_ID]);
    expect(atStart!.history.supersededBy).toEqual({ w2b: PRIOR_ID });
    expect(atStart!.history.supersededByKind).toEqual({ w2b: 'heal' });
  });

  it('A11 (route): no heal across a dismissal record', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN }, { ...WREN_DUP }]);
    writeFileSync(
      audiobook(b, 'cast-id-history.json'),
      JSON.stringify({
        schema: 1,
        supersededBy: {},
        notSamePerson: [{ a: PRIOR_ID, b: 'w2b', at: '2026-11-01T00:00:00.000Z' }],
      }),
    );
    let atStart: Row[] | undefined;
    setPhase0Hook(() => {
      atStart ??= readCast(b.bookDir);
    });
    await run(b.manuscriptId, b.bookDir, 'main');
    expect(wrenRows(atStart!).map((r) => r.id)).toEqual([PRIOR_ID, 'w2b']);
  });

  it('A11 (route): a degraded history still heals, and records no retirement', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN, lines: 40 }, { ...WREN_DUP }]);
    writeFileSync(audiobook(b, 'cast-id-history.json'), '{ not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let atStart: Row[] | undefined;
      setPhase0Hook(() => {
        atStart ??= readCast(b.bookDir);
      });
      await run(b.manuscriptId, b.bookDir, 'main');
      expect(wrenRows(atStart!).map((r) => r.id)).toEqual([PRIOR_ID]);
      expect(readFileSync(audiobook(b, 'cast-id-history.json'), 'utf8')).toBe('{ not json');
    } finally {
      warn.mockRestore();
    }
  });

  it('the stale reuse-link prune is written to cast.json at run start', async () => {
    const olga = { id: 'olga', name: 'Olga', role: 'minor', color: '#444444', matchedFrom: { bookId: 'not-in-this-series', characterId: 'olga-1' } };
    const b = seed([{ ...NARR }, olga]);
    let atStart: Row[] | undefined;
    setPhase0Hook(() => {
      atStart ??= readCast(b.bookDir);
    });
    await run(b.manuscriptId, b.bookDir, 'main');
    const row = atStart!.find((c) => c.id === 'olga')!;
    expect(row).toBeDefined();
    expect(row.matchedFrom).toBeUndefined();
  });

  it('an unverifiable book dir at run start ends the run in the curated terminal and writes nothing', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN }, { id: 'w2b', name: 'Wren', role: 'minor', color: '#333333', voiceState: 'generated' }]);
    /* The book path now holds a DIFFERENT book (as after an out-of-process move). */
    const statePath = audiobook(b, 'state.json');
    writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, 'utf8')), manuscriptId: 'some-other-book' }));
    const castBefore = readFileSync(audiobook(b, 'cast.json'), 'utf8');
    let phase0Calls = 0;
    setPhase0Hook(() => {
      phase0Calls += 1;
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const events = await run(b.manuscriptId, b.bookDir, 'main');
      /* It ends AT the run start, before any analyzer work - not later at the persist. */
      expect(phase0Calls).toBe(0);
      expect(events.some((e) => e.kind === 'result')).toBe(false);
      expect(events.find((e) => e.kind === 'error')?.code).toBe('STALE_BOOK_DIR');
      expect(readFileSync(audiobook(b, 'cast.json'), 'utf8')).toBe(castBefore);
      expect(existsSync(audiobook(b, 'cast-id-history.json'))).toBe(false);
    } finally {
      err.mockRestore();
    }
  });

  it('A22 (route): a legacy cache is a miss', async () => {
    const b = seed([]);
    await saveAnalysisCache(b.manuscriptId, {
      chapters: { 1: [{ id: 101, chapterId: 1, characterId: FRESH_ID, confidence: 0.9, text: 'LEGACY-SENTINEL' }] },
      stage1: { characters: [NARR, WREN_FRESH], chapters: [{ id: 1, title: 'Chapter One' }] },
    } as never);
    let phase0Calls = 0;
    setPhase0Hook(() => {
      phase0Calls += 1;
    });
    await run(b.manuscriptId, b.bookDir, 'main');
    expect(phase0Calls).toBeGreaterThan(0);
    const cache = readCache(b.manuscriptId)!;
    expect(cache.version).toBe(2);
    expect(JSON.stringify(cache.chapters)).not.toContain('LEGACY-SENTINEL');
  });

  it('item 9: a first analysis of a new book creates a version-2 cache', async () => {
    const b = seed([]);
    let atStart: { version?: number } | null | undefined;
    setPhase0Hook(() => {
      atStart ??= readCache(b.manuscriptId) ?? null;
    });
    await run(b.manuscriptId, b.bookDir, 'main');
    expect(atStart?.version).toBe(2);
    expect(readCache(b.manuscriptId)!.version).toBe(2);
  });
  /* Task 28 fix round 1 (M4): "no warning frame on a run whose start wrote
     cast.json" was deleted - the phantom merge-base advisory it guarded has no
     emitter any more (the guard's reverse check pins CAST_MERGE_BASE_STALE_CODE
     deleted), and it would fail on an unrelated warning. */
});

/* ---- Plan 291 Task 16 - the main job's Phase 0b plan and snapshots ----------- */

describe('#4031 main job: Phase 0b plans cast identity once', () => {
  const orig = process.env.STAGE2_COVERAGE_RETRIES;
  const books: HarnessBook[] = [];
  const seed = (...a: Parameters<typeof mkBook>): HarnessBook => {
    const b = mkBook(...a);
    books.push(b);
    return b;
  };
  /* A descriptor-named row: the preview fold rolls it into the Unknown male bucket,
     the plan-applied snapshot must keep it as its own row. */
  const JOGGER = {
    id: 'the-jogger',
    name: 'The Jogger',
    role: 'minor',
    color: '#222222',
    gender: 'male',
    evidence: [{ quote: 'The Jogger waved' }],
  } as unknown as CharacterOutput;
  const BODY16 = `${BODY}\n\nThe Jogger waved.`;
  const OLGA: Row = { id: 'olga', name: 'Olga', role: 'minor', color: '#444444', voiceState: 'generated' };
  const LEAD_WREN: Row = { ...PRIOR_WREN, role: 'lead', color: '#111111' };
  const FRESH = { roster: [NARR, WREN_FRESH, JOGGER], speakerId: FRESH_ID };
  const stopAtPhase1 = async (
    b: HarnessBook,
    fresh: Parameters<typeof run>[3] = FRESH,
    opts?: Parameters<typeof run>[4],
    kind: 'main' | 'subset' = 'main',
  ): Promise<void> => {
    setPhase1Hook(abortAtFirstPhase1());
    await runJob(kind)(b, fresh, opts);
    setPhase1Hook(undefined);
  };
  const ids = (rows: Row[]): string[] => rows.map((r) => String(r.id));
  beforeEach(() => {
    process.env.STAGE2_COVERAGE_RETRIES = '0';
  });
  afterEach(async () => {
    resetHarness();
    if (orig === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
    else process.env.STAGE2_COVERAGE_RETRIES = orig;
    for (const b of books.splice(0)) await cleanupBook(b);
  });

  /* Plan 291 R14 (Task 26): A14 runs through both jobs; the subset's snapshot is its Phase 0a one. */
  describe.each(['main', 'subset'] as const)('A14a + F14 (%s)', (kind) => {
  it('A14a: stopped after the Phase-0b snapshot and never resumed, the cast is only extended', async () => {
    const b = seed([{ ...NARR }, { ...LEAD_WREN }, { ...OLGA }], undefined, BODY16);
    await stopAtPhase1(b, FRESH, undefined, kind);
    const cast = readCast(b.bookDir);
    /* Every prior row is still there, the joined analyzer row is the prior row, and the
       descriptor-named new row is its own (unfolded) row - not the Unknown male bucket. */
    expect(ids(cast)).toEqual(expect.arrayContaining(['narrator', PRIOR_ID, 'olga', 'the-jogger']));
    expect(ids(cast)).not.toContain(FRESH_ID);
    expect(ids(cast)).not.toContain('unknown-male');
    const wren = cast.find((c) => c.id === PRIOR_ID)!;
    expect(wren).toMatchObject({ name: 'Wren', voiceState: 'locked' });
    expect(wren.aliases).toContain('Wren Ashby');
    expect(cast.find((c) => c.id === 'olga')).toMatchObject(OLGA);
  });

  it('F14: a route-given voice on a new row survives a stopped run', async () => {
    const b = seed([{ ...NARR }, { ...LEAD_WREN }, { ...OLGA }], undefined, BODY16);
    const app = mkApp();
    let voice: { status: number } | undefined;
    /* One-shot: several chapters reach this hook, and a later call resuming after
       `run` returned must never touch `getLastJob()` - by then it is the NEXT test's
       job. The first call captures this job before its await, sends the route write
       and stops the run; every call waits for that one stop, then only throws. */
    let stopped: Promise<void> | undefined;
    setPhase1Hook(async () => {
      if (!stopped) {
        const job = getLastJob();
        stopped = (async () => {
          voice = await routeVoice(app, b.bookId, 'the-jogger');
          job?.controller.abort();
        })();
      }
      await stopped;
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    await runJob(kind)(b, FRESH);
    setPhase1Hook(undefined);
    expect(voice?.status).toBe(200);
    const row = readCast(b.bookDir).find((c) => c.id === 'the-jogger')!;
    expect((row.overrideTtsVoices as { qwen?: { name: string } }).qwen?.name).toBe('route-voice-the-jogger');
  });
  });

  it("R8/carry 4: a merge's cache re-target landing between Phase 0b's two cache patches survives", async () => {
    const b = seed([{ ...NARR }, { ...LEAD_WREN }, { ...OLGA }], undefined, BODY16);
    /* The window: the snapshot runs after the first patch (the plan is on disk) and
       before the second. Its suggestions read is where the cache half of a
       `performCastMerge` (the-jogger -> olga, cast-merge.ts) is landed - the same
       patch the route sends. */
    const suggestionsPath = castMergeSuggestionsJsonPath(b.bookDir);
    let merged = false;
    const actual = vi.mocked(stateIo.readJson).getMockImplementation()!;
    vi.mocked(stateIo.readJson).mockImplementation(async (path: string) => {
      if (!merged && path === suggestionsPath && readCache(b.manuscriptId)?.matchPlan) {
        merged = true;
        await mutateAnalysisCache(b.manuscriptId, {
          remapCharacterIds: { 'the-jogger': 'olga' },
          ledger: { 'the-jogger': null },
          transform: (c) =>
            c.matchPlan ? { ...c, matchPlan: retargetPlanForMerge(c.matchPlan, 'the-jogger', 'olga') } : c,
        });
      }
      return actual(path);
    });
    try {
      await stopAtPhase1(b);
    } finally {
      vi.mocked(stateIo.readJson).mockImplementation(actual);
    }
    expect(merged).toBe(true);
    expect(readCache(b.manuscriptId)?.matchPlan?.decisions['the-jogger']).toMatchObject({
      kind: 'join',
      priorId: 'olga',
    });
  });

  it('A7c (#4023 S1): a locked prior row joined by a surname keeps its id, its lock and its lines', async () => {
    const b = seed([{ ...NARR }, { ...LEAD_WREN }]);
    await run(b.manuscriptId, b.bookDir, 'main', { roster: [NARR, WREN_FRESH], speakerId: PRIOR_ID });
    const cast = readCast(b.bookDir);
    expect(cast.filter((c) => String(c.name).startsWith('Wren')).map((c) => c.id)).toEqual([PRIOR_ID]);
    const row = cast.find((c) => c.id === PRIOR_ID)!;
    expect(row.voiceState).toBe('locked');
    expect(row.voiceId).toBeUndefined();
    const edits = readEdits(b.bookDir);
    expect(edits.some((s) => s.characterId === PRIOR_ID)).toBe(true);
    expect(edits.some((s) => s.characterId === FRESH_ID)).toBe(false);
  });

  /* Two prior rows both match "Wren Ashby" by surname; a dismissal keeps the run-start
     heal from collapsing them. The owner's rule: no guess - a new row, suggestions to both. */
  const twoWrens = (): HarnessBook => {
    const b = seed([
      { ...NARR },
      { ...LEAD_WREN },
      { id: 'w2b', name: 'Wren', role: 'minor', color: '#333333', voiceState: 'generated' },
    ]);
    writeFileSync(
      join(b.bookDir, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({
        schema: 1,
        supersededBy: {},
        notSamePerson: [{ a: PRIOR_ID, b: 'w2b', at: '2026-11-01T00:00:00.000Z' }],
      }),
    );
    return b;
  };

  it('A7c (#4023 S2, two-row variant): two surname candidates make a new row, not a guess', async () => {
    const b = twoWrens();
    await stopAtPhase1(b, { roster: [NARR, WREN_FRESH], speakerId: FRESH_ID });
    const cast = readCast(b.bookDir);
    expect(ids(cast)).toEqual(expect.arrayContaining(['narrator', PRIOR_ID, 'w2b', FRESH_ID]));
    const plan = readCache(b.manuscriptId)!.matchPlan!;
    expect(plan.decisions[FRESH_ID]).toMatchObject({ kind: 'new', suggest: [PRIOR_ID, 'w2b'] });
  });

  it('Q3 (route): the Phase-0b snapshot writes the plan suggestions while the run is still in progress', async () => {
    const b = twoWrens();
    await stopAtPhase1(b, { roster: [NARR, WREN_FRESH], speakerId: FRESH_ID });
    const sug = readSuggestions(b.bookDir);
    expect(sug.map((s) => [s.newRow, s.candidate, s.origin, s.sourceId, s.targetId]).sort()).toEqual([
      [FRESH_ID, PRIOR_ID, 'plan', FRESH_ID, PRIOR_ID],
      [FRESH_ID, 'w2b', 'plan', FRESH_ID, 'w2b'],
    ]);
  });

  it('A7c (#4023 S3): a prior catch-all id is carried forward and the fresh row stays its own new row', async () => {
    const b = seed([
      { ...NARR },
      { id: 'unknown-male', name: 'Timkin', role: 'minor', color: '#555555', voiceState: 'tuned' },
    ]);
    const timkin = {
      id: 'timkin',
      name: 'Timkin',
      role: 'minor',
      color: '#666666',
      evidence: [{ quote: 'Olga nodded' }],
    } as unknown as CharacterOutput;
    await stopAtPhase1(b, { roster: [NARR, timkin], speakerId: 'timkin' });
    const cast = readCast(b.bookDir);
    expect(ids(cast)).toEqual(expect.arrayContaining(['narrator', 'unknown-male', 'timkin']));
    expect(cast.find((c) => c.id === 'unknown-male')).toMatchObject({ voiceState: 'tuned' });
  });

  it('the Phase-1 prompt lists prior ids and names with analyzer names as aliases', async () => {
    const b = seed([{ ...NARR }, { ...LEAD_WREN }]);
    const prompts: string[] = [];
    const base = phase1(PRIOR_ID);
    const spy: Analyzer = {
      ...base,
      runStage2Chapter: ((m: string, c: number, prompt: string, call: unknown) => {
        prompts.push(prompt);
        return (base.runStage2Chapter as (...a: unknown[]) => unknown)(m, c, prompt, call);
      }) as never,
    };
    const rec = getManuscript(b.manuscriptId)!;
    const { job } = mkJob(b.manuscriptId, b.bookDir, 'main');
    (globalThis as Record<string, unknown>)[PHASE1_GLOBAL] = sel(spy, 'phase1-model');
    await runMainAnalyzerJob(job, rec as never, sel(phase0([NARR, WREN_FRESH]), 'phase0-model'), {
      requestedFresh: false,
      allowStage1Shrink: true,
      requestedModel: undefined,
    } as never);
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) {
      expect(p).toContain(`"id": "${PRIOR_ID}"`);
      expect(p).toContain('"name": "Wren"');
      expect(p).not.toContain(FRESH_ID);
      /* ...with the analyzer's own name listed as an alias of that row. */
      expect(p).toContain('Wren Ashby');
    }
    /* The analyzer's own name is kept as an alias of the joined row. */
    expect(readCast(b.bookDir).find((c) => c.id === PRIOR_ID)!.aliases).toContain('Wren Ashby');
  });

  it('Phase 0a writes no cast.json in the main job', async () => {
    const b = seed([{ ...NARR }, { ...LEAD_WREN }, { ...OLGA }], undefined, BODY16);
    const before = readFileSync(join(b.bookDir, '.audiobook', 'cast.json'), 'utf8');
    const seen: string[] = [];
    setPhase0Hook(async (id) => {
      /* Let an earlier chapter finish (and snapshot, if it did) first. */
      if (id === 3) await new Promise((r) => setTimeout(r, 250));
      seen.push(readFileSync(join(b.bookDir, '.audiobook', 'cast.json'), 'utf8'));
    });
    await stopAtPhase1(b);
    setPhase0Hook(undefined);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const s of seen) expect(s).toBe(before);
  });

  /** A committed text fixture, with CRLF line endings normalised to LF. */
  const readFixtureText = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const FRAMES_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'src',
    'test-fixtures',
    'analysis-cast-update-frames.json',
  );

  it("record: the job's cast-update frames are written to src/test-fixtures/analysis-cast-update-frames.json", async () => {
    const b = seed([{ ...NARR }, { ...LEAD_WREN }, { ...OLGA }], undefined, BODY16);
    let rec!: ReturnType<typeof recordCastUpdateFrames>;
    await stopAtPhase1(b, FRESH, {
      onJob: (j) => {
        rec = recordCastUpdateFrames(j);
      },
    });
    const fresh = `${JSON.stringify({ frames: rec.frames.map((characters) => ({ kind: 'cast-update', characters })) }, null, 2)}\n`;
    if (process.env.RECORD_FIXTURES === '1') {
      mkdirSync(dirname(FRAMES_PATH), { recursive: true });
      writeFileSync(FRAMES_PATH, fresh);
    }
    /* Staleness: the committed file must equal a fresh capture (re-record with RECORD_FIXTURES=1).
       Read line-ending-normalised: a Windows checkout under core.autocrlf=true can
       materialise the fixture as CRLF (.gitattributes pins it to LF too). */
    expect(existsSync(FRAMES_PATH)).toBe(true);
    expect(readFixtureText(FRAMES_PATH)).toBe(fresh);
    /* ...and that comparison holds for a CRLF checkout of the same content, which a
       raw byte comparison would fail. */
    const crlfCopy = join(dirname(b.bookDir), 'analysis-cast-update-frames.crlf.json');
    writeFileSync(crlfCopy, fresh.replace(/\n/g, '\r\n'));
    expect(readFileSync(crlfCopy, 'utf8')).not.toBe(fresh);
    expect(readFixtureText(crlfCopy)).toBe(fresh);
    /* The last frame is the Phase-0b one: the plan-applied roster, prior ids. */
    const last = rec.frames[rec.frames.length - 1];
    expect(ids(last)).toContain(PRIOR_ID);
    expect(ids(last)).not.toContain(FRESH_ID);
  });
});

/* ---- Plan 291 Task 16 - the linker runs on `new` rows only ------------------- */

describe('#4031 linkSeriesReuseOnNewRows (Phase 0b linker)', () => {
  const BOOK1 = 'book-1';
  const BOOK2 = 'book-2';
  const LIBRARY: LibraryCharacterRecord[] = [
    {
      bookId: BOOK1,
      bookTitle: 'Book One',
      character: { id: 'wren', name: 'Wren', gender: 'female', ageRange: 'teen', voiceId: 'wren' },
    },
    {
      bookId: BOOK1,
      bookTitle: 'Book One',
      character: { id: 'marlow', name: 'Marlow', gender: 'male', ageRange: 'teen' },
    },
  ];
  const options = (): LinkSeriesReuseOptions => ({
    scanLibrary: async () => LIBRARY,
    resolveAuthorSeries: async () => ({ author: 'A', series: 'S' }),
    positions: async () =>
      new Map<string, number | null>([
        [BOOK1, 1],
        [BOOK2, 2],
      ]),
    isStandaloneBookId: async () => false,
    resolveBookLanguage: async () => 'en',
    castLoader: async () => null,
  });
  const planOf = (decisions: MatchPlan['decisions']): MatchPlan => ({ version: 1, runToken: 'tok', decisions });
  const newD = (id: string, inheritedDeclines: Array<{ bookId?: string; characterId: string }> = []): MatchPlan['decisions'][string] => ({
    kind: 'new',
    rawId: id,
    id,
    minted: false,
    suggest: [],
    inheritedDeclines,
  });

  it("A7c (#4023 S2): a joined row keeps the prior row's link and is not re-linked; a new row is linked", async () => {
    const rows = [
      { id: PRIOR_ID, name: 'Wren', gender: 'female', ageRange: 'teen' },
      { id: 'marlow-x', name: 'Marlow', gender: 'male', ageRange: 'teen' },
    ] as never[];
    const plan = planOf({
      [FRESH_ID]: { kind: 'join', rawId: FRESH_ID, priorId: PRIOR_ID, tier: 'surname' },
      'marlow-x': newD('marlow-x'),
    });
    const linked = await linkSeriesReuseOnNewRows(BOOK2, rows, plan, options(), []);
    expect(linked).toBe(1);
    expect((rows[0] as { matchedFrom?: unknown }).matchedFrom).toBeUndefined();
    expect((rows[1] as { matchedFrom?: { bookId: string } }).matchedFrom?.bookId).toBe(BOOK1);
  });

  it('a new row never takes a series link one of its candidates declined (inheritedDeclines)', async () => {
    const mk = (): never[] => [{ id: 'wren-x', name: 'Wren', gender: 'female', ageRange: 'teen' }] as never[];
    const control = mk();
    expect(await linkSeriesReuseOnNewRows(BOOK2, control, planOf({ 'wren-x': newD('wren-x') }), options(), [])).toBe(1);

    const declined = mk();
    const plan = planOf({ 'wren-x': newD('wren-x', [{ bookId: BOOK1, characterId: 'wren' }]) });
    expect(await linkSeriesReuseOnNewRows(BOOK2, declined, plan, options(), [])).toBe(0);
    expect((declined[0] as { matchedFrom?: unknown }).matchedFrom).toBeUndefined();
    /* The linker does not write the decline onto the row (the persist overlay records the
       cross-book declines on the added row; see the Task 22 A7 route test). */
    expect((declined[0] as { notLinkedTo?: unknown }).notLinkedTo).toBeUndefined();
  });
});

/* ---- Plan 291 Task 18 - the main job's resume ------------------------------- */

describe('#4031 main job: resume', () => {
  const orig = process.env.STAGE2_COVERAGE_RETRIES;
  const books: HarnessBook[] = [];
  const seed = (...a: Parameters<typeof mkBook>): HarnessBook => {
    const b = mkBook(...a);
    books.push(b);
    return b;
  };
  const JOGGER = {
    id: 'the-jogger',
    name: 'The Jogger',
    role: 'minor',
    color: '#222222',
    gender: 'male',
    evidence: [{ quote: 'The Jogger waved' }],
  } as unknown as CharacterOutput;
  const BODY18 = `${BODY}\n\nThe Jogger waved.`;
  const OLGA: Row = { id: 'olga', name: 'Olga', role: 'minor', color: '#444444', voiceState: 'generated' };
  const LEAD_WREN: Row = { ...PRIOR_WREN, role: 'lead', color: '#111111' };
  const FRESH = { roster: [NARR, WREN_FRESH, JOGGER], speakerId: FRESH_ID };
  const PRIORS = (): Row[] => [{ ...NARR }, { ...LEAD_WREN }, { ...OLGA }];
  const ids = (rows: Row[]): string[] => rows.map((r) => String(r.id));
  beforeEach(() => {
    process.env.STAGE2_COVERAGE_RETRIES = '0';
  });
  afterEach(async () => {
    resetHarness();
    if (orig === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
    else process.env.STAGE2_COVERAGE_RETRIES = orig;
    for (const b of books.splice(0)) await cleanupBook(b);
  });

  /* What a run leaves, for "the resumed result equals an uninterrupted one". */
  const shape = (b: HarnessBook): unknown[] =>
    readCast(b.bookDir).map((c) => [c.id, c.name, c.lines ?? null, c.voiceState ?? null]);
  const decisionsOf = (b: HarnessBook): unknown => {
    const d = readCache(b.manuscriptId)?.matchPlan?.decisions ?? {};
    return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { ...v }]));
  };
  /* Stop the job the way a user Stop does, in Phase 0a: chapter 1 completes (its cast is cached),
     the first later chapter aborts the job, and every later call only throws. */
  const abortPhase0 = (job: AnalysisJob): void => {
    let stopped = false;
    setPhase0Hook(async (chapterId) => {
      if (chapterId === 1) return;
      if (!stopped) {
        stopped = true;
        /* Chapter 1's cast must be cached before the abort (bounded wait): the tests
           assume a resume replays it, and same-tick ordering is not a guarantee. */
        const ch1Cached = (): boolean => (readCache(job.manuscriptId)?.chapterCast?.[1]?.length ?? 0) > 0;
        for (let i = 0; i < 100 && !ch1Cached(); i++) await new Promise((r) => setTimeout(r, 20));
        job.controller.abort();
      }
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
  };
  const stop1 = async (b: HarnessBook, fresh: Parameters<typeof run>[3] = FRESH): Promise<void> => {
    setPhase1Hook(abortAtFirstPhase1());
    await run(b.manuscriptId, b.bookDir, 'main', fresh);
    setPhase1Hook(undefined);
  };
  const straightRun = async (): Promise<HarnessBook> => {
    const b = seed(PRIORS(), undefined, BODY18);
    await run(b.manuscriptId, b.bookDir, 'main', FRESH);
    return b;
  };
  const errCode = (events: Array<{ kind: string; code?: unknown }>): unknown =>
    events.find((e) => e.kind === 'error')?.code;
  const done = (events: Array<{ kind: string }>): boolean => events.some((e) => e.kind === 'result');

  it('F1: cast_incomplete -> subset Retry -> resume_required -> main resume plans and completes', async () => {
    const straight = await straightRun();
    const b = seed(PRIORS(), undefined, BODY18);
    setPhase0Hook((id) => {
      if (id === 3) throw new Error('phase 0 boom');
    });
    const first = await run(b.manuscriptId, b.bookDir, 'main', FRESH);
    setPhase0Hook(undefined);
    expect(errCode(first)).toBe('cast_incomplete');
    const retry = await runSubsetRetry(b, FRESH);
    expect(errCode(retry)).toBe('resume_required');
    /* Flow (b) never plans, so it puts no raw-id row into cast.json (spec :117-119). */
    expect(ids(readCast(b.bookDir))).not.toContain(FRESH_ID);
    expect(ids(readCast(b.bookDir))).not.toContain('the-jogger');
    /* The Retry left the normal "current-unplanned" cache: a roster, no plan. */
    expect(readCache(b.manuscriptId)?.stage1).toBeDefined();
    expect(readCache(b.manuscriptId)?.matchPlan).toBeUndefined();
    const resumed = await run(b.manuscriptId, b.bookDir, 'main', FRESH);
    expect(resumed.some((e) => e.kind === 'result')).toBe(true);
    expect(readCache(b.manuscriptId)?.matchPlan).toBeDefined();
    expect(shape(b)).toEqual(shape(straight));
    expect(decisionsOf(b)).toEqual(decisionsOf(straight));
  });

  it('F1: stopped in Phase 0a and resumed, the result equals an uninterrupted run', async () => {
    const straight = await straightRun();
    const b = seed(PRIORS(), undefined, BODY18);
    await run(b.manuscriptId, b.bookDir, 'main', FRESH, { onJob: abortPhase0 });
    setPhase0Hook(undefined);
    const stopped = readCache(b.manuscriptId)!;
    expect(stopped.stage1).toBeUndefined();
    /* The aborted chapters carry the empty failed marker, not a cast. */
    expect(
      Object.entries(stopped.chapterCast ?? {})
        .filter(([, c]) => c.length > 0)
        .map(([k]) => k),
    ).toEqual(['1']);
    /* Phase 0a writes no cast.json in the main job: no raw-id row on disk. */
    expect(ids(readCast(b.bookDir))).not.toContain(FRESH_ID);
    expect(ids(readCast(b.bookDir))).not.toContain('the-jogger');
    const phase0Chapters: number[] = [];
    setPhase0Hook((id) => {
      phase0Chapters.push(id);
    });
    const resumed = await run(b.manuscriptId, b.bookDir, 'main', FRESH);
    setPhase0Hook(undefined);
    /* The resume replays chapter 1 from the cache and runs only the rest. */
    expect(phase0Chapters.sort()).toEqual([2, 3]);
    expect(resumed.some((e) => e.kind === 'result')).toBe(true);
    expect(shape(b)).toEqual(shape(straight));
    expect(decisionsOf(b)).toEqual(decisionsOf(straight));
  });

  const rowOfB = (b: HarnessBook, id: string): Row | undefined => readCast(b.bookDir).find((c) => c.id === id);
  /* The end state compared across runs: cast.json, line counts (narrator included), history,
     suggestions and the cache ledger. */
  const endState = (b: HarnessBook) => ({
    shape: shape(b),
    lines: linesById(b.bookDir),
    edits: readEdits(b.bookDir).reduce<Record<string, number>>((a, s) => ({ ...a, [String(s.characterId)]: (a[String(s.characterId)] ?? 0) + 1 }), {}),
    history: (readHistory(b.bookDir) as { supersededBy: Record<string, string> }).supersededBy,
    suggestions: readSuggestions(b.bookDir),
    addedRows: readCache(b.manuscriptId)?.addedRows,
  });
  /** A subset run stopped at its first Phase-1 call (after its snapshot), then resumed. */
  const stoppedThenResumedSubset = async (
    b: HarnessBook,
    fresh: { roster: CharacterOutput[]; speakerId: string | string[] } = FRESH,
  ): Promise<Sent[]> => {
    setPhase1Hook(abortAtFirstPhase1());
    await run(b.manuscriptId, b.bookDir, 'subset', fresh);
    setPhase1Hook(undefined);
    expect(ids(readCast(b.bookDir))).toContain('the-jogger'); /* the stop left the snapshot's row */
    expect(readCache(b.manuscriptId)?.addedRows?.['the-jogger']).toMatchObject({ state: 'run-owned' });
    return runSubsetRetry(b, fresh);
  };

  it("R35b (I1): a resumed subset converts the stopped attempt's row it keeps speaking to added-once, as an uninterrupted subset does", async () => {
    const boris = { ...JOGGER, id: 'boris', name: 'Boris Vane', evidence: [{ quote: 'Wren asked' }] } as unknown as CharacterOutput;
    const WITH_BORIS = { roster: [...FRESH.roster, boris], speakerId: ['boris', PRIOR_ID] };
    const straight = seed(PRIORS(), undefined, BODY18);
    expect(done(await run(straight.manuscriptId, straight.bookDir, 'subset', WITH_BORIS))).toBe(true);
    expect(readCache(straight.manuscriptId)?.addedRows?.boris).toEqual({ state: 'added-once' });
    const b = seed(PRIORS(), undefined, BODY18);
    expect(done(await stoppedThenResumedSubset(b, WITH_BORIS))).toBe(true);
    expect(readCache(b.manuscriptId)?.addedRows?.boris).toEqual(readCache(straight.manuscriptId)?.addedRows?.boris);
    expect(rowOfB(b, 'boris')?.lines).toBe(rowOfB(straight, 'boris')?.lines);
    expect(linesById(b.bookDir).narrator ?? 0).toBe(endState(b).edits.narrator ?? 0);
    expect(endState(b).history).toEqual(endState(straight).history);
    expect(endState(b).suggestions).toEqual(endState(straight).suggestions);
  });

  it("A14b (subset): a resumed subset keeps the stopped attempt's fold-dropped row; the next main run converges on the uninterrupted run", async () => {
    /* R42: invariant 6 outranks acceptance 14 for a subset resuming a stopped subset. */
    const straight = seed(PRIORS(), undefined, BODY18);
    expect(done(await run(straight.manuscriptId, straight.bookDir, 'subset', FRESH))).toBe(true);
    expect(ids(readCast(straight.bookDir))).not.toContain('the-jogger');
    const b = seed(PRIORS(), undefined, BODY18);
    expect(done(await stoppedThenResumedSubset(b))).toBe(true);
    /* (a) The documented divergence: the subset deletes nothing by ledger, so the stopped
       attempt's fold-dropped row is still there, still the run's own (R35a). */
    expect(ids(readCast(b.bookDir))).toContain('the-jogger');
    expect(readCache(b.manuscriptId)?.addedRows?.['the-jogger']).toMatchObject({ state: 'run-owned' });
    /* The run-owned entry still marks it as a known run row: the resume re-minted no duplicate. */
    expect(JSON.stringify(readCast(b.bookDir))).not.toContain('the-jogger-n');
    /* (b) Convergence: the next main run fold-drops the untouched row (rule 11). */
    expect(done(await run(b.manuscriptId, b.bookDir, 'main', FRESH))).toBe(true);
    expect(ids(readCast(b.bookDir))).not.toContain('the-jogger');
    expect(endState(b)).toEqual(endState(straight));
  });

  it('R35a: a user edit made between runs on such a row survives the next main persist', async () => {
    const b = seed(PRIORS(), undefined, BODY18);
    expect(done(await stoppedThenResumedSubset(b))).toBe(true);
    await withCastLock(b.bookDir, async () => {
      const p = castJsonPath(b.bookDir);
      const cast = JSON.parse(readFileSync(p, 'utf8')) as { characters: Row[] };
      for (const c of cast.characters) if (c.id === 'the-jogger') c.name = 'The Morning Jogger';
      writeFileSync(p, JSON.stringify(cast));
    });
    expect(done(await run(b.manuscriptId, b.bookDir, 'main', FRESH))).toBe(true);
    /* Rule 11's fingerprint compare: the user's edit makes the row theirs. */
    expect(readCast(b.bookDir).find((c) => c.id === 'the-jogger')).toMatchObject({ name: 'The Morning Jogger' });
    expect(readCache(b.manuscriptId)?.addedRows?.['the-jogger']).toEqual({ state: 'added-once' });
    expect(linesById(b.bookDir)).toMatchObject(endState(b).edits);
    expect((readHistory(b.bookDir) as { supersededBy: Record<string, string> }).supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  it('A14b: stopped after the snapshot and resumed, the result equals an uninterrupted run (a fold-dropped run-added row is gone)', async () => {
    const straight = await straightRun();
    /* The row this run added (a descriptor-named speaker nobody attributes to) is folded away
       by the persist, as in the straight run. */
    expect(ids(readCast(straight.bookDir))).not.toContain('the-jogger');
    const b = seed(PRIORS(), undefined, BODY18);
    await stop1(b);
    expect(ids(readCast(b.bookDir))).toContain('the-jogger'); /* the stop left the snapshot's row */
    expect(Object.keys(readCache(b.manuscriptId)?.addedRows ?? {})).toEqual(['the-jogger']);
    const resumed = await run(b.manuscriptId, b.bookDir, 'main', FRESH);
    expect(resumed.some((e) => e.kind === 'result')).toBe(true);
    /* The resumed snapshot knew the row was the run's own: no re-mint, no duplicate. The
       completed persist then dropped it (un-edited, fold-dropped: rule 11), so its ledger entry
       is gone, and the one row it added and wrote (the fold's bucket) is kept as added-once (R4). */
    expect(readCache(b.manuscriptId)?.addedRows).toEqual({ 'unknown-male': { state: 'added-once' } });
    expect(JSON.stringify(readCast(b.bookDir))).not.toContain('the-jogger-n');
    expect(shape(b)).toEqual(shape(straight));
    expect(ids(readCast(b.bookDir))).not.toContain('the-jogger');
    expect(decisionsOf(b)).toEqual(decisionsOf(straight));
  });

  it('Q2: a resumed run saves the decisions it adds to a cached plan, and keeps the ones it reuses', async () => {
    const b = seed(PRIORS(), undefined, BODY18);
    await stop1(b);
    const before = readCache(b.manuscriptId)!;
    const kept = JSON.parse(JSON.stringify(before.matchPlan!)) as MatchPlan;
    /* A roster row the plan does not cover (what a Retry's stage 1 can hold). */
    const boris = {
      id: 'boris',
      name: 'Boris Vane',
      role: 'minor',
      color: '#555555',
      gender: 'male',
      evidence: [{ quote: 'Olga nodded' }],
    } as unknown as CharacterOutput;
    await saveAnalysisCache(b.manuscriptId, {
      ...before,
      stage1: { ...before.stage1!, characters: [...before.stage1!.characters, boris] },
    } as never);
    await stop1(b, { roster: [NARR, WREN_FRESH, JOGGER, boris], speakerId: FRESH_ID });
    const after = readCache(b.manuscriptId)!.matchPlan!;
    expect(after.runToken).toBe(kept.runToken);
    for (const [k, d] of Object.entries(kept.decisions)) expect(after.decisions[k]).toEqual(d);
    expect(after.decisions.boris).toMatchObject({ kind: 'new', id: 'boris' });
    expect(ids(readCast(b.bookDir))).toContain('boris');
  });

  it('Q2: a resumed run over an unplanned cache plans and saves before it stops again', async () => {
    const b = seed(PRIORS(), undefined, BODY18);
    await stop1(b);
    const before = readCache(b.manuscriptId)!;
    const { matchPlan: _plan, ...unplanned } = before;
    await saveAnalysisCache(b.manuscriptId, unplanned as never);
    expect(readCache(b.manuscriptId)?.matchPlan).toBeUndefined();
    await stop1(b);
    const plan = readCache(b.manuscriptId)?.matchPlan;
    expect(plan).toBeDefined();
    /* Unreachable in production (a dropped plan keeps its ledger nowhere); the invariant is only
       that a plan is made and saved, and the first run's row is not copied under a minted id. */
    expect(plan!.decisions[FRESH_ID]).toMatchObject({ kind: 'join', priorId: PRIOR_ID });
    expect(JSON.stringify(readCast(b.bookDir))).not.toContain('the-jogger-n');
  });

  /* A completed run keeps its cache (stage 1, the plan, its ledger), so a second, non-fresh
     analysis resumes from it. */
  it('R4: a completed book re-analysed without Start fresh gets no -n1 duplicate of a row the first run added', async () => {
    const boris = {
      id: 'boris',
      name: 'Boris Vane',
      role: 'minor',
      color: '#555555',
      gender: 'male',
      evidence: [{ quote: 'Wren asked' }],
    } as unknown as CharacterOutput;
    const fresh = { roster: [NARR, WREN_FRESH, boris], speakerId: ['boris', FRESH_ID] };
    const b = seed([{ ...NARR }, { ...LEAD_WREN }]);
    await run(b.manuscriptId, b.bookDir, 'main', fresh);
    expect(ids(readCast(b.bookDir))).toContain('boris');
    expect(readCache(b.manuscriptId)?.addedRows?.boris).toBeDefined();
    await run(b.manuscriptId, b.bookDir, 'main', fresh);
    expect(ids(readCast(b.bookDir)).filter((id) => id.startsWith('boris'))).toEqual(['boris']);
    expect(readCache(b.manuscriptId)?.matchPlan?.decisions.boris).toMatchObject({ kind: 'new', id: 'boris', minted: false });
  });

  it('item 20: a resumed drift-refused run removes the pairs its pre-stop snapshot added', async () => {
    /* Two prior candidates for one fresh row: the snapshot's plan suggestions. */
    const b = seed([
      { ...NARR },
      { ...LEAD_WREN },
      { id: 'w2b', name: 'Wren', role: 'minor', color: '#333333', voiceState: 'generated' },
    ]);
    writeFileSync(
      join(b.bookDir, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({
        schema: 1,
        supersededBy: {},
        notSamePerson: [{ a: PRIOR_ID, b: 'w2b', at: '2026-11-01T00:00:00.000Z' }],
      }),
    );
    const two = { roster: [NARR, WREN_FRESH], speakerId: FRESH_ID };
    await stop1(b, two);
    expect(readSuggestions(b.bookDir).filter((s) => s.origin === 'plan')).toHaveLength(2);
    expect(readCache(b.manuscriptId)?.runAddedPairs).toHaveLength(2);
    /* A run-added pair whose ids are both in the fresh roster survives the drift path's dedup
       prune (`reconcileDedupSuggestions` against characters0), so only the explicit removal
       can take it out. */
    const sugPath = castMergeSuggestionsJsonPath(b.bookDir);
    const stored = JSON.parse(readFileSync(sugPath, 'utf8')) as { suggestions: Row[] };
    stored.suggestions.push({
      ...stored.suggestions[0],
      sourceId: FRESH_ID,
      targetId: 'narrator',
      a: 'narrator',
      b: FRESH_ID,
      newRow: FRESH_ID,
      candidate: 'narrator',
    });
    writeFileSync(sugPath, JSON.stringify(stored));
    const cached = readCache(b.manuscriptId)!;
    await saveAnalysisCache(b.manuscriptId, {
      ...cached,
      runAddedPairs: [...(cached.runAddedPairs ?? []), ['narrator', FRESH_ID]],
    } as never);
    /* Resume with a Phase 1 whose speaker is unknown for every sentence: attribution drift. */
    const rec = getManuscript(b.manuscriptId)!;
    const ghost: Analyzer = {
      ...phase1(FRESH_ID),
      runStage2Chapter: (async (_m: string, chapterId: number) => ({
        sentences: Array.from({ length: 120 }, (_, k) => ({
          id: chapterId * 1000 + k + 1,
          chapterId,
          /* A few real lines keep the fresh row in the roster the drift path prunes against. */
          characterId: k < 10 ? FRESH_ID : 'ghost',
          confidence: 0.9,
          text: `Are you sure this will work (${k})`,
        })),
      })) as unknown as Analyzer['runStage2Chapter'],
    };
    (globalThis as Record<string, unknown>)[PHASE1_GLOBAL] = sel(ghost, 'phase1-model');
    const { job, events } = mkJob(b.manuscriptId, b.bookDir, 'main');
    await runMainAnalyzerJob(job, rec as never, sel(phase0(two.roster), 'phase0-model'), {
      requestedFresh: false,
      allowStage1Shrink: true,
      requestedModel: undefined,
    } as never);
    expect(errCode(events)).toBe('attribution_drift');
    expect(readSuggestions(b.bookDir).filter((s) => s.origin === 'plan')).toEqual([]);
    expect(readSuggestions(b.bookDir).some((s) => s.a === 'narrator' && s.b === FRESH_ID)).toBe(false);
  });
});

describe('#4031 main job: cache saves and rolls are additive (Task 19)', () => {
  const orig = process.env.STAGE2_COVERAGE_RETRIES;
  const books: HarnessBook[] = [];
  const seed = (...a: Parameters<typeof mkBook>): HarnessBook => {
    const b = mkBook(...a);
    books.push(b);
    return b;
  };
  const OLGA: Row = { id: 'olga', name: 'Olga', role: 'minor', color: '#444444', voiceState: 'generated' };
  const LEAD_WREN: Row = { ...PRIOR_WREN, role: 'lead', color: '#111111' };
  const FRESH = { roster: [NARR, WREN_FRESH], speakerId: FRESH_ID };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const seedWren = (): HarnessBook => seed([{ ...NARR }, { ...LEAD_WREN }, { ...OLGA }]);
  /* Chapter 1 is done once its take is cached and its roll has landed. */
  const chapterOneRolled = (b: HarnessBook): boolean =>
    readCache(b.manuscriptId)?.chapters?.[1] !== undefined &&
    existsSync(join(b.bookDir, '.audiobook', 'manuscript-edits.json')) &&
    readEdits(b.bookDir).some((s) => s.chapterId === 1);
  /* The user merges the prior Wren (the row the run joined) into olga (the route: cast.json, history, edits and cache) once, after chapter 1. */
  const mergeAfterChapterOne = (b: HarnessBook, onMerged?: () => void, targetId = 'olga') => {
    const app = mkApp();
    let merged: Promise<{ status: number }> | undefined;
    return {
      hook: async (chapterId: number): Promise<void> => {
        if (chapterId === 1) return;
        for (let i = 0; i < 300 && !chapterOneRolled(b); i++) await sleep(20);
        merged ??= request(app)
          .post(`/api/books/${b.bookId}/cast/merge`)
          .set('Content-Type', 'application/json')
          .send({ sourceId: PRIOR_ID, targetId })
          .then((r) => {
            onMerged?.();
            return r;
          });
        await merged;
      },
      status: async (): Promise<number | undefined> => (await merged)?.status,
    };
  };
  beforeEach(() => {
    process.env.STAGE2_COVERAGE_RETRIES = '0';
  });
  afterEach(async () => {
    resetHarness();
    rollSpy.isPlanned = undefined;
    rollSpy.after = undefined;
    cacheSpy.beforePatch = undefined;
    if (orig === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
    else process.env.STAGE2_COVERAGE_RETRIES = orig;
    for (const b of books.splice(0)) await cleanupBook(b);
  });

  it('F5: a Phase-1 chapter failure after a mid-run merge keeps the merge, plan and failure record', async () => {
    const b = seedWren();
    const m = mergeAfterChapterOne(b);
    setPhase1Hook(async (chapterId) => {
      await m.hook(chapterId);
      if (chapterId !== 3) return;
      /* Chapter 2 finishes after the merge; chapter 3 then fails. */
      for (let i = 0; i < 300 && readCache(b.manuscriptId)?.chapters?.[2] === undefined; i++) await sleep(20);
      throw new Error('boom: the model gave up on this chapter');
    });
    await run(b.manuscriptId, b.bookDir, 'main', FRESH);
    expect(await m.status()).toBe(200);
    const cache = readCache(b.manuscriptId)!;
    /* The merge: the re-target of the plan and the remap of the take chapter 1 made before it. */
    expect(cache.matchPlan?.decisions[FRESH_ID]).toMatchObject({ kind: 'join', priorId: 'olga' });
    expect(new Set(cache.chapters[1].map((s) => s.characterId))).toEqual(new Set(['olga']));
    /* The failure record the failing chapter's own save made. */
    expect(cache.failedChapterIds).toEqual(expect.arrayContaining([3]));
    expect(cache.failedChapterErrors?.['3']).toMatchObject({ phase: 'attribution' });
  });

  /* Task 27 (R18, carry 5): A23 runs through both jobs; the subset leg reaches the subset's own
     take patch and roll resolver. */
  describe.each(['main', 'subset'] as const)('A23 (%s)', (kind) => {
  const go = runJob(kind);
  /* The test bar (carry 8): cast.json, per-character line counts (narrator included), history
     and suggestions at the end of the run. */
  const endState = (b: HarnessBook) => {
    const edits: Record<string, number> = {};
    for (const s of readEdits(b.bookDir)) edits[String(s.characterId)] = (edits[String(s.characterId)] ?? 0) + 1;
    return {
      cast: readCast(b.bookDir).map((c) => String(c.id)).sort(),
      edits,
      lines: linesById(b.bookDir),
      history: (readHistory(b.bookDir) as { supersededBy: Record<string, string> }).supersededBy,
      suggestions: readSuggestions(b.bookDir),
    };
  };
  it('A23: after a mid-run merge the rolled manuscript-edits.json and the cache carry the survivor id', async () => {
    const b = seedWren();
    let merged = false;
    const m = mergeAfterChapterOne(b, () => {
      merged = true;
    });
    setPhase1Hook(m.hook);
    /* Every roll made once the merge is answered: what the file and the cache say at that moment. */
    const after: Array<{ edits: string[]; takes: string[] }> = [];
    rollSpy.isPlanned = () => merged;
    rollSpy.after = (mergedAtCall) => {
      if (!mergedAtCall) return;
      after.push({
        edits: (readEdits(b.bookDir) as Array<{ characterId: string }>).map((s) => s.characterId),
        takes: Object.values(readCache(b.manuscriptId)!.chapters).flatMap((ss) => ss.map((s) => s.characterId)),
      });
    };
    await go(b, FRESH);
    expect(await m.status()).toBe(200);
    expect(endState(b)).toEqual({
      cast: ['narrator', 'olga'],
      edits: { olga: 3 },
      lines: { narrator: 0, olga: 3 },
      history: { [PRIOR_ID]: 'olga', [FRESH_ID]: 'olga' },
      suggestions: [],
    });
    expect(after.length).toBeGreaterThan(0);
    for (const seen of after) {
      expect(seen.edits).not.toContain(PRIOR_ID);
      expect(seen.edits).toContain('olga');
      expect(seen.takes).not.toContain(PRIOR_ID);
    }
  });

  it('A23: when the raw id is the prior id itself, the cache take and the roll both follow the merge', async () => {
    const b = seedWren();
    let merged = false;
    const m = mergeAfterChapterOne(b, () => {
      merged = true;
    });
    setPhase1Hook(m.hook);
    /* A tier-1 self-join: the analyzer emits the prior id, and the merge re-targets the on-disk
       plan's decision for it to `join -> olga` while the in-memory plan still says `join -> w2`. */
    const SELF = { roster: [NARR, { ...WREN_FRESH, id: PRIOR_ID }], speakerId: PRIOR_ID };
    const after: Array<{ edits: string[]; takes: string[] }> = [];
    rollSpy.isPlanned = () => merged;
    rollSpy.after = (mergedAtCall) => {
      if (!mergedAtCall) return;
      after.push({
        edits: (readEdits(b.bookDir) as Array<{ characterId: string }>).map((s) => s.characterId),
        takes: Object.values(readCache(b.manuscriptId)!.chapters).flatMap((ss) => ss.map((s) => s.characterId)),
      });
    };
    await go(b, SELF);
    expect(await m.status()).toBe(200);
    expect(endState(b)).toEqual({
      cast: ['narrator', 'olga'],
      edits: { olga: 3 },
      lines: { narrator: 0, olga: 3 },
      history: { [PRIOR_ID]: 'olga' },
      suggestions: [],
    });
    expect(after.length).toBeGreaterThan(0);
    for (const seen of after) {
      expect(seen.edits).not.toContain(PRIOR_ID);
      expect(seen.edits).toContain('olga');
      expect(seen.takes).not.toContain(PRIOR_ID);
      expect(seen.takes).toContain('olga');
    }
  });

  it('A23: a merge of the prior id into a row this run added: the cache take and the roll both carry the new row', async () => {
    const b = seedWren();
    const KIT = { ...WREN_FRESH, id: 'kit-marlow', name: 'Kit Marlow', role: 'minor', gender: 'male' } as CharacterOutput;
    let merged = false;
    const m = mergeAfterChapterOne(
      b,
      () => {
        merged = true;
      },
      KIT.id,
    );
    setPhase1Hook(m.hook);
    /* The merge re-targets the on-disk decision for w2 to kit's `new` decision, while the
       in-memory plan still says `join -> w2`. Kit speaks too, so it clears the minor-cast fold. */
    const SELF = { roster: [NARR, { ...WREN_FRESH, id: PRIOR_ID }, KIT], speakerId: [PRIOR_ID, KIT.id] };
    const after: Array<{ edits: string[]; takes: string[] }> = [];
    rollSpy.isPlanned = () => merged;
    rollSpy.after = (mergedAtCall) => {
      if (!mergedAtCall) return;
      after.push({
        edits: (readEdits(b.bookDir) as Array<{ characterId: string }>).map((s) => s.characterId),
        takes: Object.values(readCache(b.manuscriptId)!.chapters).flatMap((ss) => ss.map((s) => s.characterId)),
      });
    };
    await go(b, SELF);
    expect(await m.status()).toBe(200);
    expect(endState(b)).toEqual({
      cast: ['kit-marlow', 'narrator', 'olga'],
      edits: { [KIT.id]: 9 },
      lines: { narrator: 0, [KIT.id]: 9, olga: undefined },
      history: { [PRIOR_ID]: KIT.id },
      suggestions: [],
    });
    expect(readCache(b.manuscriptId)!.matchPlan?.decisions[PRIOR_ID]).toMatchObject({ kind: 'new', id: KIT.id });
    expect(after.length).toBeGreaterThan(0);
    for (const seen of after) {
      expect(seen.edits).not.toContain(PRIOR_ID);
      expect(seen.edits).toContain(KIT.id);
      expect(seen.takes).not.toContain(PRIOR_ID);
      expect(seen.takes).toContain(KIT.id);
    }
  });
  });

  it('item 8: a Phase-1 save after a failure keeps pendingAttributionChapterIds and takesPersisted', async () => {
    const b = seedWren();
    /* An earlier stopped run left chapter 3's take (the prior Wren's) pending and unpersisted. */
    await saveAnalysisCache(b.manuscriptId, {
      version: ANALYSIS_CACHE_VERSION,
      chapters: { 3: [{ id: 301, chapterId: 3, characterId: PRIOR_ID, confidence: 0.9, text: 'Old take.' }] },
      pendingAttributionChapterIds: [3],
      takesPersisted: false,
    } as never);
    /* The user merges that Wren into olga from inside the first failing chapter's call, and it
       finishes before the chapter throws; every chapter then fails. */
    const app = mkApp();
    let merge: Promise<{ status: number }> | undefined;
    setPhase1Hook(async () => {
      merge ??= request(app)
        .post(`/api/books/${b.bookId}/cast/merge`)
        .set('Content-Type', 'application/json')
        .send({ sourceId: PRIOR_ID, targetId: 'olga' })
        .then((r) => r);
      await merge;
      throw new Error('boom: the model gave up on this chapter');
    });
    await run(b.manuscriptId, b.bookDir, 'main', FRESH);
    expect((await merge)?.status).toBe(200);
    const cache = readCache(b.manuscriptId)!;
    expect(cache.failedChapterIds?.length).toBeGreaterThan(0); // a failure save ran
    expect(cache.pendingAttributionChapterIds).toEqual([3]);
    expect(cache.takesPersisted).toBe(false);
    /* The pending take is kept, never deleted, and the failure save did not write it back
       over the merge's remap. */
    expect(cache.chapters[3].map((s) => s.characterId)).toEqual(['olga']);
  });

  it('a take is resolved inside the cache op: a merge that lands before the op still wins', async () => {
    const b = seedWren();
    const app = mkApp();
    let merge: Promise<{ status: number }> | undefined;
    let chapterId: number | undefined;
    /* The window: after the job has read the history for the take and before its patch joins the
       cache op chain, the merge's history write and cache op both land. */
    cacheSpy.beforePatch = async (patch) => {
      if (merge || !patch.chapters) return;
      chapterId = Number(Object.keys(patch.chapters)[0]);
      merge = request(app)
        .post(`/api/books/${b.bookId}/cast/merge`)
        .set('Content-Type', 'application/json')
        .send({ sourceId: PRIOR_ID, targetId: 'olga' })
        .then((r) => r);
      await merge;
    };
    await run(b.manuscriptId, b.bookDir, 'main', FRESH);
    expect((await merge)?.status).toBe(200);
    expect(chapterId).toBeDefined();
    expect(readCache(b.manuscriptId)!.chapters[chapterId!].map((s) => s.characterId)).toEqual(['olga']);
  });

  /* Fix round 1 (M1, I1): the subset's ledger helpers, as units. */
  describe('subset ledger helpers (R35a, R35b)', () => {
    const ro = (fp: string, by?: 'subset') => ({ state: 'run-owned' as const, fp, ...(by ? { by } : {}) });
    it('otherRunsLedger never shares a key with the own ledger (the disjointness the R4 helpers rely on)', () => {
      const cache = { a: ro('1'), b: ro('2', 'subset'), c: { state: 'added-once' as const } };
      const own = { b: ro('9'), d: ro('4') };
      const other = otherRunsLedger(cache, own);
      expect(other).toEqual({ a: ro('1'), c: { state: 'added-once' } });
      expect(Object.keys(other).filter((k) => Object.hasOwn(own, k))).toEqual([]);
    });
    it("subsetCompletedAddedOnce converts written own rows, own rows the overlay made added-once, and a subset's tagged written rows - never a main run's or a carried one", () => {
      const out = subsetCompletedAddedOnce({
        characters: [{ id: 'own-w' }, { id: 'own-c' }, { id: 'sub-w' }, { id: 'sub-c' }, { id: 'main-w' }],
        carriedForward: [{ id: 'own-c' }, { id: 'sub-c' }],
        ledger: { 'own-w': ro('1'), 'own-c': ro('2'), 'own-del': { state: 'added-once' }, 'own-gone': ro('3') },
        mainLedger: { 'sub-w': ro('4', 'subset'), 'sub-c': ro('5', 'subset'), 'main-w': ro('6') },
      });
      expect(out).toEqual({ 'own-w': { state: 'added-once' }, 'own-del': { state: 'added-once' }, 'sub-w': { state: 'added-once' } });
    });
    it('refreshLedger keeps the by tag when it refreshes a fingerprint', () => {
      const row = { id: 'x', name: 'X' };
      const next = { id: 'x', name: 'X', aliases: ['Ex'] };
      expect(refreshLedger({ x: ro(userOwnedFingerprint(row), 'subset') }, [row], [next])).toEqual({ x: ro(userOwnedFingerprint(next), 'subset') });
    });
  });

  describe('persistDecisionsTransform (PR #4103 pass 1 O2 c)', () => {
    const plan = (decisions: Record<string, unknown>) =>
      ({ version: ANALYSIS_CACHE_VERSION, chapters: {}, matchPlan: { version: 1, runToken: 't', decisions } }) as never;
    it("never overwrites the file's merge decision; adds and changes the others against the file", () => {
      const onFile = plan({
        boris: { kind: 'join', rawId: 'boris', priorId: 'olga', tier: 'merge' },
        anna: { kind: 'join', rawId: 'anna', priorId: 'anna', tier: 'id' },
      });
      const out = persistDecisionsTransform({
        boris: { kind: 'new', rawId: 'boris', id: 'boris', minted: false, suggest: [], inheritedDeclines: [] },
        anna: { kind: 'join', rawId: 'anna', priorId: 'anna', tier: 'id' },
        kai: { kind: 'new', rawId: 'kai', id: 'kai', minted: false, suggest: [], inheritedDeclines: [] },
      })(onFile) as { matchPlan: { decisions: Record<string, { kind: string; priorId?: string; tier?: string }> } };
      expect(out.matchPlan.decisions.boris).toMatchObject({ kind: 'join', priorId: 'olga', tier: 'merge' });
      expect(out.matchPlan.decisions.anna).toMatchObject({ kind: 'join', priorId: 'anna' });
      expect(out.matchPlan.decisions.kai).toMatchObject({ kind: 'new' });
    });
    it("F3: a dropped run row's new decision goes with it, on file and in the persist's copy", () => {
      const keep = { kind: 'new', rawId: 'kai', id: 'kai', minted: false, suggest: [], inheritedDeclines: [] };
      const boris = { kind: 'new', rawId: 'boris', id: 'boris', minted: false, suggest: [], inheritedDeclines: [] };
      const out = persistDecisionsTransform({ boris, kai: keep } as never, ['boris'])(plan({ boris, kai: keep })) as {
        matchPlan: { decisions: Record<string, unknown> };
      };
      expect(Object.keys(out.matchPlan.decisions)).toEqual(['kai']);
    });
    it('a cache with no plan is left alone', () => {
      const c = { version: ANALYSIS_CACHE_VERSION, chapters: {} } as never;
      expect(persistDecisionsTransform({})(c)).toBe(c);
    });
  });

  describe('resolveCurrentIds', () => {
    const mkDir = (cast: Row[], supersededBy: Record<string, string>): string => {
      const dir = seed([]).bookDir;
      writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters: cast }));
      writeFileSync(join(dir, '.audiobook', 'cast-id-history.json'), JSON.stringify({ schema: 1, supersededBy }));
      return dir;
    };
    const take = (characterId: string) => [{ id: 1, chapterId: 1, characterId, confidence: 0.9, text: 't' }];
    const ids = (...v: string[]): ReadonlySet<string> => new Set(v);
    it('a live id that is also a stale history key stays itself; a prior id merged away follows to its live survivor', async () => {
      const dir = mkDir([{ id: 'a' }, { id: 'b' }], { a: 'b', x: 'b' });
      expect((await resolveCurrentIds(dir, {}, take('a'), ids('a', 'b', 'x')))[0].characterId).toBe('a');
      expect((await resolveCurrentIds(dir, {}, take('x'), ids('a', 'b', 'x')))[0].characterId).toBe('b');
    });
    it('a history target that is no longer live resolves nothing', async () => {
      const dir = mkDir([{ id: 'b' }], { x: 'gone' });
      expect((await resolveCurrentIds(dir, {}, take('x'), ids('b', 'x')))[0].characterId).toBe('x');
    });
    it('R33: a raw id that is a separator variant of a live prior row, planned new, stays itself', async () => {
      const dir = mkDir([{ id: 'the_torment' }], {});
      expect((await resolveCurrentIds(dir, {}, take('the-torment'), ids('the_torment')))[0].characterId).toBe(
        'the-torment',
      );
    });
    it('R33: a prior id that is only a separator variant of a live row is not rewritten (the history-tier gate)', async () => {
      const dir = mkDir([{ id: 'p_x' }], {});
      expect((await resolveCurrentIds(dir, {}, take('p-x'), ids('p-x')))[0].characterId).toBe('p-x');
    });
    it('a prior id the plan made new is not rewritten; no decision, or a join of itself, still follows the merge', async () => {
      const dir = mkDir([{ id: 'y' }], { x: 'y' });
      const asNew = { x: { kind: 'new', rawId: 'x', id: 'x-n1' } };
      const asJoin = { x: { kind: 'join', rawId: 'x', priorId: 'x' } };
      expect((await resolveCurrentIds(dir, {}, take('x'), ids('x'), asNew))[0].characterId).toBe('x');
      expect((await resolveCurrentIds(dir, {}, take('x'), ids('x'), asJoin))[0].characterId).toBe('y');
      expect((await resolveCurrentIds(dir, {}, take('x'), ids('x'), {}))[0].characterId).toBe('y');
      expect((await resolveCurrentIds(dir, {}, take('x'), ids('x'), undefined))[0].characterId).toBe('y');
    });
    it('a decision the merge re-targeted to the survivor (join -> y) still follows; a join to another prior does not', async () => {
      const dir = mkDir([{ id: 'y' }, { id: 'z' }], { x: 'y' });
      const retargeted = { x: { kind: 'join', rawId: 'x', priorId: 'y' } };
      const other = { x: { kind: 'join', rawId: 'x', priorId: 'z' } };
      expect((await resolveCurrentIds(dir, {}, take('x'), ids('x'), retargeted))[0].characterId).toBe('y');
      expect((await resolveCurrentIds(dir, {}, take('x'), ids('x'), other))[0].characterId).toBe('x');
    });
    it('a merge into a run-added row (re-targeted to new -> y) follows; a plan-new minted elsewhere does not', async () => {
      const dir = mkDir([{ id: 'y' }], { x: 'y' });
      const retargeted = { x: { kind: 'new', rawId: 'x', id: 'y' } };
      const minted = { x: { kind: 'new', rawId: 'x', id: 'x-n1' } };
      expect((await resolveCurrentIds(dir, {}, take('x'), ids('x'), retargeted))[0].characterId).toBe('y');
      expect((await resolveCurrentIds(dir, {}, take('x'), ids('x'), minted))[0].characterId).toBe('x');
    });
    it('R33: a raw analyzer-chain key that is not a prior id stays itself', async () => {
      const dir = mkDir([{ id: 'b' }], { raw: 'b' });
      expect((await resolveCurrentIds(dir, {}, take('raw'), ids('b')))[0].characterId).toBe('raw');
    });
    describe('R34: ids the run added', () => {
      const own = { x: { kind: 'new', rawId: 'x', id: 'x' } };
      it('an added id with no history stays itself', async () => {
        const dir = mkDir([{ id: 'y' }, { id: 'x' }], {});
        expect((await resolveCurrentIds(dir, {}, take('x'), ids(), own, ids('x')))[0].characterId).toBe('x');
      });
      it('a non-prior, non-added analyzer-chain key still stays itself with addedIds passed', async () => {
        const dir = mkDir([{ id: 'b' }], { raw: 'b' });
        expect((await resolveCurrentIds(dir, {}, take('raw'), ids(), {}, ids('x')))[0].characterId).toBe('raw');
      });
      it('an added id with its own new decision and a history entry to a live target is rewritten, prior id or not', async () => {
        const dir = mkDir([{ id: 'y' }], { x: 'y' });
        expect((await resolveCurrentIds(dir, {}, take('x'), ids(), own, ids('x')))[0].characterId).toBe('y');
        expect((await resolveCurrentIds(dir, {}, take('x'), ids('x'), own, ids('x')))[0].characterId).toBe('y');
        /* without the added set it is left alone */
        expect((await resolveCurrentIds(dir, {}, take('x'), ids(), own))[0].characterId).toBe('x');
      });
      it("R49: the run's own fold bucket never follows a user merge of an old bucket", async () => {
        const dir = mkDir([{ id: 'lord-vane' }], { 'unknown-male': 'lord-vane' });
        const bucket = { 'unknown-male': { kind: 'new', rawId: 'unknown-male', id: 'unknown-male' } };
        expect(
          (await resolveCurrentIds(dir, {}, take('unknown-male'), ids(), bucket, ids('unknown-male')))[0].characterId,
        ).toBe('unknown-male');
      });
    });
  });
});

/* ---- Plan 291 Task 20 - the main job persists through persistPlannedCast ---- */

describe('#4031 main job: the planned persist (Task 20)', () => {
  const orig = process.env.STAGE2_COVERAGE_RETRIES;
  const books: HarnessBook[] = [];
  const seed = (...a: Parameters<typeof mkBook>): HarnessBook => {
    const b = mkBook(...a);
    books.push(b);
    return b;
  };
  const OLGA: Row = { id: 'olga', name: 'Olga', role: 'minor', color: '#444444', voiceState: 'generated' };
  const LEAD_WREN: Row = { ...PRIOR_WREN, role: 'lead', color: '#111111' };
  const PRIORS = (): Row[] => [{ ...NARR }, { ...LEAD_WREN }, { ...OLGA }];
  const BORIS = {
    id: 'boris',
    name: 'Boris Vane',
    role: 'minor',
    color: '#555555',
    gender: 'male',
    evidence: [{ quote: 'Wren asked' }],
  } as unknown as CharacterOutput;
  const ids = (rows: Row[]): string[] => rows.map((r) => String(r.id));
  const errCode = (events: Array<{ kind: string; code?: unknown }>): unknown =>
    events.find((e) => e.kind === 'error')?.code;
  /* Two prior Wrens a dismissal keeps apart: the fresh "Wren Ashby" is a new row with a
     suggestion to each (the run's own suggestion pairs). */
  const twoWrens = (): HarnessBook => {
    const b = seed([
      { ...NARR },
      { ...LEAD_WREN },
      { id: 'w2b', name: 'Wren', role: 'minor', color: '#333333', voiceState: 'generated' },
    ]);
    writeFileSync(
      join(b.bookDir, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({
        schema: 1,
        supersededBy: {},
        notSamePerson: [{ a: PRIOR_ID, b: 'w2b', at: '2026-11-01T00:00:00.000Z' }],
      }),
    );
    return b;
  };
  type History = { supersededBy: Record<string, string>; supersededByKind?: Record<string, string> };
  beforeEach(() => {
    process.env.STAGE2_COVERAGE_RETRIES = '0';
  });
  afterEach(async () => {
    resetHarness();
    castIoSpy.afterPersist = undefined;
    if (orig === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
    else process.env.STAGE2_COVERAGE_RETRIES = orig;
    for (const b of books.splice(0)) await cleanupBook(b);
  });

  it("the result event's characters equal the persisted cast", async () => {
    /* olga is a prior row the fresh run never mentions: carried forward on disk (rule 1),
       so a result built from the fresh roster would omit it. */
    const b = seed(PRIORS());
    const events = await run(b.manuscriptId, b.bookDir, 'main', { roster: [NARR, WREN_FRESH], speakerId: PRIOR_ID });
    const result = events.find((e) => e.kind === 'result')!;
    expect(result).toBeDefined();
    expect(result.response!.characters).toEqual(readCast(b.bookDir));
    expect(ids(result.response!.characters)).toContain('olga');
  });

  it('persist records analyzer-tagged retirements after releasing the lock', async () => {
    const b = seed(PRIORS());
    const actual = await vi.importActual<typeof import('../store/cast-id-history.js')>('../store/cast-id-history.js');
    const seen: Array<{ from: string; to: string; kind?: string; castLockHeld: boolean }> = [];
    vi.mocked(historyStore.retireCharacterId).mockImplementation(async (dir, from, to, kind) => {
      let castLockHeld = false;
      try {
        await withKeyLock(castJsonPath(dir), async () => {}, 200);
      } catch (err) {
        if (!(err instanceof LockAcquisitionTimeoutError)) throw err;
        castLockHeld = true;
      }
      seen.push({ from, to, kind, castLockHeld });
      return actual.retireCharacterId(dir, from, to, kind);
    });
    const events = await run(b.manuscriptId, b.bookDir, 'main', { roster: [NARR, WREN_FRESH], speakerId: PRIOR_ID });
    expect(events.some((e) => e.kind === 'result')).toBe(true);
    /* The plan's join (raw "wren-ashby" -> the prior "w2"), recorded once, analyzer-tagged,
       outside the cast lock. The narrator's join records nothing. */
    expect(seen.filter((r) => r.from === FRESH_ID)).toEqual([
      { from: FRESH_ID, to: PRIOR_ID, kind: 'analyzer', castLockHeld: false },
    ]);
    expect(seen.some((r) => r.from === 'narrator')).toBe(false);
    expect(seen.every((r) => !r.castLockHeld)).toBe(true);
    const history = readHistory(b.bookDir) as History;
    expect(history.supersededBy[FRESH_ID]).toBe(PRIOR_ID);
    expect(history.supersededByKind?.[FRESH_ID]).toBe('analyzer');
  });

  it('an analyzer join never replaces a user merge already keyed on the raw id', async () => {
    /* "wren-ashby" was merged into olga by the user; the fresh "Wren Ashby" row still
       carries that id, so the plan follows the merge and the entry is left alone. */
    const b = seed(PRIORS(), { [FRESH_ID]: 'olga' });
    await run(b.manuscriptId, b.bookDir, 'main', { roster: [NARR, WREN_FRESH], speakerId: PRIOR_ID });
    const history = readHistory(b.bookDir) as History;
    expect(history.supersededBy[FRESH_ID]).toBe('olga');
    expect(history.supersededByKind?.[FRESH_ID]).toBeUndefined();
  });

  it('item 13: at a completed persist a new row already on disk keeps its user-owned fields from disk', async () => {
    const b = seed(PRIORS());
    /* After the Phase-0b snapshot wrote boris (a new row), a route-like write changes its
       user-owned fields on disk, under the cast lock. */
    let edited = false;
    setPhase1Hook(async () => {
      if (edited) return;
      edited = true;
      await withCastLock(b.bookDir, async () => {
        const p = castJsonPath(b.bookDir);
        const cast = JSON.parse(readFileSync(p, 'utf8')) as { characters: Row[] };
        for (const c of cast.characters) {
          if (c.id === 'boris') Object.assign(c, { gender: 'female', description: 'set by the user mid-run' });
        }
        writeFileSync(p, JSON.stringify(cast));
      });
    });
    const events = await run(b.manuscriptId, b.bookDir, 'main', {
      roster: [NARR, WREN_FRESH, BORIS],
      speakerId: ['boris', PRIOR_ID],
    });
    expect(edited).toBe(true);
    expect(events.some((e) => e.kind === 'result')).toBe(true);
    const boris = readCast(b.bookDir).find((c) => c.id === 'boris')!;
    expect(boris).toMatchObject({ gender: 'female', description: 'set by the user mid-run' });
    /* ...and the analysis-owned counts are this run's. */
    expect(boris.lines).toBeGreaterThan(0);
  });

  it('F2 (R4): a completed run leaves no run-owned addedRows and no runAddedPairs; the rows it added stay known as added-once', async () => {
    const b = twoWrens();
    const two = { roster: [NARR, WREN_FRESH], speakerId: [FRESH_ID, PRIOR_ID] };
    const first = await run(b.manuscriptId, b.bookDir, 'main', two);
    expect(first.some((e) => e.kind === 'result')).toBe(true);
    expect(ids(readCast(b.bookDir))).toContain(FRESH_ID);
    const cache = readCache(b.manuscriptId)!;
    expect(cache.runAddedPairs).toBeUndefined();
    expect(Object.values(cache.addedRows ?? {}).filter((e) => e.state === 'run-owned')).toEqual([]);
    expect(cache.addedRows?.[FRESH_ID]).toEqual({ state: 'added-once' });
    /* A non-fresh re-run over the completed cache knows the row as the run's own: no -n1. */
    const second = await run(b.manuscriptId, b.bookDir, 'main', two);
    expect(second.some((e) => e.kind === 'result')).toBe(true);
    expect(ids(readCast(b.bookDir)).filter((id) => id.startsWith(FRESH_ID))).toEqual([FRESH_ID]);
    expect(readCache(b.manuscriptId)?.matchPlan?.decisions[FRESH_ID]).toMatchObject({
      kind: 'new',
      id: FRESH_ID,
      minted: false,
    });
  });

  it('item 17: a twin roster whose takes come from edits-derived cache chapters is not demoted', async () => {
    /* Two prior Wrens a dismissal keeps apart, and a cache rebuilt from the book's edits:
       its takes name the twins themselves, and the fresh roster holds one "Wren Ashby"
       (planned new, a suggestion to each twin). */
    const b = twoWrens();
    const take = (chapterId: number, characterId: string) => [
      { id: chapterId * 100 + 1, chapterId, characterId, confidence: 0.9, text: 'Are you sure this will work' },
    ];
    await saveAnalysisCache(b.manuscriptId, {
      version: ANALYSIS_CACHE_VERSION,
      chapters: { 1: take(1, PRIOR_ID), 2: take(2, 'w2b'), 3: take(3, PRIOR_ID) },
      takesPersisted: true,
    } as never);
    const events = await run(b.manuscriptId, b.bookDir, 'main', { roster: [NARR, WREN_FRESH], speakerId: FRESH_ID });
    expect(errCode(events)).toBeUndefined();
    expect(events.some((e) => e.kind === 'result')).toBe(true);
    const edits = readEdits(b.bookDir);
    expect(edits.filter((s) => s.characterId === PRIOR_ID).map((s) => s.chapterId)).toEqual([1, 3]);
    expect(edits.filter((s) => s.characterId === 'w2b').map((s) => s.chapterId)).toEqual([2]);
    expect(ids(readCast(b.bookDir))).toEqual(expect.arrayContaining([PRIOR_ID, 'w2b']));
  });

  /* Task 27 (R18): A24 runs through both jobs. */
  describe.each(['main', 'subset'] as const)('A24 (%s)', (kind) => {
  it('A24 (route): a drift-refused run writes no suggestions', async () => {
    /* Two fresh rows the dedup will not merge (a diminutive: a suggestion, not a merge),
       and a Phase 1 that attributes almost every line to an unknown id. */
    const b = seed([{ ...NARR }]);
    const olga = { id: 'olga', name: 'Olga Petrov', aliases: ['Doc'], role: 'minor', color: '#444444', gender: 'female', evidence: [{ quote: 'Olga nodded' }] } as unknown as CharacterOutput;
    const olya = { id: 'olya', name: 'Mira Stone', aliases: ['Doc'], role: 'minor', color: '#555555', gender: 'female', evidence: [{ quote: 'Olga nodded' }] } as unknown as CharacterOutput;
    /* Precondition (non-vacuous): the dedup refuses to merge these two and suggests the pair. */
    expect(dedupAndPrepare([NARR, olga, olya], [], 'en', EMPTY_DEDUP_CONSTRAINTS).suggestions.map((s) => [s.a, s.b])).toEqual([['olga', 'olya']]);
    const ghost: Analyzer = {
      ...phase1('olga'),
      runStage2Chapter: (async (_m: string, chapterId: number) => ({
        sentences: Array.from({ length: 120 }, (_, k) => ({
          id: chapterId * 1000 + k + 1,
          chapterId,
          characterId: k < 6 ? 'olga' : k < 12 ? 'olya' : 'ghost',
          confidence: 0.9,
          text: `Are you sure this will work (${k})`,
        })),
      })) as unknown as Analyzer['runStage2Chapter'],
    };
    const events = await runJob(kind)(b, { roster: [NARR, olga, olya], speakerId: 'olga' }, { phase1: ghost });
    expect(errCode(events)).toBe('attribution_drift');
    expect(readSuggestions(b.bookDir)).toEqual([]);
    /* The refused run still writes the edits (disk consistent). */
    expect(readEdits(b.bookDir).length).toBeGreaterThan(0);
    /* The test bar (carry 8). The snapshot's rows are on disk, but the refused persist never flips
       their counts; the ghost's lines are demoted onto the narrator in the edits. */
    expect(ids(readCast(b.bookDir)).sort()).toEqual(['narrator', 'olga', 'olya', 'wren']);
    expect(linesById(b.bookDir)).toEqual({ narrator: undefined, olga: 0, olya: 0, wren: 0 });
    expect(readEdits(b.bookDir).reduce<Record<string, number>>((a, s) => ({ ...a, [String(s.characterId)]: (a[String(s.characterId)] ?? 0) + 1 }), {})).toEqual({
      olga: 18,
      olya: 18,
      narrator: 324,
    });
    expect(existsSync(join(b.bookDir, '.audiobook', 'cast-id-history.json'))).toBe(false);
  });
  });

  it('A7c (#4023 S3, completed): an unvoiced prior row the fresh run omits survives a completed run (rule 1)', async () => {
    const b = seed([
      { ...NARR },
      { ...LEAD_WREN },
      { id: 'brann', name: 'Brann', role: 'minor', color: '#555555', notLinkedTo: ['w2'] },
    ]);
    const events = await run(b.manuscriptId, b.bookDir, 'main', { roster: [NARR, WREN_FRESH], speakerId: PRIOR_ID });
    expect(events.some((e) => e.kind === 'result')).toBe(true);
    const cast = readCast(b.bookDir);
    expect(cast.find((c) => c.id === 'brann')).toMatchObject({ name: 'Brann', notLinkedTo: ['w2'] });
    expect(cast.find((c) => c.id === PRIOR_ID)).toMatchObject({ name: 'Wren', voiceState: 'locked' });
  });

  it('a failed edits write after cast.json landed still records the retirements and leaks no path to the client', async () => {
    const b = seed(PRIORS());
    const editsPath = join(b.bookDir, '.audiobook', 'manuscript-edits.json');
    castIoSpy.afterPersist = (outcome) =>
      Object.assign(new Error(`EPERM: operation not permitted, rename '${editsPath}'`), {
        code: 'EPERM',
        syscall: 'rename',
        path: editsPath,
        persistOutcome: outcome,
      });
    const events = await run(b.manuscriptId, b.bookDir, 'main', { roster: [NARR, WREN_FRESH], speakerId: PRIOR_ID });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      const text = JSON.stringify(e);
      expect(text).not.toContain(b.bookDir);
      expect(text).not.toContain(b.bookDir.replace(/\\/g, '\\\\'));
    }
    expect(readHistory(b.bookDir).supersededBy[FRESH_ID]).toBe(PRIOR_ID);
  });

  it("rule 13: a plan target deleted mid-run sends its cached takes to the cache's 'narrator' id", async () => {
    /* The book's narrator row is "char-narrator"; the user deletes the joined w2 mid-run. */
    const b = seed([{ ...NARR, id: 'char-narrator' }, { ...LEAD_WREN }, { ...OLGA }]);
    let deleted = false;
    setPhase1Hook(async () => {
      if (deleted) return;
      deleted = true;
      await withCastLock(b.bookDir, async () => {
        const p = castJsonPath(b.bookDir);
        const cast = JSON.parse(readFileSync(p, 'utf8')) as { characters: Row[] };
        writeFileSync(p, JSON.stringify({ characters: cast.characters.filter((c) => c.id !== PRIOR_ID) }));
      });
    });
    const events = await run(b.manuscriptId, b.bookDir, 'main', { roster: [NARR, WREN_FRESH], speakerId: PRIOR_ID });
    expect(events.some((e) => e.kind === 'result')).toBe(true);
    expect(ids(readCast(b.bookDir))).not.toContain(PRIOR_ID);
    const takeIds = new Set(Object.values(readCache(b.manuscriptId)!.chapters).flat().map((s) => s.characterId));
    expect([...takeIds]).toEqual(['narrator']);
  });

  /** A committed text fixture, with CRLF line endings normalised to LF. */
  const readFixtureText = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const END_OF_RUN_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'src',
    'test-fixtures',
    'analysis-end-of-run-cast.json',
  );

  it('record: the end-of-run cast fixture is current', async () => {
    /* The scripted run: a joined prior (Wren), a carried-forward prior (olga), a new row
       (boris) and the narrator. Task 21 reads the fixture. */
    const b = seed(PRIORS());
    const events = await run(b.manuscriptId, b.bookDir, 'main', {
      roster: [NARR, WREN_FRESH, BORIS],
      speakerId: ['boris', PRIOR_ID],
    });
    expect(events.some((e) => e.kind === 'result')).toBe(true);
    const fresh = `${JSON.stringify({ characters: readCast(b.bookDir) }, null, 2)}\n`;
    if (process.env.RECORD_FIXTURES === '1') {
      mkdirSync(dirname(END_OF_RUN_PATH), { recursive: true });
      writeFileSync(END_OF_RUN_PATH, fresh);
    }
    /* Staleness: the committed file must equal a fresh capture (re-record with RECORD_FIXTURES=1),
       compared line-ending-normalised (.gitattributes pins it to LF). */
    expect(existsSync(END_OF_RUN_PATH)).toBe(true);
    expect(readFixtureText(END_OF_RUN_PATH)).toBe(fresh);
    expect(ids(JSON.parse(fresh).characters)).toEqual(expect.arrayContaining(['narrator', PRIOR_ID, 'olga', 'boris']));
  });
});

/** manuscript-edits.json sentence count per characterId (`{}` when the file is absent). */
function editLinesOrEmpty(b: HarnessBook): Record<string, number> {
  if (!existsSync(join(b.bookDir, '.audiobook', 'manuscript-edits.json'))) return {};
  const out: Record<string, number> = {};
  for (const s of readEdits(b.bookDir)) out[String(s.characterId)] = (out[String(s.characterId)] ?? 0) + 1;
  return out;
}

/** A sibling book earlier in b's series, with the given confirmed cast; its dir is pushed onto
    `cleanup` for the caller's afterEach. */
function mkSibling(b: HarnessBook, characters: Row[], cleanup: string[]): string {
  const seriesDir = dirname(b.bookDir);
  const series = basename(seriesDir);
  const dir = join(seriesDir, 'Book One');
  const sibId = makeBookId('Author', series, 'Book One');
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: sibId,
      manuscriptId: `sib-${sibId}`,
      title: 'Book One',
      author: 'Author',
      language: 'en',
      series,
      seriesPosition: 1,
      isStandalone: false,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'manuscript.md'), BODY);
  writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
  cleanup.push(dir);
  return sibId;
}

/* ---- Plan 291 Tasks 22 and 26 - re-analysis identity acceptance through both jobs ---- */

/** A main run whose Phase 1 attributes `perChapter` lines per chapter, handed out in turn to
    `speakers`. Three chapters of 40 clear the drift gate's 100-sentence floor
    (`attributionDriftExceeded`), under which the gate cannot fire at all. Runs the harness's
    Phase-1 hook first, so `setPhase1Hook` / `midRun` still apply. */
async function runLots(
  b: HarnessBook,
  rosterRows: CharacterOutput[],
  speakers: string[],
  perChapter = 40,
  kind: 'main' | 'subset' = 'main',
): Promise<Sent[]> {
  const base = phase1(speakers[0]);
  const lots: Analyzer = {
    ...base,
    runStage2Chapter: (async (m: string, chapterId: number, ...rest: unknown[]) => {
      await (base.runStage2Chapter as unknown as (...a: unknown[]) => Promise<unknown>)(m, chapterId, ...rest);
      return {
        sentences: Array.from({ length: perChapter }, (_, k) => ({
          id: chapterId * 1000 + k + 1,
          chapterId,
          characterId: speakers[k % speakers.length],
          confidence: 0.9,
          text: `Are you sure this will work (${k})`,
        })),
      };
    }) as unknown as Analyzer['runStage2Chapter'],
  };
  return runJob(kind)(b, { roster: rosterRows, speakerId: speakers[0] }, { phase1: lots });
}

describe.each(['main', 'subset'] as const)('#4031 %s job: identity acceptance (Tasks 22, 26)', (kind) => {
  const go = runJob(kind);
  const orig = {
    retries: process.env.STAGE2_COVERAGE_RETRIES,
    lag: process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS,
  };
  const books: HarnessBook[] = [];
  const siblings: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn> | undefined;
  /* No "<Name> asked" tag in the body: the roster-coverage guard would otherwise add a "Wren"
     row of its own, and the narrator-line recovery would hand a joined row lines the Phase-1
     mock never gave it. */
  const NEUTRAL = 'The rain fell on the quiet street.\n\nOlga nodded and looked away.';
  const seed = (characters: Row[], supersededBy?: Record<string, string>): HarnessBook => {
    const b = mkBook(characters, supersededBy, NEUTRAL);
    books.push(b);
    return b;
  };
  beforeEach(() => {
    process.env.STAGE2_COVERAGE_RETRIES = '0';
  });
  afterEach(async () => {
    resetHarness();
    for (const [k, v] of [
      ['STAGE2_COVERAGE_RETRIES', orig.retries],
      ['ANALYZER_PHASE1_MIN_LAG_CHAPTERS', orig.lag],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    logSpy?.mockRestore();
    logSpy = undefined;
    try {
      /* Carry 8 (fix round 1, I3): every test's book ends with the narrator's cast count equal to
         its edits count (0 when the narrator speaks none). */
      for (const b of books) expect(linesById(b.bookDir).narrator ?? 0, `narrator lines (${kind})`).toBe(editLinesOrEmpty(b).narrator ?? 0);
    } finally {
      for (const b of books.splice(0)) await cleanupBook(b);
      for (const d of siblings.splice(0)) rmSync(d, { recursive: true, force: true });
    }
  });

  /** A fresh analyzer row. Its evidence quote is in the body, or the row is dropped. */
  const fr = (id: string, name: string, extra: Record<string, unknown> = {}): CharacterOutput =>
    ({
      id,
      name,
      role: 'lead',
      color: '#123456',
      gender: 'female',
      evidence: [{ quote: 'Olga nodded' }],
      ...extra,
    }) as unknown as CharacterOutput;
  /** A prior cast.json row. */
  const pr = (id: string, name: string, extra: Row = {}): Row => ({ id, name, role: 'lead', color: '#222222', ...extra });
  const ids = (rows: Row[]): string[] => rows.map((r) => String(r.id));
  const errCode = (events: Array<{ kind: string; code?: unknown }>): unknown =>
    events.find((e) => e.kind === 'error')?.code;
  const done = (events: Array<{ kind: string }>): boolean => events.some((e) => e.kind === 'result');
  /** manuscript-edits.json sentence count per characterId. */
  const editLines = (b: HarnessBook): Record<string, number> =>
    readEdits(b.bookDir).reduce<Record<string, number>>((acc, s) => {
      const id = String(s.characterId);
      return { ...acc, [id]: (acc[id] ?? 0) + 1 };
    }, {});
  const history = (b: HarnessBook): { supersededBy: Record<string, string>; supersededByKind?: Record<string, string>; displaced?: Record<string, string> } =>
    existsSync(join(b.bookDir, '.audiobook', 'cast-id-history.json'))
      ? (readHistory(b.bookDir) as never)
      : { supersededBy: {} };
  const writeHistory = (b: HarnessBook, h: Record<string, unknown>): void =>
    writeFileSync(join(b.bookDir, '.audiobook', 'cast-id-history.json'), JSON.stringify({ schema: 1, supersededBy: {}, ...h }));
  const pairs = (b: HarnessBook): Array<[unknown, unknown, unknown]> =>
    readSuggestions(b.bookDir)
      .map((s): [unknown, unknown, unknown] => [s.newRow, s.candidate, s.origin])
      .sort((x, y) => (String(x) < String(y) ? -1 : 1));
  /** Three lines per chapter, handed out in turn: the first speaker gets 5, the second 4. */
  const two = (a: string, b: string): string[] => [a, b];
  /** A sibling book earlier in b's series, with the given confirmed cast. */
  const sibling = (b: HarnessBook, characters: Row[]): string => mkSibling(b, characters, siblings);

  it('A1: #3954 - a single-candidate T3 join keeps the prior id; the voice key does not move', async () => {
    const voice = { qwen: { name: 'wren-voice' } };
    const b = seed([
      /* A stale narrator count (fix round 2, I3): the afterEach check needs this run's recount (0). */
      { ...NARR, lines: 7 },
      pr(PRIOR_ID, 'Wren', { voiceState: 'locked', voiceId: 'wren-voice-id', overrideTtsVoices: voice }),
    ]);
    const events = await go(b, {
      roster: [NARR, fr(FRESH_ID, 'Wren Ashby')],
      speakerId: PRIOR_ID,
    });
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    const cast = readCast(b.bookDir);
    expect(ids(cast).sort()).toEqual(['narrator', PRIOR_ID]);
    expect(cast.find((c) => c.id === PRIOR_ID)).toMatchObject({
      name: 'Wren',
      voiceState: 'locked',
      voiceId: 'wren-voice-id',
      overrideTtsVoices: voice,
      aliases: ['Wren Ashby'],
    });
    expect(linesById(b.bookDir)[PRIOR_ID]).toBe(3);
    expect(editLines(b)).toEqual({ [PRIOR_ID]: 3 });
    expect(history(b).supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
    expect(history(b).supersededByKind).toEqual({ [FRESH_ID]: 'analyzer' });
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  it('R49 (PR #4103 pass 1 O1): a user merge of the fold bucket into a character does not pull later folded lines onto it', async () => {
    const b = mkBook(
      [{ ...NARR }, pr('anna', 'Anna'), pr('lord-vane', 'Lord Vane', { voiceState: 'locked' })],
      { 'unknown-male': 'lord-vane' },
      `${NEUTRAL}\n\nThe Jogger waved.`,
    );
    books.push(b);
    /* "The Jogger" is a descriptor name: the fold puts his lines in the male bucket. */
    const jogger = fr('the-jogger', 'The Jogger', { role: 'minor', gender: 'male', evidence: [{ quote: 'The Jogger waved' }] });
    const events = await go(b, { roster: [NARR, fr('anna', 'Anna'), jogger], speakerId: two('anna', 'the-jogger') });
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    expect(ids(readCast(b.bookDir)).sort()).toEqual(['anna', 'lord-vane', 'narrator', 'unknown-male']);
    expect(editLines(b)).toEqual({ anna: 5, 'unknown-male': 4 });
    expect(linesById(b.bookDir)).toMatchObject({ anna: 5, 'unknown-male': 4, narrator: 0 });
    const vane = readCast(b.bookDir).find((c) => c.id === 'lord-vane')!;
    expect(vane.aliases ?? []).not.toContain('Unknown male');
    expect(vane.lines ?? 0).toBe(0);
    /* The user's merge record is kept: ignored for matching, never displaced. */
    expect(history(b).supersededBy['unknown-male']).toBe('lord-vane');
    expect(history(b).displaced?.['unknown-male']).toBeUndefined();
    expect(readSuggestions(b.bookDir)).toEqual([]);
    /* A second analysis joins the now-live bucket by id: no minted twin, nothing moves. */
    await clearAnalysisCache(b.manuscriptId);
    expect(done(await go(b, { roster: [NARR, fr('anna', 'Anna'), jogger], speakerId: two('anna', 'the-jogger') }))).toBe(true);
    expect(ids(readCast(b.bookDir)).sort()).toEqual(['anna', 'lord-vane', 'narrator', 'unknown-male']);
    expect(editLines(b)).toEqual({ anna: 5, 'unknown-male': 4 });
    expect(history(b).supersededBy['unknown-male']).toBe('lord-vane');
    expect(history(b).displaced?.['unknown-male']).toBeUndefined();
  });

  it('A1 (0-line variant): a joined row that gets no lines stays a joined row: this run\'s 0 counts and the analyzer alias', async () => {
    const voice = { qwen: { name: 'wren-voice' } };
    const b = seed([
      { ...NARR },
      pr(PRIOR_ID, 'Wren', {
        role: 'minor',
        voiceState: 'locked',
        voiceId: 'wren-voice-id',
        overrideTtsVoices: voice,
        lines: 40,
        scenes: 3,
      }),
    ]);
    /* Boris is the control: a new minor row with no lines is dropped by the same fold. */
    const boris = fr('boris', 'Boris Vane', { role: 'minor', gender: 'male' });
    const events = await go(b, {
      roster: [NARR, fr(FRESH_ID, 'Wren Ashby', { role: 'minor' }), boris],
      speakerId: 'narrator',
    });
    expect(events.filter((e) => e.kind === 'error')).toEqual([]);
    expect(done(events)).toBe(true);
    const cast = readCast(b.bookDir);
    expect(ids(cast)).not.toContain('boris');
    expect(ids(cast)).not.toContain('unknown-male');
    expect(ids(cast).filter((i) => i !== 'narrator')).toEqual([PRIOR_ID]);
    /* The row went through the run as a roster row, not as a carried-forward prior: it has
       this run's line count (0, not the stale 40) and gained the analyzer's name. */
    expect(cast.find((c) => c.id === PRIOR_ID)).toMatchObject({
      name: 'Wren',
      voiceState: 'locked',
      voiceId: 'wren-voice-id',
      overrideTtsVoices: voice,
      aliases: ['Wren Ashby'],
      lines: 0,
      scenes: 0,
    });
    expect(editLines(b)[PRIOR_ID]).toBeUndefined();
    expect(history(b).supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  /* The five #4033 twin rosters, each also through the pipelined path (A17b). */
  const TWINS: Array<{ title: string; twins: [string, string]; fresh: [string, string] }> = [
    { title: 'wren-a + wren-9', twins: ['wren-a', 'wren-b'], fresh: ['wren-a', 'wren-9'] },
    { title: 'wren-9 + wren-a', twins: ['wren-a', 'wren-b'], fresh: ['wren-9', 'wren-a'] },
    { title: 'wren-2 + wren-7', twins: ['wren-2', 'wren-7'], fresh: ['wren-2', 'wren-7'] },
    { title: 'wren-a + wren-b', twins: ['wren-a', 'wren-b'], fresh: ['wren-a', 'wren-b'] },
    { title: 'wren + wren-2', twins: ['wren', 'wren-2'], fresh: ['wren', 'wren-2'] },
  ];
  /* A17b is main-only: the subset job builds no Phase-0 watermark, so it has no pipelined path. */
  for (const pipelined of kind === 'main' ? [false, true] : [false]) {
    for (const { title, twins, fresh } of TWINS) {
      it(`A2${pipelined ? '/A17b (pipelined)' : ''}: twin roster ${title} keeps both twins, their declines and their own lines`, async () => {
        if (pipelined) {
          process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS = '0';
          setPipelined(true);
          logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        }
        const [ta, tb] = twins;
        const b = seed([
          { ...NARR },
          pr(ta, 'Wren', { notLinkedTo: [tb] }),
          pr(tb, 'Wren', { notLinkedTo: [ta] }),
        ]);
        const events = await go(b, {
          roster: [NARR, ...fresh.map((id) => fr(id, 'Wren'))],
          speakerId: two(fresh[0], fresh[1]),
        });
        expect(errCode(events)).toBeUndefined();
        expect(done(events)).toBe(true);
        if (logSpy) {
          /* The pipelined path was engaged and held for the plan, not silently the plain one. */
          const line = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).find((l: string) => l.includes('pipelined phase0=')) ?? '';
          expect(line).toContain('held-for-plan');
        }
        const cast = readCast(b.bookDir);
        const planNew = fresh.find((id) => !twins.includes(id));
        /* Neither twin is lost, and a row the plan made new is its own row. */
        expect(ids(cast).sort()).toEqual(['narrator', ta, tb, ...(planNew ? [planNew] : [])].sort());
        /* No row holds a declined link without its decline. */
        expect(cast.find((c) => c.id === ta)!.notLinkedTo).toEqual([tb]);
        expect(cast.find((c) => c.id === tb)!.notLinkedTo).toEqual([ta]);
        if (planNew) {
          const row = cast.find((c) => c.id === planNew)!;
          expect(row).not.toHaveProperty('matchedFrom');
          expect(row.notLinkedTo ?? []).toEqual([]);
        }
        /* Each twin's lines stay on that twin: the first speaker has 5, the second 4. */
        expect(editLines(b)).toEqual({ [fresh[0]]: 5, [fresh[1]]: 4 });
        expect(linesById(b.bookDir)[fresh[0]]).toBe(5);
        expect(linesById(b.bookDir)[fresh[1]]).toBe(4);
        /* The only row the plan made new asks about both twins; a twin join records nothing. */
        expect(pairs(b)).toEqual(planNew ? [[planNew, ta, 'plan'], [planNew, tb, 'plan']] : []);
        expect(history(b).supersededBy).toEqual({});
      });
    }
  }

  it('A3: degraded history - the run completes, every new row gets a minted id, no retirement is written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const b = seed([{ ...NARR }, pr('a1', 'Anna Kay', { voiceId: 'v1' }), pr('a2', 'Anna Lee')]);
      writeFileSync(join(b.bookDir, '.audiobook', 'cast-id-history.json'), '{ not json');
      const minted = (raw: string): string => {
        const d = readCache(b.manuscriptId)?.matchPlan?.decisions[raw];
        return d?.kind === 'new' ? d.id : raw;
      };
      const events = await go(b, {
        /* "Anna Kay" still joins a1 by name; the join would normally be recorded as a retirement. */
        roster: [NARR, fr('fresh-one', 'Nobody Known'), fr('fresh-two', 'Anna'), fr('ak', 'Anna Kay')],
        speakerId: (chapterId) => (chapterId === 2 ? minted('fresh-two') : minted('fresh-one')),
      });
      expect(errCode(events)).toBeUndefined();
      expect(done(events)).toBe(true);
      const token = readCache(b.manuscriptId)!.matchPlan!.runToken;
      expect(readCache(b.manuscriptId)!.matchPlan!.decisions.ak).toMatchObject({ kind: 'join', priorId: 'a1' });
      const cast = readCast(b.bookDir);
      expect(ids(cast).sort()).toEqual(['a1', 'a2', `fresh-one-r${token}`, `fresh-two-r${token}`, 'narrator'].sort());
      expect(editLines(b)).toEqual({ [`fresh-one-r${token}`]: 6, [`fresh-two-r${token}`]: 3 });
      expect(linesById(b.bookDir)[`fresh-one-r${token}`]).toBe(6);
      /* The unreadable file is left exactly as it was: no retirement, no replacement. */
      expect(readFileSync(join(b.bookDir, '.audiobook', 'cast-id-history.json'), 'utf8')).toBe('{ not json');
      expect(cast.find((c) => c.id === 'a1')).toMatchObject({ name: 'Anna Kay', voiceId: 'v1' });
      /* "Anna" is ambiguous between a1 and a2: a question for each, on the minted row. */
      expect(pairs(b)).toEqual([
        [`fresh-two-r${token}`, 'a1', 'plan'],
        [`fresh-two-r${token}`, 'a2', 'plan'],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('A4 (N2): a merged-away id and a same-name row both join the survivor - no new row, nothing displaced', async () => {
    const b = seed([{ ...NARR }, pr('old-weir', 'Old Weir', { voiceState: 'locked', voiceId: 'ow-voice' })]);
    writeHistory(b, { supersededBy: { 'brann-weir': 'old-weir' }, supersededByKind: { 'brann-weir': 'user' } });
    const events = await go(b, {
      roster: [NARR, fr('brann-weir', 'Brann Weir'), fr('ow2', 'Old Weir')],
      speakerId: 'old-weir',
    });
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    const cast = readCast(b.bookDir);
    expect(ids(cast).sort()).toEqual(['narrator', 'old-weir']);
    expect(cast.find((c) => c.id === 'old-weir')).toMatchObject({
      name: 'Old Weir',
      voiceState: 'locked',
      voiceId: 'ow-voice',
      aliases: ['Brann Weir'],
    });
    expect(editLines(b)).toEqual({ 'old-weir': 3 });
    const h = history(b);
    expect(h.supersededBy).toEqual({ 'brann-weir': 'old-weir', ow2: 'old-weir' });
    expect(h.supersededByKind).toEqual({ 'brann-weir': 'user', ow2: 'analyzer' });
    expect(h.displaced ?? {}).toEqual({});
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  it('A5 (P4-2): "John Smith" joins js; "John" is a new row with suggestions to js and jd', async () => {
    const b = seed([{ ...NARR }, pr('js', 'John Smith'), pr('jd', 'John Doe')]);
    const events = await go(b, {
      roster: [NARR, fr('x1', 'John Smith'), fr('x2', 'John')],
      speakerId: two('js', 'x2'),
    });
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    expect(ids(readCast(b.bookDir)).sort()).toEqual(['jd', 'js', 'narrator', 'x2']);
    expect(editLines(b)).toEqual({ js: 5, x2: 4 });
    expect(pairs(b)).toEqual([['x2', 'jd', 'plan'], ['x2', 'js', 'plan']]);
    expect(history(b).supersededBy).toEqual({ x1: 'js' });
  });

  it('A6: a T3 name with one voiced and one unvoiced candidate gives a suggestion, not a join', async () => {
    const b = seed([{ ...NARR }, pr('a1', 'Anna Kay', { voiceId: 'v1' }), pr('a2', 'Anna Lee')]);
    const events = await go(b, {
      roster: [NARR, fr('x', 'Anna')],
      speakerId: 'x',
    });
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    const cast = readCast(b.bookDir);
    expect(ids(cast).sort()).toEqual(['a1', 'a2', 'narrator', 'x']);
    expect(cast.find((c) => c.id === 'a1')).toMatchObject({ name: 'Anna Kay', voiceId: 'v1' });
    expect(cast.find((c) => c.id === 'a1')).not.toHaveProperty('aliases');
    expect(editLines(b)).toEqual({ x: 3 });
    expect(pairs(b)).toEqual([['x', 'a1', 'plan'], ['x', 'a2', 'plan']]);
    expect(history(b).supersededBy).toEqual({});
  });

  describe('A7 (P5-2): series links are never inherited across a collapse', () => {
    const wrenS = { id: 'wren-s', name: 'Wren', gender: 'female', ageRange: 'teen', voiceId: 'wren-s' };
    const annaS = { id: 'anna-s', name: 'Anna', gender: 'female', ageRange: 'teen', voiceId: 'anna-s' };

    it('a joined row keeps its own link and gains none from another row that collapsed into it', async () => {
      const b = seed([{ ...NARR }]);
      const sib = sibling(b, [wrenS, annaS]);
      const link = { bookId: sib, characterId: 'wren-s' };
      const quinnLink = { bookId: sib, characterId: 'anna-s' };
      writeFileSync(
        join(b.bookDir, '.audiobook', 'cast.json'),
        JSON.stringify({
          characters: [
            { ...NARR },
            pr('old-weir', 'Old Weir', { matchedFrom: link, notLinkedTo: ['p-x'] }),
            pr('quinn', 'Quinn'),
          ],
        }),
      );
      writeHistory(b, { supersededBy: { 'brann-weir': 'old-weir' }, supersededByKind: { 'brann-weir': 'user' } });
      /* Every fresh row carries a link of its own, to a character the prior rows never chose. */
      const stray = { matchedFrom: quinnLink, notLinkedTo: [{ bookId: sib, characterId: 'wren-s' }] };
      const events = await go(b, {
        roster: [NARR, fr('brann-weir', 'Brann Weir', stray), fr('ow2', 'Old Weir', stray), fr('quinn', 'Quinn', stray)],
        speakerId: two('old-weir', 'quinn'),
      });
      expect(errCode(events)).toBeUndefined();
      expect(done(events)).toBe(true);
      const cast = readCast(b.bookDir);
      expect(ids(cast).sort()).toEqual(['narrator', 'old-weir', 'quinn']);
      const weir = cast.find((c) => c.id === 'old-weir')!;
      expect(weir.matchedFrom).toEqual(link);
      expect(weir.notLinkedTo).toEqual(['p-x']);
      const quinn = cast.find((c) => c.id === 'quinn')!;
      expect(quinn).not.toHaveProperty('matchedFrom');
      expect(quinn).not.toHaveProperty('notLinkedTo');
      expect(editLines(b)).toEqual({ 'old-weir': 5, quinn: 4 });
      expect(linesById(b.bookDir)['old-weir']).toBe(5);
      expect(linesById(b.bookDir).quinn).toBe(4);
      const h = history(b);
      expect(h.supersededBy).toEqual({ 'brann-weir': 'old-weir', ow2: 'old-weir' });
      expect(h.supersededByKind).toEqual({ 'brann-weir': 'user', ow2: 'analyzer' });
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

    it('a new row with candidates X and Y takes no link either of them declined', async () => {
      const outcome = async (declined: boolean): Promise<Row> => {
        const b = seed([{ ...NARR }]);
        const sib = sibling(b, [annaS]);
        writeFileSync(
          join(b.bookDir, '.audiobook', 'cast.json'),
          JSON.stringify({
            characters: [
              { ...NARR },
              pr('x-kay', 'Anna Kay', declined ? { notLinkedTo: [{ bookId: sib, characterId: 'anna-s' }] } : {}),
              pr('y-lee', 'Anna Lee'),
            ],
          }),
        );
        const events = await go(b, {
          roster: [NARR, fr('anna', 'Anna', { ageRange: 'teen' })],
          speakerId: 'anna',
        });
        expect(errCode(events)).toBeUndefined();
        expect(done(events)).toBe(true);
        expect(pairs(b)).toEqual([['anna', 'x-kay', 'plan'], ['anna', 'y-lee', 'plan']]);
        expect(editLines(b)).toEqual({ anna: 3 });
        expect(linesById(b.bookDir).anna).toBe(3);
        expect(history(b).supersededBy).toEqual({});
        return readCast(b.bookDir).find((c) => c.id === 'anna')!;
      };
      /* Control: with no decline the linker links the new row to the sibling's Anna. */
      expect((await outcome(false)).matchedFrom).toMatchObject({ characterId: 'anna-s' });
      const row = await outcome(true);
      expect(row).not.toHaveProperty('matchedFrom');
      /* ...and the new row inherits the decline itself, so no later link pass offers it either. */
      expect(row.notLinkedTo).toEqual([expect.objectContaining({ characterId: 'anna-s' })]);
    });

    it('A7c (#4023 S2, completed run): a prior row that carries its own link keeps it when it joins', async () => {
      const b = seed([{ ...NARR }]);
      const sib = sibling(b, [wrenS]);
      const link = { bookId: sib, characterId: 'wren-s' };
      writeFileSync(
        join(b.bookDir, '.audiobook', 'cast.json'),
        JSON.stringify({
          characters: [{ ...NARR }, pr(PRIOR_ID, 'Wren', { voiceState: 'locked', matchedFrom: link })],
        }),
      );
      const events = await go(b, {
        roster: [NARR, fr(FRESH_ID, 'Wren Ashby', { ageRange: 'teen' })],
        speakerId: PRIOR_ID,
      });
      expect(errCode(events)).toBeUndefined();
      expect(done(events)).toBe(true);
      const cast = readCast(b.bookDir);
      expect(ids(cast).sort()).toEqual(['narrator', PRIOR_ID]);
      expect(cast.find((c) => c.id === PRIOR_ID)).toMatchObject({ voiceState: 'locked', matchedFrom: link });
      expect(editLines(b)).toEqual({ [PRIOR_ID]: 3 });
      expect(history(b).supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
      expect(history(b).supersededByKind).toEqual({ [FRESH_ID]: 'analyzer' });
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });
  });

  it('A8 (rule 1): an unvoiced prior row and a decline-only prior row the fresh run omits are both still present with their declines', async () => {
    const quiet = pr('quiet', 'Quiet');
    const decl = pr('decl', 'Decl', { notLinkedTo: [{ bookId: 'book-0', characterId: 'z' }, 'anna'] });
    const b = seed([{ ...NARR }, pr('anna', 'Anna', { voiceId: 'v-anna' }), quiet, decl]);
    const events = await go(b, { roster: [NARR, fr('anna', 'Anna')], speakerId: 'anna' });
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    const cast = readCast(b.bookDir);
    expect(ids(cast).sort()).toEqual(['anna', 'decl', 'narrator', 'quiet']);
    expect(cast.find((c) => c.id === 'quiet')).toEqual(quiet);
    expect(cast.find((c) => c.id === 'decl')).toEqual(decl);
    expect(editLines(b)).toEqual({ anna: 3 });
    expect(history(b).supersededBy).toEqual({});
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  it('A9 (rule 2): a by-id join and a name join both keep the prior display name and gain the analyzer name as an alias', async () => {
    const b = seed([
      { ...NARR },
      pr('wren', 'Wren', { aliases: ['Ren'] }),
      pr('brann', 'Brann', { aliases: ['Bran'] }),
    ]);
    const events = await go(b, {
      roster: [NARR, fr('wren', 'Wren Ashby'), fr('b1', 'Brann Weir')],
      speakerId: two('wren', 'brann'),
    });
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    const cast = readCast(b.bookDir);
    expect(ids(cast).sort()).toEqual(['brann', 'narrator', 'wren']);
    expect(cast.find((c) => c.id === 'wren')).toMatchObject({ name: 'Wren', aliases: ['Ren', 'Wren Ashby'] });
    expect(cast.find((c) => c.id === 'brann')).toMatchObject({ name: 'Brann', aliases: ['Bran', 'Brann Weir'] });
    expect(editLines(b)).toEqual({ wren: 5, brann: 4 });
    expect(history(b).supersededBy).toEqual({ b1: 'brann' });
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  it('A10 (rule 3): a fresh row carrying a merged-away id lands on the survivor even when its name matches another row', async () => {
    const b = seed([{ ...NARR }, pr('keep', 'Keeper'), pr('mira', 'Mira')]);
    writeHistory(b, { supersededBy: { gone: 'keep' } });
    const events = await go(b, {
      roster: [NARR, fr('gone', 'Mira')],
      speakerId: 'keep',
    });
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    const cast = readCast(b.bookDir);
    expect(ids(cast).sort()).toEqual(['keep', 'mira', 'narrator']);
    expect(cast.find((c) => c.id === 'keep')).toMatchObject({ name: 'Keeper', aliases: ['Mira'] });
    expect(cast.find((c) => c.id === 'mira')).toEqual(pr('mira', 'Mira'));
    expect(editLines(b)).toEqual({ keep: 3 });
    /* The merge stays a merge: it is not moved to `displaced`, and nothing is added. */
    const h = history(b);
    expect(h.supersededBy).toEqual({ gone: 'keep' });
    expect(h.displaced ?? {}).toEqual({});
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  it('A15: a forced-new row mints an id that is no live, superseded, displaced or raw id, and its sentences carry it', async () => {
    const b = seed([{ ...NARR }, pr('wren', 'Wren Ash'), pr('wren-2', 'Wren')]);
    writeHistory(b, { supersededBy: { 'wren-n1': 'wren-2' }, displaced: { 'wren-n2': 'wren-2' } });
    const events = await go(b, {
      roster: [NARR, fr('wren', 'Wren'), fr('wren-n3', 'Cora Vale')],
      speakerId: two('wren-n4', 'wren-n3'),
    });
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    const cast = readCast(b.bookDir);
    expect(ids(cast).sort()).toEqual(['narrator', 'wren', 'wren-2', 'wren-n3', 'wren-n4']);
    expect(cast.find((c) => c.id === 'wren')).toEqual(pr('wren', 'Wren Ash'));
    expect(cast.find((c) => c.id === 'wren-2')).toEqual(pr('wren-2', 'Wren'));
    expect(editLines(b)).toEqual({ 'wren-n4': 5, 'wren-n3': 4 });
    expect(linesById(b.bookDir)['wren-n4']).toBe(5);
    expect(pairs(b)).toEqual([['wren-n4', 'wren', 'plan'], ['wren-n4', 'wren-2', 'plan']]);
    const h = history(b);
    expect(h.supersededBy).toEqual({ 'wren-n1': 'wren-2' });
    expect(h.displaced).toEqual({ 'wren-n2': 'wren-2' });
  });

  it('A18: a book whose narrator row is char-narrator re-analyses without attribution_drift and prose lands on it', async () => {
    const b = seed([{ ...NARR, id: 'char-narrator' }, pr(PRIOR_ID, 'Wren')]);
    /* 120 lines: under 100 the drift gate cannot fire, so the claim would be vacuous. */
    const events = await runLots(b, [NARR, fr(FRESH_ID, 'Wren Ashby')], ['narrator', PRIOR_ID], 40, kind);
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    const cast = readCast(b.bookDir);
    expect(ids(cast).sort()).toEqual(['char-narrator', PRIOR_ID]);
    expect(editLines(b)).toEqual({ 'char-narrator': 60, [PRIOR_ID]: 60 });
    expect(linesById(b.bookDir)['char-narrator']).toBe(60);
    expect(history(b).supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  /* M8 (item 17): the drift gate's valid ids are the roster plus the ids live on disk, read
     lock-free just before the gate - not a run-start read. */
  it('item 17: a take naming a row added on disk mid-run is kept; a take naming a dead id goes to the narrator', async () => {
    const app = mkApp();
    const b = seed([{ ...NARR }, pr(PRIOR_ID, 'Wren')]);
    const zed = pr('zed', 'Zed');
    let put: number | undefined;
    setPhase1Hook(async () => {
      if (put !== undefined) return;
      put = 0;
      put = (await putCast(app, b.bookId, [...readCast(b.bookDir), zed])).status;
    });
    const events = await go(b, { roster: [NARR, fr(FRESH_ID, 'Wren Ashby')], speakerId: ['zed', 'ghost', PRIOR_ID] });
    setPhase1Hook(undefined);
    expect(put).toBe(200);
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    const cast = readCast(b.bookDir);
    expect(ids(cast).sort()).toEqual(['narrator', PRIOR_ID, 'zed']);
    expect(editLines(b)).toEqual({ zed: 3, narrator: 3, [PRIOR_ID]: 3 });
    /* zed's own cast.json `lines` is not asserted: a row the user added mid-run is carried
       forward from disk uncounted (reported as a Task 26 finding). */
    expect(linesById(b.bookDir)).toMatchObject({ narrator: 3, [PRIOR_ID]: 3 });
    expect(history(b).supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  describe('A21 (rule 12): history provenance', () => {
    it('an untagged and a user entry are T1: the merged-away ids land on the survivor, not on the name match', async () => {
      const b = seed([{ ...NARR }, pr('survivor', 'Old Name'), pr('other', 'Zed')]);
      writeHistory(b, { supersededBy: { u1: 'survivor', u2: 'survivor' }, supersededByKind: { u2: 'user' } });
      const events = await go(b, {
        roster: [NARR, fr('u1', 'Zed'), fr('u2', 'Zed')],
        speakerId: 'survivor',
      });
      expect(errCode(events)).toBeUndefined();
      expect(done(events)).toBe(true);
      const cast = readCast(b.bookDir);
      expect(ids(cast).sort()).toEqual(['narrator', 'other', 'survivor']);
      expect(cast.find((c) => c.id === 'survivor')).toMatchObject({ name: 'Old Name', aliases: ['Zed'] });
      expect(cast.find((c) => c.id === 'other')).toEqual(pr('other', 'Zed'));
      expect(editLines(b)).toEqual({ survivor: 3 });
      /* Both ids are already supersededBy keys: left exactly as written, nothing re-tagged. */
      expect(history(b).supersededBy).toEqual({ u1: 'survivor', u2: 'survivor' });
      expect(history(b).supersededByKind).toEqual({ u2: 'user' });
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

    it('an analyzer entry is not T1: a later ambiguous name gives a suggestion, not a join', async () => {
      const b = seed([{ ...NARR }, pr('survivor', 'Old Name'), pr('z1', 'Zed Kay'), pr('z2', 'Zed Lee')]);
      writeHistory(b, { supersededBy: { 'ana-x': 'survivor' }, supersededByKind: { 'ana-x': 'analyzer' } });
      const events = await go(b, {
        roster: [NARR, fr('ana-x', 'Zed')],
        speakerId: 'ana-x-n1',
      });
      expect(errCode(events)).toBeUndefined();
      expect(done(events)).toBe(true);
      const cast = readCast(b.bookDir);
      expect(ids(cast).sort()).toEqual(['ana-x-n1', 'narrator', 'survivor', 'z1', 'z2']);
      expect(cast.find((c) => c.id === 'survivor')).toEqual(pr('survivor', 'Old Name'));
      expect(editLines(b)).toEqual({ 'ana-x-n1': 3 });
      expect(pairs(b)).toEqual([['ana-x-n1', 'z1', 'plan'], ['ana-x-n1', 'z2', 'plan']]);
      expect(history(b).supersededBy).toEqual({ 'ana-x': 'survivor' });
    });
  });
});

/* ---- Plan 291 Task 23 - mid-run user writes survive a re-analysis (main job) ---- */

/* Task 27: through both jobs (R18). A16 is main-only: see its exemption in the run-start block. */
describe.each(['main', 'subset'] as const)('#4031 %s job: mid-run acceptance (Tasks 23, 27)', (kind) => {
  const go = runJob(kind);
  const orig = process.env.STAGE2_COVERAGE_RETRIES;
  const books: HarnessBook[] = [];
  /* No "<Name> asked" tag in the body (see the Task 22 block); `BODY` is used by the tests that
     measure attribution health, which need a spoken span. */
  const NEUTRAL = 'The rain fell on the quiet street.\n\nOlga nodded and looked away.';
  const seed = (characters: Row[], supersededBy?: Record<string, string>, body: string = NEUTRAL): HarnessBook => {
    const b = mkBook(characters, supersededBy, body);
    books.push(b);
    return b;
  };
  const app = mkApp();
  beforeEach(() => {
    process.env.STAGE2_COVERAGE_RETRIES = '0';
  });
  afterEach(async () => {
    resetHarness();
    rollSpy.isPlanned = undefined;
    rollSpy.after = undefined;
    if (orig === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
    else process.env.STAGE2_COVERAGE_RETRIES = orig;
    try {
      /* Carry 8 (fix round 1, I3): every test's book ends with the narrator's cast count equal to
         its edits count (0 when the narrator speaks none). The narrator-deleted carry opts out:
         its end state (no narrator row) is pinned in the test itself. */
      if (!narratorRowDeleted) {
        for (const b of books) expect(linesById(b.bookDir).narrator ?? 0, `narrator lines (${kind})`).toBe(editLinesOrEmpty(b).narrator ?? 0);
      }
    } finally {
      narratorRowDeleted = false;
      for (const b of books.splice(0)) await cleanupBook(b);
      for (const d of siblings.splice(0)) rmSync(d, { recursive: true, force: true });
    }
  });
  let narratorRowDeleted = false;
  const siblings: string[] = [];

  const fr = (id: string, name: string, extra: Record<string, unknown> = {}): CharacterOutput =>
    ({
      id,
      name,
      role: 'lead',
      color: '#123456',
      gender: 'female',
      evidence: [{ quote: 'Olga nodded' }],
      ...extra,
    }) as unknown as CharacterOutput;
  const pr = (id: string, name: string, extra: Row = {}): Row => ({ id, name, role: 'lead', color: '#222222', ...extra });
  const ids = (rows: Row[]): string[] => rows.map((r) => String(r.id));
  const errCode = (events: Array<{ kind: string; code?: unknown }>): unknown =>
    events.find((e) => e.kind === 'error')?.code;
  const done = (events: Array<{ kind: string }>): boolean => events.some((e) => e.kind === 'result');
  const editLines = (b: HarnessBook): Record<string, number> =>
    readEdits(b.bookDir).reduce<Record<string, number>>((acc, s) => {
      const id = String(s.characterId);
      return { ...acc, [id]: (acc[id] ?? 0) + 1 };
    }, {});
  type History = {
    supersededBy: Record<string, string>;
    supersededByKind?: Record<string, string>;
    notSamePerson?: Array<{ a: string; b: string; at: string }>;
  };
  const history = (b: HarnessBook): History =>
    existsSync(join(b.bookDir, '.audiobook', 'cast-id-history.json'))
      ? (readHistory(b.bookDir) as never)
      : { supersededBy: {} };
  const dismissals = (b: HarnessBook): Array<[string, string]> =>
    (history(b).notSamePerson ?? []).map((r): [string, string] => [r.a, r.b]).sort();
  const writeHistory = (b: HarnessBook, h: Record<string, unknown>): void =>
    writeFileSync(join(b.bookDir, '.audiobook', 'cast-id-history.json'), JSON.stringify({ schema: 1, supersededBy: {}, ...h }));
  const pairs = (b: HarnessBook): Array<[unknown, unknown, unknown]> =>
    readSuggestions(b.bookDir)
      .map((s): [unknown, unknown, unknown] => [s.newRow, s.candidate, s.origin])
      .sort((x, y) => (String(x) < String(y) ? -1 : 1));
  const two = (a: string, b: string): string[] => [a, b];
  const edgeTo = (b: HarnessBook, characterId: string) => ({ bookId: b.bookId, characterId });
  const row = (b: HarnessBook, id: string): Row | undefined => readCast(b.bookDir).find((c) => c.id === id);

  /** Runs `fn` once, the first time the run reaches `phase`; every chapter's call waits for
      it, so no take is cached and no roll lands before the user's write has. */
  const midRun = (phase: 'phase0' | 'phase1', fn: () => Promise<unknown>): { result: () => Promise<unknown> } => {
    let p: Promise<unknown> | undefined;
    const hook = async (): Promise<void> => {
      p ??= fn();
      await p;
    };
    if (phase === 'phase0') setPhase0Hook(hook);
    else setPhase1Hook(hook);
    return { result: async () => p };
  };
  const mergeRoute = (b: HarnessBook, sourceId: string, targetId: string) =>
    request(app)
      .post(`/api/books/${b.bookId}/cast/merge`)
      .set('Content-Type', 'application/json')
      .send({ sourceId, targetId });
  const dismissRoute = (b: HarnessBook, sourceId: string, targetId: string) =>
    request(app)
      .post(`/api/books/${b.bookId}/cast/merge-suggestions/dismiss`)
      .set('Content-Type', 'application/json')
      .send({ sourceId, targetId });
  /** What a user delete leaves on disk: the row gone from cast.json, no history entry. */
  const deleteRow = (b: HarnessBook, id: string): Promise<void> =>
    withCastLock(b.bookDir, async () => {
      const p = castJsonPath(b.bookDir);
      const cast = JSON.parse(readFileSync(p, 'utf8')) as { characters: Row[] };
      writeFileSync(p, JSON.stringify({ ...cast, characters: cast.characters.filter((c) => c.id !== id) }));
    });
  /** Start fresh (rule 8): the same run as `run(..., 'main')` with `requestedFresh`. */
  const runStartFresh = async (
    b: HarnessBook,
    fresh: { roster: CharacterOutput[]; speakerId: string | string[] },
  ): Promise<Array<{ kind: string; code?: unknown }>> => {
    const { job, events } = mkJob(b.manuscriptId, b.bookDir, 'main');
    const rec = getManuscript(b.manuscriptId);
    if (!rec) throw new Error('manuscript missing');
    (globalThis as Record<string, unknown>)[PHASE1_GLOBAL] = sel(phase1(fresh.speakerId), 'phase1-model');
    await runMainAnalyzerJob(job, rec as never, sel(phase0(fresh.roster), 'phase0-model'), {
      requestedFresh: true,
      allowStage1Shrink: true,
      requestedModel: undefined,
    } as never);
    return events;
  };

  /** Two prior Wrens a dismissal keeps apart (a fresh "Wren Ashby" is ambiguous between them). */
  const twoWrens = (extra: Row[] = []): HarnessBook => {
    const b = seed([
      { ...NARR },
      pr(PRIOR_ID, 'Wren', { voiceState: 'locked' }),
      pr('w2b', 'Wren', { role: 'minor', voiceState: 'generated' }),
      ...extra,
    ]);
    writeHistory(b, { notSamePerson: [{ a: PRIOR_ID, b: 'w2b', at: '2026-11-01T00:00:00.000Z' }] });
    return b;
  };
  const ASHBY = { roster: [NARR, fr(FRESH_ID, 'Wren Ashby')], speakerId: FRESH_ID };
  /** A real second analysis. A plain re-run over a finished cache only replays it (no analyzer
      call), so the cache goes first, the way a Re-parse or a cache miss leaves the book. */
  const reanalyse = async (
    b: HarnessBook,
    fresh: { roster: CharacterOutput[]; speakerId: string | string[] },
  ): ReturnType<typeof run> => {
    await clearAnalysisCache(b.manuscriptId);
    return go(b, fresh);
  };

  /* ---- A12 / F9: the suggestion lifecycle ---- */

  it('A12 (rule 7): an open suggestion survives a second re-analysis, and a repeat ambiguous name joins the open-question row', async () => {
    const b = seed([{ ...NARR }, pr('a1', 'Anna Lee', { role: 'minor' }), pr('a2', 'Anna Fox', { role: 'minor' })]);
    const castIds = ['a1', 'a2', 'narrator', 'q'];
    const open = [['q', 'a1', 'plan'], ['q', 'a2', 'plan']];
    /* "Anna" is ambiguous between the two Annas: a new row, with a question to each. */
    const first = await go(b, { roster: [NARR, fr('q', 'Anna')], speakerId: 'q' });
    expect(errCode(first)).toBeUndefined();
    expect(done(first)).toBe(true);
    expect(pairs(b)).toEqual(open);
    expect(ids(readCast(b.bookDir)).sort()).toEqual(castIds);
    /* The user gives the new row its full name. */
    await withCastLock(b.bookDir, async () => {
      const p = castJsonPath(b.bookDir);
      const cast = JSON.parse(readFileSync(p, 'utf8')) as { characters: Row[] };
      writeFileSync(p, JSON.stringify({ characters: cast.characters.map((c) => (c.id === 'q' ? { ...c, name: 'Anna Kay' } : c)) }));
    });

    /* A second analysis emits the same row: the open questions are still open. */
    const second = await reanalyse(b, { roster: [NARR, fr('q', 'Anna')], speakerId: 'q' });
    expect(errCode(second)).toBeUndefined();
    expect(done(second)).toBe(true);
    expect(pairs(b)).toEqual(open);
    expect(ids(readCast(b.bookDir)).sort()).toEqual(castIds);
    expect(row(b, 'q')).toMatchObject({ name: 'Anna Kay' });
    expect(editLines(b)).toEqual({ q: 3 });
    expect(linesById(b.bookDir).q).toBe(3);
    expect(history(b).supersededBy).toEqual({});

    /* The same ambiguous name under another raw id: it joins the row that carries the open
       question (all three Annas are candidates), not a second new row. */
    const third = await reanalyse(b, { roster: [NARR, fr('x2', 'Anna')], speakerId: 'q' });
    expect(errCode(third)).toBeUndefined();
    expect(done(third)).toBe(true);
    expect(ids(readCast(b.bookDir)).sort()).toEqual(castIds);
    expect(editLines(b)).toEqual({ q: 3 });
    expect(linesById(b.bookDir).q).toBe(3);
    expect(pairs(b)).toEqual(open);
    expect(history(b).supersededBy).toEqual({ x2: 'q' });
    expect(history(b).supersededByKind).toEqual({ x2: 'analyzer' });
  });

  /* Main-only (one line, R18): Start fresh is a main-job request. */
  if (kind === 'main')
    it("R50 (PR #4103 pass 1 F2): Start fresh carries a stopped run's ledger - its untouched rows are dropped, a user-edited one stays", async () => {
      const b = seed([{ ...NARR }, pr('anna', 'Anna')]);
      const boris = fr('boris', 'Boris Vane', { role: 'minor', gender: 'male' });
      const carl = fr('carl', 'Carl Reyes', { role: 'minor', gender: 'male' });
      /* Leg one stops after its Phase-0b snapshot: boris and carl are on disk with 0 lines, run-owned. */
      setPhase1Hook(abortAtFirstPhase1());
      await go(b, { roster: [NARR, fr('anna', 'Anna'), boris, carl], speakerId: 'anna' });
      setPhase1Hook(undefined);
      expect(ids(readCast(b.bookDir)).sort()).toEqual(['anna', 'boris', 'carl', 'narrator']);
      /* Between the runs the user gives carl a voice. */
      expect((await routeVoice(app, b.bookId, 'carl')).status).toBe(200);
      const events = await runStartFresh(b, { roster: [NARR, fr('anna', 'Anna')], speakerId: 'anna' });
      expect(errCode(events)).toBeUndefined();
      expect(done(events)).toBe(true);
      expect(ids(readCast(b.bookDir)).sort()).toEqual(['anna', 'carl', 'narrator']);
      expect(row(b, 'carl')).toMatchObject({ overrideTtsVoices: { qwen: { name: 'route-voice-carl' } } });
      expect(editLines(b)).toEqual({ anna: 3 });
      expect(linesById(b.bookDir)).toMatchObject({ anna: 3, narrator: 0 });
      expect(history(b).supersededBy).toEqual({});
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

  /* Main-only (one line, R18): Start fresh is a main-job request. */
  if (kind === 'main')
    it('P2-3 (b): a Start fresh that throws after clearing the cache keeps the carried ledger, and the next one still drops the row', async () => {
      const b = seed([{ ...NARR }, pr('anna', 'Anna')]);
      const boris = fr('boris', 'Boris Vane', { role: 'minor', gender: 'male' });
      setPhase1Hook(abortAtFirstPhase1());
      await go(b, { roster: [NARR, fr('anna', 'Anna'), boris], speakerId: 'anna' });
      setPhase1Hook(undefined);
      const entry = readCache(b.manuscriptId)?.addedRows?.boris;
      expect((entry as { state?: string } | undefined)?.state).toBe('run-owned');
      /* A fault after the clear: the un-confirm's state.json write (a lock timeout, say). */
      stateSpy.failNext = new Error('EBUSY: resource busy or locked (simulated state.json fault)');
      try {
        const failed = await runStartFresh(b, { roster: [NARR, fr('anna', 'Anna')], speakerId: 'anna' });
        expect(failed.some((e) => e.kind === 'error')).toBe(true);
      } finally {
        stateSpy.failNext = undefined;
      }
      expect(readCache(b.manuscriptId)?.addedRows?.boris).toEqual(entry);
      /* The retried Start fresh still knows boris as the stopped run's own and drops him. */
      const events = await runStartFresh(b, { roster: [NARR, fr('anna', 'Anna')], speakerId: 'anna' });
      expect(errCode(events)).toBeUndefined();
      expect(done(events)).toBe(true);
      expect(ids(readCast(b.bookDir)).sort()).toEqual(['anna', 'narrator']);
      expect(editLines(b)).toEqual({ anna: 3 });
    });

  /* PR #4103 pass 2 P2-3 (a): the stopped leg runs through either job; Start fresh is the main job's. */
  describe('P2-3 (a): Start fresh after a stopped run folds an untouched one-off the next run hears again', () => {
    const body = `${NEUTRAL}\n\nThe Jogger waved.`;
    /* "The Jogger" is a descriptor name: a clean run folds his lines into the male bucket. */
    const jogger = fr('the-jogger', 'The Jogger', { role: 'minor', gender: 'male', evidence: [{ quote: 'The Jogger waved' }] });
    const FRESH = { roster: [NARR, fr('anna', 'Anna'), jogger], speakerId: two('anna', 'the-jogger') };
    const stoppedRun = async (b: HarnessBook): Promise<void> => {
      setPhase1Hook(abortAtFirstPhase1());
      await go(b, FRESH);
      setPhase1Hook(undefined);
      expect(ids(readCast(b.bookDir))).toContain('the-jogger');
      expect((readCache(b.manuscriptId)?.addedRows?.['the-jogger'] as { state?: string } | undefined)?.state).toBe('run-owned');
    };

    it('an untouched run row lands in the bucket, as on a clean run', async () => {
      const control = seed([{ ...NARR }, pr('anna', 'Anna')], undefined, body);
      expect(done(await run(control.manuscriptId, control.bookDir, 'main', FRESH))).toBe(true);
      expect(ids(readCast(control.bookDir)).sort()).toEqual(['anna', 'narrator', 'unknown-male']);

      const b = seed([{ ...NARR }, pr('anna', 'Anna')], undefined, body);
      await stoppedRun(b);
      const events = await runStartFresh(b, FRESH);
      expect(errCode(events)).toBeUndefined();
      expect(done(events)).toBe(true);
      expect(ids(readCast(b.bookDir)).sort()).toEqual(ids(readCast(control.bookDir)).sort());
      expect(editLines(b)).toEqual(editLines(control));
      expect(editLines(b)).toEqual({ anna: 5, 'unknown-male': 4 });
      expect(linesById(b.bookDir)).toMatchObject({ anna: 5, 'unknown-male': 4, narrator: 0 });
      expect(readCache(b.manuscriptId)?.addedRows?.['the-jogger']).toBeUndefined();
      expect(history(b).supersededBy).toEqual({});
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

    const rename = (b: HarnessBook): Promise<void> =>
      withCastLock(b.bookDir, async () => {
        const p = castJsonPath(b.bookDir);
        const cast = JSON.parse(readFileSync(p, 'utf8')) as { characters: Row[] };
        writeFileSync(p, JSON.stringify({ characters: cast.characters.map((c) => (c.id === 'the-jogger' ? { ...c, name: 'Jim the Jogger' } : c)) }));
      });
    /* Between the runs (the Start fresh snapshot sees it), or during the Start fresh run's
       Phase 1 (after its snapshot: only the fold's own fingerprint check sees it). */
    for (const when of ['between the runs', 'during the Start fresh run'] as const) {
      it(`a run row the user renamed ${when} stays its own, with its lines`, async () => {
        const b = seed([{ ...NARR }, pr('anna', 'Anna')], undefined, body);
        await stoppedRun(b);
        if (when === 'between the runs') await rename(b);
        else midRun('phase1', () => rename(b));
        const events = await runStartFresh(b, FRESH);
        expect(errCode(events)).toBeUndefined();
        expect(done(events)).toBe(true);
        expect(ids(readCast(b.bookDir)).sort()).toEqual(['anna', 'narrator', 'the-jogger']);
        expect(row(b, 'the-jogger')).toMatchObject({ name: 'Jim the Jogger' });
        expect(editLines(b)).toEqual({ anna: 5, 'the-jogger': 4 });
        expect(linesById(b.bookDir)).toMatchObject({ anna: 5, 'the-jogger': 4, narrator: 0 });
        expect(readCache(b.manuscriptId)?.addedRows?.['the-jogger']).toEqual({ state: 'added-once' });
        expect(history(b).supersededBy).toEqual({});
      });
    }
  });

  it('A12 (rule 7): a dismissal survives a re-analysis, a Start fresh and a later merge of one of the pair into a third character', async () => {
    const b = twoWrens([pr('olga', 'Olga Marsh', { role: 'minor' })]);
    const first = await go(b, ASHBY);
    expect(done(first)).toBe(true);
    expect(pairs(b)).toEqual([[FRESH_ID, PRIOR_ID, 'plan'], [FRESH_ID, 'w2b', 'plan']]);

    /* The user says "not the same person" for one of the two questions. */
    expect((await dismissRoute(b, FRESH_ID, 'w2b')).status).toBe(200);
    const kept = [[FRESH_ID, PRIOR_ID, 'plan']];
    const dismissed = (): void => {
      expect(dismissals(b)).toEqual([[PRIOR_ID, 'w2b'], ['w2b', FRESH_ID]].sort());
      expect(row(b, FRESH_ID)!.notLinkedTo).toEqual(expect.arrayContaining([edgeTo(b, 'w2b')]));
      expect(row(b, 'w2b')!.notLinkedTo).toEqual(expect.arrayContaining([edgeTo(b, FRESH_ID)]));
      expect(pairs(b)).toEqual(kept);
    };
    dismissed();

    /* A plain re-run replays the cached plan, which still says "new row, ask about both": its
       suggestions are planned again, and only the dismissal keeps the answered pair out. */
    const replay = await go(b, ASHBY, { seedCache: false });
    expect(errCode(replay)).toBeUndefined();
    expect(done(replay)).toBe(true);
    dismissed();

    /* A re-analysis (reconcile included). */
    const second = await reanalyse(b, ASHBY);
    expect(errCode(second)).toBeUndefined();
    expect(done(second)).toBe(true);
    dismissed();
    expect(editLines(b)).toEqual({ [FRESH_ID]: 3 });

    /* Start fresh keeps it. */
    const fresh = await runStartFresh(b, ASHBY);
    expect(fresh.some((e) => e.kind === 'error')).toBe(false);
    expect(done(fresh)).toBe(true);
    dismissed();
    expect(editLines(b)).toEqual({ [FRESH_ID]: 3 });
    expect(linesById(b.bookDir)[FRESH_ID]).toBe(3);

    /* A later merge of w2b into a third character repoints the record onto it. */
    expect((await mergeRoute(b, 'w2b', 'olga')).status).toBe(200);
    expect(ids(readCast(b.bookDir))).not.toContain('w2b');
    expect(dismissals(b)).toEqual([['olga', PRIOR_ID], ['olga', FRESH_ID]].map(([x, y]) => [x, y] as [string, string]).sort());
    expect(row(b, 'olga')!.notLinkedTo).toEqual(expect.arrayContaining([edgeTo(b, FRESH_ID), edgeTo(b, PRIOR_ID)]));
    const fourth = await reanalyse(b, ASHBY);
    expect(errCode(fourth)).toBeUndefined();
    expect(done(fourth)).toBe(true);
    expect(dismissals(b)).toEqual([['olga', PRIOR_ID], ['olga', FRESH_ID]].map(([x, y]) => [x, y] as [string, string]).sort());
    expect(row(b, 'olga')!.notLinkedTo).toEqual(expect.arrayContaining([edgeTo(b, FRESH_ID), edgeTo(b, PRIOR_ID)]));
    /* The pair is not suggested again, and the open question to the other Wren is still open. */
    expect(ids(readCast(b.bookDir)).sort()).toEqual(['narrator', 'olga', PRIOR_ID, FRESH_ID].sort());
    expect(pairs(b)).toEqual(kept);
    expect(editLines(b)).toEqual({ [FRESH_ID]: 3 });
    expect(history(b).supersededBy).toEqual({ w2b: 'olga' });
    expect(history(b).supersededByKind).toEqual({ w2b: 'user' });
  });

  it('F9: dismiss, then merge the pair, then re-analyse - the roster joins the survivor and re-raises nothing', async () => {
    const b = seed([{ ...NARR }, pr(PRIOR_ID, 'Wren Kay'), pr('w2b', 'Wren Lee', { role: 'minor' })]);
    expect((await dismissRoute(b, PRIOR_ID, 'w2b')).status).toBe(200);
    expect(dismissals(b)).toEqual([[PRIOR_ID, 'w2b']]);
    expect((await mergeRoute(b, 'w2b', PRIOR_ID)).status).toBe(200);
    /* The merge dropped the record and both edges. */
    expect(dismissals(b)).toEqual([]);
    expect(row(b, PRIOR_ID)!.notLinkedTo ?? []).toEqual([]);
    expect(history(b).supersededBy).toEqual({ w2b: PRIOR_ID });

    const events = await go(b, {
      /* The merged-away id (rule 3) and a bare "Wren" that used to be ambiguous between the two. */
      roster: [NARR, fr('w2b', 'Wren Lee'), fr('wx', 'Wren')],
      speakerId: PRIOR_ID,
    });
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    const cast = readCast(b.bookDir);
    expect(ids(cast).sort()).toEqual(['narrator', PRIOR_ID]);
    expect(cast.find((c) => c.id === PRIOR_ID)).toMatchObject({ name: 'Wren Kay', aliases: expect.arrayContaining(['Wren Lee']) });
    expect(editLines(b)).toEqual({ [PRIOR_ID]: 3 });
    expect(linesById(b.bookDir)[PRIOR_ID]).toBe(3);
    expect(readSuggestions(b.bookDir)).toEqual([]);
    expect(dismissals(b)).toEqual([]);
    expect(history(b).supersededBy).toEqual({ w2b: PRIOR_ID, wx: PRIOR_ID });
    expect(history(b).supersededByKind).toMatchObject({ wx: 'analyzer' });
  });

  /* ---- A13: a merge and a dismissal made during the run ---- */

  for (const phase of ['phase0', 'phase1'] as const) {
    it(`A13 (${phase}): a merge and a dismissal made during the run survive ${phase === 'phase0' ? 'the Phase-0b snapshot, the rolls and the persist' : 'the rolls and the persist'}`, async () => {
      const b = seed([
        { ...NARR },
        pr(PRIOR_ID, 'Wren'),
        pr('kit', 'Kit', { role: 'minor', voiceState: 'locked', voiceId: 'kit-voice' }),
        pr('rae', 'Rae', { role: 'minor' }),
        pr('olga', 'Olga', { role: 'minor' }),
      ]);
      const m = midRun(phase, async () => [
        (await mergeRoute(b, 'kit', 'rae')).status,
        (await dismissRoute(b, 'olga', 'rae')).status,
      ]);
      const events = await go(b, { ...ASHBY, speakerId: PRIOR_ID });
      expect(await m.result()).toEqual([200, 200]);
      expect(errCode(events)).toBeUndefined();
      expect(done(events)).toBe(true);
      const cast = readCast(b.bookDir);
      expect(ids(cast).sort()).toEqual(['narrator', 'olga', 'rae', PRIOR_ID]);
      expect(cast.find((c) => c.id === 'rae')).toMatchObject({ name: 'Rae', aliases: expect.arrayContaining(['Kit']) });
      expect(row(b, 'olga')!.notLinkedTo).toEqual([edgeTo(b, 'rae')]);
      expect(row(b, 'rae')!.notLinkedTo).toEqual(expect.arrayContaining([edgeTo(b, 'olga')]));
      expect(dismissals(b)).toEqual([['olga', 'rae']]);
      expect(history(b).supersededBy).toEqual({ kit: 'rae', [FRESH_ID]: PRIOR_ID });
      expect(history(b).supersededByKind).toEqual({ kit: 'user', [FRESH_ID]: 'analyzer' });
      expect(editLines(b)).toEqual({ [PRIOR_ID]: 3 });
      expect(linesById(b.bookDir)[PRIOR_ID]).toBe(3);
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });
  }

  /* ---- A19 (rule 11): a row the run added and the fold drops ---- */

  describe('A19 (rule 11): a fold-dropped run-added row', () => {
    const boris = fr('boris', 'Boris Vane', { role: 'minor', gender: 'male' });
    const BORIS_RUN = { roster: [NARR, fr('anna', 'Anna'), boris], speakerId: 'anna' };
    const annaBook = (): HarnessBook => seed([{ ...NARR }, pr('anna', 'Anna')]);

    it('A19: a fold-dropped run-owned row is gone; one the user gave a voice mid-run through a voice route is kept', async () => {
      const b = annaBook();
      const m = midRun('phase1', async () => (await routeVoice(app, b.bookId, 'boris')).status);
      const events = await go(b, BORIS_RUN);
      expect(await m.result()).toBe(200);
      expect(errCode(events)).toBeUndefined();
      expect(done(events)).toBe(true);
      const cast = readCast(b.bookDir);
      expect(ids(cast).sort()).toEqual(['anna', 'boris', 'narrator']);
      expect(row(b, 'boris')).toMatchObject({
        name: 'Boris Vane',
        overrideTtsVoices: { qwen: { name: 'route-voice-boris' } },
        lines: 0,
      });
      expect(editLines(b)).toEqual({ anna: 3 });
      expect(linesById(b.bookDir).anna).toBe(3);
      expect(history(b).supersededBy).toEqual({});
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

    it('A19 negative: a fold-dropped run-added row with no route edit is deleted', async () => {
      const b = annaBook();
      /* The same wait at the same point, with nothing written: only the voice differs. */
      midRun('phase1', async () => undefined);
      const events = await go(b, BORIS_RUN);
      expect(errCode(events)).toBeUndefined();
      expect(done(events)).toBe(true);
      expect(ids(readCast(b.bookDir)).sort()).toEqual(['anna', 'narrator']);
      expect(editLines(b)).toEqual({ anna: 3 });
      expect(linesById(b.bookDir).anna).toBe(3);
      expect(history(b).supersededBy).toEqual({});
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

    /* Subset-only (one line, R18): the first run is a main run; the subset Retry after it is the subject. */
    if (kind === 'subset')
      it('F3 (PR #4103 pass 1): a subset Retry stopped in Phase 0a does not re-add a row the main persist fold-dropped', async () => {
        const b = annaBook();
        expect(done(await run(b.manuscriptId, b.bookDir, 'main', BORIS_RUN))).toBe(true);
        expect(ids(readCast(b.bookDir)).sort()).toEqual(['anna', 'narrator']);
        expect(readCache(b.manuscriptId)!.matchPlan?.decisions.boris).toBeUndefined();
        /* Stopped at chapter 3's Phase-0 call: with two chapters in parallel, an earlier
           chapter's Phase-0a snapshot has run, and the subset never reaches its finalise
           (whose own new rows are the confirmed R42 case, not this one). */
        setPhase0Hook(async (ch) => {
          if (ch !== 3) return;
          getLastJob()?.controller.abort();
          const e = new Error('aborted');
          e.name = 'AbortError';
          throw e;
        });
        await runSubsetRetry(b, BORIS_RUN);
        expect(ids(readCast(b.bookDir)).sort()).toEqual(['anna', 'narrator']);
        expect(editLines(b)).toEqual({ anna: 3 });
        expect(linesById(b.bookDir)).toMatchObject({ anna: 3, narrator: 0 });
        expect(history(b).supersededBy).toEqual({});
        expect(readSuggestions(b.bookDir)).toEqual([]);
      });
  });

  /* ---- Rule 13 and degraded history ---- */

  /** What the attribution health reports for the book's cache, the way `measure-attribution` reads it. */
  const demotedNarrator = async (b: HarnessBook): Promise<number | undefined> =>
    (await resolveAttributionState(b.bookDir)).measurement?.demotedNarrator;
  const cacheTakes = (b: HarnessBook) => Object.values(readCache(b.manuscriptId)!.chapters).flat();

  it('A20 / Review Focus 4: a mid-run merge whose history write failed answered 500; the source stays gone and its lines land on the narrator, with no attribution_drift', async () => {
    /* The main speaker is the row that is merged away, so every spoken line is rerouted. */
    const b = seed([{ ...NARR }, pr(PRIOR_ID, 'Wren', { voiceState: 'locked' }), pr('olga', 'Olga', { role: 'minor' })], undefined, BODY);
    const failed = failNextRetirement();
    const m = midRun('phase1', () => mergeRoute(b, PRIOR_ID, 'olga'));
    const events = await go(b, { roster: [NARR, WREN_FRESH], speakerId: FRESH_ID });
    expect(failed.calls()).toBe(1);
    expect(((await m.result()) as request.Response).status).toBe(500);
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    /* The source stays gone; the merge's other writes landed. */
    const cast = readCast(b.bookDir);
    expect(ids(cast).sort()).toEqual(['narrator', 'olga']);
    expect(history(b).supersededBy).toEqual({});
    /* Its lines: on the narrator in the edits and in the cache, each marked with where it came from. */
    const edits = readEdits(b.bookDir);
    expect(edits).toHaveLength(3);
    for (const s of edits) expect(s).toMatchObject({ characterId: 'narrator', priorCharacterId: PRIOR_ID });
    expect(cacheTakes(b)).toHaveLength(3);
    for (const s of cacheTakes(b)) expect(s).toMatchObject({ characterId: 'narrator', priorCharacterId: PRIOR_ID });
    expect(linesById(b.bookDir).narrator).toBe(3);
    expect(linesById(b.bookDir).olga ?? 0).toBe(0);
    /* ...and they show in attribution review: one demoted spoken span per chapter. */
    expect(await demotedNarrator(b)).toBe(3);
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  it('Review Focus 4: a plain mid-run delete of the main speaker never trips the drift gate; its lines are on the narrator', async () => {
    const b = seed([{ ...NARR }, pr(PRIOR_ID, 'Wren', { voiceState: 'locked' }), pr('olga', 'Olga', { role: 'minor' })], undefined, BODY);
    const m = midRun('phase1', () => deleteRow(b, PRIOR_ID));
    const events = await go(b, { roster: [NARR, WREN_FRESH], speakerId: FRESH_ID });
    await m.result();
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    expect(ids(readCast(b.bookDir)).sort()).toEqual(['narrator', 'olga']);
    const edits = readEdits(b.bookDir);
    expect(edits).toHaveLength(3);
    for (const s of edits) expect(s).toMatchObject({ characterId: 'narrator', priorCharacterId: PRIOR_ID });
    expect(cacheTakes(b)).toHaveLength(3);
    for (const s of cacheTakes(b)) expect(s).toMatchObject({ characterId: 'narrator', priorCharacterId: PRIOR_ID });
    expect(linesById(b.bookDir).narrator).toBe(3);
    expect(await demotedNarrator(b)).toBe(3);
    expect(history(b).supersededBy).toEqual({});
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  /* The two tests above run 3 lines, under the drift gate's 100-sentence floor, so they cannot
     show the gate staying quiet. These run 120 on the deleted or merged-away main speaker. */
  it('Review Focus 4 (drift gate live): a merge-away of the main speaker whose history write failed does not end the run with attribution_drift', async () => {
    const b = seed([{ ...NARR }, pr(PRIOR_ID, 'Wren', { voiceState: 'locked' }), pr('olga', 'Olga', { role: 'minor' })], undefined, BODY);
    failNextRetirement();
    const m = midRun('phase1', () => mergeRoute(b, PRIOR_ID, 'olga'));
    const events = await runLots(b, [NARR, WREN_FRESH], [PRIOR_ID], 40, kind);
    expect(((await m.result()) as request.Response).status).toBe(500);
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    expect(ids(readCast(b.bookDir)).sort()).toEqual(['narrator', 'olga']);
    expect(editLines(b)).toEqual({ narrator: 120 });
    for (const s of readEdits(b.bookDir)) expect(s.priorCharacterId).toBe(PRIOR_ID);
    expect(linesById(b.bookDir).narrator).toBe(120);
    expect(history(b).supersededBy).toEqual({});
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  it('Review Focus 4 (drift gate live): a plain delete of the main speaker does not end the run with attribution_drift', async () => {
    const b = seed([{ ...NARR }, pr(PRIOR_ID, 'Wren', { voiceState: 'locked' }), pr('olga', 'Olga', { role: 'minor' })], undefined, BODY);
    const m = midRun('phase1', () => deleteRow(b, PRIOR_ID));
    const events = await runLots(b, [NARR, WREN_FRESH], [PRIOR_ID], 40, kind);
    await m.result();
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    expect(ids(readCast(b.bookDir)).sort()).toEqual(['narrator', 'olga']);
    expect(editLines(b)).toEqual({ narrator: 120 });
    for (const s of readEdits(b.bookDir)) expect(s.priorCharacterId).toBe(PRIOR_ID);
    expect(linesById(b.bookDir).narrator).toBe(120);
    expect(history(b).supersededBy).toEqual({});
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  it('item 3: a row the run added and the user deleted mid-run stays deleted, reported and rerouted to the narrator', async () => {
    const b = seed([{ ...NARR }, pr('anna', 'Anna')]);
    const m = midRun('phase1', () => deleteRow(b, 'boris'));
    const events = await go(b, {
      roster: [NARR, fr('anna', 'Anna'), fr('boris', 'Boris Vane', { role: 'minor', gender: 'male' })],
      speakerId: two('anna', 'boris'),
    });
    await m.result();
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    expect(ids(readCast(b.bookDir)).sort()).toEqual(['anna', 'narrator']);
    expect(editLines(b)).toEqual({ anna: 5, narrator: 4 });
    const rerouted = readEdits(b.bookDir).filter((s) => s.characterId === 'narrator');
    for (const s of rerouted) expect(s.priorCharacterId).toBe('boris');
    expect(linesById(b.bookDir)).toMatchObject({ anna: 5, narrator: 4 });
    /* A user delete sticks: the row is known as added-once, never re-added. */
    expect(readCache(b.manuscriptId)!.addedRows?.boris).toEqual({ state: 'added-once' });
    expect(history(b).supersededBy).toEqual({});
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  it("carry (Task 8): a narrator row deleted mid-run leaves the run's narrator sentences on 'narrator'", async () => {
    const b = seed([{ ...NARR }, pr(PRIOR_ID, 'Wren')]);
    narratorRowDeleted = true;
    const m = midRun('phase1', () => deleteRow(b, 'narrator'));
    const events = await go(b, {
      roster: [NARR, fr(FRESH_ID, 'Wren Ashby')],
      speakerId: 'narrator',
    });
    await m.result();
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    const edits = readEdits(b.bookDir);
    expect(edits).toHaveLength(3);
    for (const s of edits) expect(s.characterId).toBe('narrator');
    for (const s of cacheTakes(b)) expect(s.characterId).toBe('narrator');
    expect(history(b).supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
    /* The end state TODAY, stated so that it flips visibly when the narrator rule-13 exemption is
       decided (an open design question): the narrator row is gone (rule 13 treats the user's delete
       as a delete), and every narrator line is marked as rerouted from 'narrator' itself. */
    expect(ids(readCast(b.bookDir))).toEqual([PRIOR_ID]);
    for (const s of edits) expect(s.priorCharacterId).toBe('narrator');
    expect(cacheTakes(b)).toHaveLength(3);
    for (const s of cacheTakes(b)) expect(s.priorCharacterId).toBe('narrator');
    expect(editLines(b)).toEqual({ narrator: 3 });
    expect(linesById(b.bookDir)).toEqual({ [PRIOR_ID]: 0 });
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  /* ---- Review Focus 2 and 3 ---- */

  it('Review Focus 2: told-apart twins plus a third fresh Wren give a new row, suggestions to both, and no inherited "not Y"', async () => {
    const b = seed([
      { ...NARR },
      pr('wren-a', 'Wren', { notLinkedTo: ['wren-b'] }),
      pr('wren-b', 'Wren', { notLinkedTo: ['wren-a'] }),
    ]);
    writeHistory(b, { notSamePerson: [{ a: 'wren-a', b: 'wren-b', at: '2026-11-01T00:00:00.000Z' }] });
    const events = await go(b, {
      roster: [NARR, fr('wren-a', 'Wren'), fr('wren-b', 'Wren'), fr('wren-c', 'Wren')],
      speakerId: ['wren-a', 'wren-b', 'wren-c'],
    });
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    const cast = readCast(b.bookDir);
    expect(ids(cast).sort()).toEqual(['narrator', 'wren-a', 'wren-b', 'wren-c']);
    /* The third Wren is its own row and holds neither twin's decline. */
    const third = cast.find((c) => c.id === 'wren-c')!;
    expect(third).not.toHaveProperty('matchedFrom');
    expect(third.notLinkedTo ?? []).toEqual([]);
    /* Each twin still declines the other (the reconcile adds the record-backed edge beside the seeded one). */
    expect(cast.find((c) => c.id === 'wren-a')!.notLinkedTo).toEqual(expect.arrayContaining(['wren-b']));
    expect(cast.find((c) => c.id === 'wren-b')!.notLinkedTo).toEqual(expect.arrayContaining(['wren-a']));
    expect(JSON.stringify(third)).not.toMatch(/wren-[ab]/);
    expect(pairs(b)).toEqual([['wren-c', 'wren-a', 'plan'], ['wren-c', 'wren-b', 'plan']]);
    expect(editLines(b)).toEqual({ 'wren-a': 3, 'wren-b': 3, 'wren-c': 3 });
    expect(history(b).supersededBy).toEqual({});
  });

  it('Review Focus 3: a user merge whose source is this run\'s new row, between Phase 0b and the persist, resolves onto the survivor', async () => {
    const b = seed([{ ...NARR }, pr('olga', 'Olga', { role: 'minor' })]);
    const boris = fr('boris', 'Boris Vane', { role: 'minor', gender: 'male' });
    /* Every roll made after the merge answered, before the persist: what the edits file says then. */
    let merged = false;
    const rolled: string[][] = [];
    rollSpy.isPlanned = () => merged;
    rollSpy.after = (mergedAtCall) => {
      if (mergedAtCall) rolled.push(readEdits(b.bookDir).map((s) => String(s.characterId)));
    };
    const m = midRun('phase1', async () => {
      const res = await mergeRoute(b, 'boris', 'olga');
      merged = true;
      return res;
    });
    const events = await go(b, { roster: [NARR, boris], speakerId: 'boris' });
    /* The new row was already in cast.json (the Phase-0b snapshot) when the user merged it away. */
    expect(((await m.result()) as request.Response).status).toBe(200);
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    const cast = readCast(b.bookDir);
    expect(ids(cast).sort()).toEqual(['narrator', 'olga']);
    expect(cast.find((c) => c.id === 'olga')).toMatchObject({ name: 'Olga', aliases: expect.arrayContaining(['Boris Vane']) });
    expect(editLines(b)).toEqual({ olga: 3 });
    expect(linesById(b.bookDir).olga).toBe(3);
    /* R34: the cache takes and the mid-run rolled edits speak the survivor too, though the merged-away
       row is one this run added. */
    expect(rolled.length).toBeGreaterThan(0);
    for (const ids of rolled) expect(ids).toEqual(expect.not.arrayContaining(['boris']));
    for (const ids of rolled) expect(ids.length).toBeGreaterThan(0);
    for (const ids of rolled) expect(ids).toEqual(expect.arrayContaining(['olga']));
    expect(cacheTakes(b)).toHaveLength(3);
    for (const s of cacheTakes(b)) expect(s.characterId).toBe('olga');
    expect(readCache(b.manuscriptId)!.matchPlan?.decisions.boris).toMatchObject({ kind: 'join', priorId: 'olga' });
    expect(history(b).supersededBy).toEqual({ boris: 'olga' });
    expect(history(b).supersededByKind).toEqual({ boris: 'user' });
    expect(readSuggestions(b.bookDir)).toEqual([]);
    /* The merged-away row is not left in the ledger as a row to delete or re-add. */
    expect(readCache(b.manuscriptId)!.addedRows?.boris).toBeUndefined();
  });

  it('Review Focus 3 (resume): a merge of a row the stopped leg added, made during the resume, reaches the rolls and the cache', async () => {
    const b = seed([{ ...NARR }, pr('olga', 'Olga', { role: 'minor' })]);
    const boris = fr('boris', 'Boris Vane', { role: 'minor', gender: 'male' });
    const BORIS = { roster: [NARR, boris], speakerId: 'boris' };
    /* Leg one: stopped after the Phase-0b snapshot, which left boris in cast.json. */
    setPhase1Hook(abortAtFirstPhase1());
    await go(b, BORIS);
    setPhase1Hook(undefined);
    expect(ids(readCast(b.bookDir))).toContain('boris');
    /* Leg two: the resume reads boris as a prior row; the user merges it away mid-run. */
    let merged = false;
    const rolled: string[][] = [];
    rollSpy.isPlanned = () => merged;
    rollSpy.after = (mergedAtCall) => {
      if (mergedAtCall) rolled.push(readEdits(b.bookDir).map((s) => String(s.characterId)));
    };
    const m = midRun('phase1', async () => {
      const res = await mergeRoute(b, 'boris', 'olga');
      merged = true;
      return res;
    });
    const events = await go(b, BORIS, { seedCache: false });
    expect(((await m.result()) as request.Response).status).toBe(200);
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    expect(rolled.length).toBeGreaterThan(0);
    for (const r of rolled) {
      expect(r).toEqual(expect.arrayContaining(['olga']));
      expect(r).toEqual(expect.not.arrayContaining(['boris']));
    }
    expect(cacheTakes(b)).toHaveLength(3);
    for (const s of cacheTakes(b)) expect(s.characterId).toBe('olga');
    expect(ids(readCast(b.bookDir)).sort()).toEqual(['narrator', 'olga']);
    expect(editLines(b)).toEqual({ olga: 3 });
    expect(linesById(b.bookDir).olga).toBe(3);
    expect(history(b).supersededBy).toEqual({ boris: 'olga' });
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  /* ---- PR #4103 pass 1 O2: a mid-run merge of a row the run added, below the fold's line count ---- */

  describe('O2: a mid-run merge of a below-minLines run-added row is honoured by the dedup and the fold', () => {
    const boris = fr('boris', 'Boris Vane', { role: 'minor', gender: 'male' });
    const borisVane = fr('boris-vane', 'Boris Vane', { role: 'minor', gender: 'male' });
    const olgaBook = (): HarnessBook => seed([{ ...NARR }, pr('anna', 'Anna'), pr('olga', 'Olga', { role: 'minor' })]);
    /** Merge boris into olga once Phase 1 starts (after the Phase-0b snapshot wrote boris). */
    const mergeBorisIntoOlga = (b: HarnessBook) => midRun('phase1', () => mergeRoute(b, 'boris', 'olga'));
    /** After the run: boris is gone for good, the merge is the cache's decision and the user's record. */
    const expectMergeHonoured = (b: HarnessBook): void => {
      expect(readCache(b.manuscriptId)!.matchPlan?.decisions.boris).toMatchObject({ kind: 'join', priorId: 'olga', tier: 'merge' });
      expect(readCache(b.manuscriptId)!.addedRows?.boris).toBeUndefined();
      expect(history(b).supersededBy).toEqual({ boris: 'olga' });
      expect(history(b).supersededByKind).toEqual({ boris: 'user' });
      expect((history(b) as { displaced?: Record<string, string> }).displaced?.boris).toBeUndefined();
      expect(readSuggestions(b.bookDir)).toEqual([]);
    };

    it('O2: the one line lands on the survivor, not in a bucket; a second run does not re-add the row', async () => {
      const b = olgaBook();
      const FRESH = {
        roster: [NARR, fr('anna', 'Anna'), boris],
        speakerId: 'anna',
      };
      const script = phase1Script((ch) => (ch === 1 ? ['anna', 'boris'] : ['anna']));
      const m = mergeBorisIntoOlga(b);
      const events = await go(b, FRESH, { phase1: script });
      expect(((await m.result()) as request.Response).status).toBe(200);
      expect(errCode(events)).toBeUndefined();
      expect(done(events)).toBe(true);
      expect(ids(readCast(b.bookDir)).sort()).toEqual(['anna', 'narrator', 'olga']);
      expect(row(b, 'olga')).toMatchObject({ name: 'Olga', aliases: expect.arrayContaining(['Boris Vane']) });
      expect(editLines(b)).toEqual({ anna: 3, olga: 1 });
      expect(linesById(b.bookDir)).toMatchObject({ anna: 3, olga: 1, narrator: 0 });
      expectMergeHonoured(b);

      setPhase1Hook(undefined);
      /* The cached plan now joins boris to olga, so the Phase-1 prompt names olga: the
         analyzer speaks the plan-applied id, as in A1. */
      const again = await go(b, FRESH, {
        phase1: phase1Script((ch) => (ch === 1 ? ['anna', 'olga'] : ['anna'])),
        seedCache: false,
      });
      expect(errCode(again)).toBeUndefined();
      expect(done(again)).toBe(true);
      expect(ids(readCast(b.bookDir)).sort()).toEqual(['anna', 'narrator', 'olga']);
      expect(editLines(b)).toEqual({ anna: 3, olga: 1 });
      expect(linesById(b.bookDir)).toMatchObject({ anna: 3, olga: 1, narrator: 0 });
      expectMergeHonoured(b);
    });

    it('O2 (same-name sibling): the merged row\'s line goes to the survivor, not to the other "Boris Vane"', async () => {
      const b = olgaBook();
      const FRESH = { roster: [NARR, fr('anna', 'Anna'), boris, borisVane], speakerId: 'anna' };
      const script = phase1Script((ch) => (ch === 1 ? ['anna', 'boris', 'boris-vane'] : ['anna', 'boris-vane']));
      const m = mergeBorisIntoOlga(b);
      const events = await go(b, FRESH, { phase1: script });
      expect(((await m.result()) as request.Response).status).toBe(200);
      expect(errCode(events)).toBeUndefined();
      expect(done(events)).toBe(true);
      expect(ids(readCast(b.bookDir)).sort()).toEqual(['anna', 'boris-vane', 'narrator', 'olga']);
      expect(editLines(b)).toEqual({ anna: 3, olga: 1, 'boris-vane': 3 });
      expect(linesById(b.bookDir)).toMatchObject({ anna: 3, olga: 1, 'boris-vane': 3, narrator: 0 });
      expectMergeHonoured(b);
    });

    /* Main-only (one line, R18): only the main job awaits (its Phase-2 sleep and settings read) between Phase 1 and its dedup. */
    if (kind === 'main')
      it('P3-2 (PR #4103 pass 3): a merge landing in the settings read before the dedup still reaches the survivor, not the sibling', async () => {
        const b = olgaBook();
        const FRESH = { roster: [NARR, fr('anna', 'Anna'), boris, borisVane], speakerId: 'anna' };
        const script = phase1Script((ch) => (ch === 1 ? ['anna', 'boris', 'boris-vane'] : ['anna', 'boris-vane']));
        /* The job's settings read after the Phase-2 sleep: the first one once Phase 2 is under way. */
        let job: { replay: { lastPhase: { phaseId?: number } | null } } | undefined;
        let merged: request.Response | undefined;
        settingsSpy.before = async () => {
          if (merged || job?.replay.lastPhase?.phaseId !== 2) return;
          merged = await mergeRoute(b, 'boris', 'olga');
        };
        let events: Awaited<ReturnType<typeof go>>;
        try {
          events = await go(b, FRESH, { phase1: script, onJob: (j) => (job = j as unknown as typeof job) });
        } finally {
          settingsSpy.before = undefined;
        }
        expect(merged?.status).toBe(200);
        expect(errCode(events)).toBeUndefined();
        expect(done(events)).toBe(true);
        expect(ids(readCast(b.bookDir)).sort()).toEqual(['anna', 'boris-vane', 'narrator', 'olga']);
        expect(editLines(b)).toEqual({ anna: 3, olga: 1, 'boris-vane': 3 });
        expect(linesById(b.bookDir)).toMatchObject({ anna: 3, olga: 1, 'boris-vane': 3, narrator: 0 });
        expectMergeHonoured(b);
      });

    it('P2-2 (PR #4103 pass 2): a merge landing after the first collapse, before the fold, is honoured', async () => {
      const b = olgaBook();
      const FRESH = { roster: [NARR, fr('anna', 'Anna'), boris], speakerId: 'anna' };
      const script = phase1Script((ch) => (ch === 1 ? ['anna', 'boris'] : ['anna']));
      /* The front-matter guard's classifier call sits after the dedup's collapse and before
         the fold in both jobs (boris, 1 line in the first chapter, is its candidate). */
      let merged: request.Response | undefined;
      setNonStoryHook(async () => {
        merged ??= await mergeRoute(b, 'boris', 'olga');
      });
      const events = await go(b, FRESH, { phase1: script });
      expect(merged?.status).toBe(200);
      expect(errCode(events)).toBeUndefined();
      expect(done(events)).toBe(true);
      expect(ids(readCast(b.bookDir)).sort()).toEqual(['anna', 'narrator', 'olga']);
      expect(row(b, 'olga')).toMatchObject({ name: 'Olga', aliases: expect.arrayContaining(['Boris Vane']) });
      expect(editLines(b)).toEqual({ anna: 3, olga: 1 });
      expect(linesById(b.bookDir)).toMatchObject({ anna: 3, olga: 1, narrator: 0 });
      expectMergeHonoured(b);
    });

    /* Subset-only (one line, R14): the main job reaches its plan save with a reused plan only on
       a resume whose Phase 0 is cached, so no analyzer seam runs between its cache load and the save. */
    if (kind === 'subset')
      it("O2 (b): a merge during the subset's Phase 0a is not undone by its plan save, though the run stops before its persist", async () => {
        const b = olgaBook();
        const FRESH = { roster: [NARR, fr('anna', 'Anna'), boris], speakerId: 'anna' };
        const both = phase1Script(() => ['anna', 'boris']);
        expect(done(await run(b.manuscriptId, b.bookDir, 'main', FRESH, { phase1: both }))).toBe(true);
        expect(readCache(b.manuscriptId)!.matchPlan?.decisions.boris).toMatchObject({ kind: 'new', id: 'boris' });
        const m = midRun('phase0', () => mergeRoute(b, 'boris', 'olga'));
        setPhase1Hook(abortAtFirstPhase1());
        await runSubsetRetry(b, FRESH, { phase1: both });
        expect(((await m.result()) as request.Response).status).toBe(200);
        expect(readCache(b.manuscriptId)!.matchPlan?.decisions.boris).toMatchObject({ kind: 'join', priorId: 'olga', tier: 'merge' });
        expect(ids(readCast(b.bookDir))).not.toContain('boris');
        expect(history(b).supersededBy).toEqual({ boris: 'olga' });
      });
  });

  /* ---- PR #4103 pass 2 P2-1: a merge of a fold bucket never poisons the cached plan ---- */

  it('P2-1: after the user merges the fold bucket into a character, re-analyses on the cached plan complete and keep the bucket its own', async () => {
    const b = seed(
      [{ ...NARR }, pr('anna', 'Anna'), pr('lord-vane', 'Lord Vane', { voiceState: 'locked' })],
      undefined,
      `${NEUTRAL}\n\nThe Jogger waved.`,
    );
    /* "The Jogger" is a descriptor name: the fold puts his lines in the male bucket. */
    const jogger = fr('the-jogger', 'The Jogger', { role: 'minor', gender: 'male', evidence: [{ quote: 'The Jogger waved' }] });
    const FRESH = { roster: [NARR, fr('anna', 'Anna'), jogger], speakerId: two('anna', 'the-jogger') };
    expect(done(await run(b.manuscriptId, b.bookDir, 'main', FRESH))).toBe(true);
    expect(editLines(b)).toEqual({ anna: 5, 'unknown-male': 4 });
    expect((await mergeRoute(b, 'unknown-male', 'lord-vane')).status).toBe(200);
    expect(editLines(b)).toEqual({ anna: 5, 'lord-vane': 4 });
    /* The merge itself gave the character the bucket's names; the runs below add none. */
    const mergedAliases = row(b, 'lord-vane')!.aliases;
    expect(mergedAliases).toEqual(['Unknown male', 'The Jogger']);
    /* Two re-analyses on the real cache (no clearing): a subset Retry, or a non-fresh main run. */
    for (const pass of [1, 2]) {
      const events = await go(b, FRESH, { seedCache: false });
      expect(errCode(events), `pass ${pass}`).toBeUndefined();
      expect(done(events), `pass ${pass}`).toBe(true);
      expect(ids(readCast(b.bookDir)).sort()).toEqual(['anna', 'lord-vane', 'narrator', 'unknown-male']);
      expect(editLines(b)).toEqual({ anna: 5, 'unknown-male': 4 });
      expect(linesById(b.bookDir)).toMatchObject({ anna: 5, 'unknown-male': 4, narrator: 0 });
      /* The character gains no line (none in the edits above) and no alias from this run. */
      expect(row(b, 'lord-vane')!.aliases).toEqual(mergedAliases);
      /* The user's record is kept, ignored for matching, never displaced. */
      expect(history(b).supersededBy).toEqual({ 'unknown-male': 'lord-vane' });
      expect(history(b).supersededByKind).toEqual({ 'unknown-male': 'user' });
      expect((history(b) as { displaced?: Record<string, string> }).displaced?.['unknown-male']).toBeUndefined();
      expect(readSuggestions(b.bookDir)).toEqual([]);
    }
  });

  /* ---- PR #4103 pass 3 P3-1: a merge of the live fold bucket WHILE a run is going ---- */

  describe('P3-1: a mid-run merge of the live bucket never sends that run\'s lines, or a later run\'s, to the merge target', () => {
    const body = `${NEUTRAL}\n\nThe Jogger waved.`;
    const jogger = fr('the-jogger', 'The Jogger', { role: 'minor', gender: 'male', evidence: [{ quote: 'The Jogger waved' }] });
    const vaneBook = (): HarnessBook =>
      seed([{ ...NARR }, pr('anna', 'Anna'), pr('lord-vane', 'Lord Vane', { voiceState: 'locked' })], undefined, body);
    /** Lands the merge from the front-matter guard's classifier call: after the dedup's
        collapse, before the second collapse and the fold, in both jobs. */
    const mergeFromClassifier = (b: HarnessBook): { status: () => number | undefined; target: () => Row | undefined } => {
      let merged: request.Response | undefined;
      let target: Row | undefined;
      setNonStoryHook(async () => {
        if (merged) return;
        merged = await mergeRoute(b, 'unknown-male', 'lord-vane');
        target = row(b, 'lord-vane');
      });
      return { status: () => merged?.status, target: () => target };
    };
    /** The merge target as the run leaves it: no alias added, and counts never raised above
        what the merge gave it (a row the roster does not name is carried with its count by
        the main job and recounted from the edits by the subset job). */
    const expectTargetUntouched = (b: HarnessBook, afterMerge: Row, label: string): void => {
      const now = row(b, 'lord-vane')!;
      expect(now.aliases, label).toEqual(afterMerge.aliases);
      expect(Number(now.lines ?? 0), label).toBeLessThanOrEqual(Number(afterMerge.lines ?? 0));
      expect(Number(now.scenes ?? 0), label).toBeLessThanOrEqual(Number(afterMerge.scenes ?? 0));
    };
    const expectUserRecordKept = (b: HarnessBook): void => {
      expect(history(b).supersededBy).toEqual({ 'unknown-male': 'lord-vane' });
      expect(history(b).supersededByKind).toEqual({ 'unknown-male': 'user' });
      expect((history(b) as { displaced?: Record<string, string> }).displaced?.['unknown-male']).toBeUndefined();
      expect(readSuggestions(b.bookDir)).toEqual([]);
    };

    it('the merged run, a further run and a Start fresh all keep the background lines on the bucket', async () => {
      const b = vaneBook();
      /* Boris Vane, one line in the first chapter, is the guard's candidate; he folds too. */
      const borisP = fr('boris', 'Boris Vane', { role: 'minor', gender: 'male' });
      const FRESH = { roster: [NARR, fr('anna', 'Anna'), jogger, borisP], speakerId: 'anna' };
      const script = phase1Script((ch) => (ch === 1 ? ['anna', 'boris', 'the-jogger', 'the-jogger'] : ['anna', 'the-jogger']));
      expect(done(await run(b.manuscriptId, b.bookDir, 'main', FRESH, { phase1: script }))).toBe(true);
      expect(editLines(b)).toEqual({ anna: 3, 'unknown-male': 5 });

      const m = mergeFromClassifier(b);
      const merged = await go(b, FRESH, { seedCache: false, phase1: script });
      setNonStoryHook(undefined);
      expect(m.status()).toBe(200);
      /* The merge itself gave the character the bucket's names and lines (as on `main`). */
      const afterMerge = m.target()!;
      expect(afterMerge.aliases).toEqual(['Unknown male', 'The Jogger', 'Boris Vane']);
      const expectBucketKept = (events: Array<{ kind: string; code?: unknown }>, label: string): void => {
        expect(errCode(events), label).toBeUndefined();
        expect(done(events), label).toBe(true);
        expect(ids(readCast(b.bookDir)).sort(), label).toEqual(['anna', 'lord-vane', 'narrator', 'unknown-male']);
        expect(editLines(b), label).toEqual({ anna: 3, 'unknown-male': 5 });
        expect(linesById(b.bookDir), label).toMatchObject({ anna: 3, 'unknown-male': 5, narrator: 0 });
        expectTargetUntouched(b, afterMerge, label);
        expectUserRecordKept(b);
      };
      expectBucketKept(merged, 'run 2 (merge during the run)');

      expectBucketKept(await go(b, FRESH, { seedCache: false, phase1: script }), 'run 3');

      /* Main-only (one line, R18): Start fresh is a main-job request. */
      if (kind === 'main') {
        const fresh = await runStartFresh(b, { roster: FRESH.roster, speakerId: two('anna', 'the-jogger') });
        expect(errCode(fresh)).toBeUndefined();
        expect(done(fresh)).toBe(true);
        expect(ids(readCast(b.bookDir)).sort()).toEqual(['anna', 'lord-vane', 'narrator', 'unknown-male']);
        expect(editLines(b)).toEqual({ anna: 5, 'unknown-male': 4 });
        expect(linesById(b.bookDir)).toMatchObject({ anna: 5, 'unknown-male': 4, narrator: 0 });
        expectTargetUntouched(b, afterMerge, 'Start fresh');
        expectUserRecordKept(b);
      }
    });

    it('a run that folds nothing into the male bucket leaves the ledger entry the merge deleted deleted', async () => {
      const b = vaneBook();
      /* One line each: Boris folds into the male bucket, Greta into the female one. */
      const borisP = fr('boris', 'Boris Vane', { role: 'minor', gender: 'male' });
      const greta = fr('greta', 'Greta Vane', { role: 'minor' });
      const FRESH = { roster: [NARR, fr('anna', 'Anna'), borisP, greta], speakerId: 'anna' };
      const first = phase1Script((ch) => (ch === 1 ? ['anna', 'boris', 'greta'] : ['anna']));
      expect(done(await run(b.manuscriptId, b.bookDir, 'main', FRESH, { phase1: first }))).toBe(true);
      expect(editLines(b)).toMatchObject({ 'unknown-male': 1, 'unknown-female': 1 });
      expect(entryOf(b, 'unknown-male')).toEqual({ state: 'added-once' });

      /* This run hears Anna and Greta only (Greta, one line in the first chapter, is the guard's
         candidate): Boris has no line and is dropped, so nothing re-adds the male bucket after
         the merge removes it. The cached takes go first (plan and ledger kept, the F2 M6 lever)
         so both jobs attribute afresh rather than replay the first run's bucket line. */
      await mutateAnalysisCache(b.manuscriptId, { transform: (c) => ({ ...c, chapters: {} }) });
      const m = mergeFromClassifier(b);
      const events = await go(b, FRESH, {
        seedCache: false,
        phase1: phase1Script((ch) => (ch === 1 ? ['anna', 'greta'] : ['anna'])),
      });
      setNonStoryHook(undefined);
      expect(m.status()).toBe(200);
      expect(errCode(events)).toBeUndefined();
      expect(done(events)).toBe(true);
      expect(ids(readCast(b.bookDir))).not.toContain('unknown-male');
      expect(editLines(b)['lord-vane']).toBeUndefined();
      expect(entryOf(b, 'unknown-male')).toBeUndefined();
      expectUserRecordKept(b);
    });
  });

  /* ---- F2: a run after a main run deletes nothing by the earlier run's ledger ---- */

  const entryOf = (b: HarnessBook, id: string): unknown => readCache(b.manuscriptId)?.addedRows?.[id];

  it(`F2: a ${kind} run after a completed main run deletes nothing`, async () => {
    const b = seed([{ ...NARR }, pr('anna', 'Anna')]);
    const boris = fr('boris', 'Boris Vane', { role: 'minor', gender: 'male' });
    const BORIS_TOO = { roster: [NARR, fr('anna', 'Anna'), boris], speakerId: two('anna', 'boris') };
    expect(done(await run(b.manuscriptId, b.bookDir, 'main', BORIS_TOO))).toBe(true);
    expect(entryOf(b, 'boris')).toEqual({ state: 'added-once' });
    /* The next run, on the cache the main run left (a subset Retry; the main job's re-run of a
       finished cache replays it). */
    const events = await go(b, BORIS_TOO, { seedCache: false });
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    expect(ids(readCast(b.bookDir)).sort()).toEqual(['anna', 'boris', 'narrator']);
    expect(entryOf(b, 'boris')).toEqual({ state: 'added-once' });
    expect(editLines(b)).toEqual({ anna: 5, boris: 4 });
    expect(linesById(b.bookDir)).toMatchObject({ anna: 5, boris: 4, narrator: 0 });
    /* M6: a further run whose roster still names boris but gives him no line - fold-drop
       pressure. He stays, added-once (his stale count is the ruled stale-count issue). The
       cached takes go first (plan and ledger kept) - a test lever, since no user action empties
       takes in production - so both jobs attribute afresh rather than replay: the silence is
       real. */
    await mutateAnalysisCache(b.manuscriptId, { transform: (c) => ({ ...c, chapters: {} }) });
    const silent = await go(b, { roster: BORIS_TOO.roster, speakerId: 'anna' }, { seedCache: false });
    expect(errCode(silent)).toBeUndefined();
    expect(done(silent)).toBe(true);
    expect(editLines(b)).toEqual({ anna: 3 });
    expect(ids(readCast(b.bookDir)).sort()).toEqual(['anna', 'boris', 'narrator']);
    expect(entryOf(b, 'boris')).toEqual({ state: 'added-once' });
    expect(history(b).supersededBy).toEqual({});
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  /* Subset-only (one line, R18): a main run after a stopped main run is its resume, which
     fold-drops the stopped run's untouched rows by ledger (A14b). */
  if (kind === 'subset')
    it('F2: a subset run after a stopped main run deletes nothing by its ledger and refreshes the fingerprints of the rows it writes', async () => {
      const JOGGER = fr('the-jogger', 'The Jogger', { role: 'minor', gender: 'male', ageRange: 'adult', evidence: [{ quote: 'The Jogger waved' }] });
      const FRESH = { roster: [NARR, fr(FRESH_ID, 'Wren Ashby'), JOGGER], speakerId: PRIOR_ID };
      /* The narrator's stale count (fix round 2, I3) makes the afterEach recount check bite here. */
      const priors = (): Row[] => [{ ...NARR, lines: 7 }, pr(PRIOR_ID, 'Wren', { voiceState: 'locked' }), pr('olga', 'Olga', { role: 'minor' })];
      const body = `${NEUTRAL}\n\nThe Jogger waved.`;
      const straight = seed(priors(), undefined, body);
      expect(done(await run(straight.manuscriptId, straight.bookDir, 'main', FRESH))).toBe(true);
      expect(ids(readCast(straight.bookDir))).not.toContain('the-jogger');

      const b = seed(priors(), undefined, body);
      setPhase1Hook(abortAtFirstPhase1());
      await run(b.manuscriptId, b.bookDir, 'main', FRESH);
      setPhase1Hook(undefined);
      expect((entryOf(b, 'the-jogger') as { state: string }).state).toBe('run-owned');
      /* Between the stop and the subset run, with no user edit of the row:
         - a stale reuse link on it (the stopped run's own last write, as at t:632), which the
           subset's run start prunes;
         - a sibling book whose Jogger the subset's linker stamps onto it;
         - a recorded "not the same person" between it and olga, whose edge the subset's
           reconcile writes onto it. */
      await withCastLock(b.bookDir, async () => {
        const p = castJsonPath(b.bookDir);
        const cast = JSON.parse(readFileSync(p, 'utf8')) as { characters: Row[] };
        for (const c of cast.characters) if (c.id === 'the-jogger') c.matchedFrom = { bookId: 'not-in-this-series', characterId: 'x' };
        writeFileSync(p, JSON.stringify(cast));
      });
      await mutateAnalysisCache(b.manuscriptId, { ledger: { 'the-jogger': { state: 'run-owned', fp: userOwnedFingerprint(row(b, 'the-jogger')!) } } });
      const sib = mkSibling(b, [{ id: 'jog-s', name: 'The Jogger', gender: 'male', ageRange: 'adult', voiceId: 'jog-s' }], siblings);
      writeHistory(b, { supersededBy: history(b).supersededBy, notSamePerson: [{ a: 'olga', b: 'the-jogger', at: '2026-11-01T00:00:00.000Z' }] });
      let atStart: Row | undefined;
      setPhase0Hook(() => {
        atStart ??= row(b, 'the-jogger');
      });
      /* The subset also gives the row an alias (its snapshots). */
      const runner = { ...JOGGER, aliases: ['Runner'] } as unknown as CharacterOutput;
      const events = await runSubsetRetry(b, { roster: [NARR, fr(FRESH_ID, 'Wren Ashby'), runner], speakerId: PRIOR_ID });
      setPhase0Hook(undefined);
      expect(errCode(events)).toBeUndefined();
      expect(done(events)).toBe(true);
      expect(atStart?.matchedFrom).toBeUndefined(); /* the run-start prune */
      /* Deletes nothing: the stopped run's silent row is still there (invariant 6). */
      const written = row(b, 'the-jogger')!;
      expect(written).toBeDefined();
      expect(written.aliases).toEqual(expect.arrayContaining(['Runner']));
      /* The linker's stamp: the sibling's voice, reused. */
      expect(sib).toBeTruthy();
      expect(written).toMatchObject({ voiceId: 'jog-s', voiceState: 'reused' });
      expect(written.notLinkedTo).toEqual(expect.arrayContaining([edgeTo(b, 'olga')]));
      /* ...and still the main run's row, with the fingerprint of the subset's last write of it. */
      expect(entryOf(b, 'the-jogger')).toEqual({ state: 'run-owned', fp: userOwnedFingerprint(written) });
      expect(linesById(b.bookDir)).toMatchObject(editLines(b));
      expect(editLines(b)).toEqual({ [PRIOR_ID]: 3 });
      expect(history(b).supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
      expect(readSuggestions(b.bookDir)).toEqual([]);

      /* The resumed main persist still fold-drops the untouched row: the uninterrupted cast. */
      expect(done(await run(b.manuscriptId, b.bookDir, 'main', FRESH))).toBe(true);
      expect(row(b, 'the-jogger')).toBeUndefined();
      expect(ids(readCast(b.bookDir)).sort()).toEqual(ids(readCast(straight.bookDir)).sort());
      expect(linesById(b.bookDir)).toMatchObject(editLines(b));
      expect(history(b).supersededBy).toEqual(history(straight).supersededBy);
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

  describe('F8 (rule 9): degraded history at persist fails closed', () => {
    const degraded = (): HarnessBook => {
      const b = seed([{ ...NARR }, pr(PRIOR_ID, 'Wren', { voiceState: 'locked' }), pr('olga', 'Olga', { role: 'minor' })], undefined, BODY);
      writeFileSync(join(b.bookDir, '.audiobook', 'cast-id-history.json'), '{ not json');
      return b;
    };
    const unreadable = '{ not json';
    const historyFile = (b: HarnessBook): string => readFileSync(join(b.bookDir, '.audiobook', 'cast-id-history.json'), 'utf8');
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
    });

    it('F8: a plan target merged away mid-run is unresolved, not deleted - the run completes and nothing is rerouted, re-added or written to the history', async () => {
      const b = degraded();
      const m = midRun('phase1', () => mergeRoute(b, PRIOR_ID, 'olga'));
      const events = await go(b, { roster: [NARR, WREN_FRESH], speakerId: FRESH_ID });
      expect(((await m.result()) as request.Response).status).toBe(200);
      expect(errCode(events)).toBeUndefined();
      expect(done(events)).toBe(true);
      /* The target is gone and is not re-added, and no line is sent to the narrator as a delete. */
      expect(ids(readCast(b.bookDir)).sort()).toEqual(['narrator', 'olga']);
      expect(readEdits(b.bookDir).filter((s) => s.characterId === 'narrator')).toEqual([]);
      expect(editLines(b)).toEqual({ [PRIOR_ID]: 3 });
      expect(linesById(b.bookDir).narrator ?? 0).toBe(0);
      /* Logged server-side with the ids (and no path): their lines stay on them. */
      const unresolvedLines = warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes('plan target(s) are gone'));
      expect(unresolvedLines).toHaveLength(1);
      expect(unresolvedLines[0]).toMatch(/: w2$/);
      expect(unresolvedLines[0]).not.toContain(b.bookDir);
      /* The unreadable file is left exactly as it was: no retirement, no replacement. */
      expect(historyFile(b)).toBe(unreadable);
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

    it('M2: a row the run added and the user deleted mid-run is recorded added-once though the history is degraded (rule 13)', async () => {
      const b = degraded();
      const minted = (raw: string): string => {
        const d = readCache(b.manuscriptId)?.matchPlan?.decisions[raw];
        return d?.kind === 'new' ? d.id : raw;
      };
      let gone = '';
      const m = midRun('phase1', async () => {
        gone = minted('boris');
        await deleteRow(b, gone);
      });
      const events = await go(b, {
        roster: [NARR, WREN_FRESH, fr('boris', 'Boris Vane', { role: 'minor', gender: 'male' })],
        speakerId: (chapterId) => (chapterId === 1 ? minted('boris') : PRIOR_ID),
      });
      await m.result();
      expect(errCode(events)).toBeUndefined();
      expect(done(events)).toBe(true);
      expect(gone).toMatch(/^boris-r/);
      /* The delete sticks: the row is gone and known as added-once, never re-added. */
      expect(ids(readCast(b.bookDir))).not.toContain(gone);
      expect(readCache(b.manuscriptId)!.addedRows?.[gone]).toEqual({ state: 'added-once' });
      /* Rule 9: the degraded history cannot tell the delete from a merge, so its lines stay on its
         id (unresolved, not rerouted); the narrator speaks none. */
      expect(editLines(b)).toEqual({ [gone]: 3, [PRIOR_ID]: 6 });
      expect(linesById(b.bookDir)).toEqual({ narrator: 0, [PRIOR_ID]: 6, olga: undefined });
      expect(historyFile(b)).toBe(unreadable);
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

    it('F8 control: a degraded history with no merge or delete logs no unresolved targets', async () => {
      const b = degraded();
      const events = await go(b, { roster: [NARR, WREN_FRESH], speakerId: FRESH_ID });
      expect(errCode(events)).toBeUndefined();
      expect(done(events)).toBe(true);
      expect(ids(readCast(b.bookDir)).sort()).toEqual(['narrator', 'olga', PRIOR_ID]);
      expect(editLines(b)).toEqual({ [PRIOR_ID]: 3 });
      expect(warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes('plan target(s) are gone'))).toEqual([]);
    });

    it("F8 consequence: a mid-run merge's edits remap is undone for the chapters the run rewrites, and it is logged", async () => {
      const b = degraded();
      /* The book was analysed before: its edits file holds the old run's lines on w2. */
      const old = [1, 2, 3].map((chapterId) => ({
        id: chapterId * 100 + 1,
        chapterId,
        characterId: PRIOR_ID,
        confidence: 0.9,
        text: 'Are you sure this will work',
      }));
      writeFileSync(join(b.bookDir, '.audiobook', 'manuscript-edits.json'), JSON.stringify({ sentences: old }));
      /* The user merges w2 into olga mid-run; the merge route remaps the edits file. */
      let editsAfterMerge: string[] = [];
      const m = midRun('phase1', async () => {
        const res = await mergeRoute(b, PRIOR_ID, 'olga');
        editsAfterMerge = readEdits(b.bookDir).map((s) => String(s.characterId));
        return res;
      });
      const events = await go(b, { roster: [NARR, WREN_FRESH], speakerId: FRESH_ID });
      expect(((await m.result()) as request.Response).status).toBe(200);
      expect(errCode(events)).toBeUndefined();
      expect(done(events)).toBe(true);
      /* Control: the merge's remap did land in the edits file. */
      expect(editsAfterMerge).toEqual(['olga', 'olga', 'olga']);
      /* ...and the run's terminal write undoes it: the history cannot say w2 was merged, so
         every line is back on w2, which has no row. Nothing reaches olga. */
      expect(editLines(b)).toEqual({ [PRIOR_ID]: 3 });
      expect(ids(readCast(b.bookDir)).sort()).toEqual(['narrator', 'olga']);
      expect(historyFile(b)).toBe(unreadable);
      expect(readSuggestions(b.bookDir)).toEqual([]);
      /* Logged: every interim roll of the run fails loudly because the history cannot be read, and
         the operator is told the file needs attention. */
      /* The subset job names itself in the same line ("failed to roll subset manuscript-edits.json"). */
      const rollFailures = warn.mock.calls.filter((c: unknown[]) => /failed to roll (subset )?manuscript-edits\.json/.test(String(c[0])));
      expect(rollFailures.length).toBeGreaterThan(0);
      for (const c of rollFailures) expect(String((c[1] as Error).message)).toMatch(/cast-id-history\.json could not be read/);
      /* ...and the persist names the unresolved target, ids only. */
      const unresolvedLines = warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes('plan target(s) are gone'));
      expect(unresolvedLines).toHaveLength(1);
      expect(unresolvedLines[0]).toMatch(/: w2$/);
      expect(unresolvedLines[0]).not.toContain(b.bookDir);
    });
  });
});

describe('#4031 subset job: classification, run start, Phase 0a and finalise (Task 24)', () => {
  const orig = process.env.STAGE2_COVERAGE_RETRIES;
  const books: HarnessBook[] = [];
  const seed = (...a: Parameters<typeof mkBook>): HarnessBook => {
    const b = mkBook(...a);
    books.push(b);
    return b;
  };
  beforeEach(() => {
    process.env.STAGE2_COVERAGE_RETRIES = '0';
  });
  afterEach(async () => {
    resetHarness();
    if (orig === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
    else process.env.STAGE2_COVERAGE_RETRIES = orig;
    for (const b of books.splice(0)) await cleanupBook(b);
  });

  const audiobook = (b: HarnessBook, file: string): string => join(b.bookDir, '.audiobook', file);
  const bytes = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8') : null);
  const JOGGER = {
    id: 'the-jogger',
    name: 'The Jogger',
    role: 'minor',
    color: '#222222',
    gender: 'male',
    evidence: [{ quote: 'The Jogger waved' }],
  } as unknown as CharacterOutput;
  const BORIS = {
    id: 'boris',
    name: 'Boris Vane',
    role: 'minor',
    color: '#555555',
    gender: 'male',
    evidence: [{ quote: 'Wren asked' }],
  } as unknown as CharacterOutput;
  const BODY18 = `${BODY}\n\nThe Jogger waved.`;
  const OLGA: Row = { id: 'olga', name: 'Olga', role: 'minor', color: '#444444', voiceState: 'generated' };
  const LEAD_WREN: Row = { ...PRIOR_WREN, role: 'lead', color: '#111111' };
  const WREN_DUP: Row = { id: 'w2b', name: 'Wren', role: 'minor', color: '#333333', voiceState: 'generated' };
  const FRESH = { roster: [NARR, WREN_FRESH, JOGGER], speakerId: FRESH_ID };
  const PRIORS = (): Row[] => [{ ...NARR }, { ...LEAD_WREN }, { ...OLGA }];
  const ids = (rows: Row[]): string[] => rows.map((r) => String(r.id));
  const errCode = (events: Array<{ kind: string; code?: unknown }>): unknown =>
    events.find((e) => e.kind === 'error')?.code;
  const done = (events: Array<{ kind: string }>): boolean => events.some((e) => e.kind === 'result');
  const history = (b: HarnessBook): { supersededBy: Record<string, string>; supersededByKind?: Record<string, string> } =>
    existsSync(audiobook(b, 'cast-id-history.json')) ? (readHistory(b.bookDir) as never) : { supersededBy: {} };
  const editLines = (b: HarnessBook): Record<string, number> =>
    readEdits(b.bookDir).reduce<Record<string, number>>((acc, s) => {
      const id = String(s.characterId);
      return { ...acc, [id]: (acc[id] ?? 0) + 1 };
    }, {});
  const decisionsOf = (b: HarnessBook): Record<string, unknown> =>
    JSON.parse(JSON.stringify(readCache(b.manuscriptId)?.matchPlan?.decisions ?? {}));

  it('A22 subset: a legacy cache ends analysis_cache_legacy before any write; cast.json and history stay byte-identical', async () => {
    /* A same-name prior pair: a run start that ran would heal it (cast.json and history). */
    const b = seed([{ ...NARR }, { ...PRIOR_WREN, lines: 40 }, { ...WREN_DUP, lines: 2 }]);
    writeFileSync(audiobook(b, 'cast-id-history.json'), JSON.stringify({ schema: 1, supersededBy: { w9: PRIOR_ID } }));
    writeFileSync(
      castMergeSuggestionsJsonPath(b.bookDir),
      JSON.stringify({ suggestions: [{ sourceId: 'w2b', targetId: PRIOR_ID, a: PRIOR_ID, b: 'w2b', reason: 'x', origin: 'dedup' }] }),
    );
    /* No `version`: a cache an older build wrote. */
    await saveAnalysisCache(b.manuscriptId, {
      chapters: { 1: [{ id: 101, chapterId: 1, characterId: FRESH_ID, confidence: 0.9, text: 'LEGACY-SENTINEL' }] },
      stage1: { characters: [NARR, WREN_FRESH], chapters: [{ id: 1, title: 'Chapter One' }] },
    } as never);
    const before = {
      cast: bytes(audiobook(b, 'cast.json')),
      history: bytes(audiobook(b, 'cast-id-history.json')),
      suggestions: bytes(castMergeSuggestionsJsonPath(b.bookDir)),
      edits: bytes(audiobook(b, 'manuscript-edits.json')),
      cache: bytes(cachePath(b.manuscriptId)),
      state: bytes(audiobook(b, 'state.json')),
    };
    let phase0Calls = 0;
    setPhase0Hook(() => {
      phase0Calls += 1;
    });
    const events = await runSubsetRetry(b, FRESH);
    expect(errCode(events)).toBe('analysis_cache_legacy');
    expect(String(events.find((e) => e.kind === 'error')?.message)).toMatch(/older version/);
    expect(done(events)).toBe(false);
    expect(phase0Calls).toBe(0);
    expect(bytes(audiobook(b, 'cast.json'))).toBe(before.cast);
    expect(linesById(b.bookDir)).toEqual({ narrator: undefined, [PRIOR_ID]: 40, w2b: 2 });
    expect(bytes(audiobook(b, 'cast-id-history.json'))).toBe(before.history);
    expect(bytes(castMergeSuggestionsJsonPath(b.bookDir))).toBe(before.suggestions);
    expect(bytes(audiobook(b, 'manuscript-edits.json'))).toBe(before.edits);
    expect(bytes(cachePath(b.manuscriptId))).toBe(before.cache);
    expect(bytes(audiobook(b, 'state.json'))).toBe(before.state);
  });

  it('A11 subset: identical names heal at the subset run start, in cast.json and in the history as a heal', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN, lines: 40 }, { ...WREN_DUP }]);
    let atStart: { cast: Row[]; history: Record<string, unknown> } | undefined;
    setPhase0Hook(() => {
      atStart ??= { cast: readCast(b.bookDir), history: readJson(b.bookDir, 'cast-id-history.json') };
    });
    /* The narrator speaks too, so the narrator-inclusive count check below can fail (M4). */
    const events = await run(b.manuscriptId, b.bookDir, 'subset', { roster: [NARR, WREN_FRESH], speakerId: [PRIOR_ID, 'narrator'] });
    expect(done(events)).toBe(true);
    expect(atStart!.cast.filter((r) => r.name === 'Wren').map((r) => r.id)).toEqual([PRIOR_ID]);
    expect(atStart!.history.supersededBy).toEqual({ w2b: PRIOR_ID });
    expect(atStart!.history.supersededByKind).toEqual({ w2b: 'heal' });
    /* ...and it stays healed through the persist. */
    expect(ids(readCast(b.bookDir)).sort()).toEqual(['narrator', PRIOR_ID]);
    expect(editLines(b)).toEqual({ [PRIOR_ID]: 5, narrator: 4 }); // three lines a chapter, handed out in turn
    expect(linesById(b.bookDir)).toMatchObject(editLines(b)); // cast.json counts match the edits, narrator included (Task 25 carry 5)
    /* The heal, and the persist's record of the plan's join (raw -> prior). */
    expect(history(b).supersededBy).toEqual({ w2b: PRIOR_ID, [FRESH_ID]: PRIOR_ID });
    expect(history(b).supersededByKind).toEqual({ w2b: 'heal', [FRESH_ID]: 'analyzer' });
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  it('subset flow (b) on a v2 cache writes stage1 with no plan', async () => {
    const b = seed(PRIORS(), undefined, BODY18);
    setPhase0Hook((id) => {
      if (id === 3) throw new Error('phase 0 boom');
    });
    expect(errCode(await run(b.manuscriptId, b.bookDir, 'main', FRESH))).toBe('cast_incomplete');
    setPhase0Hook(undefined);
    expect(readCache(b.manuscriptId)?.version).toBe(2);
    const castBefore = bytes(audiobook(b, 'cast.json'));
    const historyBefore = bytes(audiobook(b, 'cast-id-history.json'));
    /* Every Phase-0a snapshot the Retry makes: none may put a raw analyzer id on disk. */
    const seen: string[][] = [];
    setPhase0Hook(() => {
      seen.push(ids(readCast(b.bookDir)));
    });
    const retry = await runSubsetRetry(b, FRESH);
    expect(errCode(retry)).toBe('resume_required');
    const cache = readCache(b.manuscriptId)!;
    expect(cache.version).toBe(2);
    expect(cache.stage1?.characters.map((c) => c.id).sort()).toEqual(['narrator', 'the-jogger', FRESH_ID]);
    expect(cache.matchPlan).toBeUndefined();
    /* No raw-id row on disk: cast.json is what the stopped run left (spec :117-119). */
    for (const s of [...seen, ids(readCast(b.bookDir))]) {
      expect(s).not.toContain(FRESH_ID);
      expect(s).not.toContain('the-jogger');
    }
    expect(bytes(audiobook(b, 'cast.json'))).toBe(castBefore);
    expect(linesById(b.bookDir)).toEqual({ narrator: undefined, [PRIOR_ID]: undefined, olga: undefined });
    expect(bytes(audiobook(b, 'cast-id-history.json'))).toBe(historyBefore);
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  it('Q2: subset flow (a) saves its extension decisions', async () => {
    const b = seed(PRIORS(), undefined, BODY18);
    expect(done(await run(b.manuscriptId, b.bookDir, 'main', FRESH))).toBe(true);
    const kept = readCache(b.manuscriptId)!.matchPlan!;
    expect(Object.keys(kept.decisions)).toEqual(expect.arrayContaining(['narrator', FRESH_ID]));
    /* The Jogger folded into the bucket and his run row was dropped: his decision went with it (F3). */
    expect(kept.decisions['the-jogger']).toBeUndefined();
    expect(kept.decisions.boris).toBeUndefined();
    const historyAfterMain = history(b).supersededBy;
    /* The Retry's roster has a row the cached plan does not cover. */
    let atPhase1: { cast: Row[]; decisions: Record<string, unknown> } | undefined;
    setPhase1Hook(() => {
      atPhase1 ??= { cast: readCast(b.bookDir), decisions: decisionsOf(b) };
    });
    const events = await runSubsetRetry(b, { roster: [NARR, WREN_FRESH, JOGGER, BORIS], speakerId: ['boris', FRESH_ID] });
    expect(done(events)).toBe(true);
    /* Saved before Phase 1: same token, the reused decisions as they were, Boris added. */
    const after = readCache(b.manuscriptId)!.matchPlan!;
    expect(after.runToken).toBe(kept.runToken);
    for (const [k, d] of Object.entries(kept.decisions)) expect(after.decisions[k]).toEqual(d);
    expect(after.decisions.boris).toMatchObject({ kind: 'new', id: 'boris', minted: false });
    expect(atPhase1!.decisions.boris).toMatchObject({ kind: 'new', id: 'boris' });
    expect(ids(atPhase1!.cast)).toContain('boris');
    const cast = ids(readCast(b.bookDir));
    expect(cast.filter((id) => id.startsWith('boris'))).toEqual(['boris']);
    expect(cast).toContain(PRIOR_ID);
    expect(cast).not.toContain(FRESH_ID);
    expect(editLines(b).boris).toBeGreaterThan(0);
    expect(editLines(b)[FRESH_ID]).toBeUndefined();
    expect(linesById(b.bookDir)).toMatchObject(editLines(b)); // cast.json counts match the edits, narrator included (Task 25 carry 5)
    /* The subset run retires nothing beyond what the main run already recorded. */
    expect(history(b).supersededBy).toEqual(historyAfterMain);
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  it('subset: one analyzer row never gets two cast rows', async () => {
    const fresh = { roster: [NARR, WREN_FRESH, BORIS], speakerId: ['boris', FRESH_ID] };
    const b = seed([{ ...NARR }, { ...LEAD_WREN }]);
    expect(done(await run(b.manuscriptId, b.bookDir, 'main', fresh))).toBe(true);
    expect(ids(readCast(b.bookDir))).toContain('boris');
    const plan = decisionsOf(b);
    const linesAfterMain = editLines(b);
    const borisLinesAfterMain = linesById(b.bookDir).boris;
    expect(borisLinesAfterMain).toBeGreaterThan(0);
    const historyAfterMain = history(b).supersededBy;
    expect(historyAfterMain).toEqual({ [FRESH_ID]: PRIOR_ID }); // the main run's analyzer join
    const events = await runSubsetRetry(b, fresh);
    expect(done(events)).toBe(true);
    /* The cached plan is reused as it was: Boris is the row the main run added, not a second one. */
    expect(decisionsOf(b)).toEqual(plan);
    const cast = ids(readCast(b.bookDir));
    expect(cast.filter((id) => id.startsWith('boris'))).toEqual(['boris']);
    expect(cast.filter((id) => id.startsWith('w2') || id === FRESH_ID)).toEqual([PRIOR_ID]);
    expect(editLines(b)).toEqual(linesAfterMain);
    expect(linesById(b.bookDir)).toMatchObject(editLines(b)); // cast.json counts match the edits, narrator included (Task 25 carry 5)
    expect(linesById(b.bookDir).boris).toBe(borisLinesAfterMain);
    expect(history(b).supersededBy).toEqual(historyAfterMain);
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  it('Task 9 carry: a subset Retry after a stop in Phase 1 reuses the surviving stage1 and its plan', async () => {
    const straight = seed(PRIORS(), undefined, BODY18);
    expect(done(await run(straight.manuscriptId, straight.bookDir, 'main', FRESH))).toBe(true);
    const b = seed(PRIORS(), undefined, BODY18);
    setPhase1Hook(abortAtFirstPhase1());
    await run(b.manuscriptId, b.bookDir, 'main', FRESH);
    setPhase1Hook(undefined);
    const stopped = readCache(b.manuscriptId)!;
    expect(stopped.stage1).toBeDefined();
    expect(stopped.matchPlan).toBeDefined();
    const plan = decisionsOf(b);
    const events = await runSubsetRetry(b, FRESH);
    /* stage1 existed: flow (a) attributes the chapters (no resume_required) on the stopped plan. */
    expect(errCode(events)).toBeUndefined();
    expect(done(events)).toBe(true);
    expect(readCache(b.manuscriptId)!.matchPlan!.runToken).toBe(stopped.matchPlan!.runToken);
    /* Every stopped-run decision is reused as it was; the persist adds exactly one, for
       the fold's bucket it planned (Q2: every post-0b decision is saved), as the
       uninterrupted run's persist does. */
    const after = decisionsOf(b);
    for (const [k, d] of Object.entries(plan)) expect(after[k]).toEqual(d);
    expect(Object.keys(after).filter((k) => !Object.hasOwn(plan, k))).toEqual(['unknown-male']);
    expect(after['unknown-male']).toEqual(decisionsOf(straight)['unknown-male']);
    const cast = ids(readCast(b.bookDir));
    expect(cast).toContain(PRIOR_ID);
    expect(cast).not.toContain(FRESH_ID);
    expect(JSON.stringify(cast)).not.toContain('-n1');
    /* Carry 5: the narrator's lines are counted too (the old persist wrote 0). */
    expect(editLines(b)).toEqual(editLines(straight));
    expect(editLines(b)[PRIOR_ID]).toBe(3); // one line in each of three chapters
    expect(linesById(b.bookDir)).toMatchObject(editLines(b)); // cast.json counts match the edits, narrator included
    /* The rows the uninterrupted run persisted, with the same counts. */
    expect(cast).toEqual(expect.arrayContaining(['narrator', 'unknown-male', PRIOR_ID, 'olga']));
    expect(ids(readCast(straight.bookDir)).sort()).toEqual(['narrator', 'olga', 'unknown-male', PRIOR_ID]);
    /* The stopped main run's own row the fold took is NOT deleted by the subset (it never
       deletes by `addedRows`, invariant 6): it stays, carried forward, still that run's
       `run-owned` row with the fingerprint of what is on disk. */
    const jogger = readCast(b.bookDir).find((c) => c.id === 'the-jogger')!;
    expect(jogger).toBeDefined();
    expect(readCache(b.manuscriptId)!.addedRows?.['the-jogger']).toEqual({ state: 'run-owned', fp: userOwnedFingerprint(jogger) });
    /* M7: the history equals the uninterrupted run's exactly - the plan's join only; the
       fold's bucket retires nothing. */
    expect(history(straight).supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
    expect(history(b).supersededBy).toEqual(history(straight).supersededBy);
    expect(readSuggestions(b.bookDir)).toEqual([]);
    /* ...and the next main run's persist ends that run's ledger: the untouched row is
       fold-dropped, leaving the uninterrupted run's cast. */
    expect(done(await run(b.manuscriptId, b.bookDir, 'main', FRESH))).toBe(true);
    expect(ids(readCast(b.bookDir)).sort()).toEqual(ids(readCast(straight.bookDir)).sort());
    expect(history(b).supersededBy).toEqual(history(straight).supersededBy);
  });

  /* ---- Fix round 1 ---- */

  const ONE_ROW = { roster: [NARR, WREN_FRESH, BORIS], speakerId: ['boris', FRESH_ID] };
  const countsOf = (b: HarnessBook, id: string): { lines: unknown; scenes: unknown } => {
    const r = readCast(b.bookDir).find((c) => c.id === id);
    return { lines: r?.lines, scenes: r?.scenes };
  };

  it("I1: a subset Retry that stops in Phase 1 leaves a completed run's row with its line and scene counts", async () => {
    const b = seed([{ ...NARR }, { ...LEAD_WREN }]);
    expect(done(await run(b.manuscriptId, b.bookDir, 'main', ONE_ROW))).toBe(true);
    const before = countsOf(b, 'boris');
    expect(before.lines).toBeGreaterThan(0);
    const historyBefore = history(b).supersededBy;
    setPhase1Hook(abortAtFirstPhase1());
    const events = await runSubsetRetry(b, ONE_ROW);
    expect(done(events)).toBe(false);
    /* The finalise snapshot wrote no placeholder over the row the main run persisted. */
    expect(countsOf(b, 'boris')).toEqual(before);
    expect(ids(readCast(b.bookDir)).filter((id) => id.startsWith('boris'))).toEqual(['boris']);
    expect(history(b).supersededBy).toEqual(historyBefore);
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  it("I1 (drift-refused): a subset persist that refuses to flip cast.json leaves a completed run's row with its counts", async () => {
    const b = seed([{ ...NARR }, { ...LEAD_WREN }]);
    expect(done(await run(b.manuscriptId, b.bookDir, 'main', ONE_ROW))).toBe(true);
    const before = countsOf(b, 'boris');
    expect(before.lines).toBeGreaterThan(0);
    /* A Phase 1 whose speaker is unknown for almost every sentence: attribution drift. */
    const ghost: Analyzer = {
      ...phase1(FRESH_ID),
      runStage2Chapter: (async (_m: string, chapterId: number) => ({
        sentences: Array.from({ length: 120 }, (_, k) => ({
          id: chapterId * 1000 + k + 1,
          chapterId,
          characterId: k < 10 ? 'boris' : 'ghost',
          confidence: 0.9,
          text: `Are you sure this will work (${k})`,
        })),
      })) as unknown as Analyzer['runStage2Chapter'],
    };
    const rec = getManuscript(b.manuscriptId)!;
    const { job, events } = mkJob(b.manuscriptId, b.bookDir, 'subset');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runSubsetAnalyzerJob(job, rec as never, sel(phase0(ONE_ROW.roster), 'phase0-model'), sel(ghost, 'phase1-model'), rec.chapterHints, true);
    } finally {
      warn.mockRestore();
    }
    expect(events.some((e) => e.kind === 'log' && String(e.message).includes('Attribution drift exceeded'))).toBe(true);
    expect(countsOf(b, 'boris')).toEqual(before);
  });

  it('M8a: a cache-patch fault after a landed Phase-0a snapshot does not record the chapter as a cast failure', async () => {
    const b = seed([{ ...NARR }, { ...LEAD_WREN }]);
    /* Task 25 fix round 1 (M5) — a ledger patch now carries only what changed, so the
       Phase-0a snapshot must change an entry: a STOPPED main run's run-owned boris, given
       an alias the snapshot writes (its fingerprint is refreshed). The run start refreshes
       nothing (the row is untouched), so the first ledger patch is the Phase-0a
       snapshot's. (Was: a completed main run, whose added-once entries the snapshot
       re-sent unchanged.) */
    setPhase1Hook(abortAtFirstPhase1());
    await run(b.manuscriptId, b.bookDir, 'main', ONE_ROW);
    setPhase1Hook(undefined);
    expect((readCache(b.manuscriptId)?.addedRows?.boris as { state: string }).state).toBe('run-owned');
    const withAlias = { roster: [NARR, WREN_FRESH, { ...BORIS, aliases: ['Bo'] } as unknown as CharacterOutput], speakerId: ['boris', FRESH_ID] };
    let faulted = 0;
    cacheSpy.beforePatch = async (p) => {
      if (faulted === 0 && 'ledger' in (p as Record<string, unknown>)) {
        faulted += 1;
        throw Object.assign(new Error('EPERM: cache write'), { code: 'EPERM' });
      }
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let events: Sent[];
    let warned: string[];
    try {
      events = await runSubsetRetry(b, withAlias);
    } finally {
      warned = warn.mock.calls.map((c) => String(c[0]));
      cacheSpy.beforePatch = undefined;
      warn.mockRestore();
    }
    expect(faulted).toBe(1);
    expect(errCode(events)).toBeUndefined();
    expect(warned.filter((m) => m.includes('cache patch failed'))).toEqual([
      expect.stringContaining('subset Phase-0a cache patch failed'),
    ]);
    expect(events.some((e) => e.kind === 'chapter-failed')).toBe(false);
    expect(done(events)).toBe(true);
    expect(readCache(b.manuscriptId)?.failedChapterIds ?? []).toEqual([]);
    expect(ids(readCast(b.bookDir)).filter((id) => id.startsWith('boris'))).toEqual(['boris']);
    expect(linesById(b.bookDir)).toMatchObject(editLines(b));
  });

  it('N1: a reused new row that never reached disk is added by the subset finalise with counts', async () => {
    const b = seed([{ ...NARR }, { ...LEAD_WREN }]);
    /* The main run's Phase-0b snapshot fails (swallowed, #2292) and the run stops in
       Phase 1: the plan decides `boris`, but no boris row is on disk. */
    castIoSpy.failSnapshot = () => new Error('EPERM: snapshot');
    setPhase1Hook(abortAtFirstPhase1());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await run(b.manuscriptId, b.bookDir, 'main', ONE_ROW);
    } finally {
      castIoSpy.failSnapshot = undefined;
      warn.mockRestore();
    }
    expect(readCache(b.manuscriptId)?.matchPlan?.decisions.boris).toMatchObject({ kind: 'new', id: 'boris' });
    expect(ids(readCast(b.bookDir))).not.toContain('boris');
    /* A Retry reuses that decision (not a placeholder id), stops in Phase 1: its
       finalise snapshot is boris's first write. */
    setPhase1Hook(abortAtFirstPhase1());
    expect(done(await runSubsetRetry(b, ONE_ROW))).toBe(false);
    expect(ids(readCast(b.bookDir)).filter((id) => id.startsWith('boris'))).toEqual(['boris']);
    expect(countsOf(b, 'boris')).toEqual({ lines: 0, scenes: 0 });
    expect(history(b).supersededBy).toEqual({});
    expect(readSuggestions(b.bookDir)).toEqual([]);
  });

  it('N2: a Phase-0a re-mint whose cache patch faulted reaches the cache before an early exit', async () => {
    const b = seed([{ ...NARR }, { ...LEAD_WREN }]);
    expect(done(await run(b.manuscriptId, b.bookDir, 'main', ONE_ROW))).toBe(true);
    /* `boris` is live but in no ledger (as a row a previous subset run added): the
       Phase-0a snapshot re-mints the plan's `new` boris. */
    const cached = readCache(b.manuscriptId)!;
    const { addedRows: _drop, ...unledgered } = cached;
    await saveAnalysisCache(b.manuscriptId, unledgered as never);
    let faulted = 0;
    cacheSpy.beforePatch = async (p) => {
      if (faulted === 0 && 'remapCharacterIds' in (p as Record<string, unknown>)) {
        faulted += 1;
        throw Object.assign(new Error('EPERM: cache write'), { code: 'EPERM' });
      }
    };
    /* Chapters 2 and 3 fail their cast: the run ends right after Phase 0a, with no
       later snapshot and no finalise. */
    setPhase0Hook((id) => {
      if (id >= 2) throw new Error('phase 0 boom');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let events: Sent[];
    try {
      events = await runSubsetRetry(b, ONE_ROW);
    } finally {
      cacheSpy.beforePatch = undefined;
      warn.mockRestore();
    }
    expect(faulted).toBe(1);
    expect(done(events)).toBe(false);
    const castIds = ids(readCast(b.bookDir));
    expect(castIds).toContain('boris-n1');
    const cache = readCache(b.manuscriptId)!;
    /* The cache names the id cast.json holds: the decision and every take. */
    expect(cache.matchPlan?.decisions.boris).toMatchObject({ kind: 'new', id: 'boris-n1' });
    const takeIds = Object.values(cache.chapters).flat().map((s) => s.characterId);
    expect(takeIds).toContain('boris-n1');
    expect(takeIds).not.toContain('boris');
    expect(history(b).supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
  });

  it('N2 (pause): a Phase-0a re-mint whose cache patch faulted reaches the cache when the run is paused in Phase 0a', async () => {
    const b = seed([{ ...NARR }, { ...LEAD_WREN }]);
    expect(done(await run(b.manuscriptId, b.bookDir, 'main', ONE_ROW))).toBe(true);
    const { addedRows: _drop, ...unledgered } = readCache(b.manuscriptId)!;
    await saveAnalysisCache(b.manuscriptId, unledgered as never);
    let faulted = 0;
    cacheSpy.beforePatch = async (p) => {
      if (faulted === 0 && 'remapCharacterIds' in (p as Record<string, unknown>)) {
        faulted += 1;
        throw Object.assign(new Error('EPERM: cache write'), { code: 'EPERM' });
      }
    };
    /* The user pauses during chapter 2's cast detection. */
    const pauseAtChapter2 = (job: AnalysisJob): void => {
      setPhase0Hook((id) => {
        if (id < 2) return;
        job.controller.abort();
        throw new AnalysisAbortedError('paused');
      });
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let events: Sent[];
    try {
      events = await runSubsetRetry(b, ONE_ROW, { onJob: pauseAtChapter2 });
    } finally {
      cacheSpy.beforePatch = undefined;
      warn.mockRestore();
    }
    expect(faulted).toBe(1);
    expect(errCode(events)).toBe('aborted');
    expect(ids(readCast(b.bookDir))).toContain('boris-n1');
    const cache = readCache(b.manuscriptId)!;
    expect(cache.matchPlan?.decisions.boris).toMatchObject({ kind: 'new', id: 'boris-n1' });
    const takeIds = Object.values(cache.chapters).flat().map((s) => s.characterId);
    expect(takeIds).toContain('boris-n1');
    expect(takeIds).not.toContain('boris');
  });

  it('R3-1: a faulted Phase-0a patch is re-sent before the next snapshot, so its older ledger never rolls back a newer one', async () => {
    /* A stopped main run leaves `the-jogger` run-owned in addedRows. */
    const b = seed(PRIORS(), undefined, BODY18);
    setPhase1Hook(abortAtFirstPhase1());
    await run(b.manuscriptId, b.bookDir, 'main', FRESH);
    setPhase1Hook(undefined);
    const fpStopped = (readCache(b.manuscriptId)?.addedRows?.['the-jogger'] as { state: string; fp?: string }) ?? {};
    expect(fpStopped.state).toBe('run-owned');
    /* Chapter 1's snapshot patch faults; chapter 2 gives the row a new alias, so its
       snapshot refreshes the row's fingerprint (a newer ledger); chapter 3's cast fails,
       so the run ends after Phase 0a with no whole-cache save to paper over the order. */
    const roster = (id: number): CharacterOutput[] =>
      id === 1 ? [NARR, WREN_FRESH, JOGGER] : [NARR, WREN_FRESH, { ...JOGGER, aliases: ['Runner'] } as unknown as CharacterOutput];
    const phase0ByChapter: Analyzer = {
      ...phase0(FRESH.roster),
      async runStage1Chapter(_m: string, chapterId: number) {
        if (chapterId === 3) throw new Error('phase 0 boom');
        return { characters: roster(chapterId) };
      },
    } as Analyzer;
    let faulted = 0;
    let ledgerPatches = 0;
    cacheSpy.beforePatch = async (p) => {
      if (!('ledger' in (p as Record<string, unknown>))) return;
      ledgerPatches += 1;
      if (faulted === 0) {
        faulted += 1;
        throw Object.assign(new Error('EPERM: cache write'), { code: 'EPERM' });
      }
    };
    const rec = getManuscript(b.manuscriptId)!;
    const { job, events } = mkJob(b.manuscriptId, b.bookDir, 'subset');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runSubsetAnalyzerJob(job, rec as never, sel(phase0ByChapter, 'phase0-model'), sel(phase1(FRESH_ID), 'phase1-model'), rec.chapterHints, true);
    } finally {
      cacheSpy.beforePatch = undefined;
      warn.mockRestore();
    }
    expect(faulted).toBe(1);
    expect(ledgerPatches).toBeGreaterThanOrEqual(2); // the faulted one, then chapter 2's
    expect(done(events)).toBe(false);
    const row = readCast(b.bookDir).find((c) => c.id === 'the-jogger')!;
    expect(row.aliases).toEqual(expect.arrayContaining(['Runner']));
    /* The cache's entry is the fingerprint of the job's LAST write of the row (chapter 2's),
       not the faulted chapter-1 patch's older one landing after it. */
    const entry = readCache(b.manuscriptId)?.addedRows?.['the-jogger'] as { state: string; fp?: string };
    expect(entry).toEqual({ state: 'run-owned', fp: userOwnedFingerprint(row) });
    expect(entry.fp).not.toBe(fpStopped.fp);
  });

  it("M8b: the Phase-0a snapshot writes a covered joined row's new alias before the finalise", async () => {
    const b = seed([{ ...NARR }, { ...LEAD_WREN }]);
    expect(done(await run(b.manuscriptId, b.bookDir, 'main', ONE_ROW))).toBe(true);
    expect(JSON.stringify(readCast(b.bookDir))).not.toContain('Wrennie');
    let atChapter2: Row | undefined;
    setPhase0Hook((id) => {
      if (id === 2) atChapter2 = readCast(b.bookDir).find((c) => c.id === PRIOR_ID);
    });
    const withAlias = { ...WREN_FRESH, aliases: ['Wrennie'] } as unknown as CharacterOutput;
    expect(done(await runSubsetRetry(b, { roster: [NARR, withAlias, BORIS], speakerId: ['boris', FRESH_ID] }))).toBe(true);
    expect(atChapter2?.aliases).toEqual(expect.arrayContaining(['Wrennie']));
    /* Only the covered row: no raw id, no second Boris. */
    expect(ids(readCast(b.bookDir))).not.toContain(FRESH_ID);
    expect(ids(readCast(b.bookDir)).filter((id) => id.startsWith('boris'))).toEqual(['boris']);
  });

  /* Regression pins: a real Stop ends `aborted` in both jobs (the controller aborts and the
     in-flight call rejects with `AnalysisAbortedError`, as the transports throw it). */
  for (const kind of ['main', 'subset'] as const) {
    it(`a Stop during ${kind} Phase 1 ends the run with code aborted`, async () => {
      const b = seed(PRIORS());
      if (kind === 'subset') expect(done(await run(b.manuscriptId, b.bookDir, 'main', { roster: [NARR, WREN_FRESH], speakerId: PRIOR_ID }))).toBe(true);
      const castBefore = readFileSync(join(b.bookDir, '.audiobook', 'cast.json'), 'utf8');
      /* As a real transport does on a Stop: the controller aborts, the call rejects. */
      setPhase1Hook(async () => {
        getLastJob()?.controller.abort();
        throw new AnalysisAbortedError('Endpoint call aborted (paused or client disconnected).');
      });
      const events = await run(b.manuscriptId, b.bookDir, kind, { roster: [NARR, WREN_FRESH], speakerId: PRIOR_ID });
      setPhase1Hook(undefined);
      expect(errCode(events)).toBe('aborted');
      expect(events.some((e) => e.kind === 'chapter-failed')).toBe(false);
      expect(done(events)).toBe(false);
      if (kind === 'subset') {
        /* Nothing the Stop interrupted was persisted; no failure recorded for the chapter. */
        expect(readFileSync(join(b.bookDir, '.audiobook', 'cast.json'), 'utf8')).toBe(castBefore);
        expect(readCache(b.manuscriptId)?.failedChapterIds ?? []).toEqual([]);
      }
    });
  }

  /* Task 25 fix round 1 (I2): the cache op right after a landed persist (its decisions,
     re-mints and ledger) can throw an fs error. It must not skip the retirements or
     state.json - the job would emit `result` over a stale state.json with the plan's
     joins never recorded. */
  describe.each(['main', 'subset'] as const)('I2 (%s): a cache-patch fault at persist', (kind) => {
    const app = mkApp();
    afterEach(() => {
      castIoSpy.onPersisted = undefined;
      cacheSpy.beforePatch = undefined;
    });
    it('no longer skips the retirements and state.json', async () => {
      const b = seed(PRIORS());
      let persisted = false;
      let faulted = 0;
      castIoSpy.onPersisted = () => {
        persisted = true;
      };
      cacheSpy.beforePatch = async (patch) => {
        if (persisted && faulted === 0 && Object.hasOwn(patch as object, 'ledger')) {
          faulted += 1;
          throw Object.assign(new Error('EPERM: operation not permitted, rename analysis cache'), { code: 'EPERM' });
        }
      };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      let events: Sent[];
      try {
        events = await run(b.manuscriptId, b.bookDir, kind, { roster: [NARR, WREN_FRESH], speakerId: PRIOR_ID });
      } finally {
        warn.mockRestore();
        err.mockRestore();
      }
      expect(faulted).toBe(1);
      expect(done(events)).toBe(true);
      const h = readHistory(b.bookDir) as { supersededBy: Record<string, string>; supersededByKind?: Record<string, string> };
      expect(h.supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
      expect(h.supersededByKind).toEqual({ [FRESH_ID]: 'analyzer' });
      const state = readJson(b.bookDir, 'state.json') as { analysisProvenance?: { model?: string } };
      expect(state.analysisProvenance?.model).toBe('phase1-model');
      expect(ids(readCast(b.bookDir)).sort()).toEqual(['narrator', 'olga', PRIOR_ID]);
      expect(linesById(b.bookDir)).toMatchObject(editLines(b));
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

    /* Fix round 2 (N2): the faulted patch carried the persist's ledger (the fold bucket's
       entry, which only the persist records) and its decisions. They must still reach the
       cache before the run ends. The user-visible loss without them (fix round 3, F3) is
       R4: the bucket is no longer known as the run's own row, so a user delete of it does
       not stick - the next run re-plans it as a fresh row and re-adds it. (The main job's
       completion op rewrites the ledger, so there only the decision was at risk.) */
    it("is re-sent: the cache keeps that persist's ledger and decisions, so a user delete of the row it added sticks (R4)", async () => {
      const b = seed(PRIORS(), undefined, BODY18);
      /* The subset's fold bucket is new at ITS persist: the main run before it has no
         jogger, so no bucket. */
      if (kind === 'subset') {
        expect(done(await run(b.manuscriptId, b.bookDir, 'main', { roster: [NARR, WREN_FRESH], speakerId: PRIOR_ID }))).toBe(true);
        expect(ids(readCast(b.bookDir))).not.toContain('unknown-male');
      }
      let persisted = false;
      let faulted = 0;
      castIoSpy.onPersisted = () => {
        persisted = true;
      };
      cacheSpy.beforePatch = async (patch) => {
        if (persisted && faulted === 0 && Object.hasOwn(patch as object, 'ledger')) {
          faulted += 1;
          throw Object.assign(new Error('EPERM: operation not permitted, rename analysis cache'), { code: 'EPERM' });
        }
      };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let events: Sent[];
      try {
        events = await run(b.manuscriptId, b.bookDir, kind, FRESH);
      } finally {
        warn.mockRestore();
        castIoSpy.onPersisted = undefined;
        cacheSpy.beforePatch = undefined;
      }
      expect(faulted).toBe(1);
      expect(done(events)).toBe(true);
      expect(ids(readCast(b.bookDir))).toContain('unknown-male');
      /* The persist's ledger and its bucket decision reached the cache after all. */
      expect(readCache(b.manuscriptId)?.addedRows?.['unknown-male']).toEqual({ state: 'added-once' });
      expect(readCache(b.manuscriptId)?.matchPlan?.decisions['unknown-male']).toMatchObject({ kind: 'new', id: 'unknown-male' });
      /* R4: the user deletes the bucket through the cast route; the next main run, which
         produces the bucket again, must not re-add it. */
      expect((await putCast(app, b.bookId, readCast(b.bookDir).filter((c) => c.id !== 'unknown-male'))).status).toBe(200);
      expect(done(await run(b.manuscriptId, b.bookDir, 'main', FRESH))).toBe(true);
      expect(ids(readCast(b.bookDir)).filter((id) => id.startsWith('unknown-male'))).toEqual([]);
      expect(ids(readCast(b.bookDir)).sort()).toEqual(['narrator', 'olga', PRIOR_ID]);
      expect(history(b).supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });
  });

  /* ---- Task 25: the subset's Phase 1 and its planned persist ---- */

  describe('Task 25: the subset persist (persistPlannedCast)', () => {
    afterEach(() => {
      castIoSpy.afterPersist = undefined;
      castIoSpy.failSnapshot = undefined;
      cacheSpy.beforePatch = undefined;
      /* M6 — the retirement probe's mockImplementation never outlives its test. */
      vi.mocked(historyStore.retireCharacterId).mockReset();
    });
    type History = { supersededBy: Record<string, string>; supersededByKind?: Record<string, string> };
    const app = mkApp();
    /** A subset run over `chapterIds` only, on the cache the last run left. */
    const runSubsetOn = async (
      b: HarnessBook,
      fresh: { roster: CharacterOutput[]; speakerId: string | string[] | ((chapterId: number) => string) },
      chapterIds: number[],
    ): Promise<Sent[]> => {
      const rec = getManuscript(b.manuscriptId)!;
      const { job, events } = mkJob(b.manuscriptId, b.bookDir, 'subset');
      await runSubsetAnalyzerJob(
        job,
        rec as never,
        sel(phase0(fresh.roster), 'phase0-model'),
        sel(phase1(fresh.speakerId), 'phase1-model'),
        rec.chapterHints.filter((h) => chapterIds.includes(h.id)),
        true,
      );
      return events;
    };
    const entryOf = (b: HarnessBook, id: string): unknown => readCache(b.manuscriptId)?.addedRows?.[id];
    const rowOf = (b: HarnessBook, id: string): Row | undefined => readCast(b.bookDir).find((c) => c.id === id);
    /** A main run stopped after its Phase-0b snapshot (its rows are on disk, run-owned). */
    const stoppedMain = async (b: HarnessBook, fresh: typeof FRESH): Promise<void> => {
      setPhase1Hook(abortAtFirstPhase1());
      await run(b.manuscriptId, b.bookDir, 'main', fresh);
      setPhase1Hook(undefined);
    };

    it('subset persist records analyzer-tagged retirements after the lock', async () => {
      const b = seed(PRIORS());
      const actual = await vi.importActual<typeof import('../store/cast-id-history.js')>('../store/cast-id-history.js');
      const seen: Array<{ from: string; to: string; kind?: string; castLockHeld: boolean }> = [];
      vi.mocked(historyStore.retireCharacterId).mockImplementation(async (dir, from, to, kind) => {
        let castLockHeld = false;
        try {
          await withKeyLock(castJsonPath(dir), async () => {}, 200);
        } catch (err) {
          if (!(err instanceof LockAcquisitionTimeoutError)) throw err;
          castLockHeld = true;
        }
        seen.push({ from, to, kind, castLockHeld });
        return actual.retireCharacterId(dir, from, to, kind);
      });
      const events = await run(b.manuscriptId, b.bookDir, 'subset', { roster: [NARR, WREN_FRESH], speakerId: PRIOR_ID });
      expect(done(events)).toBe(true);
      /* The plan's join (raw "wren-ashby" -> the prior "w2"), recorded once, analyzer-tagged,
         outside the cast lock. The narrator's join records nothing. */
      expect(seen.filter((r) => r.from === FRESH_ID)).toEqual([
        { from: FRESH_ID, to: PRIOR_ID, kind: 'analyzer', castLockHeld: false },
      ]);
      expect(seen.some((r) => r.from === 'narrator')).toBe(false);
      expect(seen.every((r) => !r.castLockHeld)).toBe(true);
      const h = readHistory(b.bookDir) as History;
      expect(h.supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
      expect(h.supersededByKind).toEqual({ [FRESH_ID]: 'analyzer' });
      expect(ids(readCast(b.bookDir)).sort()).toEqual(['narrator', 'olga', PRIOR_ID]);
      expect(linesById(b.bookDir)).toMatchObject(editLines(b));
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

    it('subset result characters equal the persisted cast', async () => {
      /* olga is a prior row the fresh run never mentions: carried forward on disk (rule 1),
         so a result built from the fresh roster would omit it. The narrator speaks too. */
      const b = seed(PRIORS());
      const events = await run(b.manuscriptId, b.bookDir, 'subset', { roster: [NARR, WREN_FRESH], speakerId: [PRIOR_ID, 'narrator'] });
      const result = events.find((e) => e.kind === 'result')!;
      expect(result).toBeDefined();
      expect(result.response!.characters).toEqual(readCast(b.bookDir));
      expect(ids(result.response!.characters)).toContain('olga');
      /* Carry 5: every row's count matches the edits, the narrator's included (never 0). */
      expect(editLines(b).narrator).toBeGreaterThan(0);
      expect(linesById(b.bookDir)).toMatchObject(editLines(b));
      expect(result.response!.sentences).toEqual(readEdits(b.bookDir));
      expect((readHistory(b.bookDir) as History).supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

    for (const routeEdit of [true, false]) {
      it(`subset: a row it added and ${routeEdit ? 'a voice route then changed is kept' : 'nothing changed is removed'} at its fold-drop`, async () => {
        const b = seed([{ ...NARR }, { ...LEAD_WREN }]);
        expect(done(await run(b.manuscriptId, b.bookDir, 'main', { roster: [NARR, WREN_FRESH], speakerId: PRIOR_ID }))).toBe(true);
        const historyAfterMain = (readHistory(b.bookDir) as History).supersededBy;
        /* The Retry's roster adds boris (planned new by the subset's finalise, written by its
           snapshot) but never attributes a line to him: the fold drops him as silent. */
        let routed = false;
        setPhase1Hook(async () => {
          if (!routeEdit || routed) return;
          routed = true;
          expect(rowOf(b, 'boris')).toBeDefined();
          expect((await routeVoice(app, b.bookId, 'boris')).status).toBe(200);
        });
        const events = await runSubsetRetry(b, { roster: [NARR, WREN_FRESH, BORIS], speakerId: PRIOR_ID });
        expect(done(events)).toBe(true);
        expect(routed).toBe(routeEdit);
        if (routeEdit) {
          /* Rule 11 on the subset's own ledger: a user change keeps the row; it is now
             added-once in the cache too (R35a: the completed persist's R4 for a row it keeps). */
          expect(rowOf(b, 'boris')).toMatchObject({ overrideTtsVoices: expect.anything() });
          expect(entryOf(b, 'boris')).toEqual({ state: 'added-once' });
        } else {
          expect(rowOf(b, 'boris')).toBeUndefined();
          /* The entry its snapshot recorded goes with the row (a later run may add it again). */
          expect(entryOf(b, 'boris')).toBeUndefined();
        }
        expect(linesById(b.bookDir)).toMatchObject(editLines(b));
        expect(editLines(b)).toEqual({ [PRIOR_ID]: 3 });
        expect((readHistory(b.bookDir) as History).supersededBy).toEqual(historyAfterMain);
        expect(readSuggestions(b.bookDir)).toEqual([]);
      });
    }

    /* Covers the subset's snapshot write (an alias) and its persist's own analysis (the
       tone it fills); the run-start stale-link prune has its own test below. The linker
       stamp and notLinkedTo writes are carried to Task 27's F2 (they need series fixtures). */
    it("item 10: a subset alias (its snapshots) and its persist's own write (tone) on a stopped main run's row refresh that row's addedRows fingerprint", async () => {
      /* A main run stopped after its Phase-0b snapshot: boris is its run-owned row on disk. */
      const b = seed([{ ...NARR }, { ...LEAD_WREN }]);
      await stoppedMain(b, ONE_ROW as never);
      const stopped = entryOf(b, 'boris') as { state: string; fp: string };
      expect(stopped.state).toBe('run-owned');
      expect(stopped.fp).toBe(userOwnedFingerprint(rowOf(b, 'boris')!));
      /* The subset writes the row: a new alias (its snapshots), and the persist's own
         analysis of it (the tone it fills). */
      const withAlias = { ...BORIS, aliases: ['Bo'] } as unknown as CharacterOutput;
      const events = await runSubsetRetry(b, { roster: [NARR, WREN_FRESH, withAlias], speakerId: ['boris', PRIOR_ID] });
      expect(done(events)).toBe(true);
      const row = rowOf(b, 'boris')!;
      expect(row.aliases).toEqual(expect.arrayContaining(['Bo']));
      expect(row.tone).toBeDefined();
      /* Compare-then-refresh: still the main run's row, with the fingerprint of the
         subset's last write of it. */
      expect(entryOf(b, 'boris')).toEqual({ state: 'run-owned', fp: userOwnedFingerprint(row) });
      expect(linesById(b.bookDir)).toMatchObject(editLines(b));
      expect((readHistory(b.bookDir) as History).supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

    it("item 10: a subset persist's refresh of a stopped main run's row it wrote lets a later main persist still fold-drop it", async () => {
      /* Fix round 2 (Step-5 chain): a main run stops; subset A completes with boris
         speaking, so A's persist WRITES his row (counts and tone); subset B re-attributes
         him silent, so B's fold takes him and he is carried; a main run follows. Every run
         start compares disk with the entry's fp (refreshLedger), so A's persist must
         have refreshed it or B turns the row added-once and the main run keeps it. */
      const b = seed([{ ...NARR }, { ...LEAD_WREN }]);
      await stoppedMain(b, ONE_ROW as never);
      expect((entryOf(b, 'boris') as { state: string }).state).toBe('run-owned');
      /* A: boris speaks, so A's persist writes his row (counts and the tone it fills). */
      expect(done(await runSubsetRetry(b, { roster: ONE_ROW.roster, speakerId: ['boris', PRIOR_ID] }))).toBe(true);
      expect(rowOf(b, 'boris')!.lines).toBeGreaterThan(0);
      expect(rowOf(b, 'boris')!.tone).toBeDefined();
      /* B: boris is silent; B's fold drops him and he is carried forward. */
      expect(done(await runSubsetRetry(b, { roster: ONE_ROW.roster, speakerId: PRIOR_ID }))).toBe(true);
      expect(rowOf(b, 'boris')).toBeDefined(); // the subset never deletes by addedRows
      expect((entryOf(b, 'boris') as { state: string }).state).toBe('run-owned');
      /* The main run (B's takes are current) fold-drops the untouched row. */
      expect(done(await run(b.manuscriptId, b.bookDir, 'main', ONE_ROW as never))).toBe(true);
      expect(rowOf(b, 'boris')).toBeUndefined();
      expect(linesById(b.bookDir)).toMatchObject(editLines(b));
      expect(history(b).supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

    it("item 10: the subset run start's stale-link prune on a stopped main run's row refreshes its fingerprint, and the next main persist still fold-drops it", async () => {
      const b = seed(PRIORS(), undefined, BODY18);
      await stoppedMain(b, FRESH);
      /* As t:632 seeds it: the stopped run's own last write of the-jogger carried a reuse
         link to a book outside this series (a linker stamp), and its ledger fingerprint is
         of that write. */
      await withCastLock(b.bookDir, async () => {
        const p = castJsonPath(b.bookDir);
        const cast = JSON.parse(readFileSync(p, 'utf8')) as { characters: Row[] };
        for (const c of cast.characters) {
          if (c.id === 'the-jogger') c.matchedFrom = { bookId: 'not-in-this-series', characterId: 'x' };
        }
        writeFileSync(p, JSON.stringify(cast));
      });
      const stamped = rowOf(b, 'the-jogger')!;
      await mutateAnalysisCache(b.manuscriptId, { ledger: { 'the-jogger': { state: 'run-owned', fp: userOwnedFingerprint(stamped) } } });
      let atStart: { row?: Row; entry?: unknown } | undefined;
      setPhase0Hook(() => {
        atStart ??= { row: rowOf(b, 'the-jogger'), entry: entryOf(b, 'the-jogger') };
      });
      expect(done(await runSubsetRetry(b, FRESH))).toBe(true);
      setPhase0Hook(undefined);
      /* The run start pruned the stale link and refreshed the stopped run's entry. */
      expect(atStart!.row).toBeDefined();
      expect(atStart!.row!.matchedFrom).toBeUndefined();
      expect(atStart!.entry).toEqual({ state: 'run-owned', fp: userOwnedFingerprint(atStart!.row!) });
      expect(entryOf(b, 'the-jogger')).toEqual({ state: 'run-owned', fp: userOwnedFingerprint(rowOf(b, 'the-jogger')!) });
      /* ...so the next main persist still fold-drops it as untouched. */
      expect(done(await run(b.manuscriptId, b.bookDir, 'main', FRESH))).toBe(true);
      expect(rowOf(b, 'the-jogger')).toBeUndefined();
      expect(linesById(b.bookDir)).toMatchObject(editLines(b));
      expect(history(b).supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

    it('item 10: … and the resumed main persist still fold-drops those rows when their user-owned fields are otherwise untouched', async () => {
      const straight = seed(PRIORS(), undefined, BODY18);
      expect(done(await run(straight.manuscriptId, straight.bookDir, 'main', FRESH))).toBe(true);
      const b = seed(PRIORS(), undefined, BODY18);
      await stoppedMain(b, FRESH);
      expect((entryOf(b, 'the-jogger') as { state: string }).state).toBe('run-owned');
      /* A subset Retry gives the stopped run's row an alias (its snapshots) and is paused
         in Phase 1: no persist. */
      const runner = { ...JOGGER, aliases: ['Runner'] } as unknown as CharacterOutput;
      setPhase1Hook(abortAtFirstPhase1());
      const retry = await runSubsetRetry(b, { roster: [NARR, WREN_FRESH, runner], speakerId: PRIOR_ID });
      setPhase1Hook(undefined);
      expect(done(retry)).toBe(false);
      const written = rowOf(b, 'the-jogger')!;
      expect(written.aliases).toEqual(expect.arrayContaining(['Runner']));
      expect(entryOf(b, 'the-jogger')).toEqual({ state: 'run-owned', fp: userOwnedFingerprint(written) });
      /* The resumed main run's persist fold-drops the untouched row: the uninterrupted cast. */
      expect(done(await run(b.manuscriptId, b.bookDir, 'main', FRESH))).toBe(true);
      expect(rowOf(b, 'the-jogger')).toBeUndefined();
      expect(ids(readCast(b.bookDir)).sort()).toEqual(ids(readCast(straight.bookDir)).sort());
      expect(linesById(b.bookDir)).toMatchObject(editLines(b));
      expect(history(b).supersededBy).toEqual(history(straight).supersededBy);
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

    it('item 10: a route-given voice on such a row between the stop and the subset run IS a user change: the row becomes added-once and survives', async () => {
      const b = seed(PRIORS(), undefined, BODY18);
      await stoppedMain(b, FRESH);
      expect((entryOf(b, 'the-jogger') as { state: string }).state).toBe('run-owned');
      expect((await routeVoice(app, b.bookId, 'the-jogger')).status).toBe(200);
      const events = await runSubsetRetry(b, FRESH);
      expect(done(events)).toBe(true);
      expect(entryOf(b, 'the-jogger')).toEqual({ state: 'added-once' });
      expect(rowOf(b, 'the-jogger')).toMatchObject({ overrideTtsVoices: expect.anything() });
      /* A later main run's persist keeps it: the user owns it now. */
      expect(done(await run(b.manuscriptId, b.bookDir, 'main', FRESH))).toBe(true);
      expect(rowOf(b, 'the-jogger')).toMatchObject({ overrideTtsVoices: expect.anything() });
      expect(linesById(b.bookDir)).toMatchObject(editLines(b));
      expect(history(b).supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

    it('R39: a manuscript PUT to an untouched chapter mid-subset survives the next roll', async () => {
      const b = seed(PRIORS());
      expect(done(await run(b.manuscriptId, b.bookDir, 'main', { roster: [NARR, WREN_FRESH], speakerId: PRIOR_ID }))).toBe(true);
      const castBefore = readFileSync(join(b.bookDir, '.audiobook', 'cast.json'), 'utf8');
      /* A Retry of chapters 1 and 2. While chapter 1 is attributed the user edits chapter
         3's text (a manuscript PUT is allowed mid-run); chapter 1's roll follows. The run is
         then stopped in chapter 2, so no persist rewrites the file afterwards. */
      let put: number | undefined;
      setPhase1Hook(async (chapterId) => {
        if (chapterId === 1) {
          const sentences = readEdits(b.bookDir).map((s) => (s.chapterId === 3 ? { ...s, text: 'EDITED BY THE USER' } : s));
          put = (await request(app).put(`/api/books/${b.bookId}/state`).send({ slice: 'manuscript', patch: { sentences } })).status;
        }
        if (chapterId === 2) throw new AnalysisAbortedError('paused in chapter 2');
      });
      const events = await runSubsetOn(b, { roster: [NARR, WREN_FRESH], speakerId: PRIOR_ID }, [1, 2]);
      setPhase1Hook(undefined);
      expect(put).toBe(200);
      expect(errCode(events)).toBe('aborted');
      const ch3 = readEdits(b.bookDir).filter((s) => s.chapterId === 3);
      expect(ch3.length).toBeGreaterThan(0);
      expect(ch3.every((s) => s.text === 'EDITED BY THE USER')).toBe(true);
      /* Chapter 1's own roll did land. */
      expect(readEdits(b.bookDir).filter((s) => s.chapterId === 1).map((s) => s.characterId)).toEqual([PRIOR_ID]);
      expect(readFileSync(join(b.bookDir, '.audiobook', 'cast.json'), 'utf8')).toBe(castBefore);
      expect(history(b).supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

    it("M5: a mid-subset merge of a stopped main run's row leaves no addedRows entry for the source", async () => {
      const b = seed([{ ...NARR }, { ...LEAD_WREN }]);
      await stoppedMain(b, ONE_ROW as never);
      expect((entryOf(b, 'boris') as { state: string }).state).toBe('run-owned');
      /* The user merges boris into Wren while the subset is in Phase 1; the merge drops
         boris's ledger entry from the cache. No later patch of this run may bring it back. */
      const merge = mergeMidRun(app, b.bookId, 'boris', PRIOR_ID, 'phase1');
      const events = await runSubsetRetry(b, ONE_ROW);
      expect((await merge.done)?.status).toBe(200);
      expect(done(events)).toBe(true);
      expect(Object.keys(readCache(b.manuscriptId)?.addedRows ?? {})).not.toContain('boris');
      expect(rowOf(b, 'boris')).toBeUndefined();
      expect(ids(readCast(b.bookDir)).sort()).toEqual(['narrator', PRIOR_ID]);
      expect(linesById(b.bookDir)).toMatchObject(editLines(b));
      expect(history(b).supersededBy).toMatchObject({ boris: PRIOR_ID });
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

    it('subset never deletes by addedRows', async () => {
      /* The stopped main run's the-jogger is untouched and the subset's fold takes it: it
         stays on disk (carried forward) and keeps its run-owned entry. */
      const b = seed(PRIORS(), undefined, BODY18);
      await stoppedMain(b, FRESH);
      expect((entryOf(b, 'the-jogger') as { state: string }).state).toBe('run-owned');
      const castBefore = rowOf(b, 'the-jogger');
      expect(castBefore).toBeDefined();
      expect(done(await runSubsetRetry(b, FRESH))).toBe(true);
      /* Still there with everything it had (the subset's snapshots may add to it). */
      const after = rowOf(b, 'the-jogger')!;
      expect(after).toMatchObject(castBefore!);
      expect(entryOf(b, 'the-jogger')).toEqual({ state: 'run-owned', fp: userOwnedFingerprint(after) });
      expect(linesById(b.bookDir)).toMatchObject(editLines(b));
      expect(history(b).supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

    it('R35: a main resume after a subset run makes no -n1 duplicate; nor does a second subset run reusing the plan', async () => {
      const b = seed(PRIORS(), undefined, BODY18);
      expect(done(await run(b.manuscriptId, b.bookDir, 'main', FRESH))).toBe(true);
      /* The subset adds boris (its own row, planned new into the cached plan). */
      const withBoris = { roster: [NARR, WREN_FRESH, JOGGER, BORIS], speakerId: ['boris', PRIOR_ID] };
      expect(done(await runSubsetRetry(b, withBoris))).toBe(true);
      expect(entryOf(b, 'boris')).toEqual({ state: 'added-once' });
      const borisLines = rowOf(b, 'boris')!.lines;
      expect(borisLines).toBeGreaterThan(0);
      for (const again of ['subset', 'main'] as const) {
        const events = again === 'subset' ? await runSubsetRetry(b, withBoris) : await run(b.manuscriptId, b.bookDir, 'main', withBoris);
        expect(done(events)).toBe(true);
        expect(ids(readCast(b.bookDir)).filter((id) => id.startsWith('boris'))).toEqual(['boris']);
        expect(readCache(b.manuscriptId)!.matchPlan!.decisions.boris).toMatchObject({ kind: 'new', id: 'boris', minted: false });
        expect(rowOf(b, 'boris')!.lines).toBe(borisLines);
        expect(linesById(b.bookDir)).toMatchObject(editLines(b));
        expect(history(b).supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
        expect(readSuggestions(b.bookDir)).toEqual([]);
      }
    });

    it('Task 8 carry: the subset persists the full sentence set - a row speaking only in an untouched chapter keeps its counts', async () => {
      const b = seed(PRIORS());
      /* The main run: olga speaks only in chapter 3. */
      const byChapter = (c: number): string => (c === 3 ? 'olga' : PRIOR_ID);
      const OLGA_FRESH = { id: 'olga', name: 'Olga', role: 'minor', color: '#444444', gender: 'female', evidence: [{ quote: 'Olga nodded' }] } as unknown as CharacterOutput;
      expect(done(await run(b.manuscriptId, b.bookDir, 'main', { roster: [NARR, WREN_FRESH, OLGA_FRESH], speakerId: byChapter }))).toBe(true);
      const olgaBefore = { lines: rowOf(b, 'olga')!.lines, scenes: rowOf(b, 'olga')!.scenes };
      expect(olgaBefore).toEqual({ lines: 3, scenes: 1 });
      /* A Retry of chapter 1 only. */
      const events = await runSubsetOn(b, { roster: [NARR, WREN_FRESH, OLGA_FRESH], speakerId: () => PRIOR_ID }, [1]);
      expect(done(events)).toBe(true);
      expect({ lines: rowOf(b, 'olga')!.lines, scenes: rowOf(b, 'olga')!.scenes }).toEqual(olgaBefore);
      expect(readEdits(b.bookDir).filter((s) => s.characterId === 'olga').map((s) => s.chapterId)).toEqual([3, 3, 3]);
      expect(linesById(b.bookDir)).toMatchObject(editLines(b));
      expect(history(b).supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

    it('carry 10: a failed edits write after cast.json landed still records the retirements and leaks no path to the client', async () => {
      const b = seed(PRIORS());
      const editsPath = join(b.bookDir, '.audiobook', 'manuscript-edits.json');
      castIoSpy.afterPersist = (outcome) =>
        Object.assign(new Error(`EPERM: operation not permitted, rename '${editsPath}'`), {
          code: 'EPERM',
          syscall: 'rename',
          path: editsPath,
          persistOutcome: outcome,
        });
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      let events: Sent[];
      try {
        events = await run(b.manuscriptId, b.bookDir, 'subset', { roster: [NARR, WREN_FRESH], speakerId: PRIOR_ID });
      } finally {
        err.mockRestore();
      }
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        const text = JSON.stringify(e);
        expect(text).not.toContain(b.bookDir);
        expect(text).not.toContain(b.bookDir.replace(/\\/g, '\\\\'));
      }
      expect((readHistory(b.bookDir) as History).supersededBy).toEqual({ [FRESH_ID]: PRIOR_ID });
      expect(ids(readCast(b.bookDir)).sort()).toEqual(['narrator', 'olga', PRIOR_ID]);
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });

    it('carry 10: a persist cast-lock timeout parks - state.json is still written (no provenance stamp), then the job fails curated', async () => {
      const b = seed(PRIORS());
      const statePath = join(b.bookDir, '.audiobook', 'state.json');
      const stateBefore = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
      castIoSpy.afterPersist = () => new LockAcquisitionTimeoutError(`cast:${b.bookDir}`, 10);
      const events = await run(b.manuscriptId, b.bookDir, 'subset', { roster: [NARR, WREN_FRESH], speakerId: PRIOR_ID });
      expect(done(events)).toBe(false);
      const error = events.find((e) => e.kind === 'error')!;
      expect(error).toBeDefined();
      const text = JSON.stringify(error);
      expect(text).not.toContain(b.bookDir);
      expect(text).not.toContain(b.bookDir.replace(/\\/g, '\\\\'));
      const stateAfter = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
      expect(stateAfter.updatedAt).not.toBe(stateBefore.updatedAt);
      expect(stateAfter.analysisProvenance).toBeUndefined();
      /* Nothing the timed-out persist "returned" was recorded: no retirement. */
      expect(history(b).supersededBy).toEqual({});
      expect(readSuggestions(b.bookDir)).toEqual([]);
    });
  });
});

/* R47 (#4031 Task 28 fix round 1): a code-seeded default narrator name is
   analysis-owned. A book first analysed as English keeps "Narrator"; once its
   language is corrected to `ru`, re-analysis re-localises the joined narrator.
   A name the user chose stays. */
describe.each(['main', 'subset'] as const)('R47: the narrator name on re-analysis (%s job)', (kind) => {
  const books: HarnessBook[] = [];
  const orig = process.env.STAGE2_COVERAGE_RETRIES;
  beforeEach(() => {
    process.env.STAGE2_COVERAGE_RETRIES = '0';
  });
  afterEach(async () => {
    resetHarness();
    if (orig === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
    else process.env.STAGE2_COVERAGE_RETRIES = orig;
    for (const b of books.splice(0)) await cleanupBook(b);
  });
  const ruBook = (narratorName: string): HarnessBook => {
    const b = mkBook([{ ...NARR, name: narratorName }, { ...PRIOR_WREN }]);
    books.push(b);
    const statePath = join(b.bookDir, '.audiobook', 'state.json');
    writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, 'utf8')), language: 'ru' }));
    return b;
  };
  const narratorName = (b: HarnessBook) => readCast(b.bookDir).find((c) => c.id === 'narrator')?.name;

  it('a default "Narrator" re-localises to the book language', async () => {
    const b = ruBook('Narrator');
    await runJob(kind)(b);
    expect(narratorName(b)).toBe('Рассказчик');
  });

  it('control: a user-renamed narrator keeps its name', async () => {
    const b = ruBook('The Chronicler');
    await runJob(kind)(b);
    expect(narratorName(b)).toBe('The Chronicler');
  });
});
