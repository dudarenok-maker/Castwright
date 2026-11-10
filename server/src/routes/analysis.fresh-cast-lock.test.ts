/* Plan 291 Task 14 (#4031), rule 8 - a cast writer racing a Start fresh run is not lost.

   Replaces the #1981 Task 11 test of the same file, which raced add-alias against
   Start fresh's cast.json DELETE and pinned "cast.json stays deleted". Start fresh
   no longer deletes cast.json (rule 8), so that outcome is gone with the delete.

   What the old test could not do (#3022): it asserted an outcome that a SECOND lock
   (the job's own locked prior read) already guaranteed, so removing the delete's own
   lock left it green, and its closing assertion sampled a state no writer could
   change. This one is built so each assertion can fail:

   - It uses a positive signal, not a sleep. The Phase-0 detect call is the first
     thing the run does after its run-start block (the prior read, and the place
     Start fresh used to delete files), so reaching it proves that block has fully
     run. The disk is sampled at that instant, and again after the run finishes.
   - A control group: the same add-alias write, fired once with the lock contended
     (it holds the cast lock while the job starts) and once after run start. Re-adding
     the cast.json delete reddens both (the first sees the file gone at the sample, the
     second gets add-alias's 409 "no cast on disk").
   Mutations are recorded in the Task 14 report. */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import express from 'express';
import request from 'supertest';

vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs');
  const os = process.getBuiltinModule('node:os');
  const path = process.getBuiltinModule('node:path');
  process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-4031-race-ws-'));
});

import {
  NARR,
  PHASE1_GLOBAL,
  cleanupBook,
  mkBook,
  mkJob,
  phase0,
  phase1,
  readCast,
  resetHarness,
  sel,
  setPhase0Hook,
  type HarnessBook,
  type Row,
} from './__test-helpers__/analysis-job-harness.js';
import { runMainAnalyzerJob } from './analysis.js';
import { castAliasesRouter } from './cast-aliases.js';
import { getManuscript } from '../store/manuscripts.js';
import * as stateIo from '../workspace/state-io.js';
import { castJsonPath, castMergesJsonPath } from '../workspace/paths.js';
import { withCastLock } from '../workspace/cast-lock.js';
import {
  appendManualEntry,
  loadCastMerges,
  saveCastMerges,
  type CastMergeEntry,
} from '../store/cast-merges.js';
import type { CharacterOutput } from '../handoff/schemas.js';

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

const SYNC_WAIT_TIMEOUT_MS = 5_000;
const BODY = '“Are you sure this will work,” Nova asked.\n\nOlga nodded and looked away.';
const NOVA = {
  id: 'nova',
  name: 'Nova',
  role: 'lead',
  color: '#abc',
  evidence: [{ quote: 'Nova asked' }],
} as CharacterOutput;
const PRIOR_NOVA: Row = { id: 'nova', name: 'Nova', role: 'character', color: '#abc', aliases: [] };

