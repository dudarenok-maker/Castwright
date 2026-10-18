/* #3400, pass 7 — every `state.json` read-modify-write holds the per-book lock.

   The chapter restructure holds `withBookLock` across its writes, so a writer
   that derives its write from an earlier UNLOCKED read can land after it with
   the pre-restructure chapter list (the held/exclude toggles, the cover
   patches, GET /state's title refresh + uuid mint, /sync-manifest's uuid mint).

   Deterministic harness (no wall-clock race): the FIRST `writeStateJsonAtomic`
   after arming is paused for 40 ms, and a stand-in "restructure" (a lock-taking
   read-modify-write that drops chapter 3, written with plain fs so it bypasses
   the paused writer) is started inside that pause.
     - An UNLOCKED writer has already read the 3-chapter state; the restructure
       takes the free lock and lands; the writer's stale whole-file write then
       lands last -> chapter 3 is back. RED.
     - A LOCKED writer holds the lock through the pause; the restructure queues
       behind it and lands after the write -> 2 chapters AND the writer's own
       change. GREEN. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const hooks = vi.hoisted(() => ({
  beforeNextWrite: undefined as undefined | (() => Promise<void>),
}));

/* Hooked at `writeJsonAtomic` (the primitive `writeStateJsonAtomic` ends in), for
   state.json paths only: `updateStateJsonLocked` (the leaf-locked primitive the
   writers now share) calls `writeStateJsonAtomic` through its own module
   binding, so a mock of that export would never see the layered writers' write. */
vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../workspace/state-io.js')>();
  return {
    ...orig,
    writeJsonAtomic: (async (...args: Parameters<typeof orig.writeJsonAtomic>) => {
      const fire = hooks.beforeNextWrite;
      if (fire && /[\\/]state\.json$/.test(String(args[0]))) {
        hooks.beforeNextWrite = undefined;
        await fire();
      }
      return orig.writeJsonAtomic(...args);
    }) as typeof orig.writeJsonAtomic,
  };
});

const AUTHOR = 'Writer Lock';
const SERIES = 'Standalones';
const TITLE = 'Writer Lock Book';

