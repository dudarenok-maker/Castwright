/* #3713 step 3 -- duplicate-bookId detection + twin ranking. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* Paths whose read throws EBUSY (state.json) or EPERM (cast.json); everything
   else is the real reader. */
const faultedState = vi.hoisted(() => new Set<string>());
const faultedCast = vi.hoisted(() => new Set<string>());

vi.mock('./state-migrate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./state-migrate.js')>();
  return {
    ...actual,
    readStateJsonWithRecovery: async (path: string) => {
      if (faultedState.has(path)) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${path}'`), { code: 'EBUSY' });
      }
      return actual.readStateJsonWithRecovery(path);
    },
  };
});

vi.mock('./state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./state-io.js')>();
  return {
    ...actual,
    readJson: async (path: string) => {
      if (faultedCast.has(path)) {
        throw Object.assign(new Error(`EPERM: operation not permitted, open '${path}'`), { code: 'EPERM' });
      }
      return actual.readJson(path);
    },
  };
});

let workspaceRoot: string;
let paths: typeof import('./paths.js');
let lock: typeof import('./book-op-lock.js');
let sweep: typeof import('./duplicate-bookid-sweep.js');
let warn: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-dup-bookid-sweep-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Sequential imports -- a Promise.all of dynamic imports races vi.mock factories (#2083). */
  paths = await import('./paths.js');
  lock = await import('./book-op-lock.js');
  sweep = await import('./duplicate-bookid-sweep.js');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

afterEach(() => {
  faultedState.clear();
  faultedCast.clear();
  warn.mockClear();
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  lock.__bookDirIndexForTest().clear();
  lock.__duplicateBookIdsForTest().clear();
});

interface SeedOpts {
  rendered?: number;
  unrendered?: number;
  cast?: number; // undefined => no cast.json
  createdAt?: string;
}

function seed(author: string, series: string, title: string, bookId: string, o: SeedOpts = {}): string {
  const dir = join(paths.BOOKS_ROOT, author, series, title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  const chapters: Record<string, unknown>[] = [];
  for (let i = 0; i < (o.rendered ?? 0); i++) {
    chapters.push({ id: chapters.length + 1, title: `C${i}`, slug: `r${i}`, audioRenderedAt: '2026-02-01T00:00:00.000Z' });
  }
  for (let i = 0; i < (o.unrendered ?? 1); i++) {
    chapters.push({ id: chapters.length + 1, title: `U${i}`, slug: `u${i}` });
  }
  const state: Record<string, unknown> = {
    bookId,
    manuscriptId: `m_${title}`,
    title,
    author,
    series,
    seriesPosition: null,
    isStandalone: false,
    manuscriptFile: 'manuscript.md',
    castConfirmed: false,
    chapters,
    coverGradient: ['#000', '#fff'],
    updatedAt: '2026-01-01T00:00:00.000Z',
    language: 'en',
  };
  if (o.createdAt !== undefined) state.createdAt = o.createdAt;
  writeFileSync(paths.stateJsonPath(dir), JSON.stringify(state));
  if (o.cast !== undefined) {
    writeFileSync(
      paths.castJsonPath(dir),
      JSON.stringify({ characters: Array.from({ length: o.cast }, (_, i) => ({ id: `c${i}` })) }),
    );
  }
  return dir;
}

const twin = (
  dir: string,
  walkIndex: number,
  over: Partial<import('./duplicate-bookid-sweep.js').TwinRankInput> = {},
) => ({ dir, walkIndex, renderedChapters: 0, castRows: 0, createdAt: '2026-01-01T00:00:00.000Z', ...over });

describe('findDuplicateBookIdGroups', () => {
  it('canonical fixture: the twin with the work wins, though it is not walk-first', async () => {
    const original = seed('A', 'S', 'T', 'a__s__t', { rendered: 2, cast: 3, createdAt: '2026-01-01T00:00:00.000Z' });
    const renamed = join(paths.BOOKS_ROOT, 'A', 'S', 'T2');
    renameSync(original, renamed);
    const fresh = seed('A', 'S', 'T', 'a__s__t', { cast: undefined, createdAt: '2026-06-01T00:00:00.000Z' });

    const groups = await sweep.findDuplicateBookIdGroups();
    expect(groups).toEqual([{ bookId: 'a__s__t', winnerDir: renamed, loserDirs: [fresh] }]);
    /* Documents why ranking is needed: today's resolve-by-id returns the walk-first twin. */
    expect((await lock.peekBook('a__s__t'))?.bookDir).toBe(fresh);
  });

  it('returns [] when no bookId is shared', async () => {
    seed('A', 'S', 'One', 'a__s__one');
    seed('A', 'S', 'Two', 'a__s__two');
    expect(await sweep.findDuplicateBookIdGroups()).toEqual([]);
  });

  it('a three-way duplicate gives one winner and two losers, in walk order', async () => {
    const a = seed('A', 'S', 'A1', 'dup', { createdAt: '2026-03-01T00:00:00.000Z' });
    const b = seed('A', 'S', 'B1', 'dup', { createdAt: '2026-01-01T00:00:00.000Z' });
    const c = seed('A', 'S', 'C1', 'dup', { createdAt: '2026-02-01T00:00:00.000Z' });
    const groups = await sweep.findDuplicateBookIdGroups();
    expect(groups).toEqual([{ bookId: 'dup', winnerDir: b, loserDirs: [a, c] }]);
  });

  it('unreadable state.json anywhere: result is [] and one warning is logged', async () => {
    seed('A', 'S', 'T', 'dup');
    seed('A', 'S', 'T2', 'dup');
    const busy = seed('Z', 'S', 'Busy', 'z__s__busy');
    faultedState.add(paths.stateJsonPath(busy));
    expect(await sweep.findDuplicateBookIdGroups()).toEqual([]);
    const sweepWarns = warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('[duplicate-bookid-sweep]'));
    expect(sweepWarns).toHaveLength(1);
    expect(String(sweepWarns[0][0])).not.toContain(workspaceRoot);
  });

  it('a twin whose cast.json throws a non-ENOENT error skips only that group', async () => {
    seed('A', 'S', 'X1', 'bad', { cast: 1 });
    const x2 = seed('A', 'S', 'X2', 'bad', { cast: 2 });
    faultedCast.add(paths.castJsonPath(x2));
    const g1 = seed('B', 'S', 'G1', 'good', { rendered: 1 });
    const g2 = seed('B', 'S', 'G2', 'good');
    const groups = await sweep.findDuplicateBookIdGroups();
    expect(groups).toEqual([{ bookId: 'good', winnerDir: g1, loserDirs: [g2] }]);
    expect(warn.mock.calls.some((c: unknown[]) => String(c[0]).includes('bad'))).toBe(true);
  });
});

describe('rankTwins -- each criterion alone', () => {
  it('only rendered chapters differ: more wins', () => {
    const r = sweep.rankTwins([twin('a', 0), twin('b', 1, { renderedChapters: 2 })]);
    expect(r.winner.dir).toBe('b');
  });
  it('equal rendered: more cast rows wins', () => {
    const r = sweep.rankTwins([twin('a', 0, { castRows: 1 }), twin('b', 1, { castRows: 4 })]);
    expect(r.winner.dir).toBe('b');
  });
  it('equal rendered and cast: the older createdAt wins', () => {
    const r = sweep.rankTwins([
      twin('a', 0, { createdAt: '2026-06-01T00:00:00.000Z' }),
      twin('b', 1, { createdAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    expect(r.winner.dir).toBe('b');
  });
  it('all equal: the walk-first folder wins', () => {
    const r = sweep.rankTwins([twin('b', 1), twin('a', 0)]);
    expect(r.winner.dir).toBe('a');
    expect(r.losers.map((l) => l.dir)).toEqual(['b']);
  });
  it('a missing or unparseable createdAt loses to a valid one', () => {
    expect(sweep.rankTwins([twin('a', 0, { createdAt: undefined }), twin('b', 1)]).winner.dir).toBe('b');
    expect(sweep.rankTwins([twin('a', 0, { createdAt: 'garbage' }), twin('b', 1)]).winner.dir).toBe('b');
  });
});
