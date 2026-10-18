/* #3625 pass 4 — state.json ABSENT (a crash between the rotation's two renames,
   or a failed rename-in whose `.bak.1` restore also failed) with a good `.bak.N`
   beside it. Nothing deletes state.json on purpose, so an absent main is always
   a stranded one: every reader recovers from the newest parseable backup, and a
   locked writer then re-creates main. A book with NO main and NO backup is just
   a book that has never been analysed and still reads as null. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AUTHOR = 'Missing Main';
const SERIES = 'Standalones';
const TITLE = 'Missing Main Book';

let workspaceRoot: string;
let bookDir: string;
let bookId: string;
let statePath: string;

const full = () =>
  JSON.stringify({
    bookId,
    manuscriptId: 'm_missing_main',
    title: TITLE,
    author: AUTHOR,
    series: SERIES,
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile: 'manuscript.txt',
    castConfirmed: true,
    chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one', uuid: 'u-1' }],
    coverImage: { source: 'local', originalFilename: null, uploadedAt: '2026-01-01T00:00:00.000Z' },
    language: 'en',
    coverGradient: ['#000', '#fff'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-missing-main-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { makeBookId } = await import('./paths.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  statePath = join(bookDir, '.audiobook', 'state.json');
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  rmSync(statePath, { force: true });
  for (const n of [1, 2, 3]) rmSync(`${statePath}.bak.${n}`, { force: true });
});

describe('state.json absent, good .bak.1 present', () => {
  beforeEach(() => {
    writeFileSync(`${statePath}.bak.1`, full());
  });

  it('readStateJsonWithRecovery returns the backup and logs a warning', async () => {
    const { readStateJsonWithRecovery } = await import('./state-migrate.js');
    const state = await readStateJsonWithRecovery(statePath);
    expect(state?.bookId).toBe(bookId);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('.bak.1'));
  });

  it('falls back to the newest PARSEABLE backup', async () => {
    writeFileSync(`${statePath}.bak.1`, '{ torn');
    writeFileSync(`${statePath}.bak.2`, full());
    const { readStateJsonWithRecovery } = await import('./state-migrate.js');
    const state = await readStateJsonWithRecovery(statePath);
    expect(state?.bookId).toBe(bookId);
  });

  it('findBookByBookId finds the book', async () => {
    const { findBookByBookId } = await import('./scan.js');
    const found = await findBookByBookId(bookId);
    expect(found?.bookDir).toBe(bookDir);
  });

  it('scanLibrary lists it from the recovered state, not as not_analysed', async () => {
    const { scanLibrary } = await import('./scan.js');
    const lib = await scanLibrary();
    const b = lib.authors.flatMap((a) => a.series.flatMap((s) => s.books)).find((x) => x.bookId === bookId);
    expect(b).toBeDefined();
    expect(b!.status).not.toBe('not_analysed');
    expect(b!.status).not.toBe('unreadable');
    expect(b!.chapterCount).toBe(1);
  });

  it('a locked writer (patchStateCover) writes, re-creating main', async () => {
    const { patchStateCover } = await import('../cover/store.js');
    await patchStateCover(bookDir, { id: 'c1', source: 'openlibrary', coverUrl: 'http://x/y.jpg' } as never);
    expect(existsSync(statePath)).toBe(true);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).coverImage.candidateId).toBe('c1');
  });
});

describe('state.json absent, the only .bak.1 is torn (state files exist, none parse)', () => {
  const find = async () => {
    const { scanLibrary } = await import('./scan.js');
    const lib = await scanLibrary();
    return lib.authors.flatMap((a) => a.series.flatMap((s) => s.books)).find((x) => x.title === TITLE);
  };
  beforeEach(() => {
    writeFileSync(`${statePath}.bak.1`, '{ torn');
  });

  it('with a manuscript: unreadable, not a complete 0-chapter book', async () => {
    expect((await find())?.status).toBe('unreadable');
  });

  it('without a manuscript: unreadable, not an orphaned row', async () => {
    rmSync(join(bookDir, 'manuscript.txt'), { force: true });
    expect((await find())?.status).toBe('unreadable');
  });
});

describe('state.json absent and no backups (a genuinely new book)', () => {
  it('readStateJsonWithRecovery still returns null', async () => {
    const { readStateJsonWithRecovery } = await import('./state-migrate.js');
    expect(await readStateJsonWithRecovery(statePath)).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('findBookByBookId returns null and scanLibrary lists it as not_analysed', async () => {
    const { findBookByBookId, scanLibrary } = await import('./scan.js');
    expect(await findBookByBookId(bookId)).toBeNull();
    const lib = await scanLibrary();
    const b = lib.authors.flatMap((a) => a.series.flatMap((s) => s.books)).find((x) => x.title === TITLE);
    expect(b?.status).toBe('not_analysed');
  });
});
