/* #3625 review 2 (🟠4) - DELETE /api/books/:bookId on an `unreadable` row. The
   row's bookId is derived from its folder path (no state parses), and the delete
   used to look books up by parseable state only, so it answered 204 and removed
   nothing while the card kept offering "Delete book". */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Torn Author';
const SERIES = 'Standalones';
const TORN = 'Torn Book';
const HEALTHY = 'Healthy Book';

let workspaceRoot: string;
let app: Express;
let tornDir: string;
let healthyDir: string;
let tornId: string;
let healthyId: string;

const listed = async () => {
  const { scanLibrary } = await import('../workspace/scan.js');
  const lib = await scanLibrary();
  return lib.authors.flatMap((a) => a.series.flatMap((s) => s.books));
};

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'delete-unreadable-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ bookStateRouter }, { makeBookId }] = await Promise.all([
    import('./book-state.js'),
    import('../workspace/paths.js'),
  ]);
  tornId = makeBookId(AUTHOR, SERIES, TORN);
  healthyId = makeBookId(AUTHOR, SERIES, HEALTHY);
  tornDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TORN);
  healthyDir = join(workspaceRoot, 'books', AUTHOR, SERIES, HEALTHY);
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(async () => {
  await rm(join(workspaceRoot, 'books'), { recursive: true, force: true });
  mkdirSync(join(tornDir, '.audiobook'), { recursive: true });
  writeFileSync(join(tornDir, 'manuscript.txt'), 'x');
  writeFileSync(join(tornDir, '.audiobook', 'state.json'), '{ torn');
  writeFileSync(join(tornDir, '.audiobook', 'state.json.bak.1'), '{ torn');
  mkdirSync(join(healthyDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(healthyDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: healthyId,
      manuscriptId: 'm_healthy',
      title: HEALTHY,
      author: AUTHOR,
      series: SERIES,
      updatedAt: '2026-05-23T00:00:00.000Z',
      schema: 1,
      chapters: [],
    }),
  );
});

