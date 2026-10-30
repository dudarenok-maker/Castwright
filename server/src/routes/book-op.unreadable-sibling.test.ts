/* #3711 PR #3714 review pass 3 -- one unreadable state.json must not take down
   every book that sorts after it. Pass 2 made a read error fail the resolve so
   it is never read as "not this book"; applied to EVERY walked folder, that let
   one EBUSY / EISDIR folder (an unrelated book) 500 every autosave, rename,
   delete, job registration and peek of every later book, permanently (the
   later book could never become indexed).

   Owner decision (2026-10-18): the walk skips PAST an unreadable folder. A
   later match is returned non-authoritatively (no index write, no verdict
   change), except for a known duplicate id, which still fails closed; no match
   after an unreadable folder still fails. Minting never refuses: an unreadable
   folder could hold ANY id (a renamed book keeps its old one), so while one
   exists the mint uses a suffix no counter id can produce, and
   `isBookIdTaken` answers "taken". The failure scope now matches the
   uncertainty scope (catalogue 41). */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

/* Paths (state.json) whose read throws EBUSY, the way Windows does while another
   process holds the file. Every other read is the real recovering reader. */
const faulted = vi.hoisted(() => new Set<string>());

vi.mock('../workspace/state-migrate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-migrate.js')>();
  return {
    ...actual,
    readStateJsonWithRecovery: async (path: string) => {
      if (faulted.has(path)) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${path}'`), { code: 'EBUSY' });
      }
      return actual.readStateJsonWithRecovery(path);
    },
  };
});

