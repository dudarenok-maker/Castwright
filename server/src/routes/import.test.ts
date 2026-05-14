/* Import route — verifies that POST /api/books persists the ORIGINAL
   uploaded bytes to manuscript.<ext>, not the parser's extracted
   sourceText. Earlier versions wrote sourceText for every format,
   silently corrupting later re-parse runs:
     - EPUB/PDF: re-parse blew up because plain text isn't a valid ZIP.
     - Markdown: re-parse silently produced the wrong chapter split
       because parseText strips headings + injects audio tags into
       sourceText.
   This regression test pins the binary-preservation behaviour. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_EPUB = resolve(__dirname, '..', 'parsers', '__fixtures__', 'sample.epub');

let workspaceRoot: string;
let app: Express;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-import-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { importRouter } = await import('./import.js');
  app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api', importRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('POST /api/books — binary preservation', () => {
  it('writes the verbatim EPUB bytes to manuscript.epub (zip magic intact)', async () => {
    const epubBytes = await readFile(FIXTURE_EPUB);

    const importRes = await request(app)
      .post('/api/import')
      .attach('file', epubBytes, { filename: 'sample.epub', contentType: 'application/epub+zip' });
    expect(importRes.status).toBe(200);
    const tempId = importRes.body.tempId;

    const confirmRes = await request(app)
      .post('/api/books')
      .send({
        tempId,
        author: 'Verbatim Author',
        title:  'Verbatim Book',
        series: 'Verbatim Series',
        seriesPosition: 1,
        isStandalone: false,
      });
    expect(confirmRes.status).toBe(201);
    const bookDir = confirmRes.body.paths.bookDir;
    const manuscriptPath = join(bookDir, 'manuscript.epub');

    expect(existsSync(manuscriptPath)).toBe(true);
    const written = readFileSync(manuscriptPath);
    /* Bytes round-trip exactly — no UTF-8 encoding pass, no extracted-
       text substitution. */
    expect(written.equals(epubBytes)).toBe(true);
    /* And the leading bytes are a valid ZIP local-file header so a
       re-parse via epub2/adm-zip would actually succeed. */
    expect(written[0]).toBe(0x50); // P
    expect(written[1]).toBe(0x4b); // K
    expect(written[2]).toBe(0x03);
    expect(written[3]).toBe(0x04);
  });

  it('writes the verbatim markdown bytes to manuscript.md (preserves headings + line breaks)', async () => {
    const md = `# A Real Title\n\n## Chapter One\n\nA short opening.\n\n## Chapter Two\n\nAnd a second chapter.\n`;

    const importRes = await request(app)
      .post('/api/import')
      .send({ text: md, fileName: 'verbatim.md' });
    expect(importRes.status).toBe(200);
    const tempId = importRes.body.tempId;

    const confirmRes = await request(app)
      .post('/api/books')
      .send({
        tempId,
        author: 'Markdown Author',
        title:  'Markdown Book',
        seriesPosition: null,
        isStandalone: true,
      });
    expect(confirmRes.status).toBe(201);
    const bookDir = confirmRes.body.paths.bookDir;
    const manuscriptPath = join(bookDir, 'manuscript.md');

    expect(existsSync(manuscriptPath)).toBe(true);
    const written = readFileSync(manuscriptPath, 'utf8');
    /* The on-disk file is the original markdown. parseText would have
       stripped the `# A Real Title` and `## Chapter N` headings out of
       sourceText — we MUST not write that lossy form. */
    expect(written).toBe(md);
    expect(written).toContain('# A Real Title');
    expect(written).toContain('## Chapter One');
  });
});
