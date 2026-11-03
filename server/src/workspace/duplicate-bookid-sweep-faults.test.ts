/* #3713 / PR #4004 pass 1 -- the sweep under faults at its seams: an unlistable
   directory, a failing state.json write, a lost race. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hiddenDirs = vi.hoisted(() => new Set<string>());
/* state.json paths whose locked write throws EPERM. */
const failWriteFor = vi.hoisted(() => new Set<string>());
/* Hooks run at the seams between the sweep's detection and its locked write. */
const hooks = vi.hoisted(() => ({
  beforeWithBookOp: null as null | ((hintDir: string | undefined) => void),
  dropHint: false,
  onMint: null as null | (() => void),
  afterMint: null as null | (() => void),
  /* Runs after the locked repair of one loser returned, as a crash there would. */
  afterWithBookOp: null as null | (() => void),
  /* Dirs whose state.json read fails (EPERM) while armed. */
  unreadable: new Set<string>(),
}));

vi.mock('./state-migrate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./state-migrate.js')>();
  return {
    ...actual,
    updateStateJsonLocked: async (path: string, ...rest: unknown[]) => {
      if (failWriteFor.has(path)) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${path}'`), { code: 'EPERM' });
      }
      return (actual.updateStateJsonLocked as (...a: unknown[]) => unknown)(path, ...rest);
    },
  };
});

vi.mock('./book-op-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./book-op-lock.js')>();
  return {
    ...actual,
    withBookOp: ((bookId: string, fn: unknown, opts?: { hintDir?: string }) => {
      hooks.beforeWithBookOp?.(opts?.hintDir);
      const o = hooks.dropHint ? { ...opts, hintDir: undefined } : opts;
      const done = (actual.withBookOp as (...a: unknown[]) => Promise<unknown>)(bookId, fn, o);
      return hooks.afterWithBookOp
        ? done.then((r) => {
            hooks.afterWithBookOp?.();
            return r;
          })
        : done;
    }) as typeof actual.withBookOp,
    readBookStateOrThrow: async (dir: string) => {
      if (hooks.unreadable.has(dir)) {
        throw Object.assign(new Error(`EPERM: operation not permitted, open '${dir}'`), { code: 'EPERM' });
      }
      return actual.readBookStateOrThrow(dir);
    },
    takenBookIds: async (...args: Parameters<typeof actual.takenBookIds>) => {
      hooks.onMint?.();
      const taken = await actual.takenBookIds(...args);
      hooks.afterMint?.();
      return taken;
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: ((p: string, ...rest: unknown[]) => {
      if (hiddenDirs.has(String(p))) {
        throw Object.assign(new Error(`EPERM: operation not permitted, scandir '${p}'`), { code: 'EPERM' });
      }
      return (actual.readdirSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.readdirSync,
  };
});

let root: string;
let paths: typeof import('./paths.js');
let lock: typeof import('./book-op-lock.js');
let sweep: typeof import('./duplicate-bookid-sweep.js');
let warn: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'audiobook-dup-bookid-faults-'));
  process.env.WORKSPACE_DIR = root;
  /* Sequential imports -- a Promise.all of dynamic imports races vi.mock factories (#2083). */
  paths = await import('./paths.js');
  lock = await import('./book-op-lock.js');
  sweep = await import('./duplicate-bookid-sweep.js');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

afterEach(() => {
  hiddenDirs.clear();
  failWriteFor.clear();
  hooks.beforeWithBookOp = null;
  hooks.dropHint = false;
  hooks.onMint = null;
  hooks.afterMint = null;
  hooks.afterWithBookOp = null;
  hooks.unreadable.clear();
  warn.mockClear();
  rmSync(join(root, 'books'), { recursive: true, force: true });
  lock.__bookDirIndexForTest().clear();
  lock.__duplicateBookIdsForTest().clear();
  sweep.__resetDuplicateBookIdRepairsForTest();
});

