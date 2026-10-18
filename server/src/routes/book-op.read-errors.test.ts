/* #3711 PR #3714 review pass 2 -- a state.json READ error (EBUSY / EPERM / EIO)
   says nothing about whose book a folder holds, so it must never be read as
   "not this book" (catalogue 1: failure collapsed into absence). #3625 made the
   recovering reader rethrow those errors on purpose; resolving a book used to
   swallow them, with three effects pinned here:

     (a) DELETE resolved BOOK_GONE, fell through to the stateless branch (whose
         scan maps the same error to `unreadable`) and removed the folder while a
         long job was still registered for the book;
     (b) a walk that could not read the first twin of a duplicated bookId saw
         "one match", cleared the duplicate verdict and indexed the SECOND twin,
         so every later resolve-by-id wrote the twin the GET does not show;
     (c) `mintBookId` treated an unreadable book's id as free and could mint it
         again. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-book-op-read-errors-'));
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

/** Register a `render` job for `bookId` that runs until `finish()` is called. */
async function holdRender(bookId: string): Promise<{ finish: () => Promise<void> }> {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const reg = await bookJobs.runBookJob(bookId, 'render', () => gate);
  if (reg === bookOp.BOOK_GONE) throw new Error('test setup: book not found');
  return {
    finish: async () => {
      open();
      await reg.done;
    },
  };
}