describe('DELETE /api/books/:bookId on an unreadable book', () => {
  it('precondition: the torn book is listed as unreadable', async () => {
    const b = (await listed()).find((x) => x.bookId === tornId);
    expect(b?.status).toBe('unreadable');
  });

  it('removes the folder and the row, and leaves other books alone', async () => {
    const res = await request(app).delete(`/api/books/${tornId}`);
    expect(res.status).toBe(204);
    expect(existsSync(tornDir)).toBe(false);
    expect((await listed()).map((b) => b.bookId)).toEqual([healthyId]);
    expect(existsSync(healthyDir)).toBe(true);
  });

  it('removes a not_analysed book (manuscript, no state) too, instead of a false 204', async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    const fresh = 'Fresh Book';
    const freshDir = join(workspaceRoot, 'books', AUTHOR, SERIES, fresh);
    mkdirSync(freshDir, { recursive: true });
    writeFileSync(join(freshDir, 'manuscript.txt'), 'x');
    const freshId = makeBookId(AUTHOR, SERIES, fresh);
    expect((await listed()).find((x) => x.bookId === freshId)?.status).toBe('not_analysed');

    const res = await request(app).delete(`/api/books/${freshId}`);
    expect(res.status).toBe(204);
    expect(existsSync(freshDir)).toBe(false);
    expect((await listed()).some((b) => b.bookId === freshId)).toBe(false);
    expect(existsSync(tornDir)).toBe(true);
  });

  /* #3711 merge with #3625: a stateless book has no bookId-bearing state, so
     `withBookOp` cannot lock it; its removal is judged and run under the
     workspace path claim instead (every creator and mover holds it), so a
     creator mid-way through laying a book down at that path cannot have the
     folder removed under it. */
  it('removes a not_analysed book only once the book path claim is free', async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    const { withBookPathClaim } = await import('../workspace/book-op-lock.js');
    const fresh = 'Claimed Fresh Book';
    const freshDir = join(workspaceRoot, 'books', AUTHOR, SERIES, fresh);
    mkdirSync(freshDir, { recursive: true });
    writeFileSync(join(freshDir, 'manuscript.txt'), 'x');
    let release!: () => void;
    const held = withBookPathClaim(() => new Promise<void>((r) => (release = r)));
    const del = request(app).delete(`/api/books/${makeBookId(AUTHOR, SERIES, fresh)}`).then((r) => r);
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(freshDir)).toBe(true);
    release();
    await held;
    expect((await del).status).toBe(204);
    expect(existsSync(freshDir)).toBe(false);
  });

  /* #3625 delta review 3 (M13): the status filter is the only thing that stops
     this fallback deleting an analysed book by its folder-derived id. */
  it('leaves a parseable book alone when deleted by its folder-derived id (its state bookId differs)', async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    const title = 'Renamed Id Book';
    const dir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    writeFileSync(
      join(dir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'some-other-id',
        manuscriptId: 'm_other',
        title,
        author: AUTHOR,
        series: SERIES,
        updatedAt: '2026-05-23T00:00:00.000Z',
        schema: 1,
        chapters: [],
      }),
    );
    const res = await request(app).delete(`/api/books/${makeBookId(AUTHOR, SERIES, title)}`);
    expect(res.status).toBe(204);
    expect(existsSync(dir)).toBe(true);
  });

  /* Probe D1 (🟠3): `Vol..1` sanitises to `Vol_1`, so the scan judged the
     manuscript-only `Vol_1` and the route removed the analysed `Vol..1`. */
  it('judges and removes the same folder: an analysed `Vol..1` survives a delete of the id it shares with `Vol_1`', async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    const odd = join(workspaceRoot, 'books', 'Auth', SERIES, 'Vol..1');
    const plain = join(workspaceRoot, 'books', 'Auth', SERIES, 'Vol_1');
    mkdirSync(join(odd, '.audiobook'), { recursive: true });
    writeFileSync(
      join(odd, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'odd-book-id',
        manuscriptId: 'm_odd',
        title: 'Vol..1',
        author: 'Auth',
        series: SERIES,
        updatedAt: '2026-05-23T00:00:00.000Z',
        schema: 1,
        chapters: [],
      }),
    );
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, 'manuscript.txt'), 'x');
    const id = makeBookId('Auth', SERIES, 'Vol_1');
    expect(makeBookId('Auth', SERIES, 'Vol..1')).toBe(id);

    const res = await request(app).delete(`/api/books/${id}`);
    expect(res.status).toBe(204);
    expect(existsSync(odd)).toBe(true);
  });

  /* #3625 pass 6 (🟠3, probe P-DEL): a STRANDED book - main state.json absent,
     a good `.bak.1` (a rotating write died between its renames). The library
     lists it through the recovering read, so DELETE finds it, but the lock body
     required main to exist: it answered 204, removed nothing, and every retry
     did the same. */
  it('removes a stranded book (main state.json absent, a good .bak.1) and its row', async () => {
    const title = 'Stranded Book';
    const dir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    writeFileSync(join(dir, 'manuscript.txt'), 'x');
    writeFileSync(
      join(dir, '.audiobook', 'state.json.bak.1'),
      JSON.stringify({
        bookId: 'stranded-book-id',
        manuscriptId: 'm_stranded',
        title,
        author: AUTHOR,
        series: SERIES,
        updatedAt: '2026-05-23T00:00:00.000Z',
        schema: 1,
        chapters: [],
      }),
    );
    expect((await listed()).some((b) => b.bookId === 'stranded-book-id')).toBe(true);

    const res = await request(app).delete('/api/books/stranded-book-id');
    expect(res.status).toBe(204);
    expect(existsSync(dir)).toBe(false);
    expect((await listed()).some((b) => b.bookId === 'stranded-book-id')).toBe(false);
    expect(existsSync(healthyDir)).toBe(true);
  });

  /* The in-lock re-read compares the bookId: a different book now living in the
     resolved folder (it was renamed away and another moved in) is not removed. */
  it('does not remove the folder when the state read inside the lock names another book', async () => {
    const { findBookByBookId } = await import('../workspace/scan.js');
    const located = await findBookByBookId(healthyId);
    expect(located?.bookDir).toBe(healthyDir);
    const statePath = join(healthyDir, '.audiobook', 'state.json');
    const { withStateJsonLock } = await import('../workspace/file-lock.js');
    /* Hold the book's lock, start the DELETE (it resolves the folder, then
       queues on the lock), and swap another book's state in before releasing. */
    let release!: () => void;
    const held = withStateJsonLock(statePath, () => new Promise<void>((r) => (release = r)));
    const del = request(app).delete(`/api/books/${healthyId}`).then((r) => r);
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(
      statePath,
      JSON.stringify({
        bookId: 'another-book-id',
        manuscriptId: 'm_another',
        title: HEALTHY,
        author: AUTHOR,
        series: SERIES,
        updatedAt: '2026-05-23T00:00:00.000Z',
        schema: 1,
        chapters: [],
      }),
    );
    release();
    await held;
    const res = await del;
    expect(res.status).toBe(204);
    expect(existsSync(healthyDir)).toBe(true);
  });

  /* Pass 7 🟡2 (mutation M5b): a state that stops parsing while the DELETE waits
     on the lock is still the folder resolved a moment ago, and is removed. The
     state's bookId differs from the folder-derived id, so the stateless fallback
     cannot remove it instead: only the in-lock branch can. */
  it('removes the folder when its state (main and every backup) is torn while the DELETE waits on the lock', async () => {
    const { withStateJsonLock } = await import('../workspace/file-lock.js');
    const title = 'Torn While Waiting';
    const dir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
    const statePath = join(dir, '.audiobook', 'state.json');
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        bookId: 'torn-while-waiting-id',
        manuscriptId: 'm_torn_waiting',
        title,
        author: AUTHOR,
        series: SERIES,
        updatedAt: '2026-05-23T00:00:00.000Z',
        schema: 1,
        chapters: [],
      }),
    );
    let release!: () => void;
    const held = withStateJsonLock(statePath, () => new Promise<void>((r) => (release = r)));
    const del = request(app).delete('/api/books/torn-while-waiting-id').then((r) => r);
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(statePath, '{ torn');
    writeFileSync(`${statePath}.bak.1`, '{ torn');
    release();
    await held;
    const res = await del;
    expect(res.status).toBe(204);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(healthyDir)).toBe(true);
  });

  /* #3711 pass 4: a stateless book that becomes a real book (a state with a
     bookId lands) while the DELETE waits on the state-json lock is no longer
     stateless - removing it would bypass that id's book-op lock. */
  it('refuses 409 book_changed when the stateless folder gains a real bookId while the DELETE waits', async () => {
    const { withStateJsonLock, __stateJsonWaitersForTest } = await import('../workspace/file-lock.js');
    const { makeBookId } = await import('../workspace/paths.js');
    const title = 'Becomes Real';
    const dir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
    const statePath = join(dir, '.audiobook', 'state.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manuscript.txt'), 'x');
    let release!: () => void;
    let acquired!: () => void;
    const holding = new Promise<void>((r) => (acquired = r));
    const held = withStateJsonLock(
      statePath,
      () =>
        new Promise<void>((r) => {
          release = r;
          acquired();
        }),
    );
    await holding;
    const del = request(app).delete(`/api/books/${makeBookId(AUTHOR, SERIES, title)}`).then((r) => r);
    /* Event-based (PR #3714 review pass 4): wait until the DELETE is genuinely
       queued on this folder's state-json lock, never a fixed sleep. */
    const deadline = Date.now() + 8000;
    while (__stateJsonWaitersForTest(statePath) < 1) {
      if (Date.now() > deadline) {
        release();
        throw new Error('timed out waiting for the DELETE to queue on the state-json lock');
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        bookId: 'now-a-real-book',
        manuscriptId: 'm_real',
        title,
        author: AUTHOR,
        series: SERIES,
        updatedAt: '2026-05-23T00:00:00.000Z',
        schema: 1,
        chapters: [],
      }),
    );
    release();
    await held;
    const res = await del;
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('book_changed');
    expect(existsSync(dir)).toBe(true);
  });

  it('an unknown id is still an idempotent 204 that deletes nothing', async () => {
    const res = await request(app).delete('/api/books/no-such-book');
    expect(res.status).toBe(204);
    expect(existsSync(tornDir)).toBe(true);
    expect(existsSync(healthyDir)).toBe(true);
  });

  it('a path-traversal id resolves to no folder and deletes nothing', async () => {
    const res = await request(app).delete(`/api/books/${encodeURIComponent('..%2F..%2Fbooks')}`);
    expect(res.status).toBe(204);
    expect(existsSync(tornDir)).toBe(true);
    expect(existsSync(healthyDir)).toBe(true);
  });
});