function seed(author: string, title: string, bookId: string, rendered = 0, manuscriptId = `m_${title}`): string {
  const dir = join(paths.BOOKS_ROOT, author, 'S', title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  const chapters: unknown[] = [];
  for (let i = 0; i < Math.max(rendered, 1); i++) {
    chapters.push({
      id: i + 1,
      title: `C${i}`,
      slug: `c${i}`,
      ...(i < rendered ? { audioRenderedAt: '2026-02-01T00:00:00.000Z' } : {}),
    });
  }
  writeFileSync(
    paths.stateJsonPath(dir),
    JSON.stringify({
      bookId,
      manuscriptId,
      title,
      author,
      series: 'S',
      seriesPosition: null,
      isStandalone: false,
      manuscriptFile: 'manuscript.md',
      castConfirmed: false,
      chapters,
      coverGradient: ['#000', '#fff'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      language: 'en',
      schema: 1,
    }),
  );
  return dir;
}
const warned = (): string[] => (warn.mock.calls as unknown[][]).map((c) => String(c[0]));
const idOf = (dir: string): string => JSON.parse(readFileSync(paths.stateJsonPath(dir), 'utf8')).bookId;

describe('a directory that cannot be listed', () => {
  it('the sweep skips entirely rather than minting an id a hidden folder may carry', async () => {
    /* Z's folder carries the id the counter would mint next. */
    const hidden = seed('Z', 'Other', 'a__s__t-2');
    seed('A', 'T2', 'a__s__t', 2);
    const loser = seed('A', 'T', 'a__s__t');
    hiddenDirs.add(join(paths.BOOKS_ROOT, 'Z'));

    expect(await sweep.repairDuplicateBookIds()).toEqual([]);
    expect(sweep.getDuplicateBookIdRepairs()).toEqual([]);
    expect(idOf(loser)).toBe('a__s__t');
    expect(idOf(hidden)).toBe('a__s__t-2');
    /* The warning is path-free (the raw error carries the absolute path). */
    const lines = warned();
    expect(lines.some((l) => l.includes('skipping the sweep until next startup'))).toBe(true);
    expect(lines.every((l) => !l.includes(root))).toBe(true);

    /* The next startup, with the directory listable again, repairs. */
    hiddenDirs.clear();
    const second = await sweep.repairDuplicateBookIds();
    expect(second.map((r) => r.reassignedFolder)).toEqual(['A/S/T']);
    expect(idOf(loser)).not.toBe('a__s__t');
    expect(idOf(loser)).not.toBe(idOf(hidden));
  });
});

describe('failure paths of the locked repair', () => {
  const setId = (dir: string, bookId: string): void => {
    const p = paths.stateJsonPath(dir);
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), bookId }));
  };

  it('three-way group: one loser fails, the other is repaired, the next start finishes, the one after is a no-op', async () => {
    const w = seed('A', 'W', 'dup', 3);
    const l1 = seed('A', 'L1', 'dup');
    const l2 = seed('A', 'L2', 'dup');
    failWriteFor.add(paths.stateJsonPath(l1));

    const first = await sweep.repairDuplicateBookIds(); // must resolve, not reject
    expect(first.map((r) => r.reassignedFolder)).toEqual(['A/S/L2']);
    expect(sweep.getDuplicateBookIdRepairs().map((r) => r.reassignedFolder)).toEqual(['A/S/L2']);
    expect(idOf(w)).toBe('dup');
    expect(idOf(l1)).toBe('dup');
    expect(idOf(l2)).not.toBe('dup');

    failWriteFor.clear();
    const second = await sweep.repairDuplicateBookIds();
    expect(second.map((r) => r.reassignedFolder)).toEqual(['A/S/L1']);
    expect(idOf(w)).toBe('dup');
    expect(new Set([idOf(w), idOf(l1), idOf(l2)]).size).toBe(3);

    expect(await sweep.repairDuplicateBookIds()).toEqual([]);
  });

  it('a resolve that lands on another twin leaves BOTH alone (never re-mints the winner)', async () => {
    const w = seed('A', 'Aw', 'dup', 3); // walk-first, the winner
    const loser = seed('A', 'Zl', 'dup');
    hooks.dropHint = true; // the resolve now walks and answers the walk-first twin

    expect(await sweep.repairDuplicateBookIds()).toEqual([]);
    expect(idOf(w)).toBe('dup');
    expect(idOf(loser)).toBe('dup');
    expect(warned().some((l) => l.includes('leaving it alone'))).toBe(true);
  });

  it('a state.json that changed id after the resolve is not overwritten', async () => {
    const w = seed('A', 'W', 'dup', 3);
    const loser = seed('A', 'L', 'dup');
    hooks.onMint = () => setId(loser, 'someone-else'); // between the resolve and the write

    expect(await sweep.repairDuplicateBookIds()).toEqual([]);
    expect(sweep.getDuplicateBookIdRepairs()).toEqual([]);
    expect(idOf(loser)).toBe('someone-else');
    expect(idOf(w)).toBe('dup');
    expect(warned().some((l) => l.includes('was not rewritten'))).toBe(true);
  });

  it('a loser whose id resolves nowhere by the time the lock is held is skipped, not recorded', async () => {
    const w = seed('A', 'W', 'dup', 3);
    const loser = seed('A', 'L', 'dup');
    hooks.beforeWithBookOp = () => {
      setId(w, 'renamed-away');
      setId(loser, 'renamed-away-too');
    };

    expect(await sweep.repairDuplicateBookIds()).toEqual([]);
    expect(sweep.getDuplicateBookIdRepairs()).toEqual([]);
    expect(warned().some((l) => l.includes('is gone; nothing to repair'))).toBe(true);
  });

  it('a detection that throws is contained: the sweep resolves [] and writes nothing', async () => {
    const w = seed('A', 'W', 'dup', 3);
    const loser = seed('A', 'L', 'dup');
    /* chapters is not an array: the rendered-chapter count throws a TypeError. */
    const p = paths.stateJsonPath(w);
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), chapters: 'oops' }));

    await expect(sweep.repairDuplicateBookIds()).resolves.toEqual([]);
    expect(idOf(loser)).toBe('dup');
    expect(warned().some((l) => l.includes('detection failed'))).toBe(true);
  });

  it('the rewrite runs under the book-path claim', async () => {
    seed('A', 'W', 'dup', 3);
    const loser = seed('A', 'L', 'dup');
    let release: () => void = () => {};
    const held = lock.withBookPathClaim(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await new Promise((r) => setTimeout(r, 20));

    const run = sweep.repairDuplicateBookIds();
    await new Promise((r) => setTimeout(r, 200));
    expect(idOf(loser)).toBe('dup'); // blocked behind the held claim
    release();
    await held;
    await run;
    expect(idOf(loser)).not.toBe('dup');
  });

  const msOf = (dir: string): string => JSON.parse(readFileSync(paths.stateJsonPath(dir), 'utf8')).manuscriptId;
  const setMs = (dir: string, manuscriptId: string): void => {
    const p = paths.stateJsonPath(dir);
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), manuscriptId }));
  };

  it('a twin whose state.json cannot be read when the loser is checked counts as sharing its manuscriptId', async () => {
    const w = seed('A', 'W', 'dup', 3, 'm_win');
    const loser = seed('A', 'L', 'dup', 0, 'm_lose');
    /* After detection and the resolve, under the claim: the winner's state.json can no longer be read. */
    hooks.afterMint = () => hooks.unreadable.add(w);

    const [repair] = await sweep.repairDuplicateBookIds();
    /* A spare id costs a cache; an alias would cost data. */
    expect(msOf(loser)).not.toBe('m_lose');
    expect(msOf(loser)).toMatch(/^mns_/);
    expect(idOf(loser)).toBe(repair.newBookId);
    expect(repair.reassignedManuscriptId).toBeNull();
  });

  it('a manuscriptId that moved after the read is left where it is, and nothing is rekeyed from the old id', async () => {
    seed('A', 'W', 'dup', 3, 'm_shared');
    const loser = seed('A', 'L', 'dup', 0, 'm_shared');
    const analysisState = paths.analysisStateJsonPath(loser);
    writeFileSync(analysisState, JSON.stringify({ manuscriptId: 'm_shared', state: 'paused' }));
    hooks.afterMint = () => setMs(loser, 'm_moved'); // between the shared check's read and the locked write

    const [repair] = await sweep.repairDuplicateBookIds();
    expect(idOf(loser)).toBe(repair.newBookId);
    expect(msOf(loser)).toBe('m_moved');
    expect(JSON.parse(readFileSync(analysisState, 'utf8')).manuscriptId).toBe('m_shared');
  });

  it('a crash right after the state write still leaves the log line (no later start would find the group)', async () => {
    seed('A', 'W', 'dup', 3);
    const loser = seed('A', 'L', 'dup');
    hooks.afterWithBookOp = () => {
      throw new Error('simulated crash after the state write');
    };

    const repairs = await sweep.repairDuplicateBookIds();

    /* The write landed, the in-memory record did not (the process would be gone)... */
    expect(idOf(loser)).not.toBe('dup');
    expect(repairs).toEqual([]);
    /* ...and the durable record is the log line, written before anything after the write. */
    expect(warned().some((l) => l.includes('"dup" was carried by both') && l.includes('keeps it (ranked first)'))).toBe(true);
    /* No later start finds a duplicate group: that is why the line has to exist. */
    hooks.afterWithBookOp = null;
    expect(await sweep.repairDuplicateBookIds()).toEqual([]);
  });
});
