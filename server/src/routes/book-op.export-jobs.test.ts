/* #3711 task 4 -- both exports are registered `export` jobs: POST /exports (detached; the
   build runs after the 201) and GET /export/portable (request-scoped). While the archive
   is being built, a folder rename and a DELETE are refused with 409 `book_busy` and the
   folder is untouched; the registration is released on every exit path (success, build
   failure, a rejected pre-flight) and a start for a deleted book registers nothing.

   Driven through the real routes with the archive builder held by a gate. Event-based, no
   sleeps. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const { buildZip, buildPortable } = vi.hoisted(() => ({ buildZip: vi.fn(), buildPortable: vi.fn() }));
vi.mock('../export/build-mp3-zip.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../export/build-mp3-zip.js')>();
  return { ...actual, buildMp3Zip: (...args: unknown[]) => buildZip(...args) };
});
vi.mock('../export/build-portable-book.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../export/build-portable-book.js')>();
  return { ...actual, buildPortableBundleByBookId: (...args: unknown[]) => buildPortable(...args) };
});

const AUTHOR = 'Export Job Author';
const SERIES = 'The Series';
const TITLE = 'Export Job Book';
const NEW_TITLE = 'Export Job Book Renamed';

let workspaceRoot: string;
let bookDir: string;
let newDir: string;
let app: Express;
let bookId: string;
let bookJobKinds: typeof import('../workspace/book-op-lock.js').bookJobKinds;
let awaitInFlightJobs: () => Promise<void>;
let resetJobs: () => void;

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

function seedBook(): void {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  mkdirSync(join(bookDir, 'audio'), { recursive: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'mns_export_job',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: 1,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      language: 'en',
      chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
      coverGradient: ['#abc', '#def'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  /* The POST pre-flight only checks the chapter audio exists; the builder is mocked. */
  writeFileSync(join(bookDir, 'audio', '01-chapter-one.mp3'), Buffer.from([0]));
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-export-job-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const exp = await import('./export.js');
  const portable = await import('./exports-portable.js');
  const { bookStateRouter } = await import('./book-state.js');
  const { makeBookId } = await import('../workspace/paths.js');
  const { _resetUserSettingsCache } = await import('../workspace/user-settings.js');
  _resetUserSettingsCache();
  bookJobKinds = (await import('../workspace/book-op-lock.js')).bookJobKinds;
  awaitInFlightJobs = exp._awaitInFlightExportJobs;
  resetJobs = exp._resetExportJobs;
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  newDir = join(workspaceRoot, 'books', AUTHOR, SERIES, NEW_TITLE);
  app = express();
  app.use(express.json());
  app.use('/api/books', exp.exportRouter);
  app.use('/api/books', portable.portableExportRouter);
  app.use('/api/books', bookStateRouter);
});

beforeEach(async () => {
  await awaitInFlightJobs();
  resetJobs();
  buildZip.mockReset();
  buildPortable.mockReset();
  seedBook();
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

const renameRequest = () =>
  request(app)
    .put(`/api/books/${bookId}/state`)
    .set('Content-Type', 'application/json')
    .send({ slice: 'state', patch: { title: NEW_TITLE } });

async function expectBusyRefusals(): Promise<void> {
  const rename = await renameRequest();
  expect(rename.status).toBe(409);
  expect(rename.body.code).toBe('book_busy');
  expect(rename.body.error).toMatch(/exporting/i);
  const del = await request(app).delete(`/api/books/${bookId}`);
  expect(del.status).toBe(409);
  expect(del.body.code).toBe('book_busy');
  expect(existsSync(bookDir)).toBe(true);
  expect(existsSync(newDir)).toBe(false);
  expect(JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8')).title).toBe(TITLE);
}

const postExport = () =>
  request(app).post(`/api/books/${bookId}/exports`).send({ format: 'mp3-zip', destination: 'download' });

describe('POST /exports is a registered export job (#3711)', () => {
  it('answers 201 at once, holds the book against rename/DELETE while the archive builds, then releases', async () => {
    const entered = gate();
    const release = gate();
    buildZip.mockImplementation(async () => {
      entered.open();
      await release.promise;
      throw new Error('stop after the gate (the registration is what is under test)');
    });
    const res = await postExport();
    expect(res.status).toBe(201);
    await entered.promise;
    expect(bookJobKinds(bookId)).toEqual(['export']);

    await expectBusyRefusals();

    release.open();
    await awaitInFlightJobs();
    await vi.waitFor(() => expect(bookJobKinds(bookId)).toEqual([]));
    expect((await renameRequest()).status).toBe(200);
    expect(existsSync(newDir)).toBe(true);
  });

  it('releases the registration when the build fails outright', async () => {
    buildZip.mockRejectedValue(new Error('encoder died'));
    const res = await postExport();
    expect(res.status).toBe(201);
    await awaitInFlightJobs();
    await vi.waitFor(() => expect(bookJobKinds(bookId)).toEqual([]));
    expect((await renameRequest()).status).toBe(200);
  });

  it('releases the registration on an early return (a chapter has no audio -> 409 export_incomplete)', async () => {
    rmSync(join(bookDir, 'audio', '01-chapter-one.mp3'));
    const res = await postExport();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('export_incomplete');
    expect(bookJobKinds(bookId)).toEqual([]);
    expect((await renameRequest()).status).toBe(200);
  });

  it('a start for a deleted book answers 404 and registers nothing', async () => {
    rmSync(bookDir, { recursive: true, force: true });
    const res = await postExport();
    expect(res.status).toBe(404);
    expect(bookJobKinds(bookId)).toEqual([]);
  });
});

describe('GET /export/portable is a registered export job (#3711)', () => {
  it('holds the book against rename/DELETE while the bundle builds, then releases', async () => {
    const entered = gate();
    const release = gate();
    buildPortable.mockImplementation(async () => {
      entered.open();
      await release.promise;
      return { buffer: Buffer.from('zip-bytes') };
    });
    const run = request(app)
      .get(`/api/books/${bookId}/export/portable`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .then((r) => r);
    await entered.promise;
    expect(bookJobKinds(bookId)).toEqual(['export']);

    await expectBusyRefusals();

    release.open();
    const res = await run;
    expect(res.status).toBe(200);
    expect(bookJobKinds(bookId)).toEqual([]);
    expect((await renameRequest()).status).toBe(200);
  });

  it('releases the registration when the build fails', async () => {
    buildPortable.mockRejectedValue(new Error('zip failed'));
    const res = await request(app).get(`/api/books/${bookId}/export/portable`);
    expect(res.status).toBe(500);
    expect(bookJobKinds(bookId)).toEqual([]);
    expect((await renameRequest()).status).toBe(200);
  });

  it('a request for a deleted book answers 404 and registers nothing', async () => {
    rmSync(bookDir, { recursive: true, force: true });
    const res = await request(app).get(`/api/books/${bookId}/export/portable`);
    expect(res.status).toBe(404);
    expect(bookJobKinds(bookId)).toEqual([]);
  });
});
