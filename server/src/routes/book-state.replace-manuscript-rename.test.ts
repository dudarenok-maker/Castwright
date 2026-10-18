/* #3400 review passes 9/10 -- a folder-renaming PUT /state that lands while
   replace-manuscript / reparse is inside its destructive arms. The arms and the
   upload paths are resolved from the pre-lock bookDir, so a move mid-run would
   leave the moved book with old chapters but no cast / audio / cache. Pass 10:
   the rename is REFUSED (409) while a reparse / replace-manuscript is running
   for the book; the locked step's 404 is only a defensive backstop, driven here
   by moving the folder on disk (the route can no longer reach it). The
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
  /* runs once, right after the NEXT findBookByBookId resolves, before it returns */
  afterNextFind: undefined as undefined | (() => void),
  /* runs after EVERY findBookByBookId, with its 1-based call number */
  onFind: undefined as undefined | ((n: number) => void),
  findCalls: 0,
  /* runs once, right after parseManuscript returns (before applyReparse) */
  afterParse: undefined as undefined | (() => void),
  /* runs once, right after the rename route's mkdir resolves */
  afterMkdir: undefined as undefined | (() => void),
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

vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...real,
    default: real,
    mkdir: async (...a: Parameters<typeof real.mkdir>) => {
      const out = await real.mkdir(...a);
      const h = hooks.afterMkdir;
      if (h) {
        hooks.afterMkdir = undefined;
        h();
      }
      return out;
    },
  };
});

/* Resolved per call: the factory result is cached across vi.resetModules(), but
   the real module reads WORKSPACE_DIR at import, which changes every test. */
vi.mock('../workspace/scan.js', async () => {
  const first = await vi.importActual<typeof import('../workspace/scan.js')>('../workspace/scan.js');
  return {
    ...first,
    findBookByBookId: async (id: string) => {
      const real = await vi.importActual<typeof import('../workspace/scan.js')>(
        '../workspace/scan.js',
      );
      const found = await real.findBookByBookId(id);
      hooks.findCalls++;
      hooks.onFind?.(hooks.findCalls);
      const h = hooks.afterNextFind;
      if (h) {
        hooks.afterNextFind = undefined;
        h();
      }
      return found;
    },
  };
});

