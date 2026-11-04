/* #3713 / PR #4004 pass 2 -- the re-minted manuscriptId is checked against the ids
   already taken (`takenBookIds().takenManuscriptIds`), like every other creator. A
   random 10-character draw colliding is vanishingly rare, so the draw is scripted. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const draws = vi.hoisted(() => ({ queue: [] as string[], calls: 0 }));
vi.mock('nanoid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nanoid')>();
  return {
    ...actual,
    nanoid: (size?: number) => {
      if (size === 10 && draws.queue.length > 0) {
        draws.calls += 1;
        return draws.queue.shift()!;
      }
      return actual.nanoid(size);
    },
  };
});

let root: string;
let paths: typeof import('./paths.js');
let lock: typeof import('./book-op-lock.js');
let sweep: typeof import('./duplicate-bookid-sweep.js');

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'audiobook-dup-bookid-ids-'));
  process.env.WORKSPACE_DIR = root;
  /* Sequential imports -- a Promise.all of dynamic imports races vi.mock factories (#2083). */
  paths = await import('./paths.js');
  lock = await import('./book-op-lock.js');
  sweep = await import('./duplicate-bookid-sweep.js');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

afterEach(() => {
  draws.queue.length = 0;
  draws.calls = 0;
  rmSync(join(root, 'books'), { recursive: true, force: true });
  lock.__bookDirIndexForTest().clear();
  lock.__duplicateBookIdsForTest().clear();
  sweep.__resetDuplicateBookIdRepairsForTest();
});

function seed(author: string, title: string, bookId: string, manuscriptId: string, rendered: boolean): string {
  const dir = join(paths.BOOKS_ROOT, author, 'S', title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, 'manuscript.md'), '# Chapter One\n\nText.\n');
  writeFileSync(
    paths.stateJsonPath(dir),
    JSON.stringify({
      bookId, manuscriptId, title, author, series: 'S', seriesPosition: null, isStandalone: false,
      manuscriptFile: 'manuscript.md', castConfirmed: false, language: 'en',
      chapters: [{ id: 1, title: 'C', slug: 'c', ...(rendered ? { audioRenderedAt: '2026-02-01T00:00:00.000Z' } : {}) }],
      coverGradient: ['#000', '#fff'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', schema: 1,
    }),
  );
  return dir;
}
const msOf = (dir: string): string => JSON.parse(readFileSync(paths.stateJsonPath(dir), 'utf8')).manuscriptId;

describe('the re-minted manuscriptId', () => {
  it('is drawn again when it collides with a manuscriptId already in the workspace', async () => {
    /* An unrelated book already carries the first draw. */
    seed('Z', 'Other', 'z__s__other', 'mns_AAAAAAAAAA', false);
    seed('A', 'W', 'dup', 'm_shared', true);
    const loser = seed('A', 'L', 'dup', 'm_shared', false);
    draws.queue.push('AAAAAAAAAA', 'BBBBBBBBBB');

    await sweep.repairDuplicateBookIds();

    expect(msOf(loser)).toBe('mns_BBBBBBBBBB');
    expect(draws.calls).toBe(2);
  });

  it('takes the first draw when it is free', async () => {
    seed('A', 'W', 'dup', 'm_shared', true);
    const loser = seed('A', 'L', 'dup', 'm_shared', false);
    draws.queue.push('CCCCCCCCCC', 'DDDDDDDDDD');

    await sweep.repairDuplicateBookIds();

    expect(msOf(loser)).toBe('mns_CCCCCCCCCC');
    expect(draws.calls).toBe(1);
  });
});
