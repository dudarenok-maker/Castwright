/* #3700 review pass 2 — a request resolves the book folder, then queues on the
   per-book `state-json:<old path>` lock. If the holder moves or deletes that
   folder before releasing, the waiter acquires a lock keyed by a path that no
   longer names the book. "Absent" must be its own outcome: write NOTHING and
   answer 404, never a stale-snapshot write (resurrects the book / leaves two
   folders with one bookId) and never a false 200 for a write that did not
   happen. The interleave is forced: the test holds the old key itself, fires
   the request, waits (on the lock's own waiter count) until it is queued, changes the filesystem, then releases. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { CHAPTER_TITLE_PARSER_VERSION } from '../parsers/version.js';

/* Cover select re-locates the candidate over the network; stub just that lookup. */
vi.mock('../cover/search.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cover/search.js')>()),
  findCandidateById: vi.fn(),
  firstAvailableCover: vi.fn(),
}));

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
let waitersFor: typeof import('../workspace/file-lock.js').__stateJsonWaitersForTest;
let bookOpWaiters: typeof import('../workspace/file-lock.js').__keyWaitersForTest;
let saveAnalysisCache: typeof import('../store/analysis-cache.js').saveAnalysisCache;
let loadAnalysisCache: typeof import('../store/analysis-cache.js').loadAnalysisCache;

const movedDir = () => join(workspaceRoot, 'books', AUTHOR, SERIES, MOVED_TITLE);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until a request is genuinely blocked on `state-json:<path>` (the
 *  lock's own waiter count), so the interleave never depends on a timing guess. */
async function waitUntilQueued(path: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (waitersFor(path) >= 1) return;
    await sleep(10);
  }
  throw new Error('request never queued on the state-json lock');
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-absent-state-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ bookStateRouter }, { makeBookId }, lock, cache, { coverRouter }, { backupRouter }, { chaptersRestructureRouter }] = await Promise.all([
    import('./book-state.js'),
    import('../workspace/paths.js'),
    import('../workspace/file-lock.js'),
    import('../store/analysis-cache.js'),
    import('./cover.js'),
    import('./backup.js'),
    import('./chapters-restructure.js'),
  ]);
  withStateJsonLock = lock.withStateJsonLock;
  waitersFor = lock.__stateJsonWaitersForTest;
  bookOpWaiters = lock.__keyWaitersForTest;
  saveAnalysisCache = cache.saveAnalysisCache;
  loadAnalysisCache = cache.loadAnalysisCache;
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  statePath = join(bookDir, '.audiobook', 'state.json');
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
  app.use('/api/books', coverRouter);
  app.use('/api/books', backupRouter);
  app.use('/api/books', chaptersRestructureRouter);
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

