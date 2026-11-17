/* POST /api/manuscripts error mapping. srv-14: a DRM-protected MOBI must
   return HTTP 415 (not the generic 500) — aligning the manuscripts upload
   route with /api/import, which already returns 415. DrmProtectedError and
   UnusableEpubError share the UnusableMediaError base the route catches with
   one instanceof. Pairs with docs/features/archive/116-epub-parsing.md. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let workspaceRoot: string;
let app: Express;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-manuscripts-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { manuscriptsRouter } = await import('./manuscripts.js');
  app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/manuscripts', manuscriptsRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('POST /api/manuscripts — error status mapping', () => {
  it('returns 415 (not 500) when a MOBI file is DRM-protected', async () => {
    /* Hand-crafted MOBI-shaped buffer with encryption byte 2 (Kindle Store
       DRM) — same shape as the /api/import DRM test. The detector reads the
       record-0 offset at byte 78 and the u16 encryption type at offset+0x0C;
       parseMobi throws DrmProtectedError before the parser library is invoked. */
    const drmBuffer = Buffer.alloc(256, 0);
    const record0 = 96;
    drmBuffer.writeUInt32BE(record0, 78);
    drmBuffer.writeUInt16BE(2, record0 + 0x0c);

    const res = await request(app).post('/api/manuscripts').attach('file', drmBuffer, {
      filename: 'drm-protected.mobi',
      contentType: 'application/x-mobipocket-ebook',
    });

    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/DRM-protected/i);
  });

  it('still returns 200 for a valid plaintext upload (415 is not a blanket response)', async () => {
    const res = await request(app)
      .post('/api/manuscripts')
      .send({ text: 'A short manuscript. It has two sentences.', fileName: 'note.txt' });

    expect(res.status).toBe(200);
    expect(res.body.format).toBe('plaintext');
    expect(res.body.wordCount).toBeGreaterThan(0);
  });
});

/* I4 (#4217) — an in-memory upload extracts with the current version.
   Mutation: pass LEGACY_EXTRACTOR_VERSION in manuscripts.ts and the div
   paragraphs stay joined. */
describe('POST /api/manuscripts — extractor v2 (#4217)', () => {
  it('I4: splits div paragraphs in the returned sourceText', async () => {
    const { buildEpub } = await import('../test-utils/empty-href-epub.js');
    const chapter =
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>' +
      '<div class="p">First para one.</div><div class="p">First para two.</div></body></html>';
    const res = await request(app)
      .post('/api/manuscripts')
      .attach('file', await buildEpub([chapter]), { filename: 'divs.epub', contentType: 'application/epub+zip' });
    expect(res.status).toBe(200);
    expect(res.body.sourceText).toContain('First para one.\n\nFirst para two.');
  });
});
