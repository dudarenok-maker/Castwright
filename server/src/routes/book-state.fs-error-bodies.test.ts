/* #3711 PR #3714 -- a node fs error on a book's files (write EBUSY / ENOSPC /
   EPERM) carries the absolute path it failed on in its own message, and the
   whole-request handlers in book-state.ts and chapters-restructure.ts used to
   answer `(e as Error).message` verbatim -- the workspace layout, over LAN
   HTTPS. Each case below injects a real-shaped `ErrnoException` at one write
   (or, for the listen-progress GET, one state.json read) and asserts the 500
   body names no path and no raw fs vocabulary. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

/* Basenames whose WRITE throws. */
const faultedWrites = vi.hoisted(() => new Set<string>());
/* When set, the first read of listen-progress.json arms `stateReadsFail`, so the
   listen-progress GET's book lookup succeeds and its state.json read after it
   throws. */
const fault = vi.hoisted(() => ({ armOnProgressRead: false, stateReadsFail: false }));

const errnoAt = (path: string, syscall: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`EBUSY: resource busy or locked, ${syscall} '${path}'`), {
    code: 'EBUSY',
    errno: -4082,
    syscall,
    path,
  });

vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return {
    ...actual,
    writeJsonAtomic: async (path: string, value: unknown) => {
      if (faultedWrites.has(basename(path))) throw errnoAt(path, 'open');
      return actual.writeJsonAtomic(path, value);
    },
    readJson: async (path: string) => {
      if (fault.armOnProgressRead && basename(path) === 'listen-progress.json') fault.stateReadsFail = true;
      return actual.readJson(path);
    },
  };
});

vi.mock('../workspace/state-migrate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-migrate.js')>();
  return {
    ...actual,
    readStateJsonWithRecovery: async (path: string) => {
      if (fault.stateReadsFail) throw errnoAt(path, 'open');
      return actual.readStateJsonWithRecovery(path);
    },
  };
});

let workspaceRoot: string;
let app: Express;
let paths: typeof import('../workspace/paths.js');
let bookOp: typeof import('../workspace/book-op-lock.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-fs-error-bodies-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Sequential imports -- a Promise.all of dynamic imports races vi.mock factories (#2083). */
  const { bookStateRouter } = await import('./book-state.js');
  const { chaptersRestructureRouter } = await import('./chapters-restructure.js');
  paths = await import('../workspace/paths.js');
  bookOp = await import('../workspace/book-op-lock.js');
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
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

afterEach(async () => {
  faultedWrites.clear();
  fault.armOnProgressRead = false;
  fault.stateReadsFail = false;
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  bookOp.__bookDirIndexForTest().clear();
  const { removeManuscript } = await import('../store/manuscripts.js');
  removeManuscript('m_fs_bodies');
});

const MANUSCRIPT =
  '# Chapter One\n\nAlpha first.\nAlpha second.\n\n# Chapter Two\n\nBeta first.\nBeta second.\n\n# Chapter Three\n\nGamma first.\nGamma second.\n';

/** Seed a three-chapter book with attribution; returns its bookId. */
function seedBook(): string {
  const bookId = paths.makeBookId('Fs', 'Bodies', 'Book');
  const bookDir = join(paths.BOOKS_ROOT, 'Fs', 'Bodies', 'Book');
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT);
  writeFileSync(
    paths.stateJsonPath(bookDir),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_fs_bodies',
      title: 'Book',
      author: 'Fs',
      series: 'Bodies',
      seriesPosition: null,
      isStandalone: false,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapters: [
        { id: 1, title: 'Chapter One', slug: '01-chapter-one', uuid: 'u-1' },
        { id: 2, title: 'Chapter Two', slug: '02-chapter-two', uuid: 'u-2' },
        { id: 3, title: 'Chapter Three', slug: '03-chapter-three', uuid: 'u-3' },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      language: 'en',
    }),
  );
  writeFileSync(
    join(bookDir, '.audiobook', 'manuscript-edits.json'),
    JSON.stringify({
      sentences: [
        { id: 1, chapterId: 1, characterId: 'narr', text: 'Alpha first.' },
        { id: 2, chapterId: 1, characterId: 'narr', text: 'Alpha second.' },
        { id: 1, chapterId: 2, characterId: 'narr', text: 'Beta first.' },
        { id: 2, chapterId: 2, characterId: 'narr', text: 'Beta second.' },
        { id: 1, chapterId: 3, characterId: 'narr', text: 'Gamma first.' },
        { id: 2, chapterId: 3, characterId: 'narr', text: 'Gamma second.' },
      ],
    }),
  );
  writeFileSync(
    join(bookDir, '.audiobook', 'listen-progress.json'),
    JSON.stringify({ chapterId: 2, chapterUuid: 'u-2', currentSec: 1, updatedAt: '2026-01-01T00:00:00.000Z' }),
  );
  return bookId;
}