let workspaceRoot: string;
let bookDir: string;
let statePath: string;
let bookId: string;
let app: Express;
let lock: typeof import('../workspace/book-lock.js');
let cover: typeof import('../cover/store.js');
let upload: typeof import('../cover/upload.js');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function seed(opts: { uuids?: boolean; titleVersion?: number; cover?: boolean } = {}): void {
  const { uuids = true, titleVersion = 99, cover: withCover = false } = opts;
  writeFileSync(
    statePath,
    JSON.stringify({
      bookId,
      manuscriptId: 'm_writer_lock',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapterTitleParserVersion: titleVersion,
      chapters: [1, 2, 3].map((id) => ({
        id,
        title: `Chapter ${id}`,
        slug: `0${id}-chapter-${id}`,
        ...(uuids ? { uuid: `uuid-${id}` } : {}),
      })),
      ...(withCover
        ? { coverImage: { source: 'local', originalFilename: 'a.png', uploadedAt: 'then' } }
        : {}),
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
}

const readState = () => JSON.parse(readFileSync(statePath, 'utf8'));

/* Arm the pause: the next state write waits 40 ms while a restructure lands.
   The restructure is chained off a gate created HERE, in the test's own async
   context: started from inside the paused writer it would inherit that
   writer's held-lock context and run inline (book-lock.ts is re-entrant per
   context), which is not a second request. */
let restructure: Promise<void> = Promise.resolve();
function armRestructureDuringNextWrite(): void {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  restructure = gate.then(() =>
    lock.withBookLock(bookId, async () => {
      const cur = readState();
      cur.chapters = cur.chapters.filter((c: { id: number }) => c.id !== 3);
      writeFileSync(statePath, JSON.stringify(cur));
    }),
  );
  hooks.beforeNextWrite = async () => {
    open();
    await sleep(40);
  };
}

/* The restructure may still be queued behind a locked writer: let it land. */
async function expectRestructureSurvived() {
  await restructure;
  expect(readState().chapters.map((c: { id: number }) => c.id)).toEqual([1, 2]);
}

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-writer-lock-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { bookStateRouter } = await import('./book-state.js');
  const { syncManifestRouter } = await import('./library-sync-manifest.js');
  const { makeBookId } = await import('../workspace/paths.js');
  lock = await import('../workspace/book-lock.js');
  cover = await import('../cover/store.js');
  upload = await import('../cover/upload.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  statePath = join(bookDir, '.audiobook', 'state.json');
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, 'manuscript.md'),
    '# Chapter One\n\nAlpha.\n\n# Chapter Two\n\nBeta.\n\n# Chapter Three\n\nGamma.\n',
  );
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
  app.use('/api/library', syncManifestRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  hooks.beforeNextWrite = undefined;
  seed();
});

describe('state.json writers hold the book lock across read -> write (#3400 pass 7)', () => {
  it('POST …/held', async () => {
    armRestructureDuringNextWrite();
    const res = await request(app).post(`/api/books/${bookId}/chapters/1/held`).send({ held: true });
    expect(res.status).toBe(200);
    await expectRestructureSurvived();
    expect(readState().chapters[0].held).toBe(true);
  });

  it('POST …/exclude', async () => {
    armRestructureDuringNextWrite();
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/1/exclude`)
      .send({ excluded: true });
    expect(res.status).toBe(200);
    await expectRestructureSurvived();
    expect(readState().chapters[0].excluded).toBe(true);
  });

  it('GET /state: the uuid mint', async () => {
    seed({ uuids: false });
    armRestructureDuringNextWrite();
    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    await expectRestructureSurvived();
    expect(readState().chapters.every((c: { uuid?: string }) => !!c.uuid)).toBe(true);
  });

  it('GET /state: the title refresh', async () => {
    seed({ titleVersion: 0 });
    armRestructureDuringNextWrite();
    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    await expectRestructureSurvived();
    expect(readState().chapterTitleParserVersion).toBeGreaterThan(0);
  });

  it('GET /sync-manifest: the uuid mint', async () => {
    seed({ uuids: false });
    armRestructureDuringNextWrite();
    const res = await request(app).get(`/api/library/sync-manifest?bookId=${bookId}`);
    expect(res.status).toBe(200);
    await expectRestructureSurvived();
    expect(readState().chapters.every((c: { uuid?: string }) => !!c.uuid)).toBe(true);
  });

  it('cover: patchStateCover', async () => {
    armRestructureDuringNextWrite();
    await cover.patchStateCover(bookDir, { id: 'c1', source: 'openlibrary', coverUrl: 'https://x/y.jpg' });
    await expectRestructureSurvived();
    expect(readState().coverImage?.candidateId).toBe('c1');
  });

  it('cover: clearStateCover', async () => {
    seed({ cover: true });
    armRestructureDuringNextWrite();
    await cover.clearStateCover(bookDir);
    await expectRestructureSurvived();
    expect(readState().coverImage).toBeUndefined();
  });

  it('cover: patchStateLocalCover', async () => {
    armRestructureDuringNextWrite();
    await upload.patchStateLocalCover(bookDir, 'mine.png');
    await expectRestructureSurvived();
    expect(readState().coverImage?.originalFilename).toBe('mine.png');
  });

  it('cover: patchStateFraming', async () => {
    seed({ cover: true });
    armRestructureDuringNextWrite();
    const ok = await upload.patchStateFraming(bookDir, { offsetX: 10, offsetY: 5, zoom: 2 });
    expect(ok).toBe(true);
    await expectRestructureSurvived();
    expect(readState().coverImage?.framing?.zoom).toBe(2);
  });
});
