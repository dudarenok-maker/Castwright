/* Integration test for /api/books/:bookId/cover{,/candidates}.

   Asserts that:
     1. GET /candidates wires the book's title+author into searchCovers
        and returns the candidate list as JSON.
     2. POST writes <bookDir>/.audiobook/cover.jpg, patches state.json
        with `coverImage`, and returns the public URL.
     3. GET serves the cached bytes with the JPEG content-type and
        falls back to 404 when no cover is cached.
     4. DELETE removes the file + clears state.json `coverImage`.
     5. All four endpoints 404 on an unknown bookId.

   Tempdir workspace + deferred module imports so paths.ts picks up
   WORKSPACE_DIR; OpenLibrary network is mocked at global.fetch. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE = 'Cover Test Book';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
const fetchMock = vi.fn();

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cover-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ coverRouter }, { makeBookId }] = await Promise.all([
    import('./cover.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_test',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: false,
      chapters: [{ id: 1, title: 'Chapter 1', slug: '01-chapter-one' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );

  app = express();
  app.use(express.json());
  app.use('/api/books', coverRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function imageResponse(bytes: Uint8Array): Response {
  return new Response(bytes, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
}

const SAMPLE_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
]);

describe('cover router — happy path', () => {
  it('GET /candidates aggregates sources and returns composite-id candidates', async () => {
    // Only OpenLibrary returns docs here; apple + google resolve empty.
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('openlibrary.org')) {
        return Promise.resolve(jsonResponse({ docs: [{ cover_i: 111 }, { cover_i: 222 }] }));
      }
      if (url.includes('itunes.apple.com')) return Promise.resolve(jsonResponse({ results: [] }));
      return Promise.resolve(jsonResponse({ items: [] })); // google
    });

    const res = await request(app).get(`/api/books/${bookId}/cover/candidates`);
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(2);
    expect(res.body.candidates[0].id).toBe('openlibrary:111');
    expect(res.body.candidates[0].source).toBe('openlibrary');
    expect(res.body.candidates[0].coverUrl).toContain('covers.openlibrary.org/b/id/111-L.jpg');

    const olCall = fetchMock.mock.calls.find(([u]) => String(u).includes('openlibrary.org/search'));
    const parsed = new URL(olCall![0] as string);
    expect(parsed.searchParams.get('q')).toBe(`${TITLE} ${AUTHOR}`);
    expect(parsed.searchParams.get('title')).toBeNull();
  });

  it('POST downloads the picked candidate, writes cover.jpg, patches state.json, returns the public URL', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ docs: [{ cover_i: 555 }] })) // re-locate (openlibrary only)
      .mockResolvedValueOnce(imageResponse(SAMPLE_JPEG)); // download

    const res = await request(app)
      .post(`/api/books/${bookId}/cover`)
      .set('Content-Type', 'application/json')
      .send({ candidateId: 'openlibrary:555' });
    expect(res.status).toBe(200);
    expect(res.body.coverImageUrl).toBe(`/api/books/${bookId}/cover`);

    const onDisk = join(bookDir, '.audiobook', 'cover.jpg');
    expect(existsSync(onDisk)).toBe(true);
    expect(Array.from(readFileSync(onDisk))).toEqual(Array.from(SAMPLE_JPEG));

    const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.coverImage.candidateId).toBe('openlibrary:555');
    expect(state.coverImage.source).toBe('openlibrary');
    expect(state.coverImage.originalUrl).toBe('https://covers.openlibrary.org/b/id/555-L.jpg');
  });

  it('GET /cover streams the cached bytes with the JPEG content-type', async () => {
    const res = await request(app).get(`/api/books/${bookId}/cover`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.headers['cache-control']).toContain('max-age=3600');
    expect(Array.from(res.body)).toEqual(Array.from(SAMPLE_JPEG));
  });

  it('DELETE removes the cached file and clears state.json coverImage', async () => {
    const res = await request(app).delete(`/api/books/${bookId}/cover`);
    expect(res.status).toBe(204);

    const onDisk = join(bookDir, '.audiobook', 'cover.jpg');
    expect(existsSync(onDisk)).toBe(false);

    const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.coverImage).toBeUndefined();
  });

  it('GET /cover after DELETE returns 404 with a JSON error', async () => {
    const res = await request(app).get(`/api/books/${bookId}/cover`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no cover/i);
  });
});

describe('cover router — error paths', () => {
  it('POST 400s when candidateId is missing', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cover`)
      .set('Content-Type', 'application/json')
      .send({});
    expect(res.status).toBe(400);
  });

  it('POST 404s when the candidate id is no longer in the live result set', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ docs: [{ cover_i: 999 }] }));
    const res = await request(app)
      .post(`/api/books/${bookId}/cover`)
      .set('Content-Type', 'application/json')
      .send({ candidateId: 'openlibrary:doesnotexist' });
    expect(res.status).toBe(404);
  });

  it('POST 502s when the re-locate search throws CoverSourceError', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 503 }));
    const res = await request(app)
      .post(`/api/books/${bookId}/cover`)
      .set('Content-Type', 'application/json')
      .send({ candidateId: 'openlibrary:111' });
    expect(res.status).toBe(502);
    expect(res.body.kind).toBe('http');
  });

  it('all four endpoints return 404 for an unknown bookId', async () => {
    const stranger = 'no-such-book__nowhere__nope';
    const r1 = await request(app).get(`/api/books/${stranger}/cover/candidates`);
    const r2 = await request(app)
      .post(`/api/books/${stranger}/cover`)
      .send({ candidateId: 'openlibrary:1' });
    const r3 = await request(app).get(`/api/books/${stranger}/cover`);
    const r4 = await request(app).delete(`/api/books/${stranger}/cover`);
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
    expect(r3.status).toBe(404);
    expect(r4.status).toBe(404);
  });
});

/* ---------- Plan 40 — upload + framing endpoints ---------- */

