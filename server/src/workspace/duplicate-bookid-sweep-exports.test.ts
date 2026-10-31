/* #3713 / PR #4004 pass 1 -- the re-minted loser's export manifests carry the old
   bookId, and export.ts filters on it, so without a rewrite its exports vanish
   (list [], download 404) while the .m4b stays on disk. The sweep rewrites them
   in the same withBookOp span as the state write. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

/* Manifest paths whose atomic write throws EPERM; everything else is real. */
const failManifestWrite = vi.hoisted(() => new Set<string>());

vi.mock('./state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./state-io.js')>();
  return {
    ...actual,
    writeJsonAtomic: async (path: string, ...rest: unknown[]) => {
      if (failManifestWrite.has(path)) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${path}'`), { code: 'EPERM' });
      }
      return (actual.writeJsonAtomic as (...a: unknown[]) => unknown)(path, ...rest);
    },
  };
});

let root: string;
let app: Express;
let paths: typeof import('./paths.js');
let sweep: typeof import('./duplicate-bookid-sweep.js');
let lock: typeof import('./book-op-lock.js');

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'audiobook-dup-bookid-exports-'));
  process.env.WORKSPACE_DIR = root;
  /* Sequential imports -- a Promise.all of dynamic imports races vi.mock factories (#2083). */
  const { exportRouter } = await import('../routes/export.js');
  const { bookStateRouter } = await import('../routes/book-state.js');
  paths = await import('./paths.js');
  sweep = await import('./duplicate-bookid-sweep.js');
  lock = await import('./book-op-lock.js');
  app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/books', bookStateRouter);
  app.use('/api/books', exportRouter);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}, 120_000);

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

afterEach(() => {
  failManifestWrite.clear();
  rmSync(join(root, 'books'), { recursive: true, force: true });
  lock.__bookDirIndexForTest().clear();
  lock.__duplicateBookIdsForTest().clear();
  sweep.__resetDuplicateBookIdRepairsForTest();
});

function seed(title: string, bookId: string, rendered: number): string {
  const dir = join(paths.BOOKS_ROOT, 'A', 'S', title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, 'manuscript.md'), `# Chapter One\n\nText of ${title}.\n`);
  const chapters: unknown[] = [];
  for (let i = 0; i < Math.max(rendered, 1); i++) {
    chapters.push({
      id: i + 1,
      title: `C${i}`,
      slug: `c${i}`,
      ...(i < rendered ? { audioRenderedAt: '2026-02-01T00:00:00.000Z' } : {}),
    });
  }
  writeFileSync(
    paths.stateJsonPath(dir),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${title}`,
      title,
      author: 'A',
      series: 'S',
      seriesPosition: null,
      isStandalone: false,
      manuscriptFile: 'manuscript.md',
      castConfirmed: false,
      chapters,
      coverGradient: ['#000', '#fff'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      language: 'en',
      schema: 1,
    }),
  );
  return dir;
}

/** The canonical pair: A/S/T renamed to A/S/T2 (keeps the work), A/S/T re-imported (loser). */
function canonical(): { winner: string; loser: string } {
  const original = seed('T', 'a__s__t', 2);
  const winner = join(paths.BOOKS_ROOT, 'A', 'S', 'T2');
  renameSync(original, winner);
  return { winner, loser: seed('T', 'a__s__t', 0) };
}

function seedExport(loser: string, id: string, file: string): string {
  mkdirSync(join(loser, 'exports'), { recursive: true });
  writeFileSync(join(loser, 'exports', file), 'audio');
  mkdirSync(paths.bookExportManifestsDir(loser), { recursive: true });
  const manifestFile = join(paths.bookExportManifestsDir(loser), `${id}.json`);
  writeFileSync(
    manifestFile,
    JSON.stringify({
      id,
      bookId: 'a__s__t',
      format: 'm4b',
      destination: 'download',
      status: 'done',
      filename: file,
      sizeBytes: 5,
      progress: 1,
      downloadUrl: `/api/books/a__s__t/exports/${id}/download`,
      syncPath: null,
      errorReason: null,
      createdAt: '2026-03-01T00:00:00.000Z',
      completedAt: '2026-03-01T00:00:00.000Z',
    }),
  );
  return manifestFile;
}

describe('exports of the re-minted loser', () => {
  it('list and download by the new id still find the export; the winner does not list it', async () => {
    const { loser } = canonical();
    seedExport(loser, 'exp1', 't.m4b');

    const [repair] = await sweep.repairDuplicateBookIds();
    const list = await request(app).get(`/api/books/${repair.newBookId}/exports`);
    const dl = await request(app).get(`/api/books/${repair.newBookId}/exports/exp1/download`);
    const asWinner = await request(app).get('/api/books/a__s__t/exports');

    expect(list.body.map((j: { id: string }) => j.id)).toEqual(['exp1']);
    expect(list.body[0].downloadUrl).toBe(`/api/books/${repair.newBookId}/exports/exp1/download`);
    expect(dl.status).toBe(200);
    expect(asWinner.body).toEqual([]);
    expect(existsSync(join(loser, 'exports', 't.m4b'))).toBe(true);
  }, 30_000);

  it('a manifest that cannot be rewritten leaves the book reachable under its new id', async () => {
    const { loser } = canonical();
    const stuck = seedExport(loser, 'expStuck', 'stuck.m4b');
    seedExport(loser, 'expOk', 'ok.m4b');
    failManifestWrite.add(stuck);

    const [repair] = await sweep.repairDuplicateBookIds();
    const state = await request(app).get(`/api/books/${repair.newBookId}/state`);
    const list = await request(app).get(`/api/books/${repair.newBookId}/exports`);

    expect(repair.newBookId).not.toBe('a__s__t');
    expect(state.status).toBe(200);
    /* export.ts keeps a module-level job map across tests, so assert membership, not equality. */
    const ids = list.body.map((j: { id: string }) => j.id);
    expect(ids).toContain('expOk');
    expect(ids).not.toContain('expStuck');
    /* The unrewritten manifest is left untouched, byte for byte, with its artifact. */
    expect(JSON.parse(readFileSync(stuck, 'utf8')).bookId).toBe('a__s__t');
    expect(existsSync(join(loser, 'exports', 'stuck.m4b'))).toBe(true);
  }, 30_000);
});