describe('(a) DELETE never removes a folder whose state read failed', () => {
  it('refuses while a render is registered, even when the state read throws EBUSY', async () => {
    const bookId = paths.makeBookId('Alpha', 'Saga', 'One');
    const dir = seedBook('Alpha', 'Saga', 'One', bookId);
    const render = await holdRender(bookId);
    try {
      /* Control: a readable book under a render is refused. */
      const control = await request(app).delete(`/api/books/${bookId}`);
      expect(control.status).toBe(409);
      expect(control.body.code).toBe('book_busy');

      faulted.add(paths.stateJsonPath(dir));
      const res = await request(app).delete(`/api/books/${bookId}`);
      expect(res.status).not.toBe(204);
      expect(existsSync(dir)).toBe(true);
      expect(bookJobs.bookJobKinds(bookId)).toEqual(['render']);
      /* The fs message carries an absolute path; the body must not. */
      expect(JSON.stringify(res.body)).not.toContain(workspaceRoot);
      expect(JSON.stringify(res.body)).not.toMatch(/EBUSY/);
    } finally {
      faulted.clear();
      await render.finish();
    }
  });

  it('refuses when the book is not indexed either (the walk hits the error)', async () => {
    const bookId = paths.makeBookId('Alpha', 'Saga', 'Two');
    const dir = seedBook('Alpha', 'Saga', 'Two', bookId);
    const render = await holdRender(bookId);
    try {
      bookOp.__bookDirIndexForTest().clear();
      faulted.add(paths.stateJsonPath(dir));
      const res = await request(app).delete(`/api/books/${bookId}`);
      expect(res.status).not.toBe(204);
      expect(existsSync(dir)).toBe(true);
    } finally {
      faulted.clear();
      await render.finish();
    }
  });

  it('the stateless branch refuses (book_busy) while a long job is registered for that id', async () => {
    /* A book whose state does not parse at all (no backup) is `unreadable`: no
       route can resolve it by id. Defence in depth: a token registered under its
       path-derived id still refuses the delete. */
    const bookId = paths.makeBookId('Beta', 'Saga', 'Broken');
    const dir = seedBook('Beta', 'Saga', 'Broken', bookId);
    writeFileSync(paths.stateJsonPath(dir), '{ not json');
    const release = bookOp.__addBookJobToken(bookId, 'render');
    try {
      const res = await request(app).delete(`/api/books/${bookId}`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('book_busy');
      expect(existsSync(dir)).toBe(true);
    } finally {
      release();
    }
    /* Control: with the token released the same delete removes it. */
    const after = await request(app).delete(`/api/books/${bookId}`);
    expect(after.status).toBe(204);
    expect(existsSync(dir)).toBe(false);
  });
});

describe('(b) a walk that hit a read error is not authoritative', () => {
  const BOOK_ID = 'dup__s__twin';

  it('an EBUSY on the FIRST twin fails the resolve instead of indexing the second', async () => {
    const twin1 = seedBook('Dup', 'S', 'Twin1', BOOK_ID);
    const twin2 = seedBook('Dup', 'S', 'Twin2', BOOK_ID);

    faulted.add(paths.stateJsonPath(twin1));
    const during = await request(app)
      .put(`/api/books/${BOOK_ID}/state`)
      .send({ slice: 'state', patch: { castConfirmed: false } });
    expect(during.status).not.toBe(204);
    expect(JSON.stringify(during.body)).not.toContain(workspaceRoot);
    expect(bookOp.__bookDirIndexForTest().has(BOOK_ID)).toBe(false);
    faulted.clear();

    const put = await request(app)
      .put(`/api/books/${BOOK_ID}/state`)
      .send({ slice: 'state', patch: { castConfirmed: true } });
    expect(put.status).toBe(204);
    expect(readState(twin1).castConfirmed).toBe(true);
    expect(readState(twin2).castConfirmed).toBe(false);
    const get = await request(app).get(`/api/books/${BOOK_ID}/state`);
    expect(get.body.state.castConfirmed).toBe(true);
  });

  it('an EBUSY AFTER the first match neither clears the duplicate verdict nor writes the index', async () => {
    const twin1 = seedBook('Dup', 'S', 'Twin1', BOOK_ID);
    const twin2 = seedBook('Dup', 'S', 'Twin2', BOOK_ID);
    /* A clean walk records the duplicate. */
    expect(await bookOp.withBookOp(BOOK_ID, async (b) => b.bookDir)).toBe(twin1);
    expect(bookOp.__duplicateBookIdsForTest().has(BOOK_ID)).toBe(true);

    faulted.add(paths.stateJsonPath(twin2));
    /* The first match is still the first match... */
    expect(await bookOp.withBookOp(BOOK_ID, async (b) => b.bookDir)).toBe(twin1);
    /* ...but a walk that could not see past it proves nothing about uniqueness. */
    expect(bookOp.__duplicateBookIdsForTest().has(BOOK_ID)).toBe(true);
    expect(bookOp.__bookDirIndexForTest().has(BOOK_ID)).toBe(false);
  });

  it('an EBUSY after the first match does not index it even with no duplicate verdict yet', async () => {
    const twin1 = seedBook('Dup', 'S', 'Twin1', BOOK_ID);
    const twin2 = seedBook('Dup', 'S', 'Twin2', BOOK_ID);
    faulted.add(paths.stateJsonPath(twin2));
    expect(await bookOp.withBookOp(BOOK_ID, async (b) => b.bookDir)).toBe(twin1);
    expect(bookOp.__bookDirIndexForTest().has(BOOK_ID)).toBe(false);
  });

  it('control: a book that IS unique gets indexed by an error-free walk', async () => {
    const only = seedBook('Solo', 'S', 'Only', 'solo__s__only');
    expect(await bookOp.withBookOp('solo__s__only', async (b) => b.bookDir)).toBe(only);
    expect(bookOp.__bookDirIndexForTest().get('solo__s__only')).toBe(only);
  });
});

describe('(c) an unreadable state is never "id free"', () => {
  it('mintBookId and isBookIdTaken fail closed instead of re-minting an id they could not read', async () => {
    const base = paths.makeBookId('Gamma', 'Saga', 'Book');
    /* The book holding `base` was renamed away from its path-derived folder. */
    const dir = seedBook('Gamma', 'Saga', 'Renamed', base);
    /* Control: readable, the id is taken and the mint steps past it. */
    expect(await bookOp.isBookIdTaken(base)).toBe(true);
    expect(await bookOp.mintBookId('Gamma', 'Saga', 'Book')).not.toBe(base);

    faulted.add(paths.stateJsonPath(dir));
    await expect(bookOp.mintBookId('Gamma', 'Saga', 'Book')).rejects.toBeInstanceOf(bookOp.BookStateUnreadableError);
    await expect(bookOp.isBookIdTaken(base)).rejects.toBeInstanceOf(bookOp.BookStateUnreadableError);
  });

  it('the curated error carries no path', async () => {
    const dir = seedBook('Gamma', 'Saga', 'Other', 'gamma__saga__other');
    faulted.add(paths.stateJsonPath(dir));
    const err = await bookOp.isBookIdTaken('anything').catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(bookOp.BookStateUnreadableError);
    expect((err as Error).message).not.toContain(workspaceRoot);
    expect((err as Error).message).not.toMatch(/EBUSY/);
  });
});

describe('(d) the startup sweep never runs a step unlocked on a read error', () => {
  it('skips a folder whose state read throws EBUSY; the others still run', async () => {
    const busy = seedBook('Sweep', 'S', 'Busy', 'sweep__s__busy');
    const fine = seedBook('Sweep', 'S', 'Fine', 'sweep__s__fine');
    faulted.add(paths.stateJsonPath(busy));
    const fn = vi.fn(async (dir: string) => dir);
    const skipped = await bookOp.withBookOpAtDir(busy, fn);
    expect(fn).not.toHaveBeenCalled();
    expect(skipped).toBe(bookOp.BOOK_GONE);
    expect(await bookOp.withBookOpAtDir(fine, fn)).toBe(fine);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a state that does not parse keeps running unlocked (it carries no bookId)', async () => {
    const broken = seedBook('Sweep', 'S', 'Broken', 'sweep__s__broken');
    writeFileSync(paths.stateJsonPath(broken), '{ not json');
    const fn = vi.fn(async (dir: string) => dir);
    expect(await bookOp.withBookOpAtDir(broken, fn)).toBe(broken);
  });
});

describe('(e) an unlocked peekBook never moves the duplicate verdict', () => {
  const BOOK_ID = 'dup__s__peek';

  it('a peek that sees only one twin leaves a recorded verdict intact', async () => {
    const twin1 = seedBook('Dup', 'S', 'Peek1', BOOK_ID);
    const twin2 = seedBook('Dup', 'S', 'Peek2', BOOK_ID);
    expect(await bookOp.withBookOp(BOOK_ID, async (b) => b.bookDir)).toBe(twin1);
    expect(bookOp.__duplicateBookIdsForTest().has(BOOK_ID)).toBe(true);

    /* A mover has the other twin mid-flight: its state.json is not at the path. */
    const aside = `${paths.stateJsonPath(twin2)}.aside`;
    renameSync(paths.stateJsonPath(twin2), aside);
    expect((await bookOp.peekBook(BOOK_ID))?.bookDir).toBe(twin1);
    expect(bookOp.__duplicateBookIdsForTest().has(BOOK_ID)).toBe(true);

    renameSync(aside, paths.stateJsonPath(twin2));
    expect(await bookOp.withBookOp(BOOK_ID, async (b) => b.bookDir)).toBe(twin1);
    expect(bookOp.__duplicateBookIdsForTest().has(BOOK_ID)).toBe(true);
  });

  it('a peek that sees both twins does not record a verdict either', async () => {
    seedBook('Dup', 'S', 'Peek1', BOOK_ID);
    seedBook('Dup', 'S', 'Peek2', BOOK_ID);
    await bookOp.peekBook(BOOK_ID);
    expect(bookOp.__duplicateBookIdsForTest().has(BOOK_ID)).toBe(false);
  });

  it('a locked resolve still clears the verdict once the other twin is really gone', async () => {
    const twin1 = seedBook('Dup', 'S', 'Peek1', BOOK_ID);
    const twin2 = seedBook('Dup', 'S', 'Peek2', BOOK_ID);
    await bookOp.withBookOp(BOOK_ID, async (b) => b.bookDir);
    rmSync(twin2, { recursive: true, force: true });
    await bookOp.withBookOp(BOOK_ID, async (b) => b.bookDir);
    expect(bookOp.__duplicateBookIdsForTest().has(BOOK_ID)).toBe(false);
    expect(bookOp.__bookDirIndexForTest().get(BOOK_ID)).toBe(twin1);
  });
});