/** Resolve when `p` does, or fail naming what never happened. */
async function within<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} within ${SYNC_WAIT_TIMEOUT_MS}ms`)), SYNC_WAIT_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const aliasesOfNova = (b: HarnessBook): unknown =>
  readCast(b.bookDir).find((c) => c.id === 'nova')?.aliases;

describe('#4031 rule 8 - a cast writer racing Start fresh', () => {
  const orig = process.env.STAGE2_COVERAGE_RETRIES;
  const books: HarnessBook[] = [];
  const app = express();
  app.use(express.json());
  app.use('/api/books', castAliasesRouter);

  beforeEach(() => {
    process.env.STAGE2_COVERAGE_RETRIES = '0';
  });
  afterEach(async () => {
    resetHarness();
    setPhase0Hook(undefined);
    if (orig === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
    else process.env.STAGE2_COVERAGE_RETRIES = orig;
    for (const b of books.splice(0)) await cleanupBook(b);
  });

  /** Start fresh, held in Phase 0 until `release()`. `reached` resolves when the run
      has finished its run-start block and entered the first detect call. */
  function startFresh(b: HarnessBook) {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let signalReached!: () => void;
    const reached = new Promise<void>((r) => {
      signalReached = r;
    });
    setPhase0Hook(async () => {
      signalReached();
      await held;
    });
    const { job } = mkJob(b.manuscriptId, b.bookDir, 'main');
    const rec = getManuscript(b.manuscriptId);
    if (!rec) throw new Error('manuscript missing');
    (globalThis as Record<string, unknown>)[PHASE1_GLOBAL] = sel(phase1('nova'), 'phase1-model');
    const done = runMainAnalyzerJob(job, rec as never, sel(phase0([NARR, NOVA]), 'phase0-model'), {
      requestedFresh: true,
      allowStage1Shrink: true,
      requestedModel: undefined,
    } as never);
    done.catch(() => {});
    return { reached, release, done };
  }

  const addAlias = (b: HarnessBook) =>
    request(app)
      .post(`/api/books/${b.bookId}/cast/add-alias`)
      .send({ characterId: 'nova', aliasName: 'Supernova' });

  it('rule 8: a cast writer racing Start fresh is not lost', async () => {
    const b = mkBook([{ ...NARR }, { ...PRIOR_NOVA }], undefined, BODY);
    books.push(b);
    const castPath = castJsonPath(b.bookDir);
    const actual = await vi.importActual<typeof import('../workspace/state-io.js')>('../workspace/state-io.js');

    /* Hold add-alias inside its cast lock, after it has read cast.json. */
    let gateOpen!: () => void;
    const gate = new Promise<void>((r) => {
      gateOpen = r;
    });
    let signalHeld!: () => void;
    const held = new Promise<void>((r) => {
      signalHeld = r;
    });
    let intercepted = false;
    vi.mocked(stateIo.readJson).mockImplementation(async (path: string) => {
      if (!intercepted && path === castPath) {
        intercepted = true;
        const value = await actual.readJson(path);
        signalHeld();
        await gate;
        return value;
      }
      return actual.readJson(path);
    });

    const aliasRes = addAlias(b).then((r) => r);
    aliasRes.catch(() => {});
    await within(held, 'add-alias never reached its in-lock cast.json read');

    const run = startFresh(b);
    /* The job's own locked prior read now queues behind add-alias's cast lock. */
    gateOpen();
    expect((await aliasRes).status).toBe(200);
    await within(run.reached, 'the run never reached Phase 0');

    /* Sampled at a moment the run-start block has fully run and nothing has
       written since (Phase 0 is held): Start fresh deleted nothing. */
    expect(existsSync(castPath)).toBe(true);
    expect(aliasesOfNova(b)).toEqual(['Supernova']);

    run.release();
    await within(run.done, 'the run never finished');
    expect(aliasesOfNova(b)).toEqual(expect.arrayContaining(['Supernova']));
  });

  /* The write lands (Start fresh no longer deletes cast.json, rule 8), and it SURVIVES the
     run's later interim and final writes to the end of the run (rule 13: a mid-run route
     write is respected). */
  it('rule 8 / rule 13: a cast writer landing after Start fresh began finds its cast, writes it, and the write survives to the end of the run', async () => {
    const b = mkBook([{ ...NARR }, { ...PRIOR_NOVA }], undefined, BODY);
    books.push(b);
    const run = startFresh(b);
    await within(run.reached, 'the run never reached Phase 0');

    const res = await addAlias(b);

    /* A deleted cast.json would answer 409 "Book has no cast on disk yet". */
    expect(res.status).toBe(200);
    expect(aliasesOfNova(b)).toEqual(['Supernova']);

    run.release();
    await within(run.done, 'the run never finished');
    /* The run's snapshots and its persist overlaid onto the cast as re-read: the alias is
       the whole alias list (the analyzer's own name equals the display name, so adds none),
       and the row kept its place. */
    expect(aliasesOfNova(b)).toEqual(['Supernova']);
    expect(readCast(b.bookDir).map((c) => c.id).sort()).toEqual(['narrator', 'nova']);
  });

  /* The journal ref clear is its own read-modify-write inside Start fresh, and the
     tests above never reach it (the job's locked prior read blocks first). Hold its
     journal read open, land a manual-merge append under the cast lock meanwhile, and
     release: with the clear cast-locked the append queues behind it and survives;
     unlocked, the clear writes back its stale read and the append is lost. */
  it('rule 8: a journal append racing the ref clear is kept', async () => {
    const b = mkBook([{ ...NARR }, { ...PRIOR_NOVA }], undefined, BODY);
    books.push(b);
    const mergesPath = castMergesJsonPath(b.bookDir);
    const seed: CastMergeEntry = {
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'manual',
      sourceId: 'zed',
      sourceName: 'Zed',
      targetId: 'nova',
      affected: [{ chapterId: 1, sentenceId: 1 }],
    };
    await saveCastMerges(b.bookDir, { entries: [seed] });
    const actual = await vi.importActual<typeof import('../workspace/state-io.js')>('../workspace/state-io.js');

    let gateOpen!: () => void;
    const gate = new Promise<void>((r) => {
      gateOpen = r;
    });
    let signalHeld!: () => void;
    const held = new Promise<void>((r) => {
      signalHeld = r;
    });
    let intercepted = false;
    vi.mocked(stateIo.readJson).mockImplementation(async (path: string) => {
      if (!intercepted && path === mergesPath) {
        intercepted = true;
        const value = await actual.readJson(path);
        signalHeld();
        await gate;
        return value;
      }
      return actual.readJson(path);
    });

    const run = startFresh(b);
    await within(held, 'the ref clear never read the journal');

    const appended = withCastLock(b.bookDir, async () => {
      const journal = await loadCastMerges(b.bookDir);
      await saveCastMerges(
        b.bookDir,
        appendManualEntry(journal, { ...seed, sourceId: 'racer', sourceName: 'Racer', affected: [] }),
      );
    });
    appended.catch(() => {});
    /* No positive signal exists for "the append is queued" (locked, it cannot start),
       so give it a few macrotasks to land if nothing is stopping it. */
    await new Promise((r) => setTimeout(r, 100));
    gateOpen();
    await within(appended, 'the racing append never finished');
    await within(run.reached, 'the run never reached Phase 0');
    run.release();
    await within(run.done, 'the run never finished');

    const ids = (await loadCastMerges(b.bookDir)).entries.map((e) => e.sourceId);
    expect(ids).toEqual(expect.arrayContaining(['zed', 'racer']));
  });
});
