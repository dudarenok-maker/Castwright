/* #3437 - the analysis jobs' cast.json writers drop a superseded run's write. Deterministic
   straggler: the test holds the book's cast lock, calls the writer from inside run 1's fence so
   it queues on the lock, registers run 2 (the epoch bump), then releases the lock. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import {
  materialisePriorAtRunStart,
  persistPlannedCast,
  writePlanSnapshot,
} from './analysis-cast-io.js';
import { withCastLock } from './cast-lock.js';
import { castJsonPath, manuscriptEditsJsonPath } from './paths.js';
import { AnalysisAbortedError, StaleRunEpochError } from '../analyzer/errors.js';
import {
  __resetRunEpochsForTests,
  beginRunEpoch,
  runWithRunEpoch,
} from '../store/analysis-run-epoch.js';
import type { MatchDecision, MatchPlan, RunAddedLedger } from '../store/reanalysis-types.js';

const BOOK_ID = 'bk-1';
const MS_ID = 'ms-1';

let workspaceRoot: string;
let bookDir: string;
let logSpy: { mock: { calls: unknown[][] }; mockRestore: () => void };

const row = (id: string, name: string) => ({ id, name, role: 'secondary', color: 'halloran', lines: 1, scenes: 1 });
const join = (rawId: string, priorId: string, tier = 'id'): MatchDecision =>
  ({ kind: 'join', rawId, priorId, tier }) as MatchDecision;
const planOf = (...ds: MatchDecision[]): MatchPlan => ({
  version: 1,
  runToken: 'tok',
  decisions: Object.fromEntries(ds.map((d) => [d.rawId, d])),
});

const castBytes = (): string => readFileSync(castJsonPath(bookDir), 'utf8');
const editsBytes = (): string => readFileSync(manuscriptEditsJsonPath(bookDir), 'utf8');

const heal = () =>
  materialisePriorAtRunStart({
    bookDir,
    bookId: BOOK_ID,
    staleLinkKeys: new Set<string>(),
    runOwnedIds: new Set<string>(),
    ledger: {} as RunAddedLedger,
  });
const snapshot = () =>
  writePlanSnapshot({
    bookDir,
    bookId: BOOK_ID,
    roster: [row('alice', 'Alice'), row('dina', 'Dina')] as any[],
    plan: planOf(join('alice', 'alice'), { kind: 'new', rawId: 'dina', id: 'dina', minted: false, suggest: [], inheritedDeclines: [] } as MatchDecision),
    ledger: {},
    runSuggestions: [],
  });
const persist = () =>
  persistPlannedCast({
    bookDir,
    bookId: BOOK_ID,
    plan: planOf(join('olya', 'olga', 'name')),
    roster: [row('olga', 'Ольга')] as any[],
    sentences: [{ characterId: 'olga', chapterId: 1, text: 'line' }] as any[],
    ledger: {} as RunAddedLedger,
    runSuggestions: [],
    runAddedPairs: [],
    driftRefused: false,
  });

/* Hold the cast lock, queue `call` behind it inside run 1's fence, supersede run 1, release. */
async function straggler<T>(call: () => Promise<T>): Promise<{ settled: PromiseSettledResult<T>; logs: string[] }> {
  const f1 = beginRunEpoch(MS_ID);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held!: () => void;
  const holding = new Promise<void>((r) => (held = r));
  const holder = withCastLock(bookDir, async () => {
    held();
    await gate;
  });
  await holding;
  const pending = runWithRunEpoch(f1, call);
  const outcome = pending.then(
    (value) => ({ status: 'fulfilled', value }) as PromiseFulfilledResult<T>,
    (reason) => ({ status: 'rejected', reason }) as PromiseRejectedResult,
  );
  beginRunEpoch(MS_ID);
  release();
  await holder;
  const settled = await outcome;
  const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
  return { settled, logs };
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(pathJoin(tmpdir(), 'analysis-cast-io-epoch-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  bookDir = pathJoin(workspaceRoot, 'books', 'A', 'Standalones', 'Book');
  mkdirSync(pathJoin(bookDir, '.audiobook'), { recursive: true });
  __resetRunEpochsForTests();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

const seed = (rows: Array<ReturnType<typeof row>>): void => {
  writeFileSync(castJsonPath(bookDir), JSON.stringify({ characters: rows }));
  writeFileSync(manuscriptEditsJsonPath(bookDir), JSON.stringify({ version: 1, sentences: [] }));
};

describe('#3437 stale-run drop in the analysis cast writers', () => {
  it('materialisePriorAtRunStart: a superseded run is dropped, cast.json untouched', async () => {
    // Two same-name rows would be healed (a write) by a live run.
    seed([row('alice', 'Alice'), row('alice-2', 'Alice')]);
    const before = castBytes();
    const { settled, logs } = await straggler(heal);
    expect(settled.status).toBe('rejected');
    const err = (settled as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(StaleRunEpochError);
    expect(err).toBeInstanceOf(AnalysisAbortedError);
    expect(castBytes()).toBe(before);
    expect(logs).toContain(
      '[analysis] dropped stale-run write: run-start heal cast.json manuscript="ms-1" runEpoch=1 current=2',
    );
  });

  it('writePlanSnapshot: a superseded run is dropped, cast.json untouched', async () => {
    seed([row('alice', 'Alice')]);
    const before = castBytes();
    const { settled, logs } = await straggler(snapshot);
    expect(settled.status).toBe('rejected');
    const err = (settled as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(StaleRunEpochError);
    expect(err).toBeInstanceOf(AnalysisAbortedError);
    expect(castBytes()).toBe(before);
    expect(logs).toContain(
      '[analysis] dropped stale-run write: plan snapshot cast.json manuscript="ms-1" runEpoch=1 current=2',
    );
  });

  it('persistPlannedCast: a superseded run is dropped, cast.json and manuscript-edits.json untouched', async () => {
    seed([row('olga', 'Ольга')]);
    const castBefore = castBytes();
    const editsBefore = editsBytes();
    const { settled, logs } = await straggler(persist);
    expect(settled.status).toBe('rejected');
    const err = (settled as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(StaleRunEpochError);
    expect(err).toBeInstanceOf(AnalysisAbortedError);
    expect(castBytes()).toBe(castBefore);
    expect(editsBytes()).toBe(editsBefore);
    expect(logs).toContain(
      '[analysis] dropped stale-run write: persist cast.json manuscript="ms-1" runEpoch=1 current=2',
    );
  });

  it('the current run (fence not superseded) writes as before', async () => {
    seed([row('alice', 'Alice')]);
    const f1 = beginRunEpoch(MS_ID);
    await runWithRunEpoch(f1, snapshot);
    expect(JSON.parse(castBytes()).characters.map((r: { id: string }) => r.id)).toEqual(['alice', 'dina']);
    expect(logSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('dropped stale-run write'))).toBe(false);
  });

  it('with no fence (not an analysis run) writes as before', async () => {
    seed([row('alice', 'Alice')]);
    beginRunEpoch(MS_ID);
    beginRunEpoch(MS_ID);
    await snapshot();
    expect(JSON.parse(castBytes()).characters.map((r: { id: string }) => r.id)).toEqual(['alice', 'dina']);
    await expect(heal()).resolves.toBeDefined();
  });
});
