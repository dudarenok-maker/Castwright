/* #3625 sweep — every state.json read-modify-write that holds the state lock
   reads through `readStateJsonWithRecovery`, so a torn main file with a good
   `.bak.1` is healed rather than failing (or being skipped). These are the unit
   seams: the four cover helpers, and the library scan. The route-level cases
   live beside their routes. */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AUTHOR = 'Torn Sweep';
const SERIES = 'Standalones';
const TITLE = 'Torn Sweep Book';

let workspaceRoot: string;
let bookDir: string;
let bookId: string;
let statePath: string;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-torn-sweep-'));
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
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  const full = JSON.stringify({
    bookId,
    manuscriptId: 'm_torn_sweep',
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
  writeFileSync(`${statePath}.bak.1`, full);
  writeFileSync(statePath, full.slice(0, 40));
});

const readState = () => JSON.parse(readFileSync(statePath, 'utf8'));

describe('a torn state.json is recovered by the locked cover helpers (#3625)', () => {
  it('patchStateCover', async () => {
    const { patchStateCover } = await import('../cover/store.js');
    await patchStateCover(bookDir, { id: 'c1', source: 'openlibrary', coverUrl: 'http://x/y.jpg' } as never);
    expect(readState().coverImage.candidateId).toBe('c1');
  });

  it('clearStateCover', async () => {
    const { clearStateCover } = await import('../cover/store.js');
    await clearStateCover(bookDir);
    expect(readState().coverImage).toBeUndefined();
  });

  it('patchStateLocalCover', async () => {
    const { patchStateLocalCover } = await import('../cover/upload.js');
    await patchStateLocalCover(bookDir, 'mine.png');
    expect(readState().coverImage.originalFilename).toBe('mine.png');
  });

  it('patchStateFraming', async () => {
    const { patchStateFraming } = await import('../cover/upload.js');
    const ok = await patchStateFraming(bookDir, { offsetX: 5, offsetY: 5, zoom: 2 });
    expect(ok).toBe(true);
    expect(readState().coverImage.framing.zoom).toBe(2);
  });
});

describe('the library scan lists a torn book that has a good .bak (#3625)', () => {
  /* `unreadable` falls back to the folder name, which IS TITLE — so the title
     proves nothing. chapterCount (1) only comes from a parsed state. */
  it('scanLibrary lists it from the recovered state, not as unreadable', async () => {
    const { scanLibrary } = await import('./scan.js');
    const lib = await scanLibrary();
    const books = lib.authors.flatMap((a) => a.series.flatMap((s) => s.books));
    const b = books.find((x) => x.bookId === bookId);
    expect(b).toBeDefined();
    expect(b!.status).not.toBe('unreadable');
    expect(b!.chapterCount).toBe(1);
  });

  /* Site 1 (mintChapterUuidsLocked): a torn book whose chapters lack uuids is
     minted + healed in one scan. Strict-read there throws and the file stays
     torn (the catch in scanBook swallows it). */
  it('the uuid mint inside the scan heals a torn file', async () => {
    const full = JSON.parse(readFileSync(`${statePath}.bak.1`, 'utf8'));
    delete full.chapters[0].uuid;
    writeFileSync(`${statePath}.bak.1`, JSON.stringify(full));
    const { scanLibrary } = await import('./scan.js');
    await scanLibrary();
    expect(readState().chapters[0].uuid).toBeTruthy();
  });
});