/** A client body carries no absolute path and no raw fs error. Checked on every
 *  string field directly AND on the JSON text in both spellings: on Windows
 *  `JSON.stringify` doubles each backslash (same helper as
 *  book-op.read-errors.test.ts). */
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

type Case = {
  name: string;
  fault: string;
  send: (bookId: string) => request.Test;
};

const cases: Case[] = [
  /* book-state.ts */
  {
    name: 'book-state: chapter exclude toggle',
    fault: 'state.json',
    send: (id) => request(app).post(`/api/books/${id}/chapters/2/exclude`).send({ excluded: true }),
  },
  {
    name: 'book-state: chapter held toggle',
    fault: 'state.json',
    send: (id) => request(app).post(`/api/books/${id}/chapters/2/held`).send({ held: true }),
  },
  {
    name: 'book-state: PUT listen-progress',
    fault: 'listen-progress.json',
    send: (id) => request(app).put(`/api/books/${id}/listen-progress`).send({ chapterId: 1, currentSec: 3 }),
  },
  {
    name: 'book-state: POST shelf-status',
    fault: 'listen-progress.json',
    send: (id) => request(app).post(`/api/books/${id}/shelf-status`).send({ finished: true }),
  },
  /* chapters-restructure.ts */
  {
    name: 'restructure: merge',
    fault: 'state.json',
    send: (id) => request(app).post(`/api/books/${id}/chapters/merge`).send({ chapterIds: [2, 3] }),
  },
  {
    name: 'restructure: split',
    fault: 'state.json',
    send: (id) =>
      request(app).post(`/api/books/${id}/chapters/split`).send({ chapterId: 1, afterSentenceId: 1 }),
  },
  {
    name: 'restructure: reorder',
    fault: 'state.json',
    send: (id) => request(app).post(`/api/books/${id}/chapters/reorder`).send({ order: [2, 1, 3] }),
  },
  {
    name: 'restructure: exclude',
    fault: 'state.json',
    send: (id) =>
      request(app).post(`/api/books/${id}/chapters/exclude`).send({ chapterIds: [3], excluded: true }),
  },
  {
    name: 'restructure: rename',
    fault: 'state.json',
    send: (id) => request(app).post(`/api/books/${id}/chapters/2/rename`).send({ title: 'Renamed' }),
  },
  {
    name: 'restructure: refresh-titles',
    fault: 'state.json',
    send: (id) =>
      request(app).post(`/api/books/${id}/chapters/refresh-titles`).send({ useFirstLine: true }),
  },
];

describe('fs errors never reach a client body with their path (#3711)', () => {
  it.each(cases)('$name: a write EBUSY answers a curated 500', async ({ fault: file, send }) => {
    const bookId = seedBook();
    faultedWrites.add(file);
    const res = await send(bookId);
    expect(res.status).toBe(500);
    expect(typeof res.body.error).toBe('string');
    expectNoPathLeak(res.body);
  });

  it('GET listen-progress: a state.json read EBUSY after the lookup answers a curated 500', async () => {
    const bookId = seedBook();
    fault.armOnProgressRead = true;
    const res = await request(app).get(`/api/books/${bookId}/listen-progress`);
    expect(fault.stateReadsFail).toBe(true);
    expect(res.status).toBe(500);
    expectNoPathLeak(res.body);
  });

  it('PUT listen-progress: a state.json read EBUSY answers a curated 500', async () => {
    const bookId = seedBook();
    /* The PUT reads listen-progress.json (the compare-and-set) before its
       state.json uuid read only when `listenedAt` is supplied. */
    fault.armOnProgressRead = true;
    const res = await request(app)
      .put(`/api/books/${bookId}/listen-progress`)
      .send({ chapterId: 1, currentSec: 3, listenedAt: new Date(Date.now() - 1000).toISOString() });
    expect(fault.stateReadsFail).toBe(true);
    expect(res.status).toBe(500);
    expectNoPathLeak(res.body);
  });
});
