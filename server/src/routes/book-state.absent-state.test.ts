/* #3700 review pass 2 — a request resolves the book folder, then queues on the
   per-book `state-json:<old path>` lock. If the holder moves or deletes that
   folder before releasing, the waiter acquires a lock keyed by a path that no
   longer names the book. "Absent" must be its own outcome: write NOTHING and
   answer 404, never a stale-snapshot write (resurrects the book / leaves two
   folders with one bookId) and never a false 200 for a write that did not
   happen. The interleave is forced: the test holds the old key itself, fires
   the request, gives it time to queue, changes the filesystem, then releases. */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { CHAPTER_TITLE_PARSER_VERSION } from '../parsers/version.js';

const AUTHOR = 'Absent Test';
const SERIES = 'Standalones';
const TITLE = 'Absent State Book';
const MOVED_TITLE = 'Moved Away Book';

let workspaceRoot: string;
let app: Express;
let bookId: string;
let bookDir: string;
let statePath: string;
let withStateJsonLock: typeof import('../workspace/file-lock.js').withStateJsonLock;
let saveAnalysisCache: typeof import('../store/analysis-cache.js').saveAnalysisCache;
let loadAnalysisCache: typeof import('../store/analysis-cache.js').loadAnalysisCache;

const movedDir = () => join(workspaceRoot, 'books', AUTHOR, SERIES, MOVED_TITLE);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-absent-state-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ bookStateRouter }, { makeBookId }, lock, cache] = await Promise.all([
    import('./book-state.js'),
    import('../workspace/paths.js'),
    import('../workspace/file-lock.js'),
    import('../store/analysis-cache.js'),
  ]);
  withStateJsonLock = lock.withStateJsonLock;
  saveAnalysisCache = cache.saveAnalysisCache;
  loadAnalysisCache = cache.loadAnalysisCache;
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  statePath = join(bookDir, '.audiobook', 'state.json');
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

beforeEach(() => {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'Chapter 1\n\nSome text here.\n');
  writeFileSync(
    statePath,
    JSON.stringify({
      bookId,
      manuscriptId: 'm_absent',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapterTitleParserVersion: CHAPTER_TITLE_PARSER_VERSION,
      chapters: [{ id: 1, title: 'One', slug: '01-one', duration: '0:00', uuid: 'u-1' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

/** Hold `state-json:<old path>`, fire `fire()`, let it queue, run `change()`
 *  while still holding, release, and return the request's response. */
async function queueBehind(
  fire: () => Promise<request.Response>,
  change: () => void,
): Promise<request.Response> {
  let res!: Promise<request.Response>;
  await withStateJsonLock(statePath, async () => {
    res = Promise.resolve(fire());
    await sleep(300);
    change();
  });
  return res;
}

const moveBook = () => {
  mkdirSync(join(workspaceRoot, 'books', AUTHOR, SERIES), { recursive: true });
  renameSync(bookDir, movedDir());
};
const deleteBook = () => rmSync(bookDir, { recursive: true, force: true });

describe('absent state.json after queueing on the old-path lock (#3700)', () => {
  it('P1: exclude toggle -> 404, chapter not excluded, no in-memory change', async () => {
    const { getManuscript, putManuscript } = await import('../store/manuscripts.js');
    putManuscript({
      manuscriptId: 'm_absent',
      format: 'txt',
      title: TITLE,
      wordCount: 1,
      byteSize: 1,
      uploadedAt: new Date().toISOString(),
      sourceText: 'x',
      chapterHints: [{ id: 1, title: 'One', body: 'x' }],
      bookId,
      bookDir,
    } as never);
    const res = await queueBehind(
      () => request(app).post(`/api/books/${bookId}/chapters/1/exclude`).send({ excluded: true }),
      moveBook,
    );
    expect(res.status).toBe(404);
    const moved = JSON.parse(readFileSync(join(movedDir(), '.audiobook', 'state.json'), 'utf8')) as {
      chapters: Array<{ excluded?: boolean }>;
    };
    expect(moved.chapters[0].excluded).toBeUndefined();
    expect(getManuscript('m_absent')?.chapterHints[0].excluded).toBeUndefined();
  });

  it('P1b: held toggle -> 404', async () => {
    const res = await queueBehind(
      () => request(app).post(`/api/books/${bookId}/chapters/1/held`).send({ held: true }),
      moveBook,
    );
    expect(res.status).toBe(404);
  });

  it('P2: state-slice PUT queued behind a DELETE -> 404, no state.json recreated', async () => {
    const res = await queueBehind(
      () =>
        request(app)
          .put(`/api/books/${bookId}/state`)
          .send({ slice: 'state', patch: { castConfirmed: false } }),
      deleteBook,
    );
    expect(res.status).toBe(404);
    expect(existsSync(statePath)).toBe(false);
    expect(existsSync(bookDir)).toBe(false);
  });

  it('P3: autosave PUT queued behind a folder move -> 404, only one folder with that bookId', async () => {
    const res = await queueBehind(
      () =>
        request(app)
          .put(`/api/books/${bookId}/state`)
          .send({ slice: 'state', patch: { prosodyAnnotated: true } }),
      moveBook,
    );
    expect(res.status).toBe(404);
    expect(existsSync(bookDir)).toBe(false);
    const folders = readdirSync(join(workspaceRoot, 'books', AUTHOR, SERIES));
    expect(folders).toEqual([MOVED_TITLE]);
    const moved = JSON.parse(readFileSync(join(movedDir(), '.audiobook', 'state.json'), 'utf8')) as {
      prosodyAnnotated?: boolean;
    };
    expect(moved.prosodyAnnotated).toBeUndefined();
  });

  it('reparse queued behind a folder move -> 404, analysis cache intact, nothing written at the old path', async () => {
    await saveAnalysisCache('m_absent', { chapters: { 1: [] } });
    const res = await queueBehind(() => request(app).post(`/api/books/${bookId}/reparse`), moveBook);
    expect(res.status).toBe(404);
    expect(Object.keys((await loadAnalysisCache('m_absent')).chapters)).toEqual(['1']);
    expect(existsSync(bookDir)).toBe(false);
  });

  it('replace-manuscript queued behind a folder move -> 404, the moved book keeps its manuscript file', async () => {
    const res = await queueBehind(
      () =>
        request(app)
          .post(`/api/books/${bookId}/replace-manuscript`)
          .attach('file', Buffer.from('Chapter 1\n\nReplaced.\n'), 'new.md'),
      moveBook,
    );
    expect(res.status).toBe(404);
    const moved = JSON.parse(readFileSync(join(movedDir(), '.audiobook', 'state.json'), 'utf8')) as {
      manuscriptFile: string;
    };
    expect(existsSync(join(movedDir(), moved.manuscriptFile))).toBe(true);
    expect(existsSync(bookDir)).toBe(false);
  });
});
