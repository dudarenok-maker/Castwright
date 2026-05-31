/* Plan 67 — streaming-link share route tests.

   Scaffolds a synthetic workspace with one book that has an M4B export
   manifest + artifact on disk, then drives:
     1. POST /api/books/:bookId/share — slug mint, idempotency, 404 path.
     2. GET /share/:slug — slug → bookId → M4B stream, 404 on unknown
        slug, 409 when no M4B export exists yet.
     3. share-links.json persistence — slug-to-bookId mapping written to
        the workspace root survives a re-read.

   Avoids ffmpeg / real M4B building; the route only cares that a
   completed M4B manifest + its artifact file are on disk. The "M4B"
   here is a few bytes of placeholder content, served as audio/mp4.

   Pairs with docs/features/archive/68-streaming-link-tile.md. */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE = 'Streaming Bonus';

let workspaceRoot: string;
let bookDir: string;
let exportsDir: string;
let app: Express;
let bookId: string;
let resetShareLinks: () => Promise<void>;
let shareLinksPath: string;

/* The "M4B" is just a few bytes — the share route doesn't probe the
   file's container, it streams the raw bytes with Content-Type:
   audio/mp4. Plenty for the proxy contract. */
const FAKE_M4B_BYTES = Buffer.from('ftypM4B placeholder bytes for the share route', 'utf8');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-share-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ shareRouter, sharePublicRouter, _resetShareLinks }, { makeBookId }] = await Promise.all([
    import('./share.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  resetShareLinks = _resetShareLinks;
  shareLinksPath = join(workspaceRoot, '.audiobook', 'share-links.json');

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  exportsDir = join(bookDir, '.audiobook', 'exports');
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });

  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'mns_test',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#abc', '#def'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');

  app = express();
  app.use(express.json());
  app.use('/api/books', shareRouter);
  app.use('/', sharePublicRouter);
});

beforeEach(async () => {
  await resetShareLinks();
  if (existsSync(exportsDir)) rmSync(exportsDir, { recursive: true, force: true });
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

/** Drop an M4B export onto disk so the GET proxy has something to
    serve. Returns the absolute artifact path so tests can assert the
    bytes round-trip. */
function seedM4bExport(opts?: {
  exportId?: string;
  filename?: string;
  status?: 'done' | 'failed' | 'in_progress';
  format?: 'm4b' | 'mp3-zip';
  completedAt?: string;
}): string {
  const exportId = opts?.exportId ?? `exp_seed_${Date.now().toString(36)}`;
  const filename = opts?.filename ?? 'streaming-bonus.m4b';
  const status = opts?.status ?? 'done';
  const format = opts?.format ?? 'm4b';
  const exportDir = join(exportsDir, exportId);
  mkdirSync(exportDir, { recursive: true });
  const artifact = join(exportDir, filename);
  writeFileSync(artifact, FAKE_M4B_BYTES);
  writeFileSync(
    join(exportDir, 'manifest.json'),
    JSON.stringify({
      id: exportId,
      bookId,
      format,
      destination: 'download',
      status,
      filename,
      sizeBytes: FAKE_M4B_BYTES.length,
      progress: status === 'done' ? 1 : 0.5,
      downloadUrl: null,
      syncPath: null,
      errorReason: null,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      completedAt: status === 'done' ? (opts?.completedAt ?? new Date().toISOString()) : null,
    }),
  );
  return artifact;
}

describe('POST /api/books/:bookId/share', () => {
  it('mints a 12-char Crockford base32 slug for a known book', async () => {
    const res = await request(app).post(`/api/books/${bookId}/share`).send({});
    expect(res.status).toBe(201);
    expect(typeof res.body.slug).toBe('string');
    expect(res.body.slug).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);
    expect(res.body.url).toMatch(new RegExp(`/share/${res.body.slug}$`));
  });

  it('persists the slug → bookId mapping to <workspace>/.audiobook/share-links.json', async () => {
    const res = await request(app).post(`/api/books/${bookId}/share`).send({});
    expect(res.status).toBe(201);
    expect(existsSync(shareLinksPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(shareLinksPath, 'utf8')) as {
      links: Record<string, { bookId: string }>;
    };
    expect(parsed.links[res.body.slug]).toBeDefined();
    expect(parsed.links[res.body.slug].bookId).toBe(bookId);
  });

  it('returns the SAME slug on a re-POST for the same book (idempotent)', async () => {
    const first = await request(app).post(`/api/books/${bookId}/share`).send({});
    const second = await request(app).post(`/api/books/${bookId}/share`).send({});
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.slug).toBe(first.body.slug);
  });

  it('404s on an unknown bookId', async () => {
    const res = await request(app).post(`/api/books/unknown__bookid__here/share`).send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('book_not_found');
  });
});

describe('GET /share/:slug', () => {
  it('streams the M4B bytes with Content-Type: audio/mp4', async () => {
    seedM4bExport();
    const mint = await request(app).post(`/api/books/${bookId}/share`).send({});
    const slug = mint.body.slug as string;

    const res = await request(app).get(`/share/${slug}`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/audio\/mp4/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename=/);
    expect((res.body as Buffer).equals(FAKE_M4B_BYTES)).toBe(true);
  });

  it('returns the MOST RECENT M4B when multiple are present', async () => {
    const older = seedM4bExport({
      exportId: 'exp_older',
      filename: 'older.m4b',
      completedAt: '2020-01-01T00:00:00.000Z',
    });
    /* Second export keeps the bytes pointer; rewrite the artifact so
       we can distinguish them by content. */
    const newerPath = seedM4bExport({
      exportId: 'exp_newer',
      filename: 'newer.m4b',
      completedAt: '2030-01-01T00:00:00.000Z',
    });
    const NEWER_BYTES = Buffer.from('newer m4b bytes — distinct from older', 'utf8');
    writeFileSync(newerPath, NEWER_BYTES);
    void older;

    const mint = await request(app).post(`/api/books/${bookId}/share`).send({});
    const res = await request(app)
      .get(`/share/${mint.body.slug}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).equals(NEWER_BYTES)).toBe(true);
  });

  it('404s on an unknown slug', async () => {
    /* Use a string that matches the strict slug regex but isn't in
       the table, plus a string that fails the regex, to cover both
       gates. */
    const r1 = await request(app).get(`/share/ABCDEFGHJKMN`);
    expect(r1.status).toBe(404);
    expect(r1.body.error).toBe('slug_not_found');
    const r2 = await request(app).get(`/share/not-a-valid-slug`);
    expect(r2.status).toBe(404);
  });

  it('409s when no M4B export is ready yet', async () => {
    /* Slug minted but no M4B on disk — the share-link UI should
       render a "Build an M4B first" hint rather than mistake a 404
       for a broken slug. */
    const mint = await request(app).post(`/api/books/${bookId}/share`).send({});
    const res = await request(app).get(`/share/${mint.body.slug}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('no_m4b_ready');
  });

  it('ignores non-m4b exports and failed-status manifests when resolving', async () => {
    seedM4bExport({ format: 'mp3-zip', filename: 'zipped.zip' });
    seedM4bExport({ status: 'failed', filename: 'failed.m4b' });
    const mint = await request(app).post(`/api/books/${bookId}/share`).send({});
    const res = await request(app).get(`/share/${mint.body.slug}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('no_m4b_ready');
  });
});