let workspaceRoot: string;
let app: Express;
let paths: typeof import('../workspace/paths.js');
let bookOp: typeof import('../workspace/book-op-lock.js');
let bookJobs: typeof import('../workspace/book-jobs.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-book-op-unreadable-sibling-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Sequential imports -- a Promise.all of dynamic imports races vi.mock factories (#2083). */
  const { bookStateRouter } = await import('./book-state.js');
  paths = await import('../workspace/paths.js');
  bookOp = await import('../workspace/book-op-lock.js');
  bookJobs = await import('../workspace/book-jobs.js');
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

afterEach(() => {
  faulted.clear();
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  bookOp.__bookDirIndexForTest().clear();
  bookOp.__duplicateBookIdsForTest().clear();
});

/** Seed `<author>/<series>/<title>` carrying `bookId`. */
function seedBook(author: string, series: string, title: string, bookId: string): string {
  const bookDir = join(paths.BOOKS_ROOT, author, series, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), 'Opening prose here.\n');
  writeFileSync(
    paths.stateJsonPath(bookDir),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${title}`,
      title,
      author,
      series,
      seriesPosition: null,
      isStandalone: false,
      manuscriptFile: 'manuscript.md',
      castConfirmed: false,
      chapters: [{ id: 1, title: 'Chapter 1', slug: '01-x' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      language: 'en',
    }),
  );
  writeFileSync(paths.castJsonPath(bookDir), JSON.stringify({ characters: [] }));
  return bookDir;
}

const readState = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(paths.stateJsonPath(dir), 'utf8')) as Record<string, unknown>;

/** `Aaa/S/Busy` sorts before every other seeded book; its state read throws EBUSY. */
function seedBusySibling(): string {
  const busy = seedBook('Aaa', 'S', 'Busy', 'aaa__s__busy');
  faulted.add(paths.stateJsonPath(busy));
  return busy;
}

/** `Aaa/S/Odd`'s state.json is a DIRECTORY: a real EISDIR read, no mock. */
function seedEisdirSibling(): string {
  const odd = join(paths.BOOKS_ROOT, 'Aaa', 'S', 'Odd');
  mkdirSync(join(odd, '.audiobook', 'state.json'), { recursive: true });
  return odd;
}

describe.each([
  ['EBUSY (mocked)', seedBusySibling],
  ['EISDIR (on disk, no mock)', seedEisdirSibling],
])('an unreadable sibling folder (%s) does not block a later book', (_label, seedSibling) => {
  const ZED = 'zed__s__book';

  it('PUT /state autosaves the later book, repeatedly, with the index cold', async () => {
    seedSibling();
    const zed = seedBook('Zed', 'S', 'Book', ZED);
    for (const castConfirmed of [true, false, true]) {
      const res = await request(app).put(`/api/books/${ZED}/state`).send({ slice: 'state', patch: { castConfirmed } });
      expect(res.status).toBe(200);
      expect(readState(zed).castConfirmed).toBe(castConfirmed);
    }
    /* The walk could not read every folder: the answer is not indexed. */
    expect(bookOp.__bookDirIndexForTest().has(ZED)).toBe(false);
  });

  it('DELETE removes the later book', async () => {
    seedSibling();
    const zed = seedBook('Zed', 'S', 'Book', ZED);
    const res = await request(app).delete(`/api/books/${ZED}`);
    expect(res.status).toBe(204);
    expect(existsSync(zed)).toBe(false);
  });

  it('runBookJob registers and peekBook resolves the later book', async () => {
    seedSibling();
    const zed = seedBook('Zed', 'S', 'Book', ZED);
    expect((await bookOp.peekBook(ZED))?.bookDir).toBe(zed);
    const reg = await bookJobs.runBookJob(ZED, 'render', async (lease) => lease.bookDir);
    expect(reg).not.toBe(bookOp.BOOK_GONE);
    if (reg === bookOp.BOOK_GONE) return;
    expect(await reg.done).toBe(zed);
  });

  it('GET /state of the later book answers 200 (the series scan skips the sibling)', async () => {
    seedSibling();
    seedBook('Zed', 'S', 'Book', ZED);
    const res = await request(app).get(`/api/books/${ZED}/state`);
    expect(res.status).toBe(200);
    expect(res.body.state.bookId).toBe(ZED);
  });

  it('minting an unrelated id succeeds, and never reuses an id the sibling could hold', async () => {
    seedSibling();
    const id = await bookOp.mintBookId('Fresh', 'S', 'Title');
    expect(paths.parseBookId(id)).not.toBeNull();
    /* Not the plain base nor a counter id: either could be what the unreadable
       folder carries (a renamed book keeps its id). */
    expect(id).not.toBe('fresh__s__title');
    expect(id).not.toMatch(/^fresh__s__title-\d+$/);
    expect(id.startsWith('fresh__s__title-')).toBe(true);
    /* The bundle importer then mints instead of keeping an id it cannot prove free. */
    expect(await bookOp.isBookIdTaken('fresh__s__title')).toBe(true);
  });
});

describe('what still fails closed', () => {
  it('no match after an unreadable folder fails (the unreadable folder may be the book)', async () => {
    const busy = seedBook('Zed', 'S', 'Book', 'zed__s__book');
    faulted.add(paths.stateJsonPath(busy));
    await expect(bookOp.peekBook('zed__s__book')).rejects.toBeInstanceOf(bookOp.BookStateUnreadableError);
    const res = await request(app)
      .put('/api/books/zed__s__book/state')
      .send({ slice: 'state', patch: { castConfirmed: true } });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(workspaceRoot);
    /* JSON doubles each backslash, so on Windows the raw root never matches the serialised body. */
    expect(JSON.stringify(res.body)).not.toContain(JSON.stringify(workspaceRoot).slice(1, -1));
  });

  it('a KNOWN duplicate whose first twin is unreadable fails instead of writing the second', async () => {
    const BOOK_ID = 'dup__s__twin';
    const twin1 = seedBook('Dup', 'S', 'Twin1', BOOK_ID);
    const twin2 = seedBook('Dup', 'S', 'Twin2', BOOK_ID);
    /* A clean locked walk records the duplicate verdict. */
    expect(await bookOp.withBookOp(BOOK_ID, async (b) => b.bookDir)).toBe(twin1);
    expect(bookOp.__duplicateBookIdsForTest().has(BOOK_ID)).toBe(true);

    faulted.add(paths.stateJsonPath(twin1));
    const res = await request(app)
      .put(`/api/books/${BOOK_ID}/state`)
      .send({ slice: 'state', patch: { castConfirmed: true } });
    expect(res.status).toBe(500);
    expect(readState(twin2).castConfirmed).toBe(false);
    await expect(bookOp.peekBook(BOOK_ID)).rejects.toBeInstanceOf(bookOp.BookStateUnreadableError);
    expect(bookOp.__duplicateBookIdsForTest().has(BOOK_ID)).toBe(true);
  });

  it('control: with every folder readable the plain base id is minted', async () => {
    seedBook('Other', 'S', 'Book', 'other__s__book');
    expect(await bookOp.mintBookId('Fresh', 'S', 'Title')).toBe('fresh__s__title');
    expect(await bookOp.isBookIdTaken('fresh__s__title')).toBe(false);
  });
});
