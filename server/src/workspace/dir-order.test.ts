/* #3713 step 2 — the book-tree walk order is explicitly sorted, not whatever
   `readdirSync` returns. `readdirSync` is mocked to return entries REVERSED
   while a flag is set, so only the sort can make the first match stable. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareDirNames, sortDirNames } from './dir-order.js';

const rev = vi.hoisted(() => ({ on: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: ((...args: unknown[]) => {
      const out = (actual.readdirSync as (...a: unknown[]) => unknown[])(...args);
      return rev.on ? [...out].reverse() : out;
    }) as typeof actual.readdirSync,
  };
});

describe('compareDirNames / sortDirNames', () => {
  it('orders case-insensitively by code unit', () => {
    expect(sortDirNames(['t2', 'T', 'b', 'A'])).toEqual(['A', 'b', 'T', 't2']);
  });

  it('gives case-only twins a stable order (uppercase first) and does not mutate input', () => {
    const input = ['the', 'The'];
    expect(sortDirNames(input)).toEqual(['The', 'the']);
    expect(sortDirNames(['The', 'the'])).toEqual(['The', 'the']);
    expect(input).toEqual(['the', 'The']);
    expect(compareDirNames('x', 'x')).toBe(0);
  });
});

describe('walk order is sorted regardless of readdirSync order', () => {
  let workspaceRoot: string;
  let lock: typeof import('./book-op-lock.js');
  let scan: typeof import('./scan.js');
  let paths: typeof import('./paths.js');

  beforeAll(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-dir-order-test-'));
    process.env.WORKSPACE_DIR = workspaceRoot;
    [lock, scan, paths] = await Promise.all([
      import('./book-op-lock.js'),
      import('./scan.js'),
      import('./paths.js'),
    ]);
  });
  afterAll(() => {
    rev.on = false;
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function seed(title: string, bookId: string): string {
    const dir = join(paths.BOOKS_ROOT, 'Dup', 'S', title);
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    writeFileSync(
      join(dir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId,
        manuscriptId: `ms-${title}`,
        title,
        author: 'Dup',
        series: 'S',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: false,
        chapters: [],
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
      }),
    );
    return dir;
  }

  it('peekBook and findBookByBookId both return the sorted-first twin', async () => {
    const id = 'dup__s__twin-order';
    const first = seed('Alpha', id);
    seed('Zulu', id);
    rev.on = true;
    try {
      const peeked = await lock.peekBook(id);
      const found = await scan.findBookByBookId(id);
      expect(peeked?.bookDir).toBe(first);
      expect(found?.bookDir).toBe(first);
    } finally {
      rev.on = false;
    }
  });
});
