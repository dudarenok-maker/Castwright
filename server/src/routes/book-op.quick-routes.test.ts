/* #3711 task 3 -- the quick `/:bookId` routes in book-state.ts, the chapters
   restructure cluster and the backup routes hold the book's `book-op` lock for
   their whole span, so a folder-renaming PUT queued behind one lands everything
   in the NEW folder and recreates no old path.

   Every "rename queued behind" case is event-based, never timer-based: the route
   is parked on a lock (or a deferred) it takes AFTER entering book-op, the
   rename is sent, and the test waits for `__keyWaitersForTest('book-op:<id>')`
   to show the rename queued before it releases the route. A route that does not
   hold book-op never lets the rename queue there, so the wait times out (red).

   The two-span cases (reparse / restructure) hold book-op themselves while the
   route's slow, unlocked prepare span runs, change the manuscript, then release. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

/* A deferred in front of `readJson`, for routes that take no inner lock. */
const spies = vi.hoisted(() => ({
  readJsonGate: null as null | ((path: string) => Promise<void>),
  clearAnalysisCache: vi.fn(),
}));

vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return {
    ...actual,
    readJson: async (path: string, ...rest: unknown[]) => {
      if (spies.readJsonGate) await spies.readJsonGate(path);
      return (actual.readJson as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest);
    },
  };
});

vi.mock('../store/analysis-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/analysis-cache.js')>();
  spies.clearAnalysisCache.mockImplementation(actual.clearAnalysisCache);
  return { ...actual, clearAnalysisCache: spies.clearAnalysisCache };
});

const { mkdtemp } = await import('node:fs/promises');

const AUTHOR = 'Quick Author';
// Parses to [Chapter 1 (app-made: prose before any heading), Prologue, Epilogue].
const MANUSCRIPT_BODY = 'Opening prose here.\n\nPrologue\n\nProse two.\n\nEpilogue\n\nProse three.\n';
const MANUSCRIPT_ID_PREFIX = 'm_quick_routes_';

let workspaceRoot: string;
let app: Express;
let paths: typeof import('../workspace/paths.js');
let fileLock: typeof import('../workspace/file-lock.js');
let bookOpLock: typeof import('../workspace/book-op-lock.js');
let manuscripts: typeof import('../store/manuscripts.js');
const manuscriptIds: string[] = [];

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-book-op-quick-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ bookStateRouter }, { chaptersRestructureRouter }, { backupRouter }] = await Promise.all([
    import('./book-state.js'),
    import('./chapters-restructure.js'),
    import('./backup.js'),
  ]);
  paths = await import('../workspace/paths.js');
  fileLock = await import('../workspace/file-lock.js');
  bookOpLock = await import('../workspace/book-op-lock.js');
  manuscripts = await import('../store/manuscripts.js');
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
  app.use('/api/books', chaptersRestructureRouter);
  app.use('/api/books', backupRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  for (const id of manuscriptIds) rmSync(join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'handoff', 'cache',`${id}.json`), { force: true });
  delete process.env.WORKSPACE_DIR;
});

afterEach(() => {
  spies.readJsonGate = null;
  spies.clearAnalysisCache.mockClear();
  for (const id of manuscriptIds) manuscripts.removeManuscript(id);
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
});

interface Seeded {
  bookId: string;
  bookDir: string;
  title: string;
  manuscriptId: string;
}

