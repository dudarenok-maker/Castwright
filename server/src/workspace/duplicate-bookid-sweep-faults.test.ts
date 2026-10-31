/* #3713 / PR #4004 pass 1 -- the sweep under faults at its seams: an unlistable
   directory, a failing state.json write, a lost race. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hiddenDirs = vi.hoisted(() => new Set<string>());

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
  warn.mockClear();
  rmSync(join(root, 'books'), { recursive: true, force: true });
  lock.__bookDirIndexForTest().clear();
  lock.__duplicateBookIdsForTest().clear();
  sweep.__resetDuplicateBookIdRepairsForTest();
});

function seed(author: string, title: string, bookId: string, rendered = 0): string {
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
      manuscriptId: `m_${title}`,
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
    const lines = warn.mock.calls.map((c) => String(c[0]));
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
