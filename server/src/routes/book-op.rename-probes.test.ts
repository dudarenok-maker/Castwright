/* #3711 — a folder-renaming PUT /:bookId/state used to run the moment another
   per-book operation released the state-json lock, while that operation was still
   writing to the folder it had resolved earlier. `writeJsonAtomic` creates its
   parent directory, so every such write RECREATED the old folder: the series held
   two folders for one book, the moved book kept a stale cast.json, and the
   in-memory ManuscriptRecord pointed back at the old folder.

   P1 (reparse vs rename) and P2 (cast autosave vs rename) are the two probes from
   the issue, run through the real router. They gate with what exists on `main`:
   the test holds `withCastLock(bookDir, ...)`, exactly as the issue's probe did,
   so the in-flight operation is genuinely blocked while the rename is sent.

   The wait is timing-free on the branch: it polls `__keyWaitersForTest` for the
   rename to be queued on `book-op:<bookId>`. `__keyWaitersForTest` is read through
   a namespace import so this file also RUNS on `main` (where the property is
   undefined): there the rename is simply awaited, because nothing blocks it --
   which is exactly the defect the assertions then catch. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

/* Hoisted spies, so the modules under test bind the wrappers at load time. Each
   delegates to the real implementation unless a case installs a spy. */
const spies = vi.hoisted(() => ({
  mkdir: null as null | ((path: string, opts?: unknown) => Promise<unknown>),
  rm: null as null | ((path: string, opts?: unknown) => Promise<unknown>),
  rename: null as null | ((from: string, to: string) => Promise<unknown>),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    mkdir: (path: string, opts?: unknown) =>
      (spies.mkdir ?? (actual.mkdir as unknown as NonNullable<typeof spies.mkdir>))(path, opts),
    rm: (path: string, opts?: unknown) =>
      (spies.rm ?? (actual.rm as unknown as NonNullable<typeof spies.rm>))(path, opts),
  };
});

vi.mock('../workspace/atomic-rename.js', async () => {
  const actual = await vi.importActual<typeof import('../workspace/atomic-rename.js')>(
    '../workspace/atomic-rename.js',
  );
  return {
    ...actual,
    renameWithRetry: (from: string, to: string) =>
      (spies.rename ?? (actual.renameWithRetry as unknown as NonNullable<typeof spies.rename>))(from, to),
  };
});

const { mkdtemp } = await import('node:fs/promises');

const AUTHOR = 'Probe Author';
const MANUSCRIPT_BODY = `# Chapter One\n\nFirst sentence.\nSecond sentence.\n\n# Chapter Two\n\nMore text here.\n`;

let workspaceRoot: string;
let app: Express;
let paths: typeof import('../workspace/paths.js');
let castLock: typeof import('../workspace/cast-lock.js');
let fileLock: typeof import('../workspace/file-lock.js');
let manuscripts: typeof import('../store/manuscripts.js');

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-book-op-probes-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { bookStateRouter } = await import('./book-state.js');
  paths = await import('../workspace/paths.js');
  castLock = await import('../workspace/cast-lock.js');
  fileLock = await import('../workspace/file-lock.js');
  manuscripts = await import('../store/manuscripts.js');
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

afterEach(() => {
  spies.mkdir = null;
  spies.rm = null;
  spies.rename = null;
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
});

interface Seeded {
  bookId: string;
  bookDir: string;
  title: string;
  manuscriptId: string;
}

