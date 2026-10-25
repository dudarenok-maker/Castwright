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
         again.
   Pass 3 narrowed (b) and (c) to the uncertainty they carry (owner decision
   2026-10-18, see book-op.unreadable-sibling.test.ts): an undetected duplicate
   now resolves to its second twin non-authoritatively, and an unreadable library
   mints a non-colliding id instead of refusing. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { ZipFile } from 'yazl';

/* Paths (state.json) whose read throws EBUSY, the way Windows does while another
   process holds the file. Every other read is the real recovering reader. */
const faulted = vi.hoisted(() => new Set<string>());
/* Per-path scripted reads: each read of the path takes the next outcome; the
   LAST outcome sticks. `['ok', 'busy']` = "succeeds once, then throws EBUSY". */
const scripted = vi.hoisted(() => new Map<string, Array<'ok' | 'busy'>>());

vi.mock('../workspace/state-migrate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-migrate.js')>();
  return {
    ...actual,
    readStateJsonWithRecovery: async (path: string) => {
      const script = scripted.get(path);
      const next = script ? (script.length > 1 ? script.shift() : script[0]) : 'ok';
      if (faulted.has(path) || next === 'busy') {
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
let portable: typeof import('../import/scan-import-folder.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-book-op-read-errors-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Sequential imports -- a Promise.all of dynamic imports races vi.mock factories (#2083). */
  const { bookStateRouter } = await import('./book-state.js');
  paths = await import('../workspace/paths.js');
  bookOp = await import('../workspace/book-op-lock.js');
  bookJobs = await import('../workspace/book-jobs.js');
  portable = await import('../import/scan-import-folder.js');
  const { portableImportRouter } = await import('./exports-portable.js');
  const { chaptersRestructureRouter } = await import('./chapters-restructure.js');
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
  app.use('/api/import', portableImportRouter);
  app.use('/api/books', chaptersRestructureRouter);
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
  scripted.clear();
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

/** A client body carries no absolute path and no raw fs error. Checked on every
 *  string field directly AND on the JSON text in both spellings: on Windows
 *  `JSON.stringify` doubles each backslash, so the raw root alone never matches
 *  the serialised body (PR #3714 review pass 4). */
function expectNoPathLeak(body: unknown): void {
  const json = JSON.stringify(body);
  const fields: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') fields.push(v);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(body);
  for (const text of [...fields, json]) {
    expect(text).not.toContain(workspaceRoot);
    expect(text).not.toContain(JSON.stringify(workspaceRoot).slice(1, -1));
    expect(text).not.toMatch(/EBUSY/);
  }
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
      expectNoPathLeak(res.body);
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

  it('an EBUSY on the FIRST twin of an undetected duplicate: the second is written but never indexed', async () => {
    /* PR #3714 review pass 3, owner decision 2026-10-18: the walk skips past an
       unreadable folder, so a duplicate nobody has detected yet resolves to its
       second twin while the first is faulted (the accepted residual; a KNOWN
       duplicate still fails -- book-op.unreadable-sibling.test.ts). The answer
       is non-authoritative: no index write and no duplicate verdict. */
    const twin1 = seedBook('Dup', 'S', 'Twin1', BOOK_ID);
    const twin2 = seedBook('Dup', 'S', 'Twin2', BOOK_ID);

    faulted.add(paths.stateJsonPath(twin1));
    const during = await request(app)
      .put(`/api/books/${BOOK_ID}/state`)
      .send({ slice: 'state', patch: { castConfirmed: false } });
    expect(during.status).toBe(200);
    expect(bookOp.__bookDirIndexForTest().has(BOOK_ID)).toBe(false);
    expect(bookOp.__duplicateBookIdsForTest().has(BOOK_ID)).toBe(false);
    faulted.clear();

    const put = await request(app)
      .put(`/api/books/${BOOK_ID}/state`)
      .send({ slice: 'state', patch: { castConfirmed: true } });
    expect(put.status).toBe(200);
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
  it('mintBookId and isBookIdTaken never hand out an id the unreadable book could carry', async () => {
    const base = paths.makeBookId('Gamma', 'Saga', 'Book');
    /* The book holding `base` was renamed away from its path-derived folder, so
       its path says nothing about its id. */
    const dir = seedBook('Gamma', 'Saga', 'Renamed', base);
    /* Control: readable, the id is taken and the mint steps past it. */
    expect(await bookOp.isBookIdTaken(base)).toBe(true);
    expect(await bookOp.mintBookId('Gamma', 'Saga', 'Book')).toBe(`${base}-2`);

    /* PR #3714 review pass 3: unreadable, the mint does not refuse (that blocked
       every import) but takes a suffix the counter never produces, and
       `isBookIdTaken` answers "taken" for any id. */
    faulted.add(paths.stateJsonPath(dir));
    const minted = await bookOp.mintBookId('Gamma', 'Saga', 'Book');
    expect(minted).not.toBe(base);
    expect(minted).toMatch(/^gamma__saga__book-u[0-9a-f]{8}$/);
    expect(await bookOp.isBookIdTaken(base)).toBe(true);
    expect(await bookOp.isBookIdTaken('anything__else__entirely')).toBe(true);
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

describe('(f) the stateless DELETE judges the folder by the bookId it holds (review pass 3, A)', () => {
  /* A renamed book keeps its id: `Aut/S/New` carries `aut__s__old`. While its
     state is unreadable the library row shows the PATH-derived id
     `aut__s__new`, so the request's id says nothing about the running job. */
  const OLD = 'aut__s__old';
  const NEW = 'aut__s__new';

  it('refuses when the folder turns unreadable again inside its lock', async () => {
    const dir = seedBook('Aut', 'S', 'New', OLD);
    const render = await holdRender(OLD);
    try {
      /* The walk reads it (no folder carries `aut__s__new`: BOOK_GONE), the
         stateless scan maps the EBUSY to `unreadable`, and so does the re-read. */
      scripted.set(paths.stateJsonPath(dir), ['ok', 'busy']);
      const res = await request(app).delete(`/api/books/${NEW}`);
      expect(res.status).not.toBe(204);
      expect(existsSync(dir)).toBe(true);
      expect(bookJobs.bookJobKinds(OLD)).toEqual(['render']);
      expectNoPathLeak(res.body);
    } finally {
      scripted.clear();
      await render.finish();
    }
  });

  it('refuses book_changed when the in-lock read shows a bookId (even one with a registered job)', async () => {
    const dir = seedBook('Aut', 'S', 'New', OLD);
    const render = await holdRender(OLD);
    try {
      scripted.set(paths.stateJsonPath(dir), ['ok', 'busy', 'ok']);
      const res = await request(app).delete(`/api/books/${NEW}`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('book_changed');
      expect(existsSync(dir)).toBe(true);
    } finally {
      scripted.clear();
      await render.finish();
    }
  });
});

describe('(g) a state read that flips after the resolve never puts a path in the body (review pass 3, B)', () => {
  it('DELETE', async () => {
    const dir = seedBook('Zed', 'S', 'Book', 'zed__s__book');
    scripted.set(paths.stateJsonPath(dir), ['ok', 'busy']);
    const res = await request(app).delete('/api/books/zed__s__book');
    expect(res.status).toBe(500);
    expect(existsSync(dir)).toBe(true);
    expectNoPathLeak(res.body);
  });

  it('a renaming PUT', async () => {
    const dir = seedBook('Zed', 'S', 'Book', 'zed__s__book');
    scripted.set(paths.stateJsonPath(dir), ['ok', 'busy']);
    const res = await request(app)
      .put('/api/books/zed__s__book/state')
      .send({ slice: 'state', patch: { title: 'Renamed' } });
    expect(res.status).toBe(500);
    expect(existsSync(dir)).toBe(true);
    expectNoPathLeak(res.body);
  });
});

describe('(i) GET /state never puts a path in its 500 body (review pass 3, E)', () => {
  it('the book turns unreadable after it was located', async () => {
    const dir = seedBook('Zed', 'S', 'Book', 'zed__s__book');
    /* Owe no title refresh / uuid mint, so the GET does not re-locate (that
       path reads absence and answers 404) and reaches the series scan. */
    const st = readState(dir);
    writeFileSync(
      paths.stateJsonPath(dir),
      JSON.stringify({
        ...st,
        chapterTitleParserVersion: 999,
        chapters: [{ id: 1, title: 'Chapter 1', slug: '01-x', uuid: '00000000-0000-4000-8000-000000000001' }],
      }),
    );
    scripted.set(paths.stateJsonPath(dir), ['ok', 'busy']);
    const res = await request(app).get('/api/books/zed__s__book/state');
    expect(res.status).toBe(500);
    expectNoPathLeak(res.body);
  });
});

describe('(h) a startup sweep survives a per-book throw (review pass 3, D)', () => {
  /* `Aaa/S/Flip` reads fine for withBookOpAtDir, then its hint read inside
     withBookOp throws: that book is skipped, and the books after it still run. */
  function seedFlipThenZed(): string {
    const flip = seedBook('Aaa', 'S', 'Flip', 'aaa__s__flip');
    scripted.set(paths.stateJsonPath(flip), ['ok', 'busy']);
    const zed = seedBook('Zed', 'S', 'Book', 'zed__s__book');
    writeFileSync(join(zed, '.audiobook', 'change-log.json'), JSON.stringify({ events: [] }));
    return zed;
  }

  it('migrateLegacyChangeLogs', async () => {
    const zed = seedFlipThenZed();
    const { migrateLegacyChangeLogs } = await import('../workspace/changelog-migrate.js');
    const result = await migrateLegacyChangeLogs();
    expect(result.clean).toContain(zed);
  });

  it('fsckAllBooks', async () => {
    seedFlipThenZed();
    const { fsckAllBooks } = await import('../workspace/fsck-orphan-audio.js');
    await expect(fsckAllBooks()).resolves.toBeDefined();
  });
});

/** A minimal portable bundle (the layout buildPortableBundle writes). */
function makeBundle(state: Record<string, unknown>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    zip.addBuffer(Buffer.from(JSON.stringify({ schemaVersion: 1 })), 'MANIFEST.json');
    zip.addBuffer(Buffer.from(JSON.stringify(state)), 'state.json');
    zip.addBuffer(Buffer.from('bundle manuscript'), String(state.manuscriptFile));
    zip.end();
  });
}

describe('(j) a bundle overwrite never runs on an unreadable target state (review pass 4)', () => {
  /* Reading the target's id as "none" skipped book-op and the busy refusal, and
     the in-claim re-check (also "none") passed: the overwrite replaced the book
     and minted it a new id while a render was registered under the old one --
     #3711's split. A read failure is the curated refusal; nothing is replaced. */
  const bundle = () =>
    makeBundle({
      bookId: 'bundle-id',
      manuscriptId: 'mns_bundle',
      title: 'Busy Target',
      author: 'Probe Author',
      series: 'S',
      seriesPosition: null,
      isStandalone: false,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter 1', slug: '01-x' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

  it('refuses while a render is registered, and leaves the id and files alone', async () => {
    const dir = seedBook('Probe Author', 'S', 'Busy Target', 'busy-id');
    expect(paths.bookDirByDisplay('Probe Author', 'S', 'Busy Target')).toBe(dir);
    const render = await holdRender('busy-id');
    try {
      /* Control: readable, the overwrite is refused as busy. */
      await expect(portable.importPortableBundle(await bundle(), { onConflict: 'overwrite' })).rejects.toBeInstanceOf(
        bookOp.BookBusyError,
      );

      faulted.add(paths.stateJsonPath(dir));
      await expect(portable.importPortableBundle(await bundle(), { onConflict: 'overwrite' })).rejects.toBeInstanceOf(
        bookOp.BookStateUnreadableError,
      );
      const res = await request(app)
        .post('/api/import/portable?onConflict=overwrite')
        .attach('file', await bundle(), 'b.zip');
      expect(res.status).toBe(500);
      expect(res.body.message).toBe(new bookOp.BookStateUnreadableError().message);
      expectNoPathLeak(res.body);
      faulted.clear();

      expect(readState(dir).bookId).toBe('busy-id');
      expect(readFileSync(join(dir, 'manuscript.md'), 'utf8')).toBe('Opening prose here.\n');
      expect(bookJobs.bookJobKinds('busy-id')).toEqual(['render']);
    } finally {
      faulted.clear();
      await render.finish();
    }
  });

  it('refuses when only the in-claim re-check cannot read the state', async () => {
    const dir = seedBook('Probe Author', 'S', 'Busy Target', 'busy-id');
    /* The unlocked id read and book-op's resolve succeed; the claim's re-check throws. */
    scripted.set(paths.stateJsonPath(dir), ['ok', 'ok', 'busy']);
    await expect(portable.importPortableBundle(await bundle(), { onConflict: 'overwrite' })).rejects.toBeInstanceOf(
      bookOp.BookStateUnreadableError,
    );
    scripted.clear();
    expect(readState(dir).bookId).toBe('busy-id');
    expect(readFileSync(join(dir, 'manuscript.md'), 'utf8')).toBe('Opening prose here.\n');
  });

  it('refuses when only the outer, unlocked id read cannot read the state (review pass 5)', async () => {
    const dir = seedBook('Probe Author', 'S', 'Busy Target', 'busy-id');
    /* The unlocked id read throws once; every later read succeeds. Swallowing it
       as "carries no id" skipped book-op and reached the claim's re-check, which
       read `busy-id` and answered a 409 BundleConflictError -- a read fault
       mislabelled as a conflict. */
    scripted.set(paths.stateJsonPath(dir), ['busy', 'ok']);
    await expect(portable.importPortableBundle(await bundle(), { onConflict: 'overwrite' })).rejects.toBeInstanceOf(
      bookOp.BookStateUnreadableError,
    );
    scripted.clear();
    expect(readState(dir).bookId).toBe('busy-id');
    expect(readFileSync(join(dir, 'manuscript.md'), 'utf8')).toBe('Opening prose here.\n');
  });
});

describe('(k) an in-lock state re-read that fails never puts a path in the body (review pass 4)', () => {
  /* Each route resolves the book (that read succeeds), then re-reads state.json
     under its locks; that read throws EBUSY. The fs message names the absolute
     path; the body answers the curated BookStateUnreadableError sentence. */
  const curated = () => new bookOp.BookStateUnreadableError().message;

  it('a PUT /state that moves no folder (every autosave)', async () => {
    const dir = seedBook('Zed', 'S', 'Book', 'zed__s__book');
    scripted.set(paths.stateJsonPath(dir), ['ok', 'busy']);
    const res = await request(app)
      .put('/api/books/zed__s__book/state')
      .send({ slice: 'state', patch: { castConfirmed: true } });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(curated());
    expectNoPathLeak(res.body);
    scripted.clear();
    expect(readState(dir).castConfirmed).toBe(false);
  });

  it("reparse's presence gate", async () => {
    const dir = seedBook('Zed', 'S', 'Book', 'zed__s__book');
    /* prepareReparse's peek, then book-op's resolve, then the gate. */
    scripted.set(paths.stateJsonPath(dir), ['ok', 'ok', 'busy']);
    const res = await request(app).post('/api/books/zed__s__book/reparse');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(curated());
    expectNoPathLeak(res.body);
  });

  it("a chapter restructure's in-lock read", async () => {
    const dir = seedBook('Zed', 'S', 'Book', 'zed__s__book');
    const { getOrHydrateManuscript } = await import('../store/manuscripts.js');
    expect(await getOrHydrateManuscript('m_Book')).toBeDefined();
    /* prepareRestructure's peek, then book-op's resolve, then the in-lock read. */
    scripted.set(paths.stateJsonPath(dir), ['ok', 'ok', 'busy']);
    const res = await request(app)
      .post('/api/books/zed__s__book/chapters/merge')
      .send({ chapterIds: [1] });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(curated());
    expectNoPathLeak(res.body);
  });
});
