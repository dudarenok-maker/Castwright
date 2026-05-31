/* srv-2 — per-book state.json auto-backup: stamp format, snapshot + retention
   prune, newest-first listing, and restore (happy path + error paths).

   Mirrors the temp-workspace pattern (mkdtemp + WORKSPACE_DIR + vi.resetModules
   so paths.ts re-reads the override, then dynamic import). */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workspaceRoot: string;
let mod: typeof import('./auto-backup.js');
let paths: typeof import('./paths.js');

/* Book whose display names are already slug-identical (lowercase, no spaces) so
   the slug-based bookId resolves back to this exact path however findBookByBookId
   maps id → dir. */
function bookDirFor(name: string): { bookId: string; bookDir: string } {
  return {
    bookId: `tester__myseries__${name}`,
    bookDir: join(workspaceRoot, 'books', 'tester', 'myseries', name),
  };
}

/* A realistic-enough state.json. `findBookByBookId` walks every book's state
   and iterates `state.chapters`, so the seeded file must carry at least an
   (empty) chapters array + the identity fields, or the scan throws before it
   can match. */
function makeState(bookId: string, extra: object): Record<string, unknown> {
  return {
    bookId,
    manuscriptId: bookId,
    title: 'Test Book',
    author: 'tester',
    series: 'myseries',
    seriesPosition: null,
    isStandalone: false,
    manuscriptFile: 'manuscript.txt',
    castConfirmed: false,
    chapters: [],
    coverGradient: ['#111111', '#222222'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

/* Seed a discoverable book: a manuscript file + a state.json carrying its
   bookId (so findBookByBookId can match it on restore). */
async function seedBook(bookId: string, bookDir: string, extra: object): Promise<void> {
  await mkdir(join(bookDir, '.audiobook'), { recursive: true });
  await writeFile(join(bookDir, 'manuscript.txt'), 'chapter one', 'utf8');
  await writeFile(paths.stateJsonPath(bookDir), JSON.stringify(makeState(bookId, extra)), 'utf8');
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'backup-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  vi.resetModules();
  paths = await import('./paths.js');
  mod = await import('./auto-backup.js');
});

afterEach(async () => {
  delete process.env.WORKSPACE_DIR;
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('backupStamp', () => {
  it('formats a zero-padded, lexically sortable stamp', () => {
    expect(mod.backupStamp(new Date(2026, 4, 31, 9, 7, 3))).toBe('20260531-090703');
  });
});

describe('backupBook + retention', () => {
  it('snapshots state.json and prunes to the newest N', async () => {
    const { bookId, bookDir } = bookDirFor('retention');
    await seedBook(bookId, bookDir, { v: 1 });

    for (let i = 0; i < 16; i += 1) {
      const now = new Date(2026, 0, 1 + i, 12, 0, 0); // one per day
      const file = await mod.backupBook({ bookId, bookDir }, { keep: 14, now });
      expect(file).toMatch(/^\d{8}-\d{6}\.json$/);
    }

    const snaps = await mod.listBackups(bookId);
    expect(snaps).toHaveLength(14); // oldest 2 pruned
    expect(snaps[0].file > snaps[snaps.length - 1].file).toBe(true); // newest first
  });

  it('returns null when there is no state.json', async () => {
    const { bookId, bookDir } = bookDirFor('nostate');
    await mkdir(bookDir, { recursive: true });
    const file = await mod.backupBook({ bookId, bookDir }, { keep: 5, now: new Date() });
    expect(file).toBeNull();
  });

  it('skips a snapshot that is not yet due (minIntervalMs)', async () => {
    const { bookId, bookDir } = bookDirFor('due');
    await seedBook(bookId, bookDir, { v: 1 });
    const first = await mod.backupBook(
      { bookId, bookDir },
      { keep: 5, now: new Date(2026, 0, 1, 12, 0, 0) },
    );
    expect(first).toBeTruthy();
    const second = await mod.backupBook(
      { bookId, bookDir },
      { keep: 5, now: new Date(2026, 0, 1, 12, 10, 0), minIntervalMs: 60 * 60 * 1000 },
    );
    expect(second).toBeNull();
    expect(await mod.listBackups(bookId)).toHaveLength(1);
  });
});

describe('runBackupSweep', () => {
  it('snapshots every book in the workspace with a state.json', async () => {
    const a = bookDirFor('alpha');
    const b = bookDirFor('beta');
    await seedBook(a.bookId, a.bookDir, { v: 1 });
    await seedBook(b.bookId, b.bookDir, { v: 1 });
    const res = await mod.runBackupSweep({ keep: 5, now: new Date(2026, 0, 1, 12, 0, 0) });
    expect(res.booksBackedUp).toBe(2);
    expect(await mod.listBackups(a.bookId)).toHaveLength(1);
    expect(await mod.listBackups(b.bookId)).toHaveLength(1);
  });
});

describe('restoreBackup', () => {
  it('reverts state.json to a chosen snapshot', async () => {
    const { bookId, bookDir } = bookDirFor('restore');
    await seedBook(bookId, bookDir, { v: 'original' });
    const file = await mod.backupBook(
      { bookId, bookDir },
      { keep: 5, now: new Date(2026, 0, 1, 9, 0, 0) },
    );
    /* Mutate the live state (still a valid, chapters-bearing state), then restore. */
    await writeFile(
      paths.stateJsonPath(bookDir),
      JSON.stringify(makeState(bookId, { v: 'edited' })),
      'utf8',
    );
    await mod.restoreBackup(bookId, file!);
    const after = JSON.parse(await readFile(paths.stateJsonPath(bookDir), 'utf8'));
    expect(after.v).toBe('original');
    expect(after.bookId).toBe(bookId);
  });

  it('rejects an invalid backup filename before touching disk', async () => {
    await expect(mod.restoreBackup('tester__myseries__x', 'not-a-stamp')).rejects.toThrow(
      /invalid backup filename/,
    );
  });

  it('reports book not found for an unknown id', async () => {
    await expect(mod.restoreBackup('no__such__book', '20260101-000000.json')).rejects.toThrow(
      /book not found/,
    );
  });

  it('rejects a corrupt snapshot', async () => {
    const { bookId, bookDir } = bookDirFor('corrupt');
    await seedBook(bookId, bookDir, { v: 1 });
    const bdir = paths.bookBackupsDir(bookId);
    await mkdir(bdir, { recursive: true });
    await writeFile(join(bdir, '20260101-000000.json'), '{ not valid json', 'utf8');
    await expect(mod.restoreBackup(bookId, '20260101-000000.json')).rejects.toThrow(/corrupt/);
  });
});
