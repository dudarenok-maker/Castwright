/* Plan 291 (#4031) - route-level acceptance tests for the single fresh<->prior
   cast matcher, driven through the real analysis jobs. This file holds the
   harness smoke test and a self-test per harness helper; the acceptance tests
   (Tasks 15-27) are added on top of `__test-helpers__/analysis-job-harness.ts`.
   The mock blocks below are the ones the harness header requires. */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

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
  abortAtFirstPhase1,
  blipRemapRead,
  cleanupBook,
  failNextRetirement,
  linesById,
  mergeMidRun,
  mkApp,
  mkBook,
  putCast,
  readCache,
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
} from './__test-helpers__/analysis-job-harness.js';

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

  it('setPipelined and setPhase0Hook: the hook runs in Phase 0 and the flag is read by the mock', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN }]);
    const seen: number[] = [];
    setPhase0Hook((id) => {
      seen.push(id);
    });
    setPipelined(false);
    await run(b.manuscriptId, b.bookDir, 'main');
    expect(seen.length).toBeGreaterThan(0);
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

  it('mergeMidRun: a merge fired from the Phase-1 hook is answered while the run is in flight', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN }, { id: 'w3', name: 'Wrenna', role: 'minor', color: '#222222' }]);
    const m = mergeMidRun(mkApp(), b.bookId, 'w3', PRIOR_ID, 'phase0');
    await run(b.manuscriptId, b.bookDir, 'main');
    const res = await m.done;
    expect(res?.status).toBe(200);
    expect(res?.body.sourceId).toBe('w3');
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

  it('abortAtFirstPhase1 + runSubsetRetry: a stopped run leaves a cache the retry resumes', async () => {
    const b = seed([{ ...NARR }, { ...PRIOR_WREN }]);
    setPhase1Hook(abortAtFirstPhase1());
    await run(b.manuscriptId, b.bookDir, 'main');
    setPhase1Hook(undefined);
    const afterStop = readCache(b.manuscriptId);
    expect(afterStop?.stage1).toBeDefined();
    const events = await runSubsetRetry(b);
    expect(events.length).toBeGreaterThan(0);
    expect(readCache(b.manuscriptId)?.stage1).toBeDefined();
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
});