function seedBook(title: string): Seeded {
  const series = paths.STANDALONES_SERIES;
  const bookId = paths.makeBookId(AUTHOR, series, title);
  const bookDir = paths.bookDirByDisplay(AUTHOR, series, title);
  const manuscriptId = `${MANUSCRIPT_ID_PREFIX}${title.replace(/\W+/g, '_')}`;
  manuscriptIds.push(manuscriptId);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT_BODY);
  writeFileSync(
    paths.stateJsonPath(bookDir),
    JSON.stringify({
      bookId,
      manuscriptId,
      title,
      author: AUTHOR,
      series,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapters: [
        { id: 1, title: 'Chapter 1', slug: '01-x' },
        { id: 2, title: 'Prologue', slug: '02-x' },
        { id: 3, title: 'Epilogue', slug: '03-x' },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(
    paths.manuscriptEditsJsonPath(bookDir),
    JSON.stringify({
      sentences: [1, 2, 3].map((c) => ({ id: 1, chapterId: c, characterId: 'narr', text: `S${c}.` })),
    }),
  );
  writeFileSync(paths.castJsonPath(bookDir), JSON.stringify({ characters: [{ id: 'seed', name: 'Seed' }] }));
  return { bookId, bookDir, title, manuscriptId };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function waiters(key: string): number {
  return (fileLock as unknown as { __keyWaitersForTest: (k: string) => number }).__keyWaitersForTest(key);
}

function fire<T extends { then: PromiseLike<unknown>['then'] }>(req: T): Promise<request.Response> {
  return Promise.resolve(req as unknown as PromiseLike<request.Response>);
}

function putState(bookId: string, patch: object) {
  return request(app).put(`/api/books/${bookId}/state`).send({ slice: 'state', patch });
}

interface Gate {
  /** Resolves once the route under test is parked behind the gate. */
  parked: () => Promise<void>;
  release: () => void;
}

/** Hold a keyed lock until released; "parked" = one waiter queued on `waitKey`. */
function lockGate(waitKey: string, hold: (fn: () => Promise<void>) => Promise<unknown>): Gate {
  let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  let acquired!: () => void;
  const held = new Promise<void>((r) => (acquired = r));
  void hold(async () => {
    acquired();
    await open;
  });
  return {
    parked: async () => {
      await held;
      await waitUntil(() => waiters(waitKey) >= 1, `the route to queue on ${waitKey}`);
    },
    release,
  };
}

const stateJsonGate = (dir: string): Gate =>
  lockGate(`state-json:${paths.stateJsonPath(dir)}`, (fn) =>
    fileLock.withStateJsonLock(paths.stateJsonPath(dir), fn),
  );

/** Park the route at the first `readJson` of a path ending in `suffix`. */
function readJsonGate(suffix: string): Gate {
  let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  let hit!: () => void;
  const parked = new Promise<void>((r) => (hit = r));
  let armed = true;
  spies.readJsonGate = async (path) => {
    if (armed && path.endsWith(suffix)) {
      armed = false;
      hit();
      await open;
    }
  };
  return { parked: () => parked, release };
}

/** Start the route, wait until it is parked on `gate`, send a folder-renaming PUT,
 *  wait for it to QUEUE ON BOOK-OP, release, and return both responses. */
async function renameBehind(
  book: Seeded,
  gate: Gate,
  route: () => { then: PromiseLike<unknown>['then'] },
  newTitle: string,
) {
  const routeP = fire(route());
  await gate.parked();
  const renameP = fire(putState(book.bookId, { title: newTitle }));
  await waitUntil(() => waiters(`book-op:${book.bookId}`) >= 1, 'the rename to queue on book-op');
  gate.release();
  const [routeRes, renameRes] = await Promise.all([routeP, renameP]);
  return { routeRes, renameRes, newDir: paths.bookDirByDisplay(AUTHOR, paths.STANDALONES_SERIES, newTitle) };
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

describe('#3711 task 3 -- a rename queued behind a quick route lands everything in the new folder', () => {
  it('exclude', async () => {
    const book = seedBook('Quick Exclude');
    const { routeRes, renameRes, newDir } = await renameBehind(
      book,
      stateJsonGate(book.bookDir),
      () => request(app).post(`/api/books/${book.bookId}/chapters/1/exclude`).send({ excluded: true }),
      'Quick Exclude Renamed',
    );
    expect(routeRes.status).toBe(200);
    expect(renameRes.status).toBe(200);
    expect(existsSync(book.bookDir)).toBe(false);
    expect(readJsonFile<{ chapters: Array<{ excluded?: boolean }> }>(paths.stateJsonPath(newDir)).chapters[0].excluded).toBe(true);
  });

  it('held', async () => {
    const book = seedBook('Quick Held');
    const { routeRes, renameRes, newDir } = await renameBehind(
      book,
      stateJsonGate(book.bookDir),
      () => request(app).post(`/api/books/${book.bookId}/chapters/2/held`).send({ held: true }),
      'Quick Held Renamed',
    );
    expect(routeRes.status).toBe(200);
    expect(renameRes.status).toBe(200);
    expect(existsSync(book.bookDir)).toBe(false);
    expect(readJsonFile<{ chapters: Array<{ held?: boolean }> }>(paths.stateJsonPath(newDir)).chapters[1].held).toBe(true);
  });

  it('replace-manuscript', async () => {
    const book = seedBook('Quick Replace');
    const { routeRes, renameRes, newDir } = await renameBehind(
      book,
      stateJsonGate(book.bookDir),
      () =>
        request(app)
          .post(`/api/books/${book.bookId}/replace-manuscript`)
          .attach('file', Buffer.from('# Fresh One\n\nHello there.\n'), { filename: 'fresh.md', contentType: 'text/markdown' }),
      'Quick Replace Renamed',
    );
    expect(routeRes.status).toBe(200);
    expect(renameRes.status).toBe(200);
    expect(existsSync(book.bookDir)).toBe(false);
    expect(readFileSync(join(newDir, 'manuscript.md'), 'utf8')).toContain('Fresh One');
  });

  it('listen-progress PUT', async () => {
    const book = seedBook('Quick Progress');
    const { routeRes, renameRes, newDir } = await renameBehind(
      book,
      readJsonGate(join('.audiobook', 'listen-progress.json')),
      () => request(app).put(`/api/books/${book.bookId}/listen-progress`).send({ chapterId: 1, currentSec: 12 }),
      'Quick Progress Renamed',
    );
    expect(routeRes.status).toBe(200);
    expect(renameRes.status).toBe(200);
    expect(existsSync(book.bookDir)).toBe(false);
    expect(readJsonFile<{ currentSec: number }>(paths.listenProgressJsonPath(newDir)).currentSec).toBe(12);
  });

  it('shelf-status', async () => {
    const book = seedBook('Quick Shelf');
    const { routeRes, renameRes, newDir } = await renameBehind(
      book,
      readJsonGate(join('.audiobook', 'listen-progress.json')),
      () => request(app).post(`/api/books/${book.bookId}/shelf-status`).send({ finished: true }),
      'Quick Shelf Renamed',
    );
    expect(routeRes.status).toBe(200);
    expect(renameRes.status).toBe(200);
    expect(existsSync(book.bookDir)).toBe(false);
    expect(readJsonFile<{ finished?: boolean }>(paths.listenProgressJsonPath(newDir)).finished).toBe(true);
  });

  it('listen-stats', async () => {
    const book = seedBook('Quick Stats');
    const { routeRes, renameRes, newDir } = await renameBehind(
      book,
      lockGate(`listen-stats:${book.bookDir}`, (fn) => fileLock.withKeyLock(`listen-stats:${book.bookDir}`, fn)),
      () =>
        request(app)
          .put(`/api/books/${book.bookId}/listen-stats`)
          .send({ sessionId: 's1', days: [{ date: new Date().toISOString().slice(0, 10), seconds: 30 }] }),
      'Quick Stats Renamed',
    );
    expect(routeRes.status).toBe(200);
    expect(renameRes.status).toBe(200);
    expect(existsSync(book.bookDir)).toBe(false);
    expect(existsSync(paths.listenStatsJsonPath(newDir))).toBe(true);
  });

  it('chapters restructure (reorder)', async () => {
    const book = seedBook('Quick Reorder');
    const { routeRes, renameRes, newDir } = await renameBehind(
      book,
      stateJsonGate(book.bookDir),
      () => request(app).post(`/api/books/${book.bookId}/chapters/reorder`).send({ order: [2, 1, 3] }),
      'Quick Reorder Renamed',
    );
    expect(routeRes.status).toBe(200);
    expect(renameRes.status).toBe(200);
    expect(existsSync(book.bookDir)).toBe(false);
    const state = readJsonFile<{ chapters: Array<{ title: string }> }>(paths.stateJsonPath(newDir));
    expect(state.chapters.map((c) => c.title)).toEqual(['Prologue', 'Chapter 2', 'Epilogue']);
    expect(existsSync(paths.manuscriptEditsJsonPath(newDir))).toBe(true);
  });

  it('backup restore', async () => {
    const book = seedBook('Quick Restore');
    const snap = await request(app).post(`/api/books/${book.bookId}/backups/now`);
    expect(snap.status).toBe(200);
    const { routeRes, renameRes, newDir } = await renameBehind(
      book,
      stateJsonGate(book.bookDir),
      () => request(app).post(`/api/books/${book.bookId}/backups/restore`).send({ backupFile: snap.body.file }),
      'Quick Restore Renamed',
    );
    expect(routeRes.status).toBe(200);
    expect(renameRes.status).toBe(200);
    expect(existsSync(book.bookDir)).toBe(false);
    expect(readJsonFile<{ title: string }>(paths.stateJsonPath(newDir)).title).toBe('Quick Restore Renamed');
  });

  it('backup now', async () => {
    const book = seedBook('Quick Backup');
    /* A rename parked on the state-json gate holds book-op; the backup queues on
       book-op behind it and must snapshot the book at its NEW folder. */
    const gate = stateJsonGate(book.bookDir);
    const renameP = fire(putState(book.bookId, { title: 'Quick Backup Renamed' }));
    await gate.parked();
    const backupP = fire(request(app).post(`/api/books/${book.bookId}/backups/now`));
    await waitUntil(() => waiters(`book-op:${book.bookId}`) >= 1, 'the backup to queue on book-op');
    gate.release();
    const [renameRes, backupRes] = await Promise.all([renameP, backupP]);
    expect(renameRes.status).toBe(200);
    expect(backupRes.status).toBe(200);
    expect(existsSync(book.bookDir)).toBe(false);
  });
});

describe('#3711 task 3 -- two-span reparse and restructure', () => {
  /** Hold book-op while a route's unlocked prepare span runs, then let `change` run. */
  async function holdBookOpUntilQueued(bookId: string, route: () => { then: PromiseLike<unknown>['then'] }, change: () => void) {
    let release!: () => void;
    const open = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const held = new Promise<void>((r) => (acquired = r));
    void bookOpLock.withBookOp(bookId, async () => {
      acquired();
      await open;
    });
    await held;
    const routeP = fire(route());
    await waitUntil(() => waiters(`book-op:${bookId}`) >= 1, 'the route to reach its commit span');
    change();
    release();
    return routeP;
  }

  it('reparse: a manuscript that changed while it was being parsed is a 409 manuscript_changed and nothing is wiped', async () => {
    const book = seedBook('Quick Reparse');
    const res = await holdBookOpUntilQueued(
      book.bookId,
      () => request(app).post(`/api/books/${book.bookId}/reparse`),
      () => writeFileSync(join(book.bookDir, 'manuscript.md'), `${MANUSCRIPT_BODY}\nAn extra late paragraph.\n`),
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('manuscript_changed');
    expect(typeof res.body.error).toBe('string');
    expect(existsSync(paths.castJsonPath(book.bookDir))).toBe(true); // the destructive arms never ran
  });

  it('reparse: control -- an unchanged manuscript reparses (200)', async () => {
    const book = seedBook('Quick Reparse Control');
    const res = await holdBookOpUntilQueued(
      book.bookId,
      () => request(app).post(`/api/books/${book.bookId}/reparse`),
      () => undefined,
    );
    expect(res.status).toBe(200);
  });

  it('restructure: a fingerprint mismatch drops the advisory title flags silently and still succeeds', async () => {
    const book = seedBook('Quick Restructure Drift');
    const res = await holdBookOpUntilQueued(
      book.bookId,
      () => request(app).post(`/api/books/${book.bookId}/chapters/reorder`).send({ order: [2, 1, 3] }),
      () => writeFileSync(join(book.bookDir, 'manuscript.md'), `${MANUSCRIPT_BODY}\nAn extra late paragraph.\n`),
    );
    expect(res.status).toBe(200);
    // Flags dropped: old chapter 1 ("Chapter 1") is NOT recognised as app-made, so it is not renumbered.
    const state = readJsonFile<{ chapters: Array<{ title: string }> }>(paths.stateJsonPath(book.bookDir));
    expect(state.chapters.map((c) => c.title)).toEqual(['Prologue', 'Chapter 1', 'Epilogue']);
  });

  it('restructure: control -- an unchanged manuscript backfills the flags (renumbered)', async () => {
    const book = seedBook('Quick Restructure Control');
    const res = await holdBookOpUntilQueued(
      book.bookId,
      () => request(app).post(`/api/books/${book.bookId}/chapters/reorder`).send({ order: [2, 1, 3] }),
      () => undefined,
    );
    expect(res.status).toBe(200);
    const state = readJsonFile<{ chapters: Array<{ title: string }> }>(paths.stateJsonPath(book.bookDir));
    expect(state.chapters.map((c) => c.title)).toEqual(['Prologue', 'Chapter 2', 'Epilogue']);
  });
});

describe('#3711 task 3 -- DELETE only clears the analysis cache when it removed the book', () => {
  it("a book that vanished while the DELETE queued ('gone') clears nothing from a stale snapshot", async () => {
    const book = seedBook('Quick Delete Gone');
    const gate = stateJsonGate(book.bookDir);
    const deleteP = fire(request(app).delete(`/api/books/${book.bookId}`));
    await gate.parked(); // removeBookFolder is queued on the state-json lock
    rmSync(book.bookDir, { recursive: true, force: true }); // moved/deleted out of process
    gate.release();
    const res = await deleteP;
    expect(res.status).toBe(204);
    expect(spies.clearAnalysisCache).not.toHaveBeenCalledWith(book.manuscriptId);
  });

  it('control: a normal DELETE clears the analysis cache', async () => {
    const book = seedBook('Quick Delete Normal');
    const res = await request(app).delete(`/api/books/${book.bookId}`);
    expect(res.status).toBe(204);
    expect(spies.clearAnalysisCache).toHaveBeenCalledWith(book.manuscriptId);
  });
});

describe('#3711 review -- the move runs FIRST (inside a held book-op span); the route resolves the book UNDER the lock', () => {
  /** Hold book-op, start the route, wait for it to queue on book-op, MOVE the folder inside the
   *  held span, release. A route that resolved the book before taking the lock holds the old
   *  folder and writes (re-creating) it; one that resolves under the lock writes the new one. */
  async function moveWhileQueued(book: Seeded, route: () => { then: PromiseLike<unknown>['then'] }, newTitle: string) {
    let release!: () => void;
    const open = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const held = new Promise<void>((r) => (acquired = r));
    void bookOpLock.withBookOp(book.bookId, async () => {
      acquired();
      await open;
    });
    await held;
    const routeP = fire(route());
    await waitUntil(() => waiters(`book-op:${book.bookId}`) >= 1, 'the route to queue on book-op');
    const newDir = paths.bookDirByDisplay(AUTHOR, paths.STANDALONES_SERIES, newTitle);
    renameSync(book.bookDir, newDir);
    release();
    return { res: await routeP, newDir };
  }

  it('exclude writes the moved folder and does not re-create the old one', async () => {
    const book = seedBook('Moved Exclude');
    const { res, newDir } = await moveWhileQueued(
      book,
      () => request(app).post(`/api/books/${book.bookId}/chapters/1/exclude`).send({ excluded: true }),
      'Moved Exclude Renamed',
    );
    expect(res.status).toBe(200);
    expect(existsSync(book.bookDir)).toBe(false);
    expect(readJsonFile<{ chapters: Array<{ excluded?: boolean }> }>(paths.stateJsonPath(newDir)).chapters[0].excluded).toBe(true);
  });

  it('reparse commits to the moved folder and does not re-create the old one', async () => {
    const book = seedBook('Moved Reparse');
    const { res, newDir } = await moveWhileQueued(
      book,
      () => request(app).post(`/api/books/${book.bookId}/reparse`),
      'Moved Reparse Renamed',
    );
    expect(res.status).toBe(200);
    expect(existsSync(book.bookDir)).toBe(false);
    expect(existsSync(paths.stateJsonPath(newDir))).toBe(true);
    expect(existsSync(paths.castJsonPath(newDir))).toBe(false); // the reparse discarded the NEW folder's cast
  });

  it('listen-progress PUT lands the bookmark in the moved folder and does not re-create the old one', async () => {
    const book = seedBook('Moved Progress');
    const { res, newDir } = await moveWhileQueued(
      book,
      () => request(app).put(`/api/books/${book.bookId}/listen-progress`).send({ chapterId: 1, currentSec: 7 }),
      'Moved Progress Renamed',
    );
    expect(res.status).toBe(200);
    expect(existsSync(book.bookDir)).toBe(false);
    expect(readJsonFile<{ currentSec: number }>(paths.listenProgressJsonPath(newDir)).currentSec).toBe(7);
  });
});
