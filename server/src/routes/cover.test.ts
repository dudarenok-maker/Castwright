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

const SAMPLE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

describe('cover router — happy path', () => {
  it('GET /candidates calls OpenLibrary search with the book title + author', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      docs: [
        { cover_i: 111, title: TITLE },
        { cover_i: 222, title: TITLE },
      ],
    }));

    const res = await request(app).get(`/api/books/${bookId}/cover/candidates`);
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(2);
    expect(res.body.candidates[0].openLibraryId).toBe('cover-i:111');
    expect(res.body.candidates[0].coverUrl).toContain('covers.openlibrary.org/b/id/111-L.jpg');

    /* Confirm the search URL embedded the book's metadata. */
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.searchParams.get('title')).toBe(TITLE);
    expect(parsed.searchParams.get('author')).toBe(AUTHOR);
  });

  it('POST downloads the picked candidate, writes cover.jpg, patches state.json, and returns the public URL', async () => {
    /* Two fetch calls happen on this path: first the search to re-locate
       the candidate by id, then the actual image download. Queue both. */
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ docs: [{ cover_i: 555 }] }))
      .mockResolvedValueOnce(imageResponse(SAMPLE_JPEG));

    const res = await request(app)
      .post(`/api/books/${bookId}/cover`)
      .set('Content-Type', 'application/json')
      .send({ openLibraryId: 'cover-i:555' });
    expect(res.status).toBe(200);
    expect(res.body.coverImageUrl).toBe(`/api/books/${bookId}/cover`);

    const onDisk = join(bookDir, '.audiobook', 'cover.jpg');
    expect(existsSync(onDisk)).toBe(true);
    expect(Array.from(readFileSync(onDisk))).toEqual(Array.from(SAMPLE_JPEG));

    const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.coverImage.openLibraryId).toBe('cover-i:555');
    expect(state.coverImage.originalUrl).toBe('https://covers.openlibrary.org/b/id/555-L.jpg');
    expect(typeof state.coverImage.fetchedAt).toBe('string');
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
  it('POST 400s when openLibraryId is missing', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cover`)
      .set('Content-Type', 'application/json')
      .send({});
    expect(res.status).toBe(400);
  });

  it('POST 404s when the candidate id is no longer in the live search result set', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ docs: [{ cover_i: 999 }] }));
    const res = await request(app)
      .post(`/api/books/${bookId}/cover`)
      .set('Content-Type', 'application/json')
      .send({ openLibraryId: 'cover-i:doesnotexist' });
    expect(res.status).toBe(404);
  });

  it('POST 502s when the search throws OpenLibraryError', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 503 }));
    const res = await request(app)
      .post(`/api/books/${bookId}/cover`)
      .set('Content-Type', 'application/json')
      .send({ openLibraryId: 'cover-i:111' });
    expect(res.status).toBe(502);
    expect(res.body.kind).toBe('http');
  });

  it('all four endpoints return 404 for an unknown bookId', async () => {
    const stranger = 'no-such-book__nowhere__nope';
    const r1 = await request(app).get(`/api/books/${stranger}/cover/candidates`);
    const r2 = await request(app).post(`/api/books/${stranger}/cover`).send({ openLibraryId: 'cover-i:1' });
    const r3 = await request(app).get(`/api/books/${stranger}/cover`);
    const r4 = await request(app).delete(`/api/books/${stranger}/cover`);
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
    expect(r3.status).toBe(404);
    expect(r4.status).toBe(404);
  });
});
