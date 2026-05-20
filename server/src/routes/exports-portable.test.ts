/* Route smoke tests for /api/books/:bookId/export/portable + /api/import/portable
   (plan 75).

   Scaffolds a synthetic workspace with one complete book, hits the export
   endpoint with supertest to download the zip, then POSTs the same zip
   back to the import endpoint and verifies the new book lands on disk. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Portable Test Author';
const SERIES = 'Standalones';
const TITLE = 'Portable Test Book';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'portable-route-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ portableExportRouter, portableImportRouter }, { makeBookId }] = await Promise.all([
    import('./exports-portable.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, 'audio'), { recursive: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });

  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify(
      {
        bookId,
        manuscriptId: 'mns_test',
        title: TITLE,
        author: AUTHOR,
        series: SERIES,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters: [
          { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
          { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
        ],
        coverGradient: ['#abc', '#def'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'fixture manuscript bytes');
  writeFileSync(join(bookDir, 'audio', '01-chapter-one.mp3'), Buffer.from('mp3-bytes-1'));
  writeFileSync(join(bookDir, 'audio', '02-chapter-two.mp3'), Buffer.from('mp3-bytes-2'));

  app = express();
  app.use(express.json());
  app.use('/api/books', portableExportRouter);
  app.use('/api/import', portableImportRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('GET /api/books/:bookId/export/portable', () => {
  it('returns 200 with a zip body + attachment Content-Disposition', async () => {
    const res = await request(app)
      .get(`/api/books/${encodeURIComponent(bookId)}/export/portable`)
      .buffer(true)
      .parse((response, callback) => {
        /* supertest's default parser concatenates strings; for binary
           payloads we collect raw bytes and hand them back as a Buffer
           via the callback. */
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename=".*\.portable\.zip"/);
    /* Local zip header magic: 'PK\x03\x04'. */
    const body = res.body as Buffer;
    expect(body[0]).toBe(0x50);
    expect(body[1]).toBe(0x4b);
  });

  it('returns 404 when the book does not exist', async () => {
    const res = await request(app).get('/api/books/nonexistent__nope__nope/export/portable');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/import/portable', () => {
  it('accepts a multipart bundle and writes it under a renamed target dir', async () => {
    /* Export the existing fixture, then post the bytes back. The default
       'rename' strategy lands the imported book at "<title> (imported)". */
    const exportRes = await request(app)
      .get(`/api/books/${encodeURIComponent(bookId)}/export/portable`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(exportRes.status).toBe(200);
    const zipBytes: Buffer = exportRes.body as Buffer;

    /* supertest's `.attach(field, buffer)` chokes on raw Buffer — write
       to a temp file and attach by path. */
    const tmpZip = join(workspaceRoot, 'roundtrip-upload.zip');
    writeFileSync(tmpZip, zipBytes);

    const importRes = await request(app).post('/api/import/portable').attach('file', tmpZip);

    expect(importRes.status).toBe(201);
    expect(importRes.body.targetPath).toContain('(imported)');
    expect(importRes.body.importedFiles).toBeGreaterThan(0);
    expect(importRes.body.conflict).toEqual({
      strategy: 'rename',
      renamedTo: importRes.body.targetPath,
    });

    /* And the bytes landed: */
    const importedTarget = importRes.body.targetPath as string;
    expect(existsSync(join(importedTarget, 'manuscript.txt'))).toBe(true);
    expect(existsSync(join(importedTarget, 'audio', '01-chapter-one.mp3'))).toBe(true);

    const stateRead = JSON.parse(
      readFileSync(join(importedTarget, '.audiobook', 'state.json'), 'utf8'),
    );
    expect(stateRead.title).toContain('(imported)');
  });

  it('returns 400 with `invalid_bundle` when the upload is not a valid bundle', async () => {
    const badPath = join(workspaceRoot, 'bad.zip');
    writeFileSync(badPath, Buffer.from('not a zip'));
    const res = await request(app).post('/api/import/portable').attach('file', badPath);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_bundle');
  });

  it('returns 400 when the multipart body is missing the file field', async () => {
    const res = await request(app).post('/api/import/portable');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_file');
  });
});
