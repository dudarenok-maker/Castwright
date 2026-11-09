/* Plan 291 (#4031) - route-level acceptance tests for the single fresh<->prior
   cast matcher, driven through the real analysis jobs. This file holds the
   harness smoke test and a self-test per harness helper; the acceptance tests
   (Tasks 15-27) are added on top of `__test-helpers__/analysis-job-harness.ts`.
   The mock blocks below are the ones the harness header requires. */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Before any import binds BOOKS_ROOT: the harness books live in this workspace. */
vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs');
  const os = process.getBuiltinModule('node:os');
  const path = process.getBuiltinModule('node:path');
  process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-4031-ws-'));
});

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
  putCast,
  readCache,
  readJson,
  readCast,
  readEdits,
  readSuggestions,
  recordCastUpdateFrames,
  resetHarness,
  routeVoice,
  run,
  runSubsetRetry,
  sel,
  setPhase0Hook,
  setPhase1Hook,
  setPipelined,
  type HarnessBook,
  type Row,
} from './__test-helpers__/analysis-job-harness.js';
import * as historyStore from '../store/cast-id-history.js';
import * as stateIo from '../workspace/state-io.js';
import { mutateAnalysisCache, saveAnalysisCache } from '../store/analysis-cache.js';
import { retargetPlanForMerge } from '../store/plan-overlay.js';
import { castMergeSuggestionsJsonPath } from '../workspace/paths.js';
import { linkSeriesReuseOnNewRows, runMainAnalyzerJob } from './analysis.js';
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
vi.mock('../store/cast-id-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/cast-id-history.js')>();
  return { ...actual, retireCharacterId: vi.fn(actual.retireCharacterId) };
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
    setPhase1Hook(() => {
      release();
    });
    /* The analyzer answers in whatever id space the roster it was given uses: the
       raw id before the plan, the re-minted one after. */
    const speaker = (): string => {
      if (readCache(b.manuscriptId)?.matchPlan) return `${FRESH_ID}-n1`;
      preplanTakes += 1;
      return FRESH_ID;
    };
    await run(b.manuscriptId, b.bookDir, 'main', { roster: [NARR, WREN_FRESH], speakerId: speaker });
    expect(preplanTakes).toBeGreaterThan(0); // the scenario fired: a take predates the plan
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

  it('no cast_merge_base_stale warning on a run whose start wrote cast.json', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN, lines: 40 }, { ...WREN_DUP }]);
    const events = await run(b.manuscriptId, b.bookDir, 'main');
    expect(events.some((e) => e.kind === 'result')).toBe(true);
    expect(events.filter((e) => e.kind === 'warning' && e.code === 'cast_merge_base_stale')).toEqual([]);
  });
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
  ): Promise<void> => {
    setPhase1Hook(abortAtFirstPhase1());
    await run(b.manuscriptId, b.bookDir, 'main', fresh, opts);
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

  it('A14a: stopped after the Phase-0b snapshot and never resumed, the cast is only extended', async () => {
    const b = seed([{ ...NARR }, { ...LEAD_WREN }, { ...OLGA }], undefined, BODY16);
    await stopAtPhase1(b);
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
    const abort = abortAtFirstPhase1();
    setPhase1Hook(async (chapterId) => {
      voice = await routeVoice(app, b.bookId, 'the-jogger');
      await abort(chapterId);
    });
    await run(b.manuscriptId, b.bookDir, 'main', FRESH);
    setPhase1Hook(undefined);
    expect(voice?.status).toBe(200);
    const row = readCast(b.bookDir).find((c) => c.id === 'the-jogger')!;
    expect((row.overrideTtsVoices as { qwen?: { name: string } }).qwen?.name).toBe('route-voice-the-jogger');
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
    /* Staleness: the committed file must equal a fresh capture (re-record with RECORD_FIXTURES=1). */
    expect(existsSync(FRAMES_PATH)).toBe(true);
    expect(readFileSync(FRAMES_PATH, 'utf8')).toBe(fresh);
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
    const linked = await linkSeriesReuseOnNewRows(BOOK2, rows, plan, options());
    expect(linked).toBe(1);
    expect((rows[0] as { matchedFrom?: unknown }).matchedFrom).toBeUndefined();
    expect((rows[1] as { matchedFrom?: { bookId: string } }).matchedFrom?.bookId).toBe(BOOK1);
  });

  it('a new row never takes a series link one of its candidates declined (inheritedDeclines)', async () => {
    const mk = (): never[] => [{ id: 'wren-x', name: 'Wren', gender: 'female', ageRange: 'teen' }] as never[];
    const control = mk();
    expect(await linkSeriesReuseOnNewRows(BOOK2, control, planOf({ 'wren-x': newD('wren-x') }), options())).toBe(1);

    const declined = mk();
    const plan = planOf({ 'wren-x': newD('wren-x', [{ bookId: BOOK1, characterId: 'wren' }]) });
    expect(await linkSeriesReuseOnNewRows(BOOK2, declined, plan, options())).toBe(0);
    expect((declined[0] as { matchedFrom?: unknown }).matchedFrom).toBeUndefined();
    /* The decline is a guard for the link pass, not data: it is not written onto the row. */
    expect((declined[0] as { notLinkedTo?: unknown }).notLinkedTo).toBeUndefined();
  });
});
