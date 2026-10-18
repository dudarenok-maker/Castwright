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

const hooks = vi.hoisted(() => ({ hold: undefined as undefined | (() => Promise<void>) }));

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
    it('answers 404, installs nothing and leaves state.json and the manuscript file as they were', async () => {
      moveFolderOnDiskDuringArms();
      const res = await request(app)
        .post(`/api/books/${bookId}/replace-manuscript`)
        .attach('file', UPLOAD, upload);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Book not found.');

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
  it('answers 404 and leaves state.json untouched (the cast is already gone by then)', async () => {
    moveFolderOnDiskDuringArms();
    const res = await request(app).post(`/api/books/${bookId}/reparse`).send({});
    expect(res.status).toBe(404);
    const state = JSON.parse(readFileSync(join(newDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.chapters.map((c: { title: string }) => c.title)).toEqual(['Chapter One']);
    expect(state.castConfirmed).toBe(true);
  });
});
