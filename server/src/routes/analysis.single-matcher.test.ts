/* Plan 291 (#4031) - route-level acceptance tests for the single fresh<->prior
   cast matcher, driven through the real analysis jobs. This file holds the
   harness smoke test and a self-test per harness helper; the acceptance tests
   (Tasks 15-27) are added on top of `__test-helpers__/analysis-job-harness.ts`.
   The mock blocks below are the ones the harness header requires. */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* Before any import binds BOOKS_ROOT: the harness books live in this workspace. */
vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs');
  const os = process.getBuiltinModule('node:os');
  const path = process.getBuiltinModule('node:path');
  process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-4031-ws-'));
});

import {
  FRESH_ID,
  NARR,
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
  setPhase0Hook,
  setPhase1Hook,
  setPipelined,
  type HarnessBook,
  type Row,
} from './__test-helpers__/analysis-job-harness.js';
import * as historyStore from '../store/cast-id-history.js';
import * as stateIo from '../workspace/state-io.js';
import { saveAnalysisCache } from '../store/analysis-cache.js';

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

  it('mergeMidRun: the default Phase-1 branch merges a source that still exists then, and 404s a prior-only one', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN }, { id: 'w3', name: 'Wrenna', role: 'minor', color: '#222222' }]);
    const live = mergeMidRun(mkApp(), b.bookId, PRIOR_ID, 'narrator');
    await run(b.manuscriptId, b.bookDir, 'main');
    expect((await live.done)?.status).toBe(200);

    const c = seed([{ ...NARR }, { ...PRIOR_WREN }, { id: 'w3', name: 'Wrenna', role: 'minor', color: '#222222' }]);
    const gone = mergeMidRun(mkApp(), c.bookId, 'w3', PRIOR_ID);
    await run(c.manuscriptId, c.bookDir, 'main');
    expect((await gone.done)?.status).toBe(404);
  });

  it('failNextRetirement: the next retirement write throws once', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN }]);
    const fault = failNextRetirement();
    await run(b.manuscriptId, b.bookDir, 'main');
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