vi.mock('../workspace/revisions-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workspace/revisions-store.js')>();
  return {
    ...real,
    resetRevisions: async (dir: string) => {
      const h = hooks.hold;
      if (h) {
        hooks.hold = undefined;
        await h();
      }
      return real.resetRevisions(dir);
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
  hooks.findCalls = 0;
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
  hooks.afterNextFind = undefined;
  hooks.onFind = undefined;
  hooks.afterParse = undefined;
  hooks.afterMkdir = undefined;
  rmSync(ws, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

/* Hold the arms open and PUT a folder-moving rename from inside the hold. */
function renameDuringArms(): () => { status: number; error?: string } {
  let out: { status: number; error?: string } = { status: -1 };
  hooks.hold = async () => {
    const r = await request(app)
      .put(`/api/books/${bookId}/state`)
      .send({ slice: 'state', patch: { title: NEW_TITLE } });
    out = { status: r.status, error: r.body?.error };
  };
  return () => out;
}

/* Move the folder out-of-band (not through the route) from inside the hold, to
   exercise the locked step's backstop. */
function moveFolderOnDiskDuringArms(): void {
  hooks.hold = async () => {
    renameSync(oldDir, newDir);
  };
}

const UPLOAD = Buffer.from('## Fresh A\n\nAlpha.\n\n## Fresh B\n\nBeta.\n');
const MOVED =
  'This book was moved while the manuscript was re-parsed. Try again in a moment.';
const UNSTABLE =
  'This book was being moved while the manuscript was re-parsed. Try again in a moment.';
const REFUSAL =
  'The manuscript is being re-parsed for this book. Wait for it to finish before renaming it.';

describe('rename refused while a reparse / replace-manuscript runs (#3400 pass 10)', () => {
  it('reparse: rename PUT gets 409, folder not moved, reparse completes 200', async () => {
    const rename = renameDuringArms();
    const res = await request(app).post(`/api/books/${bookId}/reparse`).send({});
    expect(rename().status).toBe(409);
    expect(rename().error).toBe(REFUSAL);
    expect(res.status).toBe(200);
    expect(existsSync(newDir)).toBe(false);
    const state = JSON.parse(readFileSync(join(oldDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.title).toBe(TITLE);
    expect(state.castConfirmed).toBe(false);
    expect(state.chapters.map((c: { title: string }) => c.title)).toEqual(['Chapter 1']);
    expect(existsSync(join(oldDir, '.audiobook', 'cast.json'))).toBe(false);
  });

  it('replace-manuscript: rename PUT gets 409, folder not moved, replace completes 200', async () => {
    const rename = renameDuringArms();
    const res = await request(app)
      .post(`/api/books/${bookId}/replace-manuscript`)
      .attach('file', UPLOAD, 'revised.md');
    expect(rename().status).toBe(409);
    expect(rename().error).toBe(REFUSAL);
    expect(res.status).toBe(200);
    expect(existsSync(newDir)).toBe(false);
    const state = JSON.parse(readFileSync(join(oldDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.chapters.map((c: { title: string }) => c.title)).toEqual(['Fresh A', 'Fresh B']);
    expect(readFileSync(join(oldDir, 'manuscript.md'), 'utf8')).toContain('Fresh A');
  });

  it('a non-moving PUT during a reparse still returns 204', async () => {
    let status = -1;
    hooks.hold = async () => {
      const r = await request(app)
        .put(`/api/books/${bookId}/state`)
        .send({ slice: 'state', patch: { castConfirmed: true } });
      status = r.status;
    };
    const res = await request(app).post(`/api/books/${bookId}/reparse`).send({});
    expect(status).toBe(204);
    expect(res.status).toBe(200);
  });

  it('the marker is cleared after a completed reparse', async () => {
    const res = await request(app).post(`/api/books/${bookId}/reparse`).send({});
    expect(res.status).toBe(200);
    const r = await request(app)
      .put(`/api/books/${bookId}/state`)
      .send({ slice: 'state', patch: { title: NEW_TITLE } });
    expect(r.status).toBe(204);
    expect(existsSync(newDir)).toBe(true);
  });

  it('the marker is cleared after a reparse that throws', async () => {
    hooks.hold = async () => {
      throw new Error('boom');
    };
    const res = await request(app).post(`/api/books/${bookId}/reparse`).send({});
    expect(res.status).toBe(500);
    const r = await request(app)
      .put(`/api/books/${bookId}/state`)
      .send({ slice: 'state', patch: { title: NEW_TITLE } });
    expect(r.status).toBe(204);
    expect(existsSync(newDir)).toBe(true);
  });

  it('the marker is cleared after a replace-manuscript that fails', async () => {
    hooks.hold = async () => {
      throw new Error('boom');
    };
    const res = await request(app)
      .post(`/api/books/${bookId}/replace-manuscript`)
      .attach('file', UPLOAD, 'revised.md');
    expect(res.status).toBe(500);
    const r = await request(app)
      .put(`/api/books/${bookId}/state`)
      .send({ slice: 'state', patch: { title: NEW_TITLE } });
    expect(r.status).toBe(204);
  });
});

describe.each([
  ['a format change', 'revised.txt', 'manuscript.md'],
  ['the same extension', 'revised.md', 'manuscript.md'],
])(
  'replace-manuscript backstop: folder moved on disk during the arms (%s)',
  (_label, upload, original) => {
    it('answers 409, installs nothing and leaves state.json and the manuscript file as they were', async () => {
      moveFolderOnDiskDuringArms();
      const res = await request(app)
        .post(`/api/books/${bookId}/replace-manuscript`)
        .attach('file', UPLOAD, upload);

      /* the book still exists (at the new folder), so the answer is a retry, not
         a false "not found" */
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(MOVED);

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
  it('answers 409 and leaves state.json untouched (the cast is already gone by then)', async () => {
    moveFolderOnDiskDuringArms();
    const res = await request(app).post(`/api/books/${bookId}/reparse`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(MOVED);
    const state = JSON.parse(readFileSync(join(newDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.chapters.map((c: { title: string }) => c.title)).toEqual(['Chapter One']);
    expect(state.castConfirmed).toBe(true);
  });
});

/* A folder-moving rename that completes between the handler's first lookup and
   its marker: the first lookup returns the now-stale folder; the handler must
   re-resolve after marking and run against the NEW folder. */
describe('rename completing between the lookup and the marker (#3400 pass 10)', () => {
  it('reparse: runs against the new folder, nothing left at the old path', async () => {
    hooks.afterNextFind = () => renameSync(oldDir, newDir);
    const res = await request(app).post(`/api/books/${bookId}/reparse`).send({});
    expect(res.status).toBe(200);
    expect(existsSync(oldDir)).toBe(false);
    const state = JSON.parse(readFileSync(join(newDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.chapters.map((c: { title: string }) => c.title)).toEqual(['Chapter 1']);
    expect(state.castConfirmed).toBe(false);
    expect(existsSync(join(newDir, '.audiobook', 'cast.json'))).toBe(false);
  });

  it('replace-manuscript: installs into the new folder, nothing left at the old path', async () => {
    hooks.afterNextFind = () => renameSync(oldDir, newDir);
    const res = await request(app)
      .post(`/api/books/${bookId}/replace-manuscript`)
      .attach('file', UPLOAD, 'revised.md');
    expect(res.status).toBe(200);
    expect(existsSync(oldDir)).toBe(false);
    const state = JSON.parse(readFileSync(join(newDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.chapters.map((c: { title: string }) => c.title)).toEqual(['Fresh A', 'Fresh B']);
    expect(readFileSync(join(newDir, 'manuscript.md'), 'utf8')).toContain('Fresh A');
  });
});

/* Third interleave (#3400 pass 11): the folder moves after our re-resolve and
   before applyReparse's presence gate. Nothing destructive has run; the answer
   must be a retry while the book exists, and 404 only when it is gone. */
describe('book moved or deleted before the presence gate (#3400 pass 11)', () => {
  it.each(['reparse', 'replace-manuscript'] as const)(
    '%s: a move after the re-resolve answers 409, not a false 404, and the book is intact',
    async (route) => {
      hooks.afterParse = () => renameSync(oldDir, newDir);
      const req = request(app).post(`/api/books/${bookId}/${route}`);
      const res =
        route === 'reparse' ? await req.send({}) : await req.attach('file', UPLOAD, 'revised.md');
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(MOVED);
      const state = JSON.parse(readFileSync(join(newDir, '.audiobook', 'state.json'), 'utf8'));
      expect(state.chapters.map((c: { title: string }) => c.title)).toEqual(['Chapter One']);
      expect(state.castConfirmed).toBe(true);
      expect(existsSync(join(newDir, '.audiobook', 'cast.json'))).toBe(true);
      expect(existsSync(oldDir)).toBe(false);
    },
  );

  it.each(['reparse', 'replace-manuscript'] as const)(
    '%s: a book deleted before the gate answers 404',
    async (route) => {
      hooks.afterParse = () => rmSync(oldDir, { recursive: true, force: true });
      const req = request(app).post(`/api/books/${bookId}/${route}`);
      const res =
        route === 'reparse' ? await req.send({}) : await req.attach('file', UPLOAD, 'revised.md');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Book not found.');
    },
  );
});

describe('retry loop of the marker (#3400 pass 11)', () => {
  it('drops the stale mark on the vacated folder', async () => {
    const { isReparseBusy } = await import('../tts/design-lock.js');
    hooks.afterNextFind = () => renameSync(oldDir, newDir);
    const res = await request(app).post(`/api/books/${bookId}/reparse`).send({});
    expect(res.status).toBe(200);
    expect(isReparseBusy(oldDir)).toBe(false);
    expect(isReparseBusy(newDir)).toBe(false);
  });

  it('answers 409 when the folder keeps moving across every attempt, holding no marker', async () => {
    const { isReparseBusy } = await import('../tts/design-lock.js');
    const at = (t: string) => join(ws, 'books', AUTHOR, SERIES, t);
    const dirs = [oldDir, at('Hop B'), at('Hop C'), at('Hop D')];
    hooks.onFind = (n) => {
      if (n <= 3) renameSync(dirs[n - 1], dirs[n]);
    };
    const res = await request(app).post(`/api/books/${bookId}/reparse`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(UNSTABLE);
    for (const d of dirs) expect(isReparseBusy(d)).toBe(false);
    // nothing destructive ran: the book is intact at its last stop
    expect(existsSync(join(dirs[3], '.audiobook', 'cast.json'))).toBe(true);
  });

  it('answers 404, not 409, when the book is deleted during the last attempt', async () => {
    const hopB = join(ws, 'books', AUTHOR, SERIES, 'Hop B');
    const hopC = join(ws, 'books', AUTHOR, SERIES, 'Hop C');
    hooks.onFind = (n) => {
      if (n === 1) renameSync(oldDir, hopB);
      else if (n === 2) renameSync(hopB, hopC);
      else if (n === 3) rmSync(hopC, { recursive: true, force: true });
    };
    const res = await request(app).post(`/api/books/${bookId}/reparse`).send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Book not found.');
  });
});

describe('rename post-mkdir re-check (#3400 pass 11)', () => {
  it('refuses a rename whose reparse marker landed between its first check and its mkdir', async () => {
    const { markReparseBusy, clearReparseBusy } = await import('../tts/design-lock.js');
    hooks.afterMkdir = () => markReparseBusy(oldDir);
    const r = await request(app)
      .put(`/api/books/${bookId}/state`)
      .send({ slice: 'state', patch: { title: NEW_TITLE } });
    clearReparseBusy(oldDir);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(REFUSAL);
    expect(existsSync(newDir)).toBe(false);
    expect(existsSync(oldDir)).toBe(true);
  });
});