afterEach(() => {
  vi.unstubAllGlobals();
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
    await waitUntilQueued(statePath);
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

  /* #3711 (PR #3714, merge-surfaced G) -- the moved book still exists, so the
     reparse / replace-manuscript refusal is 409 `book_moved`, not 404. */
  it('reparse queued behind a folder move -> 409 book_moved, analysis cache intact, nothing written at the old path', async () => {
    await saveAnalysisCache('m_absent', { chapters: { 1: [] } });
    const res = await queueBehind(() => request(app).post(`/api/books/${bookId}/reparse`), moveBook);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('book_moved');
    expect(Object.keys((await loadAnalysisCache('m_absent')).chapters)).toEqual(['1']);
    expect(existsSync(bookDir)).toBe(false);
  });

  it('replace-manuscript (SAME extension) queued behind a folder move -> 409 book_moved, the moved book keeps its manuscript bytes', async () => {
    const res = await queueBehind(
      () =>
        request(app)
          .post(`/api/books/${bookId}/replace-manuscript`)
          .attach('file', Buffer.from('Chapter 1\n\nReplaced.\n\nChapter 2\n\nMore.\n'), 'new.txt'),
      moveBook,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('book_moved');
    expect(readFileSync(join(movedDir(), 'manuscript.txt'), 'utf8')).toBe('Chapter 1\n\nSome text here.\n');
    expect(existsSync(bookDir)).toBe(false);
  });

  it('replace-manuscript (DIFFERENT extension) queued behind a folder move -> 409 book_moved, no orphan manuscript.md in the moved folder', async () => {
    const res = await queueBehind(
      () =>
        request(app)
          .post(`/api/books/${bookId}/replace-manuscript`)
          .attach('file', Buffer.from('Chapter 1\n\nReplaced.\n'), 'new.md'),
      moveBook,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('book_moved');
    expect(readdirSync(movedDir()).sort()).toEqual(['.audiobook', 'manuscript.txt']);
    expect(existsSync(bookDir)).toBe(false);
  });

  it('replace-manuscript queued behind a folder move -> 409 book_moved, the moved book keeps its manuscript file', async () => {
    const res = await queueBehind(
      () =>
        request(app)
          .post(`/api/books/${bookId}/replace-manuscript`)
          .attach('file', Buffer.from('Chapter 1\n\nReplaced.\n'), 'new.md'),
      moveBook,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('book_moved');
    const moved = JSON.parse(readFileSync(join(movedDir(), '.audiobook', 'state.json'), 'utf8')) as {
      manuscriptFile: string;
    };
    expect(existsSync(join(movedDir(), moved.manuscriptFile))).toBe(true);
    expect(existsSync(bookDir)).toBe(false);
  });

  it('restore backup queued behind a folder move -> 404, one folder, nothing recreated at the old path', async () => {
    const { backupBook } = await import('../workspace/auto-backup.js');
    const file = await backupBook({ bookId, bookDir }, { keep: 5, now: new Date(2026, 0, 1, 9, 0, 0) });
    expect(file).toBeTruthy();
    const res = await queueBehind(
      () => request(app).post(`/api/books/${bookId}/backups/restore`).send({ backupFile: file }),
      moveBook,
    );
    expect(res.status).toBe(404);
    expect(existsSync(bookDir)).toBe(false);
    expect(readdirSync(join(workspaceRoot, 'books', AUTHOR, SERIES))).toEqual([MOVED_TITLE]);
  });

  it('restructure (reorder) queued behind a folder move -> 404, one folder, moved book untouched', async () => {
    const res = await queueBehind(
      () => request(app).post(`/api/books/${bookId}/chapters/reorder`).send({ order: [1] }),
      moveBook,
    );
    expect(res.status).toBe(404);
    expect(existsSync(bookDir)).toBe(false);
    expect(readdirSync(join(workspaceRoot, 'books', AUTHOR, SERIES))).toEqual([MOVED_TITLE]);
  });

  it('cover upload queued behind a folder move -> 404, no cover.jpg written into the moved folder', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } })
      .png()
      .toBuffer();
    const res = await queueBehind(
      () =>
        request(app)
          .post(`/api/books/${bookId}/cover/upload`)
          .attach('image', png, { filename: 'c.png', contentType: 'image/png' }),
      moveBook,
    );
    expect(res.status).toBe(404);
    expect(existsSync(join(movedDir(), '.audiobook', 'cover.jpg'))).toBe(false);
    expect(existsSync(bookDir)).toBe(false);
  });

  /* A real, decodable image body for the stubbed cover-source fetch. */
  async function stubCoverFetch(): Promise<void> {
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } })
      .jpeg()
      .toBuffer();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(jpeg), { status: 200, headers: { 'Content-Type': 'image/jpeg' } })),
    );
  }

  it('cover select queued behind a folder move -> 404, no cover.jpg written into either folder', async () => {
    const search = await import('../cover/search.js');
    vi.mocked(search.findCandidateById).mockResolvedValue({
      id: 'openlibrary:1',
      source: 'openlibrary',
      coverUrl: 'https://x/c.jpg',
    } as Awaited<ReturnType<typeof search.findCandidateById>>);
    await stubCoverFetch();
    const res = await queueBehind(
      () => request(app).post(`/api/books/${bookId}/cover`).send({ candidateId: 'openlibrary:1' }),
      moveBook,
    );
    expect(res.status).toBe(404);
    expect(existsSync(join(movedDir(), '.audiobook', 'cover.jpg'))).toBe(false);
    expect(existsSync(bookDir)).toBe(false);
  });

  it('backgroundFetchCover for a book moved while the fetch was in flight writes nothing and leaves state.json untouched', async () => {
    const search = await import('../cover/search.js');
    vi.mocked(search.firstAvailableCover).mockResolvedValue({
      id: 'apple:1',
      source: 'apple',
      coverUrl: 'https://x/c.jpg',
    } as Awaited<ReturnType<typeof search.firstAvailableCover>>);
    await stubCoverFetch();
    const { backgroundFetchCover } = await import('../cover/store.js');
    const before = readFileSync(statePath, 'utf8');
    let done!: Promise<void>;
    await withStateJsonLock(statePath, async () => {
      done = backgroundFetchCover(bookDir, TITLE, AUTHOR, bookId);
      await waitUntilQueued(statePath);
      moveBook();
    });
    await done;
    expect(existsSync(bookDir)).toBe(false);
    expect(existsSync(join(movedDir(), '.audiobook', 'cover.jpg'))).toBe(false);
    expect(readFileSync(join(movedDir(), '.audiobook', 'state.json'), 'utf8')).toBe(before);
  });

  it('cover DELETE queued behind a folder move -> 404, the moved book keeps its cover file', async () => {
    writeFileSync(join(bookDir, '.audiobook', 'cover.jpg'), 'jpegbytes');
    const res = await queueBehind(() => request(app).delete(`/api/books/${bookId}/cover`), moveBook);
    expect(res.status).toBe(404);
    expect(readFileSync(join(movedDir(), '.audiobook', 'cover.jpg'), 'utf8')).toBe('jpegbytes');
  });

  it('cover framing queued behind a folder move -> 404 (already refused; pins the shape)', async () => {
    const res = await queueBehind(
      () => request(app).patch(`/api/books/${bookId}/cover/framing`).send({ offsetX: 0, offsetY: 0, zoom: 1 }),
      moveBook,
    );
    expect(res.status).toBe(404);
  });

  it('DELETE takes the state-json lock: it does not remove the folder while another writer holds the key', async () => {
    let res!: Promise<request.Response>;
    await withStateJsonLock(statePath, async () => {
      res = Promise.resolve(request(app).delete(`/api/books/${bookId}`));
      await waitUntilQueued(statePath);
      expect(existsSync(bookDir)).toBe(true); // queued, not yet removed
    });
    expect((await res).status).toBe(204);
    expect(existsSync(bookDir)).toBe(false);
  });

  it('DELETE queued behind a folder move deletes the MOVED book (not a 204 for a no-op)', async () => {
    const res = await queueBehind(() => request(app).delete(`/api/books/${bookId}`), moveBook);
    expect(res.status).toBe(204);
    expect(existsSync(movedDir())).toBe(false);
    expect(existsSync(bookDir)).toBe(false);
  });

  it('DELETE queued behind a folder removal -> 204 and nothing is recreated (#3711)', async () => {
    const res = await queueBehind(() => request(app).delete(`/api/books/${bookId}`), deleteBook);
    expect(res.status).toBe(204);
    expect(existsSync(bookDir)).toBe(false);
    expect(existsSync(movedDir())).toBe(false);
  });

  it('DELETE queued behind an in-process rename PUT deletes the MOVED book (book-op ordering)', async () => {
    /* #3711 — the move is a real in-process rename PUT: it holds book-op, so the
       DELETE queues behind it on book-op (not on the old state-json key) and
       resolves the book AFTER the move. The out-of-process variant above is
       `removeBookFolder`'s own re-resolve under its lock. */
    let renameRes!: Promise<request.Response>;
    let deleteRes!: Promise<request.Response>;
    await withStateJsonLock(statePath, async () => {
      renameRes = Promise.resolve(
        request(app).put(`/api/books/${bookId}/state`).send({ slice: 'state', patch: { title: MOVED_TITLE } }),
      );
      await waitUntilQueued(statePath);
      deleteRes = Promise.resolve(request(app).delete(`/api/books/${bookId}`));
      while (bookOpWaiters(`book-op:${bookId}`) < 1) await new Promise((r) => setTimeout(r, 5));
    });
    expect((await renameRes).status).toBe(200);
    expect((await deleteRes).status).toBe(204);
    expect(existsSync(movedDir())).toBe(false);
    expect(existsSync(bookDir)).toBe(false);
  });
});