function seedBook(title: string, opts: { series?: string; standalone?: boolean } = {}): Seeded {
  const standalone = opts.standalone ?? true;
  const series = standalone ? paths.STANDALONES_SERIES : (opts.series ?? 'Probe Series');
  const bookId = paths.makeBookId(AUTHOR, series, title);
  const bookDir = paths.bookDirByDisplay(AUTHOR, series, title);
  const manuscriptId = `m_probe_${title.replace(/\W+/g, '_')}`;
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
      isStandalone: standalone,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(
    paths.castJsonPath(bookDir),
    JSON.stringify({ characters: [{ id: 'seed', name: 'Seed', role: 'minor', color: '#abc', voiceState: 'generated' }] }),
  );
  return { bookId, bookDir, title, manuscriptId };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Hold `withCastLock(bookDir)` until `release()` -- the gate the issue's probe used. */
function holdCastLock(bookDir: string): { held: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let acquired!: () => void;
  const held = new Promise<void>((r) => (acquired = r));
  void castLock.withCastLock(bookDir, async () => {
    acquired();
    await gate;
  });
  return { held, release };
}

/* `__keyWaitersForTest` is absent on `main`; read it defensively. */
function keyWaiters(): ((key: string) => number) | undefined {
  return (fileLock as unknown as Record<string, unknown>).__keyWaitersForTest as
    | ((key: string) => number)
    | undefined;
}

async function waitUntil(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** Wait until `n` callers are queued on `key`. On `main` there is no hook, so
 *  settle for a short pause -- the caller is gated on a real lock either way. */
async function waitQueued(key: string, n: number): Promise<void> {
  const waiters = keyWaiters();
  if (!waiters) {
    await sleep(150);
    return;
  }
  await waitUntil(() => waiters(key) >= n, `${n} waiter(s) on ${key}`);
}

function put(bookId: string, payload: object) {
  return request(app).put(`/api/books/${bookId}/state`).set('Content-Type', 'application/json').send(payload);
}

/** Start a request without awaiting it (supertest is lazy until `.then`). */
function fire<T extends { then: PromiseLike<unknown>['then'] }>(req: T): Promise<request.Response> {
  return Promise.resolve(req as unknown as PromiseLike<request.Response>);
}

describe('#3711 -- a folder rename queued behind another per-book operation', () => {
  it('P1: reparse vs rename -- one folder, change-log + record in the new one, no stale cast.json', async () => {
    const book = seedBook('Probe One');
    const newTitle = 'Probe One Renamed';
    const newDir = paths.bookDirByDisplay(AUTHOR, paths.STANDALONES_SERIES, newTitle);
    /* A manuscript edit makes reparse append a change-log entry (the write that
       used to recreate the old folder), and a live record lets us watch the heal. */
    writeFileSync(
      paths.manuscriptEditsJsonPath(book.bookDir),
      JSON.stringify({ sentences: [{ id: 's1', text: 'x', characterId: 'seed' }] }),
    );
    manuscripts.putManuscript({
      manuscriptId: book.manuscriptId,
      format: 'md',
      title: book.title,
      wordCount: 1,
      byteSize: 1,
      uploadedAt: new Date().toISOString(),
      sourceText: 'x',
      chapterHints: [],
      bookId: book.bookId,
      bookDir: book.bookDir,
    } as never);

    const gate = holdCastLock(book.bookDir);
    await gate.held;
    const reparseP = fire(request(app).post(`/api/books/${book.bookId}/reparse`));
    await waitQueued(paths.castJsonPath(book.bookDir), 1);
    const renameP = fire(put(book.bookId, { slice: 'state', patch: { title: newTitle } }));
    if (keyWaiters()) await waitQueued(`book-op:${book.bookId}`, 1);
    else await renameP;
    gate.release();
    const [reparseRes, renameRes] = await Promise.all([reparseP, renameP]);

    expect(reparseRes.status).toBe(200);
    expect(renameRes.status).toBe(200);
    expect(existsSync(book.bookDir)).toBe(false); // the old folder was NOT recreated
    expect(readdirSync(join(workspaceRoot, 'books', AUTHOR, paths.STANDALONES_SERIES))).toEqual([newTitle]);
    expect(existsSync(paths.changeLogJsonPath(newDir))).toBe(true); // change-log is in the new folder
    expect(existsSync(paths.castJsonPath(newDir))).toBe(false); // reparse's cast.json delete reached the new folder
    expect(manuscripts.getManuscript(book.manuscriptId)?.bookDir).toBe(newDir); // record healed
  });

  it('P2: cast autosave vs rename -- the new cast.json is in the new folder, no old folder', async () => {
    const book = seedBook('Probe Two');
    const newTitle = 'Probe Two Renamed';
    const newDir = paths.bookDirByDisplay(AUTHOR, paths.STANDALONES_SERIES, newTitle);

    const gate = holdCastLock(book.bookDir);
    await gate.held;
    const castP = fire(
      put(book.bookId, {
        slice: 'cast',
        patch: { characters: [{ id: 'autosaved', name: 'Autosaved', role: 'minor', color: '#abc', voiceState: 'generated' }] },
      }),
    );
    await waitQueued(paths.castJsonPath(book.bookDir), 1);
    const renameP = fire(put(book.bookId, { slice: 'state', patch: { title: newTitle } }));
    if (keyWaiters()) await waitQueued(`book-op:${book.bookId}`, 1);
    else await renameP;
    gate.release();
    const [castRes, renameRes] = await Promise.all([castP, renameP]);

    expect(castRes.status).toBe(200);
    expect(renameRes.status).toBe(200);
    expect(existsSync(book.bookDir)).toBe(false); // the old folder was NOT recreated
    const cast = JSON.parse(readFileSync(paths.castJsonPath(newDir), 'utf8')) as { characters: Array<{ id: string }> };
    expect(cast.characters.map((c) => c.id)).toEqual(['autosaved']); // the autosave landed in the new folder
  });

  it('P2-reverse: a cast autosave queued behind an in-flight rename lands in the NEW folder', async () => {
    const book = seedBook('Probe Reverse');
    const newTitle = 'Probe Reverse Renamed';
    const newDir = paths.bookDirByDisplay(AUTHOR, paths.STANDALONES_SERIES, newTitle);

    /* The rename holds book-op and parks on the state-json gate; the autosave
       queues on book-op behind it and must resolve the book AFTER the move. */
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const held = new Promise<void>((r) => (acquired = r));
    void fileLock.withStateJsonLock(paths.stateJsonPath(book.bookDir), async () => {
      acquired();
      await gate;
    });
    await held;
    const renameP = fire(put(book.bookId, { slice: 'state', patch: { title: newTitle } }));
    await waitQueued(`state-json:${paths.stateJsonPath(book.bookDir)}`, 1);
    const castP = fire(
      put(book.bookId, {
        slice: 'cast',
        patch: { characters: [{ id: 'later', name: 'Later', role: 'minor', color: '#abc', voiceState: 'generated' }] },
      }),
    );
    await waitQueued(`book-op:${book.bookId}`, 1);
    release();
    const [renameRes, castRes] = await Promise.all([renameP, castP]);

    expect(renameRes.status).toBe(200);
    expect(castRes.status).toBe(200);
    expect(existsSync(book.bookDir)).toBe(false);
    const cast = JSON.parse(readFileSync(paths.castJsonPath(newDir), 'utf8')) as { characters: Array<{ id: string }> };
    expect(cast.characters.map((c) => c.id)).toEqual(['later']);
  });

  it('a write queued behind a DELETE answers 404 and recreates nothing', async () => {
    const book = seedBook('Probe Delete');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const held = new Promise<void>((r) => (acquired = r));
    void fileLock.withStateJsonLock(paths.stateJsonPath(book.bookDir), async () => {
      acquired();
      await gate;
    });
    await held;
    const deleteP = fire(request(app).delete(`/api/books/${book.bookId}`));
    await waitQueued(`state-json:${paths.stateJsonPath(book.bookDir)}`, 1);
    const castP = fire(
      put(book.bookId, {
        slice: 'cast',
        patch: { characters: [{ id: 'ghost', name: 'Ghost', role: 'minor', color: '#abc', voiceState: 'generated' }] },
      }),
    );
    await waitQueued(`book-op:${book.bookId}`, 1);
    release();
    const [deleteRes, castRes] = await Promise.all([deleteP, castP]);

    expect(deleteRes.status).toBe(204);
    expect(castRes.status).toBe(404);
    expect(existsSync(book.bookDir)).toBe(false);
  });

  it('DELETE of a book that is already gone is an idempotent 204', async () => {
    const book = seedBook('Probe Gone');
    expect((await request(app).delete(`/api/books/${book.bookId}`)).status).toBe(204);
    expect((await request(app).delete(`/api/books/${book.bookId}`)).status).toBe(204);
    expect((await request(app).delete('/api/books/never__existed__book')).status).toBe(204);
  });

  it('EPERM on the rename is a curated 409 book_folder_in_use with no path in the body', async () => {
    const book = seedBook('Probe Eperm');
    spies.rename = async () => {
      throw Object.assign(new Error("EPERM: operation not permitted, rename 'C:\\secret\\workspace\\path'"), {
        code: 'EPERM',
      });
    };
    const res = await put(book.bookId, { slice: 'state', patch: { title: 'Probe Eperm Renamed' } });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('book_folder_in_use');
    expect(JSON.stringify(res.body)).not.toMatch(/secret|workspace|EPERM/);
    expect(existsSync(book.bookDir)).toBe(true); // nothing moved
  });

  it('a delete that fails after state.json is gone is a 409 book_partly_deleted, and the book is out of the library', async () => {
    const book = seedBook('Probe Partly');
    spies.rm = async (path, opts) => {
      if (path === book.bookDir) {
        unlinkSync(paths.stateJsonPath(book.bookDir)); // the book left the library...
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${path}'`), { code: 'EBUSY' });
      }
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return actual.rm(path, opts as never);
    };
    const res = await request(app).delete(`/api/books/${book.bookId}`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('book_partly_deleted');
    expect(res.body.error).toContain('Probe Partly');
    expect(res.body.error).not.toContain(workspaceRoot);
    spies.rm = null;
    expect((await put(book.bookId, { slice: 'cast', patch: { characters: [] } })).status).toBe(404);
  });

  it('a refused rename (path taken) is a 409 with a code', async () => {
    const a = seedBook('Probe Taken A');
    seedBook('Probe Taken B');
    const res = await put(a.bookId, { slice: 'state', patch: { title: 'Probe Taken B' } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('book_path_taken');
    expect(typeof res.body.error).toBe('string');
  });

  it('the rmdir race: one book renames OUT of a series while another renames INTO it -- both land', async () => {
    const out = seedBook('Race Out', { standalone: false, series: 'Racing Series' });
    const into = seedBook('Race Into'); // a standalone that moves into the series
    const intoDir = paths.bookDirByDisplay(AUTHOR, 'Racing Series', 'Race Into');
    const outDir = paths.bookDirByDisplay(AUTHOR, paths.STANDALONES_SERIES, 'Race Out');
    const seriesDir = join(workspaceRoot, 'books', AUTHOR, 'Racing Series');

    /* Park the INTO book's mkdir of the series directory on a gate the test
       releases, only once the OUT rename has either FINISHED (unserialised: it
       has `rmdir`ed the by-then empty series, which would make INTO's rename
       fail) or is QUEUED behind the path claim (serialised). No timer decides
       the interleave. */
    let mkdirHit!: () => void;
    const hit = new Promise<void>((r) => (mkdirHit = r));
    let releaseMkdir!: () => void;
    const mkdirGate = new Promise<void>((r) => (releaseMkdir = r));
    const actualFsp = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    spies.mkdir = async (path, opts) => {
      const made = await actualFsp.mkdir(path, opts as never);
      if (path === seriesDir) {
        mkdirHit();
        await mkdirGate;
      }
      return made;
    };

    const intoP = fire(
      put(into.bookId, { slice: 'state', patch: { isStandalone: false, series: 'Racing Series' } }),
    );
    await hit;
    let outSettled = false;
    const outP = fire(put(out.bookId, { slice: 'state', patch: { isStandalone: true } }));
    void outP.then(
      () => (outSettled = true),
      () => (outSettled = true),
    );
    await waitUntil(
      () => outSettled || (keyWaiters()?.('book-path-claim') ?? 0) >= 1,
      'the OUT rename to finish or queue behind the path claim',
    );
    releaseMkdir();
    const [intoRes, outRes] = await Promise.all([intoP, outP]);

    expect(intoRes.status).toBe(200);
    expect(outRes.status).toBe(200);
    expect(existsSync(join(intoDir, '.audiobook', 'state.json'))).toBe(true);
    expect(existsSync(join(outDir, '.audiobook', 'state.json'))).toBe(true);
    expect(existsSync(out.bookDir)).toBe(false);
  });
});
