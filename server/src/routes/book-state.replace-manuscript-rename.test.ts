/* #3400 review passes 9/10, reconciled with #3711 -- a folder-renaming PUT
   /state that lands while replace-manuscript / reparse is inside its destructive
   arms. The arms and the upload paths use the folder the run resolved, so a move
   mid-run would leave the moved book with old chapters but no cast / audio /
   cache. Both routes hold the book's `book-op` lock across the whole commit
   (#3711), so a rename queued behind the run WAITS for it and then moves the
   finished book: it lands at the new folder and the old path is never
   recreated. (#3400 pass 10 refused the rename with a 409 off a reparse-busy
   marker; book-op made that marker redundant and it was removed.) The locked
   step's backstop still covers a folder moved on disk by something that does
   not take book-op, driven here by moving the folder from inside the arms. The
   interleave is forced by holding resetRevisions (one of the arms) open. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const hooks = vi.hoisted(() => ({
  hold: undefined as undefined | (() => Promise<void>),
  /* runs once, right after parseManuscript returns (before the commit) */
  afterParse: undefined as undefined | (() => void),
  /* the hold-plus-write of the resetRevisions call that consumed `hold` */
  resetSettled: undefined as undefined | Promise<void>,
}));

vi.mock('../parsers/index.js', async () => {
  const real = await vi.importActual<typeof import('../parsers/index.js')>('../parsers/index.js');
  return {
    ...real,
    parseManuscript: async (...a: Parameters<typeof real.parseManuscript>) => {
      const out = await real.parseManuscript(...a);
      const h = hooks.afterParse;
      if (h) {
        hooks.afterParse = undefined;
        h();
      }
      return out;
    },
  };
});

vi.mock('../workspace/revisions-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workspace/revisions-store.js')>();
  return {
    ...real,
    resetRevisions: async (dir: string) => {
      const h = hooks.hold;
      if (!h) return real.resetRevisions(dir);
      hooks.hold = undefined;
      hooks.resetSettled = (async () => {
        await h();
        await real.resetRevisions(dir);
      })();
      return hooks.resetSettled;
    },
  };
});

const AUTHOR = 'Rename Author';
const SERIES = 'Standalones';
const TITLE = 'Rename Book';
const NEW_TITLE = 'Renamed Book';

let ws: string;
let app: Express;
let bookId: string;
let oldDir: string;
let newDir: string;

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) for (const f of files(join(dir, e.name))) out.push(`${e.name}/${f}`);
    else out.push(e.name);
  }
  return out.sort();
}

