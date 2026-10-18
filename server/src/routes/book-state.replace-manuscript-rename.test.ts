/* #3400 review pass 9 -- a folder-renaming PUT /state that lands while
   replace-manuscript / reparse is inside its destructive arms. The arms and the
   upload paths were resolved from the pre-lock bookDir; the locked step
   re-locates by id and would record `manuscriptFile` against the NEW folder, so
   the record and the file ended up in different folders. The locked step now
   refuses (404) when the book is no longer where the request started: nothing
   is installed, state.json is untouched, and the book still reparses. The
   interleave is forced by holding resetRevisions (one of the arms) open. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
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

async function renameDuringArms(): Promise<() => number> {
  let renameStatus = -1;
  hooks.hold = async () => {
    const r = await request(app)
      .put(`/api/books/${bookId}/state`)
      .send({ slice: 'state', patch: { title: NEW_TITLE } });
    renameStatus = r.status;
  };
  return () => renameStatus;
}

describe.each([
  ['a format change', 'revised.txt', 'manuscript.md'],
  ['the same extension', 'revised.md', 'manuscript.md'],
])('replace-manuscript with a folder rename landing during the arms (%s)', (_label, upload, original) => {
  it('refuses with 404, installs nothing, leaves the moved book intact and reparsable', async () => {
    const renameStatus = await renameDuringArms();
    const res = await request(app)
      .post(`/api/books/${bookId}/replace-manuscript`)
      .attach('file', Buffer.from('## Fresh A\n\nAlpha.\n\n## Fresh B\n\nBeta.\n'), upload);

    expect(renameStatus()).toBe(204);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Book not found.');

    const state = JSON.parse(readFileSync(join(newDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.title).toBe(NEW_TITLE);
    expect(state.manuscriptFile).toBe(original);
    expect(state.chapters.map((c: { title: string }) => c.title)).toEqual(['Chapter One']);
    expect(readFileSync(join(newDir, original), 'utf8')).toContain('Chapter One');
    // nothing installed or left behind in either folder
    expect(files(newDir).filter((f) => f.startsWith('.manuscript-') || f === 'manuscript.txt')).toEqual([]);
    expect(files(oldDir).filter((f) => !f.startsWith('.audiobook/'))).toEqual([]);

    const again = await request(app).post(`/api/books/${bookId}/reparse`).send({});
    expect(again.status).toBe(200);
  });
});

describe('reparse with a folder rename landing during the arms', () => {
  it('refuses with 404 and leaves the moved book intact', async () => {
    const renameStatus = await renameDuringArms();
    const res = await request(app).post(`/api/books/${bookId}/reparse`).send({});
    expect(renameStatus()).toBe(204);
    expect(res.status).toBe(404);
    const state = JSON.parse(readFileSync(join(newDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.chapters.map((c: { title: string }) => c.title)).toEqual(['Chapter One']);
    expect(state.castConfirmed).toBe(true);
  });
});