describe('POST /:bookId/cover/upload (plan 40)', () => {
  it('accepts a JPEG upload, writes cover.jpg verbatim, patches state with source=local', async () => {
    // Build a small valid JPEG via sharp so the bytes pass validateUpload.
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg({ quality: 85 })
      .toBuffer();

    const res = await request(app)
      .post(`/api/books/${bookId}/cover/upload`)
      .attach('image', jpeg, { filename: 'mine.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.coverImageUrl).toBe(`/api/books/${bookId}/cover`);
    expect(res.body.originalFilename).toBe('mine.jpg');

    const onDisk = join(bookDir, '.audiobook', 'cover.jpg');
    expect(existsSync(onDisk)).toBe(true);
    expect(Buffer.compare(readFileSync(onDisk), jpeg)).toBe(0);

    const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.coverImage.source).toBe('local');
    expect(state.coverImage.originalFilename).toBe('mine.jpg');
    expect(state.coverImage.openLibraryId).toBeUndefined();
  });

  it('transcodes a PNG upload to JPEG on disk', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 80, g: 30, b: 200, alpha: 1 } },
    })
      .png()
      .toBuffer();

    const res = await request(app)
      .post(`/api/books/${bookId}/cover/upload`)
      .attach('image', png, { filename: 'mine.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    const written = readFileSync(join(bookDir, '.audiobook', 'cover.jpg'));
    // JPEG SOI marker, never PNG signature.
    expect(written[0]).toBe(0xff);
    expect(written[1]).toBe(0xd8);
  });

  it('415s on an unsupported MIME (image/gif)', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cover/upload`)
      .attach('image', Buffer.from('GIF89a fake'), { filename: 'x.gif', contentType: 'image/gif' });
    expect(res.status).toBe(415);
    expect(res.body.kind).toBe('invalid_mime');
  });

  /* Plan 105 — multer 2.x MulterError paths. multer 2.x preserves the
     1.x `.code` strings (LIMIT_FILE_SIZE / LIMIT_UNEXPECTED_FILE) and
     still raises a `multer.MulterError` instance, which the route's
     middleware now gates on via `instanceof` before branching. These
     two cases pin that the upgraded error semantics still surface as
     413 (oversize) and 400 (unexpected field). */
  it('413s with kind="oversize" when the upload exceeds the fileSize limit (LIMIT_FILE_SIZE)', async () => {
    // MAX_UPLOAD_BYTES is 10 MiB — a 10.5 MiB buffer trips multer's
    // fileSize limit before validateUpload ever runs.
    const tooBig = Buffer.alloc(11 * 1024 * 1024, 0x41);
    const res = await request(app)
      .post(`/api/books/${bookId}/cover/upload`)
      .attach('image', tooBig, { filename: 'huge.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(413);
    expect(res.body.kind).toBe('oversize');
    expect(res.body.error).toMatch(/under/i);
  });

  it('400s with kind="unexpected_field" when the file rides an unexpected field name (LIMIT_UNEXPECTED_FILE)', async () => {
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .jpeg()
      .toBuffer();
    // The route configures upload.single('image'); attaching under
    // 'wrongField' makes multer raise LIMIT_UNEXPECTED_FILE.
    const res = await request(app)
      .post(`/api/books/${bookId}/cover/upload`)
      .attach('wrongField', jpeg, { filename: 'mine.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
    expect(res.body.kind).toBe('unexpected_field');
  });

  it('400s when the multipart body has no image field', async () => {
    const res = await request(app).post(`/api/books/${bookId}/cover/upload`).send();
    expect(res.status).toBe(400);
  });

  it('404s on an unknown bookId', async () => {
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .jpeg()
      .toBuffer();
    const res = await request(app)
      .post('/api/books/no-such-book__nowhere__nope/cover/upload')
      .attach('image', jpeg, { filename: 'x.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /:bookId/cover/framing (plan 40)', () => {
  beforeEach(async () => {
    // Seed a cover so framing has something to attach to. Resets prior test state.
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .jpeg()
      .toBuffer();
    await request(app)
      .post(`/api/books/${bookId}/cover/upload`)
      .attach('image', jpeg, { filename: 'seed.jpg', contentType: 'image/jpeg' });
  });

  it('persists framing on a book that has a cover', async () => {
    const res = await request(app)
      .patch(`/api/books/${bookId}/cover/framing`)
      .set('Content-Type', 'application/json')
      .send({ offsetX: 30, offsetY: -25, zoom: 1.4 });
    expect(res.status).toBe(204);

    const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.coverImage.framing).toEqual({ offsetX: 30, offsetY: -25, zoom: 1.4 });
  });

  it('clamps out-of-range values server-side', async () => {
    await request(app)
      .patch(`/api/books/${bookId}/cover/framing`)
      .set('Content-Type', 'application/json')
      .send({ offsetX: 500, offsetY: -500, zoom: 99 });

    const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.coverImage.framing).toEqual({ offsetX: 100, offsetY: -100, zoom: 3 });
  });

  it('400s when offsetX/offsetY/zoom are missing or non-numeric', async () => {
    const r1 = await request(app)
      .patch(`/api/books/${bookId}/cover/framing`)
      .set('Content-Type', 'application/json')
      .send({});
    expect(r1.status).toBe(400);

    const r2 = await request(app)
      .patch(`/api/books/${bookId}/cover/framing`)
      .set('Content-Type', 'application/json')
      .send({ offsetX: 'left', offsetY: 0, zoom: 1 });
    expect(r2.status).toBe(400);
  });

  it('404s when the book has no cover pinned', async () => {
    await request(app).delete(`/api/books/${bookId}/cover`);
    const res = await request(app)
      .patch(`/api/books/${bookId}/cover/framing`)
      .set('Content-Type', 'application/json')
      .send({ offsetX: 0, offsetY: 0, zoom: 1 });
    expect(res.status).toBe(404);
  });

  it('404s on an unknown bookId', async () => {
    const res = await request(app)
      .patch('/api/books/no-such-book__nowhere__nope/cover/framing')
      .set('Content-Type', 'application/json')
      .send({ offsetX: 0, offsetY: 0, zoom: 1 });
    expect(res.status).toBe(404);
  });
});