beforeEach(async () => {
  ws = mkdtempSync(join(tmpdir(), 'audiobook-replace-rename-'));
  process.env.WORKSPACE_DIR = ws;
  vi.resetModules();
  const { bookStateRouter } = await import('./book-state.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  oldDir = join(ws, 'books', AUTHOR, SERIES, TITLE);
  newDir = join(ws, 'books', AUTHOR, SERIES, NEW_TITLE);
  mkdirSync(join(oldDir, '.audiobook'), { recursive: true });
  writeFileSync(join(oldDir, 'manuscript.md'), '# Chapter One\n\nOne.\nTwo.\n');
  writeFileSync(
    join(oldDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_rename_probe',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one', uuid: 'u1' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      chapterTitleParserVersion: 99,
    }),
  );
  writeFileSync(
    join(oldDir, '.audiobook', 'cast.json'),
    JSON.stringify({ characters: [{ id: 'a', name: 'A' }] }),
  );
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterEach(() => {
  hooks.hold = undefined;
  hooks.afterParse = undefined;
  hooks.resetSettled = undefined;
  rmSync(ws, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

async function bookOpWaiters(): Promise<number> {
  const { __keyWaitersForTest } = await import('../workspace/file-lock.js');
  return __keyWaitersForTest(`book-op:${bookId}`);
}

/* From inside the held arms, fire a request and return once it has QUEUED on
   the book's book-op lock (the run holds it). It cannot finish inside the hold
   -- awaiting it there would deadlock -- so the test awaits its response after
   the run returns. After the queue proof the hold waits 250 ms: with book-op
   held across resetRevisions the request cannot answer in that window, so a
   run that lets the reset write escape the span lets it answer first. The
   returned getter awaits the reset write (unswallowed) and asserts the queue
   proof happened, so a failed proof cannot hide in the hold's own rejection. */
function queuedDuringArms(
  what: string,
  fire: () => request.Test,
): () => Promise<request.Response> {
  let pending: Promise<request.Response> | undefined;
  let queued = false;
  hooks.hold = async () => {
    const queuedBefore = await bookOpWaiters();
    const p = fire();
    pending = new Promise<request.Response>((resolve, reject) => p.then(resolve, reject));
    await vi.waitFor(async () => expect(await bookOpWaiters()).toBeGreaterThan(queuedBefore), {
      timeout: 5_000,
    });
    queued = true;
    await Promise.race([pending, new Promise((r) => setTimeout(r, 250))]);
  };
  return async () => {
    if (!pending) throw new Error(`the ${what} was never fired (the arms were not reached)`);
    await hooks.resetSettled;
    expect(queued).toBe(true);
    return pending;
  };
}

function putQueuedDuringArms(patch: Record<string, unknown>): () => Promise<request.Response> {
  return queuedDuringArms('PUT', () =>
    request(app).put(`/api/books/${bookId}/state`).send({ slice: 'state', patch }),
  );
}

function deleteQueuedDuringArms(): () => Promise<request.Response> {
  return queuedDuringArms('DELETE', () => request(app).delete(`/api/books/${bookId}`));
}

/* Move the folder out-of-band (not through the route) from inside the hold, to
   exercise the locked step's backstop. */
function moveFolderOnDiskDuringArms(): void {
  hooks.hold = async () => {
    renameSync(oldDir, newDir);
  };
}

const UPLOAD = Buffer.from('## Fresh A\n\nAlpha.\n\n## Fresh B\n\nBeta.\n');

describe('a rename queued behind a reparse / replace-manuscript waits, then lands (#3711)', () => {
  it('reparse: the rename waits, then moves the reparsed book; the old path is never recreated', async () => {
    const rename = putQueuedDuringArms({ title: NEW_TITLE });
    const res = await request(app).post(`/api/books/${bookId}/reparse`).send({});
    expect(res.status).toBe(200);
    const r = await rename();
    expect(r.status).toBe(200);
    expect(existsSync(oldDir)).toBe(false);
    const state = JSON.parse(readFileSync(join(newDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.title).toBe(NEW_TITLE);
    expect(state.castConfirmed).toBe(false);
    expect(state.chapters.map((c: { title: string }) => c.title)).toEqual(['Chapter 1']);
    expect(existsSync(join(newDir, '.audiobook', 'cast.json'))).toBe(false);
  });

  it('replace-manuscript: the rename waits, then moves the replaced book; the old path is never recreated', async () => {
    const rename = putQueuedDuringArms({ title: NEW_TITLE });
    const res = await request(app)
      .post(`/api/books/${bookId}/replace-manuscript`)
      .attach('file', UPLOAD, 'revised.md');
    expect(res.status).toBe(200);
    const r = await rename();
    expect(r.status).toBe(200);
    expect(existsSync(oldDir)).toBe(false);
    const state = JSON.parse(readFileSync(join(newDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.title).toBe(NEW_TITLE);
    expect(state.chapters.map((c: { title: string }) => c.title)).toEqual(['Fresh A', 'Fresh B']);
    expect(readFileSync(join(newDir, 'manuscript.md'), 'utf8')).toContain('Fresh A');
    expect(files(newDir).filter((f) => f.startsWith('.manuscript-'))).toEqual([]);
  });

  it('a non-moving PUT during a reparse still returns 200 once the run finishes', async () => {
    const put = putQueuedDuringArms({ castConfirmed: true });
    const res = await request(app).post(`/api/books/${bookId}/reparse`).send({});
    expect(res.status).toBe(200);
    expect((await put()).status).toBe(200);
    const state = JSON.parse(readFileSync(join(oldDir, '.audiobook', 'state.json'), 'utf8'));
    /* the PUT ran after the reparse, so its castConfirmed lands last */
    expect(state.castConfirmed).toBe(true);
    expect(state.chapters.map((c: { title: string }) => c.title)).toEqual(['Chapter 1']);
  });

  it('a reparse that throws releases book-op: a later rename moves the book', async () => {
    hooks.hold = async () => {
      throw new Error('boom');
    };
    const res = await request(app).post(`/api/books/${bookId}/reparse`).send({});
    expect(res.status).toBe(500);
    const r = await request(app)
      .put(`/api/books/${bookId}/state`)
      .send({ slice: 'state', patch: { title: NEW_TITLE } });
    expect(r.status).toBe(200);
    expect(existsSync(newDir)).toBe(true);
    expect(existsSync(oldDir)).toBe(false);
  });
});

describe('a DELETE queued behind a reparse / replace-manuscript waits, then removes the book (#3715)', () => {
  it.each(['reparse', 'replace-manuscript'] as const)(
    '%s: a DELETE queued behind the run waits, then removes the whole book; revisions.json is not resurrected (#3715)',
    async (route) => {
      const del = deleteQueuedDuringArms();
      const req = request(app).post(`/api/books/${bookId}/${route}`);
      const res =
        route === 'reparse' ? await req.send({}) : await req.attach('file', UPLOAD, 'revised.md');
      expect(res.status).toBe(200);
      expect((await del()).status).toBe(204);
      expect(existsSync(oldDir)).toBe(false);
      expect(files(join(ws, 'books'))).toEqual([]);
    },
  );
});

describe.each([
  ['a format change', 'revised.txt', 'manuscript.md'],
  ['the same extension', 'revised.md', 'manuscript.md'],
])(
  'replace-manuscript backstop: folder moved on disk during the arms (%s)',
  (_label, upload, original) => {
    it('answers 409 book_moved, installs nothing and leaves state.json and the manuscript file as they were', async () => {
      moveFolderOnDiskDuringArms();
      const res = await request(app)
        .post(`/api/books/${bookId}/replace-manuscript`)
        .attach('file', UPLOAD, upload);

      /* An out-of-band move is not something the API can produce (every
         in-process mover holds book-op); the locked step refuses it. The book
         still exists in its new folder, so the answer is not "not found". */
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('book_moved');
      expect(JSON.stringify(res.body)).not.toContain(ws);
      /* JSON doubles each backslash, so on Windows the raw root never matches the serialised body. */
      expect(JSON.stringify(res.body)).not.toContain(JSON.stringify(ws).slice(1, -1));

      const state = JSON.parse(readFileSync(join(newDir, '.audiobook', 'state.json'), 'utf8'));
      expect(state.manuscriptFile).toBe(original);
      expect(state.chapters.map((c: { title: string }) => c.title)).toEqual(['Chapter One']);
      expect(readFileSync(join(newDir, original), 'utf8')).toContain('Chapter One');
      // nothing installed or left behind in either folder
      expect(
        files(newDir).filter((f) => f.startsWith('.manuscript-') || f === 'manuscript.txt'),
      ).toEqual([]);
      expect(files(oldDir).filter((f) => !f.startsWith('.audiobook/'))).toEqual([]);

      const again = await request(app).post(`/api/books/${bookId}/reparse`).send({});
      expect(again.status).toBe(200);
    });
  },
);

describe('reparse backstop: folder moved on disk during the arms', () => {
  it('answers 409 book_moved and leaves state.json untouched (the cast is already gone by then)', async () => {
    moveFolderOnDiskDuringArms();
    const res = await request(app).post(`/api/books/${bookId}/reparse`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('book_moved');
    expect(JSON.stringify(res.body)).not.toContain(ws);
    /* JSON doubles each backslash, so on Windows the raw root never matches the serialised body. */
    expect(JSON.stringify(res.body)).not.toContain(JSON.stringify(ws).slice(1, -1));
    const state = JSON.parse(readFileSync(join(newDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.chapters.map((c: { title: string }) => c.title)).toEqual(['Chapter One']);
    expect(state.castConfirmed).toBe(true);
  });
});

describe('backstop: book deleted on disk during the arms', () => {
  it.each(['reparse', 'replace-manuscript'] as const)(
    '%s: answers 404 (the book is truly gone)',
    async (route) => {
      hooks.hold = async () => {
        rmSync(oldDir, { recursive: true, force: true });
      };
      const req = request(app).post(`/api/books/${bookId}/${route}`);
      const res =
        route === 'reparse' ? await req.send({}) : await req.attach('file', UPLOAD, 'revised.md');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Book not found.');
    },
  );
});

/* A folder moved on disk AFTER the slow parse and BEFORE the commit: the commit
   resolves the book under book-op, so it runs against the folder the book is in
   NOW, and nothing is written at the vacated path. A deleted book answers 404. */
describe('book moved or deleted between the parse and the commit (#3711 two-span)', () => {
  it.each(['reparse', 'replace-manuscript'] as const)(
    '%s: a move after the parse commits into the moved folder; the old path is not recreated',
    async (route) => {
      hooks.afterParse = () => renameSync(oldDir, newDir);
      const req = request(app).post(`/api/books/${bookId}/${route}`);
      const res =
        route === 'reparse' ? await req.send({}) : await req.attach('file', UPLOAD, 'revised.md');
      expect(res.status).toBe(200);
      expect(existsSync(oldDir)).toBe(false);
      const state = JSON.parse(readFileSync(join(newDir, '.audiobook', 'state.json'), 'utf8'));
      expect(state.chapters.map((c: { title: string }) => c.title)).toEqual(
        route === 'reparse' ? ['Chapter 1'] : ['Fresh A', 'Fresh B'],
      );
      expect(existsSync(join(newDir, '.audiobook', 'cast.json'))).toBe(false);
    },
  );

  it.each(['reparse', 'replace-manuscript'] as const)(
    '%s: a book deleted after the parse answers 404',
    async (route) => {
      hooks.afterParse = () => rmSync(oldDir, { recursive: true, force: true });
      const req = request(app).post(`/api/books/${bookId}/${route}`);
      const res =
        route === 'reparse' ? await req.send({}) : await req.attach('file', UPLOAD, 'revised.md');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Book not found.');
      expect(existsSync(oldDir)).toBe(false);
    },
  );
});
