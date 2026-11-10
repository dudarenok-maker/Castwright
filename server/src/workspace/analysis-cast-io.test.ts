/* #4031 Task 8 - the jobs' locked cast I/O. Real files in a temp workspace; the
   cast and book locks are wrapped (not replaced) so a test can see WHICH lock a
   write ran under and inject an acquisition timeout. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

const hooks = vi.hoisted(() => ({
  castFault: null as unknown,
  fingerprintFault: false,
  castDepth: 0,
  maxCastDepth: 0,
  bookLockCastDepths: [] as number[],
}));

vi.mock('./cast-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cast-lock.js')>();
  return {
    ...actual,
    withCastLock: async <T>(bookDir: string, fn: () => Promise<T>): Promise<T> => {
      if (hooks.castFault) throw hooks.castFault;
      return actual.withCastLock(bookDir, async () => {
        hooks.castDepth++;
        hooks.maxCastDepth = Math.max(hooks.maxCastDepth, hooks.castDepth);
        try {
          return await fn();
        } finally {
          hooks.castDepth--;
        }
      });
    },
  };
});

vi.mock('./cast-fingerprint.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cast-fingerprint.js')>();
  return {
    ...actual,
    readJsonWithFingerprint: async (path: string) =>
      hooks.fingerprintFault
        ? { value: null, fingerprint: actual.UNREADABLE }
        : actual.readJsonWithFingerprint(path),
  };
});

vi.mock('./book-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./book-lock.js')>();
  return {
    ...actual,
    withBookLock: async <T>(bookId: string, fn: () => Promise<T>): Promise<T> => {
      hooks.bookLockCastDepths.push(hooks.castDepth);
      return actual.withBookLock(bookId, fn);
    },
  };
});

import {
  materialisePriorAtRunStart,
  persistPlannedCast,
  readPriorCastLockFree,
  writePlanSnapshot,
} from './analysis-cast-io.js';
import { LockAcquisitionTimeoutError } from './file-lock.js';
import { castJsonPath, castReuseCarryoverJsonPath, manuscriptEditsJsonPath } from './paths.js';
import { castIdHistoryPath, loadCastIdHistoryWithStatus } from '../store/cast-id-history.js';
import { loadStoredSuggestions } from '../store/cast-merge-suggestions.js';
import { userOwnedFingerprint } from '../store/plan-overlay.js';
import type {
  MatchDecision,
  MatchPlan,
  RunAddedLedger,
  StoredSuggestion,
} from '../store/reanalysis-types.js';
import { castMergeSuggestionsJsonPath } from './paths.js';

const BOOK_ID = 'bk-1';

let workspaceRoot: string;
let bookDir: string;

type Row = { id: string } & Record<string, unknown>;

const row = (id: string, name: string, extra: Record<string, unknown> = {}): Row => ({
  id,
  name,
  role: 'secondary',
  color: 'halloran',
  lines: 1,
  scenes: 1,
  ...extra,
});
const roster = (...rows: Row[]): any[] => rows;
const sentences = (...ids: Array<string | [string, number]>): any[] =>
  ids.map((id, i) => {
    const [characterId, chapterId] = Array.isArray(id) ? id : [id, 1];
    return { characterId, chapterId, text: `line ${i}` };
  });

const join = (rawId: string, priorId: string, tier = 'id'): MatchDecision =>
  ({ kind: 'join', rawId, priorId, tier }) as MatchDecision;
const fresh = (rawId: string, id = rawId, suggest: string[] = []): MatchDecision => ({
  kind: 'new',
  rawId,
  id,
  minted: id !== rawId,
  suggest,
  inheritedDeclines: [],
});
const planOf = (...ds: MatchDecision[]): MatchPlan => ({
  version: 1,
  runToken: 'tok',
  decisions: Object.fromEntries(ds.map((d) => [d.rawId, d])),
});
const sug = (newRow: string, candidate: string): StoredSuggestion => ({
  sourceId: newRow,
  targetId: candidate,
  a: newRow < candidate ? newRow : candidate,
  b: newRow < candidate ? candidate : newRow,
  reason: 'same name',
  origin: 'plan',
  newRow,
  candidate,
});

const writeCast = (rows: Row[]): void =>
  writeFileSync(castJsonPath(bookDir), JSON.stringify({ characters: rows }));
const readCast = (): Row[] => JSON.parse(readFileSync(castJsonPath(bookDir), 'utf8')).characters;
const writeHistory = (h: Record<string, unknown>): void =>
  writeFileSync(castIdHistoryPath(bookDir), JSON.stringify({ schema: 1, supersededBy: {}, ...h }));
const writeSuggestions = (s: StoredSuggestion[]): void =>
  writeFileSync(castMergeSuggestionsJsonPath(bookDir), JSON.stringify({ suggestions: s }));
const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id);

beforeEach(() => {
  workspaceRoot = mkdtempSync(pathJoin(tmpdir(), 'analysis-cast-io-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  bookDir = pathJoin(workspaceRoot, 'books', 'A', 'Standalones', 'Book');
  mkdirSync(pathJoin(bookDir, '.audiobook'), { recursive: true });
  hooks.castFault = null;
  hooks.fingerprintFault = false;
  hooks.castDepth = 0;
  hooks.maxCastDepth = 0;
  hooks.bookLockCastDepths = [];
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('materialisePriorAtRunStart', () => {
  const base = { staleLinkKeys: new Set<string>(), runOwnedIds: new Set<string>(), ledger: {} as RunAddedLedger };

  it('A16: a carryover is written to cast.json at run start with ids, names, aliases and voices; its dismissal records stay readable', async () => {
    writeFileSync(
      castReuseCarryoverJsonPath(bookDir),
      JSON.stringify({
        characters: [
          row('olga', 'Ольга', {
            aliases: ['Оля'],
            voiceId: 'v_olga',
            voiceState: 'locked',
            overrideTtsVoices: { qwen: { name: 'q-olga' } },
          }),
        ],
      }),
    );
    writeHistory({ notSamePerson: [{ a: 'olga', b: 'olya', at: '2026-11-01T00:00:00.000Z' }] });

    const out = await materialisePriorAtRunStart({ bookDir, bookId: BOOK_ID, ...base });

    expect(out.source).toBe('carryover');
    const [olga] = readCast();
    expect(olga).toMatchObject({
      id: 'olga',
      name: 'Ольга',
      aliases: ['Оля'],
      voiceId: 'v_olga',
      voiceState: 'locked',
      overrideTtsVoices: { qwen: { name: 'q-olga' } },
    });
    // The re-read the later snapshots do now has a file to read.
    expect((await readPriorCastLockFree(bookDir)).source).toBe('cast');
    // The dismissal record lives in cast-id-history, which this write never touches.
    const history = await loadCastIdHistoryWithStatus(bookDir);
    expect(history.status).toBe('ok');
    expect(history.history.notSamePerson).toEqual([{ a: 'olga', b: 'olya', at: '2026-11-01T00:00:00.000Z' }]);
    expect(hooks.maxCastDepth).toBe(1);
  });

  it('the heal is written to cast.json, so a re-read does not undo it', async () => {
    writeCast([
      row('anton', 'Антон', { voiceState: 'tuned', voiceUuid: 'U1', lines: 40 }),
      row('антон', 'Антон', { voiceState: 'generated', lines: 2 }),
    ]);

    const out = await materialisePriorAtRunStart({ bookDir, bookId: BOOK_ID, ...base });

    expect(out.healRetirements).toEqual([{ from: 'антон', to: 'anton' }]);
    expect(ids(out.prior)).toEqual(['anton']);
    expect(ids(readCast())).toEqual(['anton']);
    expect(ids((await readPriorCastLockFree(bookDir)).rows)).toEqual(['anton']);
  });

  it('the heal reads the open suggestions inside the lock and skips a pair that has one', async () => {
    writeCast([row('anton', 'Антон'), row('антон', 'Антон')]);
    writeSuggestions([sug('anton', 'антон')]);
    const out = await materialisePriorAtRunStart({ bookDir, bookId: BOOK_ID, ...base });
    expect(out.healRetirements).toEqual([]);
    expect(ids(readCast())).toEqual(['anton', 'антон']);
  });

  it('an unreadable suggestions file disables the heal for the run instead of failing it', async () => {
    writeCast([row('anton', 'Антон'), row('антон', 'Антон')]);
    writeFileSync(castMergeSuggestionsJsonPath(bookDir), '{ not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await materialisePriorAtRunStart({ bookDir, bookId: BOOK_ID, ...base });
      expect(out.healRetirements).toEqual([]);
      expect(ids(readCast())).toEqual(['anton', 'антон']);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('writes nothing when there is nothing to change', async () => {
    writeCast([row('alice', 'Alice')]);
    const before = readFileSync(castJsonPath(bookDir), 'utf8');
    await materialisePriorAtRunStart({ bookDir, bookId: BOOK_ID, ...base });
    expect(readFileSync(castJsonPath(bookDir), 'utf8')).toBe(before);
  });

  it('R1: a run-added row the stale-link prune touches is compared first, then its fingerprint refreshed', async () => {
    const linked = row('narrator', 'Narrator', {
      voiceId: 'narrator',
      voiceState: 'reused',
      matchedFrom: { bookId: 'old-book', characterId: 'narrator' },
    });
    writeCast([linked]);
    const ledger: RunAddedLedger = { narrator: { state: 'run-owned', fp: userOwnedFingerprint(linked) } };
    const out = await materialisePriorAtRunStart({
      bookDir,
      bookId: BOOK_ID,
      ...base,
      staleLinkKeys: new Set(['narrator\u0000old-book']),
      ledger,
    });
    const [written] = readCast();
    expect(written.matchedFrom).toBeUndefined();
    expect(out.ledger.narrator).toEqual({ state: 'run-owned', fp: userOwnedFingerprint(written) });
  });

  it('R1: a run-added row the user changed since the job last wrote it becomes added-once', async () => {
    const original = row('narrator', 'Narrator', {
      voiceState: 'reused',
      matchedFrom: { bookId: 'old-book', characterId: 'narrator' },
    });
    const ledger: RunAddedLedger = { narrator: { state: 'run-owned', fp: userOwnedFingerprint(original) } };
    writeCast([{ ...original, voiceId: 'user-picked' }]);
    const out = await materialisePriorAtRunStart({
      bookDir,
      bookId: BOOK_ID,
      ...base,
      staleLinkKeys: new Set(['narrator\u0000old-book']),
      ledger,
    });
    expect(out.ledger.narrator).toEqual({ state: 'added-once' });
  });
});

describe('writePlanSnapshot', () => {
  const alice = row('alice', 'Alice');
  const bob = row('bob', 'Bob');
  const carl = row('carl', 'Carl');
  const dina = row('dina', 'Dina');
  const snapshotPlan = (): MatchPlan =>
    planOf(join('alice', 'alice'), join('bob', 'bob'), join('carl', 'carl'), fresh('dina', 'dina', ['carl']));

  it('Q3: the Phase-0b snapshot writes the plan\'s suggestions', async () => {
    writeCast([alice, carl]);
    const out = await writePlanSnapshot({
      bookDir,
      bookId: BOOK_ID,
      roster: roster(alice, carl, dina),
      plan: snapshotPlan(),
      ledger: {},
      runSuggestions: [sug('dina', 'carl')],
    });
    expect(ids(readCast())).toEqual(['alice', 'carl', 'dina']);
    expect((await loadStoredSuggestions(bookDir)).map((s) => [s.a, s.b])).toEqual([['carl', 'dina']]);
    expect(out.addedPairs).toEqual([['carl', 'dina']]);
    expect(out.ledger.dina?.state).toBe('run-owned');
  });

  it('A13: a merge and a dismissal made after the plan survive the next snapshot', async () => {
    writeCast([alice, bob, carl]);
    const r = roster(alice, bob, carl, dina);
    const first = await writePlanSnapshot({
      bookDir,
      bookId: BOOK_ID,
      roster: r,
      plan: snapshotPlan(),
      ledger: {},
      runSuggestions: [sug('dina', 'carl')],
    });
    expect(ids(readCast())).toEqual(['alice', 'bob', 'carl', 'dina']);

    // The user merges bob into alice and dismisses carl/dina, mid-run.
    writeCast([
      { ...alice, aliases: ['Bobby'] },
      { ...carl, notLinkedTo: [{ bookId: BOOK_ID, characterId: 'dina' }] },
      readCast().find((c) => c.id === 'dina') as Row,
    ]);
    writeHistory({
      supersededBy: { bob: 'alice' },
      notSamePerson: [{ a: 'carl', b: 'dina', at: '2026-11-01T00:00:00.000Z' }],
    });
    writeSuggestions([]);

    const second = await writePlanSnapshot({
      bookDir,
      bookId: BOOK_ID,
      roster: r,
      plan: first.plan,
      ledger: first.ledger,
      runSuggestions: [sug('dina', 'carl')],
    });

    const cast = readCast();
    expect(ids(cast)).toEqual(['alice', 'carl', 'dina']); // bob is not re-added
    expect(cast.find((c) => c.id === 'alice')?.aliases).toEqual(expect.arrayContaining(['Bobby', 'Bob']));
    expect(cast.find((c) => c.id === 'carl')?.notLinkedTo).toEqual([{ bookId: BOOK_ID, characterId: 'dina' }]);
    expect(await loadStoredSuggestions(bookDir)).toEqual([]); // the dismissed pair is not re-suggested
    expect(second.addedPairs).toEqual([]);
    expect(hooks.maxCastDepth).toBe(1);
  });

  it('item 12: a snapshot re-mints a new id that went live on disk', async () => {
    // A route created `wren` after the plan chose to keep that raw id for a new row.
    writeCast([row('wren', 'Wren', { voiceId: 'user-voice' })]);
    const out = await writePlanSnapshot({
      bookDir,
      bookId: BOOK_ID,
      roster: roster(row('wren', 'Wren the Fresh')),
      plan: planOf(fresh('wren')),
      ledger: {},
      runSuggestions: [],
    });
    expect(out.idMap).toEqual({ wren: 'wren-n1' });
    expect(out.plan.decisions.wren).toMatchObject({ kind: 'new', id: 'wren-n1', minted: true });
    const cast = readCast();
    expect(ids(cast)).toEqual(['wren', 'wren-n1']);
    expect(cast[0]).toMatchObject({ name: 'Wren', voiceId: 'user-voice' }); // the live row is untouched
    expect(out.ledger['wren-n1']?.state).toBe('run-owned');
    expect(out.ledger.wren).toBeUndefined();
  });

  it('item 12: the re-minted id also follows the run\'s suggestions', async () => {
    writeCast([row('wren', 'Wren'), carl]);
    await writePlanSnapshot({
      bookDir,
      bookId: BOOK_ID,
      roster: roster(row('wren', 'Wren the Fresh')),
      plan: planOf(fresh('wren', 'wren', ['carl'])),
      ledger: {},
      runSuggestions: [sug('wren', 'carl')],
    });
    expect((await loadStoredSuggestions(bookDir)).map((s) => [s.a, s.b])).toEqual([['carl', 'wren-n1']]);
  });

  it('R2: a stopped main run\'s row the snapshot rewrites is compared, then refreshed, in mainLedger', async () => {
    writeCast([alice]);
    const mainLedger: RunAddedLedger = { alice: { state: 'run-owned', fp: userOwnedFingerprint(alice) } };
    const out = await writePlanSnapshot({
      bookDir,
      bookId: BOOK_ID,
      roster: roster(row('alice', 'Alice', { aliases: ['Al'] })),
      plan: planOf(join('alice', 'alice')),
      ledger: {},
      runSuggestions: [],
      mainLedger,
    });
    const [written] = readCast();
    expect(written.aliases).toEqual(['Al']);
    expect(out.mainLedger?.alice).toEqual({ state: 'run-owned', fp: userOwnedFingerprint(written) });
  });

  it('R2: a main-run row the user changed since the main job wrote it becomes added-once', async () => {
    writeCast([{ ...alice, voiceId: 'user-picked' }]);
    const mainLedger: RunAddedLedger = { alice: { state: 'run-owned', fp: userOwnedFingerprint(alice) } };
    const out = await writePlanSnapshot({
      bookDir,
      bookId: BOOK_ID,
      roster: roster(row('alice', 'Alice', { aliases: ['Al'] })),
      plan: planOf(join('alice', 'alice')),
      ledger: {},
      runSuggestions: [],
      mainLedger,
    });
    expect(out.mainLedger?.alice).toEqual({ state: 'added-once' });
  });

  it('without a mainLedger it returns none', async () => {
    writeCast([alice]);
    const out = await writePlanSnapshot({
      bookDir,
      bookId: BOOK_ID,
      roster: roster(alice),
      plan: planOf(join('alice', 'alice')),
      ledger: {},
      runSuggestions: [],
    });
    expect(out.mainLedger).toBeUndefined();
  });
});

describe('persistPlannedCast', () => {
  const persistArgs = (over: Partial<Parameters<typeof persistPlannedCast>[0]> = {}) => ({
    bookDir,
    bookId: BOOK_ID,
    plan: planOf(join('olya', 'olga', 'name')),
    roster: roster(row('olga', 'Ольга')),
    sentences: sentences('olga'),
    ledger: {} as RunAddedLedger,
    runSuggestions: [] as StoredSuggestion[],
    runAddedPairs: [] as Array<[string, string]>,
    driftRefused: false,
    ...over,
  });

  it('the persist takes the book lock inside the cast lock and records no retirement under it', async () => {
    writeCast([row('olga', 'Ольга')]);
    const out = await persistPlannedCast(persistArgs());
    expect(hooks.bookLockCastDepths.length).toBeGreaterThan(0);
    expect(hooks.bookLockCastDepths.every((d) => d === 1)).toBe(true);
    expect(hooks.maxCastDepth).toBe(1);
    // The join's retirement is RETURNED for the caller to record after the lock;
    // nothing wrote cast-id-history.json here.
    expect(out.retirements).toEqual([{ from: 'olya', to: 'olga' }]);
    expect(existsSync(castIdHistoryPath(bookDir))).toBe(false);
  });

  it('a cast-lock timeout on the persist surfaces as LockAcquisitionTimeoutError', async () => {
    writeCast([row('olga', 'Ольга')]);
    const before = readFileSync(castJsonPath(bookDir), 'utf8');
    hooks.castFault = new LockAcquisitionTimeoutError('cast-key', 10);
    await expect(persistPlannedCast(persistArgs())).rejects.toBeInstanceOf(LockAcquisitionTimeoutError);
    expect(readFileSync(castJsonPath(bookDir), 'utf8')).toBe(before);
  });

  it('A24: a drift-refused persist writes edits only and removes the run\'s added pairs', async () => {
    writeCast([row('alice', 'Alice'), row('carl', 'Carl')]);
    const castBefore = readFileSync(castJsonPath(bookDir), 'utf8');
    writeSuggestions([sug('alice', 'carl'), sug('alice', 'zed')]);
    await persistPlannedCast(
      persistArgs({
        plan: planOf(join('alice', 'alice'), join('carl', 'carl')),
        roster: roster(row('alice', 'Alice'), row('carl', 'Carl')),
        sentences: sentences('alice', 'carl'),
        runAddedPairs: [['alice', 'carl']],
        driftRefused: true,
      }),
    );
    expect(readFileSync(castJsonPath(bookDir), 'utf8')).toBe(castBefore);
    const edits = JSON.parse(readFileSync(manuscriptEditsJsonPath(bookDir), 'utf8'));
    expect(edits.sentences.map((s: { characterId: string }) => s.characterId)).toEqual(['alice', 'carl']);
    expect((await loadStoredSuggestions(bookDir)).map((s) => [s.a, s.b])).toEqual([['alice', 'zed']]);
  });

  it('a drift-refused persist still reroutes a target the user deleted', async () => {
    writeCast([row('char-narrator', 'Narrator'), row('alice', 'Alice')]);
    const out = await persistPlannedCast(
      persistArgs({
        plan: planOf(join('alice', 'alice'), join('bob', 'bob')),
        roster: roster(row('alice', 'Alice'), row('bob', 'Bob')),
        sentences: sentences('alice', 'bob'),
        driftRefused: true,
      }),
    );
    expect(out.deletedTargets).toEqual(['bob']);
    const edits = JSON.parse(readFileSync(manuscriptEditsJsonPath(bookDir), 'utf8'));
    expect(edits.sentences[1]).toMatchObject({ characterId: 'char-narrator', priorCharacterId: 'bob' });
  });

  it('a bucket row created after Phase 0b persists without a throw', async () => {
    writeCast([row('alice', 'Alice')]);
    const out = await persistPlannedCast(
      persistArgs({
        plan: planOf(join('alice', 'alice')),
        roster: roster(row('alice', 'Alice'), row('unknown-male', 'Unknown male')),
        sentences: sentences('alice', 'unknown-male'),
      }),
    );
    expect(ids(readCast())).toEqual(['alice', 'unknown-male']);
    expect(out.plan.decisions['unknown-male']).toMatchObject({ kind: 'new', id: 'unknown-male' });
  });

  it('item 11: a bucket id joins a prior bucket row and keeps its name', async () => {
    writeCast([row('unknown-male', 'Minor men'), row('alice', 'Alice')]);
    await persistPlannedCast(
      persistArgs({
        plan: planOf(join('alice', 'alice')),
        roster: roster(row('alice', 'Alice'), row('unknown-male', 'Unknown male')),
        sentences: sentences('unknown-male'),
      }),
    );
    expect(readCast().find((c) => c.id === 'unknown-male')?.name).toBe('Minor men');
  });

  it('a deleted target reroutes to the book\'s own narrator id, not a hard-coded one', async () => {
    writeCast([row('char-narrator', 'Narrator'), row('alice', 'Alice')]);
    const out = await persistPlannedCast(
      persistArgs({
        plan: planOf(join('narrator', 'char-narrator', 'narrator'), join('alice', 'alice'), join('bob', 'bob')),
        roster: roster(row('narrator', 'Narrator'), row('alice', 'Alice'), row('bob', 'Bob')),
        sentences: sentences('bob', 'alice'),
      }),
    );
    expect(out.deletedTargets).toEqual(['bob']);
    expect(out.sentences[0]).toMatchObject({ characterId: 'char-narrator', priorCharacterId: 'bob' });
    expect(ids(readCast())).not.toContain('bob');
  });

  it('this run\'s narrator sentences take the prior narrator id and a merged-away target\'s take its survivor', async () => {
    writeCast([row('char-narrator', 'Narrator'), row('alice', 'Alice')]);
    writeHistory({ supersededBy: { bob: 'alice' } });
    const out = await persistPlannedCast(
      persistArgs({
        plan: planOf(join('narrator', 'char-narrator', 'narrator'), join('alice', 'alice'), join('bob', 'bob')),
        roster: roster(row('narrator', 'Narrator'), row('alice', 'Alice'), row('bob', 'Bob')),
        sentences: sentences('narrator', 'bob', 'alice'),
      }),
    );
    expect(out.sentences.map((s) => s.characterId)).toEqual(['char-narrator', 'alice', 'alice']);
    const edits = JSON.parse(readFileSync(manuscriptEditsJsonPath(bookDir), 'utf8'));
    expect(edits.sentences.map((s: { characterId: string }) => s.characterId)).toEqual([
      'char-narrator',
      'alice',
      'alice',
    ]);
    expect(out.deletedTargets).toEqual([]);
  });

  it('recounts lines and scenes from the final sentences', async () => {
    writeCast([row('char-narrator', 'Narrator'), row('alice', 'Alice')]);
    writeHistory({ supersededBy: { bob: 'alice' } });
    await persistPlannedCast(
      persistArgs({
        plan: planOf(join('narrator', 'char-narrator', 'narrator'), join('alice', 'alice'), join('bob', 'bob')),
        roster: roster(
          row('narrator', 'Narrator', { lines: 9, scenes: 9 }),
          row('alice', 'Alice', { lines: 9, scenes: 9 }),
          row('bob', 'Bob', { lines: 9, scenes: 9 }),
        ),
        sentences: sentences(['narrator', 1], ['bob', 2], ['alice', 2]),
      }),
    );
    const cast = readCast();
    expect(cast.find((c) => c.id === 'char-narrator')).toMatchObject({ lines: 1, scenes: 1 });
    expect(cast.find((c) => c.id === 'alice')).toMatchObject({ lines: 2, scenes: 1 });
  });

  it('item 12 (persist): a new id that went live on disk is re-minted and this run\'s sentences follow', async () => {
    writeCast([row('wren', 'Wren', { voiceId: 'user-voice' })]);
    const out = await persistPlannedCast(
      persistArgs({
        plan: planOf(fresh('wren')),
        roster: roster(row('wren', 'Wren the Fresh')),
        sentences: sentences('wren'),
      }),
    );
    expect(ids(readCast())).toEqual(['wren', 'wren-n1']);
    expect(readCast()[0]).toMatchObject({ name: 'Wren', voiceId: 'user-voice' });
    expect(out.sentences[0].characterId).toBe('wren-n1');
    expect(out.plan.decisions.wren).toMatchObject({ id: 'wren-n1', minted: true });
  });

  it('writes cast.json, the returned characters, the ledger-driven drop and the suggestions', async () => {
    const dropMe = row('ghost', 'Ghost');
    writeCast([row('alice', 'Alice'), dropMe]);
    const ledger: RunAddedLedger = { ghost: { state: 'run-owned', fp: userOwnedFingerprint(dropMe) } };
    const out = await persistPlannedCast(
      persistArgs({
        plan: planOf(join('alice', 'alice'), fresh('dina', 'dina', ['alice'])),
        roster: roster(row('alice', 'Alice'), row('dina', 'Dina')),
        sentences: sentences('alice', 'dina'),
        ledger,
        runSuggestions: [sug('dina', 'alice')],
      }),
    );
    expect(ids(readCast())).toEqual(['alice', 'dina']); // the run-added, unedited, unheld `ghost` is dropped
    expect(ids(out.characters)).toEqual(['alice', 'dina']);
    expect((await loadStoredSuggestions(bookDir)).map((s) => [s.a, s.b])).toEqual([['alice', 'dina']]);
  });

  it('R2: the subset persist refreshes the main run\'s ledger entry for a row it writes', async () => {
    const alice = row('alice', 'Alice');
    writeCast([alice]);
    const mainLedger: RunAddedLedger = { alice: { state: 'run-owned', fp: userOwnedFingerprint(alice) } };
    const out = await persistPlannedCast(
      persistArgs({
        plan: planOf(join('alice', 'alice')),
        roster: roster(row('alice', 'Alice', { aliases: ['Al'] })),
        sentences: sentences('alice'),
        mainLedger,
      }),
    );
    expect(out.mainLedger?.alice).toEqual({ state: 'run-owned', fp: userOwnedFingerprint(readCast()[0]) });
  });
});

describe('fix round 1 (#4031 Task 8 review)', () => {
  const persistArgs = (over: Partial<Parameters<typeof persistPlannedCast>[0]> = {}) => ({
    bookDir,
    bookId: BOOK_ID,
    plan: planOf(),
    roster: roster(),
    sentences: sentences(),
    ledger: {} as RunAddedLedger,
    runSuggestions: [] as StoredSuggestion[],
    runAddedPairs: [] as Array<[string, string]>,
    driftRefused: false,
    ...over,
  });

  it('C1: a persist over a plan-applied roster never re-applies the plan (a joined prior id that is also a new row\'s raw key)', async () => {
    // fresh `wren:"Bob"` -> new `wren-n1`; fresh `w2:"Wren"` -> join `wren`.
    writeCast([row('wren', 'Wren', { lines: 5 }), row('bobby', 'Bob')]);
    const plan = planOf(
      { kind: 'new', rawId: 'wren', id: 'wren-n1', minted: true, suggest: ['bobby', 'wren'], inheritedDeclines: [] },
      join('w2', 'wren', 'name'),
    );
    const out = await persistPlannedCast(
      persistArgs({
        plan,
        roster: roster(row('wren-n1', 'Bob'), row('wren', 'Wren')),
        sentences: sentences('wren-n1', 'wren'),
      }),
    );
    expect(out.sentences.map((s) => s.characterId)).toEqual(['wren-n1', 'wren']);
    const cast = readCast();
    expect(cast.find((c) => c.id === 'wren')).toMatchObject({ name: 'Wren', lines: 1 });
    expect(cast.find((c) => c.id === 'wren-n1')).toMatchObject({ name: 'Bob', lines: 1 });
    expect(out.idMap).toEqual({});
  });

  describe('R2: the subset job honours the main run\'s ledger', () => {
    const dinaRow = row('dina', 'Dina');
    const mainLedgerFor = (r: Row): RunAddedLedger => ({ dina: { state: 'run-owned', fp: userOwnedFingerprint(r) } });

    it('a snapshot does not re-mint a row the main run added, and refreshes its mainLedger entry', async () => {
      writeCast([row('alice', 'Alice'), dinaRow]);
      const out = await writePlanSnapshot({
        bookDir,
        bookId: BOOK_ID,
        roster: roster(row('alice', 'Alice'), row('dina', 'Dina', { aliases: ['D'] })),
        plan: planOf(join('alice', 'alice'), fresh('dina')),
        ledger: {},
        runSuggestions: [],
        mainLedger: mainLedgerFor(dinaRow),
      });
      expect(out.idMap).toEqual({});
      expect(ids(readCast())).toEqual(['alice', 'dina']);
      expect(readCast()[1].aliases).toEqual(['D']);
      expect(out.mainLedger?.dina).toEqual({ state: 'run-owned', fp: userOwnedFingerprint(readCast()[1]) });
    });

    it('a snapshot never re-adds a main-run row the user deleted (added-once)', async () => {
      writeCast([row('alice', 'Alice')]);
      const out = await writePlanSnapshot({
        bookDir,
        bookId: BOOK_ID,
        roster: roster(row('alice', 'Alice'), dinaRow),
        plan: planOf(join('alice', 'alice'), fresh('dina')),
        ledger: {},
        runSuggestions: [],
        mainLedger: { dina: { state: 'added-once' } },
      });
      expect(ids(readCast())).toEqual(['alice']);
      expect(out.idMap).toEqual({});
    });

    it('a persist does not re-mint a main-run row either, and keeps its own drops to its own ledger', async () => {
      writeCast([row('alice', 'Alice'), dinaRow]);
      const out = await persistPlannedCast(
        persistArgs({
          plan: planOf(join('alice', 'alice'), fresh('dina')),
          roster: roster(row('alice', 'Alice'), row('dina', 'Dina', { aliases: ['D'] })),
          sentences: sentences('alice', 'dina'),
          mainLedger: mainLedgerFor(dinaRow),
        }),
      );
      expect(ids(readCast())).toEqual(['alice', 'dina']);
      expect(out.sentences.map((s) => s.characterId)).toEqual(['alice', 'dina']);
      expect(out.mainLedger?.dina).toEqual({ state: 'run-owned', fp: userOwnedFingerprint(readCast()[1]) });
      expect(out.droppedRunAdded).toEqual([]);
    });
  });

  it('I2: a corrupt suggestions file does not make the snapshot throw after cast.json is written; the next snapshot does not re-mint', async () => {
    writeCast([row('alice', 'Alice')]);
    writeFileSync(castMergeSuggestionsJsonPath(bookDir), '{ nope');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const args = {
        bookDir,
        bookId: BOOK_ID,
        roster: roster(row('alice', 'Alice'), row('dina', 'Dina')),
        plan: planOf(join('alice', 'alice'), fresh('dina', 'dina', ['alice'])),
        runSuggestions: [sug('dina', 'alice')],
      };
      const first = await writePlanSnapshot({ ...args, ledger: {} });
      expect(first.addedPairs).toEqual([]);
      expect(first.ledger.dina?.state).toBe('run-owned');
      const second = await writePlanSnapshot({ ...args, plan: first.plan, ledger: first.ledger });
      expect(second.idMap).toEqual({});
      expect(ids(readCast())).toEqual(['alice', 'dina']);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  describe('I3: run start never overwrites an unreadable cast.json with a stale carryover', () => {
    const base = { staleLinkKeys: new Set<string>(), runOwnedIds: new Set<string>(), ledger: {} as RunAddedLedger };
    const stale = (): void =>
      writeFileSync(castReuseCarryoverJsonPath(bookDir), JSON.stringify({ characters: [row('old', 'Old')] }));

    it('an unparseable cast.json fails the run with a curated message and writes nothing', async () => {
      writeFileSync(castJsonPath(bookDir), '{"characters": [');
      stale();
      const before = readFileSync(castJsonPath(bookDir), 'utf8');
      await expect(materialisePriorAtRunStart({ bookDir, bookId: BOOK_ID, ...base })).rejects.toMatchObject({
        name: 'PriorCastUnreadableError',
        reason: 'corrupt',
        message: expect.not.stringContaining(workspaceRoot),
      });
      expect(readFileSync(castJsonPath(bookDir), 'utf8')).toBe(before);
    });

    it('an unreadable (EBUSY-style) cast.json does the same', async () => {
      writeCast([row('alice', 'Alice')]);
      stale();
      const before = readFileSync(castJsonPath(bookDir), 'utf8');
      hooks.fingerprintFault = true;
      await expect(materialisePriorAtRunStart({ bookDir, bookId: BOOK_ID, ...base })).rejects.toMatchObject({
        name: 'PriorCastUnreadableError',
        reason: 'unreadable',
      });
      expect(readFileSync(castJsonPath(bookDir), 'utf8')).toBe(before);
    });

    it.each(['{}', '{"other":1}', '{"characters":{}}', 'null', '[]'])(
      'a cast.json that parses but is not a cast (%s) is corrupt, not an empty cast',
      async (body) => {
        writeFileSync(castJsonPath(bookDir), body);
        stale();
        await expect(materialisePriorAtRunStart({ bookDir, bookId: BOOK_ID, ...base })).rejects.toMatchObject({
          name: 'PriorCastUnreadableError',
          reason: 'corrupt',
        });
        expect(readFileSync(castJsonPath(bookDir), 'utf8')).toBe(body);
      },
    );

    it('a cast.json that parses with an empty characters array still takes the carryover', async () => {
      writeCast([]);
      stale();
      const out = await materialisePriorAtRunStart({ bookDir, bookId: BOOK_ID, ...base });
      expect(out.source).toBe('carryover');
      expect(ids(readCast())).toEqual(['old']);
    });
  });

  it('Minor 1: an edits-write failure after cast.json landed still hands the caller the outcome', async () => {
    writeCast([row('olga', 'Ольга')]);
    mkdirSync(manuscriptEditsJsonPath(bookDir)); // a directory where the file goes: the write fails
    const err = await persistPlannedCast(
      persistArgs({
        plan: planOf(join('olya', 'olga', 'name')),
        roster: roster(row('olga', 'Ольга', { aliases: ['Оля'] })),
        sentences: sentences('olga'),
      }),
    ).then(
      () => null,
      (e: unknown) => e as { persistOutcome?: { retirements: unknown; written: unknown } },
    );
    expect(err).not.toBeNull();
    expect(err?.persistOutcome?.retirements).toEqual([{ from: 'olya', to: 'olga' }]);
    expect(err?.persistOutcome?.written).not.toBeNull();
    expect(readCast()[0].aliases).toEqual(['Оля']);
  });

  it('Minor 2: a degraded history records no retirements, and says so server-side', async () => {
    writeCast([row('olga', 'Ольга')]);
    writeFileSync(castIdHistoryPath(bookDir), '{ not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await persistPlannedCast(
        persistArgs({ plan: planOf(join('olya', 'olga', 'name')), roster: roster(row('olga', 'Ольга')), sentences: sentences('olga') }),
      );
      expect(out.retirements).toEqual([]);
      expect(warn.mock.calls.some((c) => /retirement/i.test(String(c[0])))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('Minor 2: the narrator join records no retirement', async () => {
    writeCast([row('char-narrator', 'Narrator')]);
    const out = await persistPlannedCast(
      persistArgs({
        plan: planOf(join('narrator', 'char-narrator', 'narrator')),
        roster: roster(row('narrator', 'Narrator')),
        sentences: sentences('narrator'),
      }),
    );
    expect(out.retirements).toEqual([]);
    expect(out.sentences[0].characterId).toBe('char-narrator');
  });

  it('Minor 3: an unreadable suggestions file is warned about when the persist plans a new row', async () => {
    writeCast([row('alice', 'Alice')]);
    writeFileSync(castMergeSuggestionsJsonPath(bookDir), '{ nope');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await persistPlannedCast(
        persistArgs({
          plan: planOf(join('alice', 'alice')),
          roster: roster(row('alice', 'Alice'), row('unknown-male', 'Unknown male')),
          sentences: sentences('alice'),
        }),
      );
      expect(warn.mock.calls.some((c) => /could not be read/i.test(String(c[0])))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
