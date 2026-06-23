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
const FIXTURE_EPUB_NO_CALIBRE = resolve(
  __dirname,
  '..',
  'parsers',
  '__fixtures__',
  'sample-title-no-calibre.epub',
);

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

    const confirmRes = await request(app).post('/api/books').send({
      tempId,
      author: 'Verbatim Author',
      title: 'Verbatim Book',
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

    const confirmRes = await request(app).post('/api/books').send({
      tempId,
      author: 'Markdown Author',
      title: 'Markdown Book',
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

describe('POST /api/import → POST /api/books — excluded chapters round-trip', () => {
  it('exposes per-chapter wordCount on the import candidate', async () => {
    const md = [
      '# A Tiny Book',
      '',
      '## Dedication',
      '',
      'For my readers.',
      '',
      '## Chapter One',
      '',
      'A long opening that goes on for at least several sentences so the parser registers it as a substantive chapter. The narrator strolls into the room and sets the scene. The reader settles in.',
      '',
      '## About the Author',
      '',
      'Brief bio.',
    ].join('\n');

    const importRes = await request(app)
      .post('/api/import')
      .send({ text: md, fileName: 'tiny.md' });
    expect(importRes.status).toBe(200);
    const chapters = importRes.body.candidate.chapters;
    expect(chapters).toBeInstanceOf(Array);
    /* Every chapter must carry wordCount so the frontend heuristic can
       run. Short matter (Dedication / About the Author) reads in single
       digits; the real chapter is materially longer. */
    for (const c of chapters) {
      expect(typeof c.wordCount).toBe('number');
      expect(c.wordCount).toBeGreaterThanOrEqual(0);
    }
    const dedication = chapters.find((c: { title: string }) => /dedication/i.test(c.title));
    const real = chapters.find((c: { title: string }) => /chapter\s*one/i.test(c.title));
    expect(dedication).toBeTruthy();
    expect(real).toBeTruthy();
    expect(real.wordCount).toBeGreaterThan(dedication.wordCount);
  });

  it('seeds state.json chapters with excluded=true for the slugs the client sent', async () => {
    const md = [
      '# Round Trip Book',
      '',
      '## Dedication',
      '',
      'For everyone.',
      '',
      '## Chapter One',
      '',
      'The real story starts here with several sentences of narrative content so the parser is happy.',
      '',
      '## About the Author',
      '',
      'A short bio.',
    ].join('\n');

    const importRes = await request(app)
      .post('/api/import')
      .send({ text: md, fileName: 'roundtrip.md' });
    const tempId = importRes.body.tempId;
    const chapters = importRes.body.candidate.chapters as Array<{ id: number; title: string }>;

    /* Derive the slugs the same way the server does — id-padded + title slug. */
    function slugify(title: string): string {
      return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    }
    const dedicationSlug = (() => {
      const c = chapters.find((c) => /dedication/i.test(c.title))!;
      return `${String(c.id).padStart(2, '0')}-${slugify(c.title)}`;
    })();
    const aboutSlug = (() => {
      const c = chapters.find((c) => /about/i.test(c.title))!;
      return `${String(c.id).padStart(2, '0')}-${slugify(c.title)}`;
    })();

    const confirmRes = await request(app)
      .post('/api/books')
      .send({
        tempId,
        author: 'Roundtrip Author',
        title: 'Roundtrip Book',
        seriesPosition: null,
        isStandalone: true,
        excludedSlugs: [dedicationSlug, aboutSlug],
      });
    expect(confirmRes.status).toBe(201);
    const stateJson = JSON.parse(
      readFileSync(join(confirmRes.body.paths.dotAudiobook, 'state.json'), 'utf8'),
    );

    /* state.json must have excluded=true on the two we flagged and not
       set on the real chapter. */
    const stateByTitle = new Map<string, { excluded?: boolean }>();
    for (const c of stateJson.chapters as Array<{ title: string; excluded?: boolean }>) {
      stateByTitle.set(c.title.toLowerCase(), c);
    }
    expect(stateByTitle.get('dedication')?.excluded).toBe(true);
    expect(stateByTitle.get('about the author')?.excluded).toBe(true);
    expect(stateByTitle.get('chapter one')?.excluded).toBeFalsy();
  });

  it('returns 415 with error: "drm_protected" when a MOBI file has the encryption byte set', async () => {
    /* Hand-crafted MOBI-shaped buffer with encryption byte 2 (Kindle
       Store DRM). The DRM detector in parseMobi reads bytes 78..82 for
       the record-0 offset and then the u16 at offset+0x0C; we set those
       directly and pad the rest with zeros. The library is NEVER
       invoked on this path — readMobiEncryptionType returns non-zero
       and parseMobi throws DrmProtectedError before init*File is
       called. Pairs with the unit tests in mobi.test.ts that pin the
       detection bytes. */
    const drmBuffer = Buffer.alloc(256, 0);
    const record0 = 96;
    drmBuffer.writeUInt32BE(record0, 78);
    drmBuffer.writeUInt16BE(2, record0 + 0x0c);

    const importRes = await request(app)
      .post('/api/import')
      .attach('file', drmBuffer, {
        filename: 'drm-protected.mobi',
        contentType: 'application/x-mobipocket-ebook',
      });
    expect(importRes.status).toBe(415);
    expect(importRes.body.error).toBe('drm_protected');
    expect(importRes.body.message).toMatch(/DRM-protected/i);
  });

  it('leaves every chapter included when excludedSlugs is absent', async () => {
    const md = '# A Book\n\n## Chapter One\n\nLine one. Line two. Line three.';
    const importRes = await request(app)
      .post('/api/import')
      .send({ text: md, fileName: 'no-exclusions.md' });
    const confirmRes = await request(app).post('/api/books').send({
      tempId: importRes.body.tempId,
      author: 'No Excl Author',
      title: 'No Excl Book',
      seriesPosition: null,
      isStandalone: true,
    });
    expect(confirmRes.status).toBe(201);
    const stateJson = JSON.parse(
      readFileSync(join(confirmRes.body.paths.dotAudiobook, 'state.json'), 'utf8'),
    );
    for (const c of stateJson.chapters as Array<{ excluded?: boolean }>) {
      expect(c.excluded).toBeFalsy();
    }
  });

  it('auto-excludes front/back-matter at import even with no excludedSlugs (plan 148)', async () => {
    /* The the Hollow Tide stall: EPUB back-matter (Acknowledgments / Contents / a
       next-book teaser) was queued because nothing flagged it. Layer A now
       applies the front/back-matter heuristic at import, so these default to
       excluded WITHOUT the client sending excludedSlugs. Story chapters stay
       included. */
    const md = [
      '# Plan 148 Book',
      '',
      '## Chapter One',
      '',
      'The real story opens here with several sentences of narrative content so the parser is happy. The narrator sets the scene and the reader settles in.',
      '',
      '## Acknowledgments',
      '',
      'Thanks to everyone who helped along the way, written out with enough words that this parses as its own chapter.',
    ].join('\n');

    const importRes = await request(app)
      .post('/api/import')
      .send({ text: md, fileName: 'p148.md' });
    const confirmRes = await request(app).post('/api/books').send({
      tempId: importRes.body.tempId,
      author: 'P148 Author',
      title: 'Plan 148 Book',
      seriesPosition: null,
      isStandalone: true,
      // deliberately NO excludedSlugs — exclusion must come from the parser default
    });
    expect(confirmRes.status).toBe(201);
    const stateJson = JSON.parse(
      readFileSync(join(confirmRes.body.paths.dotAudiobook, 'state.json'), 'utf8'),
    );
    const byTitle = new Map<string, { excluded?: boolean }>();
    for (const c of stateJson.chapters as Array<{ title: string; excluded?: boolean }>) {
      byTitle.set(c.title.toLowerCase(), c);
    }
    expect(byTitle.get('acknowledgments')?.excluded).toBe(true);
    expect(byTitle.get('chapter one')?.excluded).toBeFalsy();
  });
});

/* fs-2 — the confirm POST persists the chosen BCP-47 language onto
   state.json (default 'en'), so the never-cross-language routing has a
   durable per-book source. */
describe('POST /api/books — fs-2 language persistence', () => {
  it("persists the confirmed language ('ru') to state.json", async () => {
    const md = '# Russian Book\n\n## Глава Один\n\nЭто начало истории на русском языке.';
    const importRes = await request(app)
      .post('/api/import')
      .send({ text: md, fileName: 'russian.md' });
    const confirmRes = await request(app).post('/api/books').send({
      tempId: importRes.body.tempId,
      author: 'Russian Author',
      title: 'Russian Book',
      seriesPosition: null,
      isStandalone: true,
      language: 'ru',
    });
    expect(confirmRes.status).toBe(201);
    const stateJson = JSON.parse(
      readFileSync(join(confirmRes.body.paths.dotAudiobook, 'state.json'), 'utf8'),
    );
    expect(stateJson.language).toBe('ru');
  });

  it("defaults language to 'en' when the confirm body omits it", async () => {
    const md = '# English Book\n\n## Chapter One\n\nThe story opens here with several sentences.';
    const importRes = await request(app)
      .post('/api/import')
      .send({ text: md, fileName: 'english.md' });
    const confirmRes = await request(app).post('/api/books').send({
      tempId: importRes.body.tempId,
      author: 'English Author',
      title: 'English Book',
      seriesPosition: null,
      isStandalone: true,
    });
    expect(confirmRes.status).toBe(201);
    const stateJson = JSON.parse(
      readFileSync(join(confirmRes.body.paths.dotAudiobook, 'state.json'), 'utf8'),
    );
    expect(stateJson.language).toBe('en');
  });
});

/* Plan 105 — multer 2.x guard. The import route mounts
   `upload.single('file')` with no bespoke MulterError branch, so an
   upload riding an unexpected field name raises a MulterError
   (LIMIT_UNEXPECTED_FILE) that propagates to Express's error chain
   rather than being parsed as a manuscript. This pins that multer 2.x
   still rejects the wrong-field upload (it never reaches the route
   handler as a valid `req.file`). */
describe('POST /api/import — multer 2.x unexpected-field rejection', () => {
  it('does not 200 a file uploaded under an unexpected field name', async () => {
    const res = await request(app)
      .post('/api/import')
      .attach('notTheFileField', Buffer.from('hello world'), {
        filename: 'x.txt',
        contentType: 'text/plain',
      });
    /* multer raises LIMIT_UNEXPECTED_FILE → the route never sees a valid
       req.file or req.body.text, so the request is rejected (Express's
       default error handler yields 500; the route's own no-file branch
       would yield 400). Either way it is NOT a 200 parse success. */
    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

/* Bug B: the staging response surfaces `seriesFromTitle` so the
   confirm-metadata view can render the "auto-extracted" chip. */
describe('POST /api/import — seriesFromTitle plumbing', () => {
  it('emits seriesFromTitle=true on the candidate for an EPUB whose dc:title carries the series', async () => {
    const epubBytes = await readFile(FIXTURE_EPUB_NO_CALIBRE);
    const res = await request(app).post('/api/import').attach('file', epubBytes, {
      filename: 'sample-title-no-calibre.epub',
      contentType: 'application/epub+zip',
    });
    expect(res.status).toBe(200);
    expect(res.body.candidate.title).toBe('The Tidewatcher’s Oath');
    expect(res.body.candidate.series).toBe('The Hollow Tide');
    expect(res.body.candidate.seriesPosition).toBe(3);
    expect(res.body.candidate.seriesFromTitle).toBe(true);
  });

  it('emits seriesFromTitle=false on the candidate when Calibre meta is authoritative', async () => {
    const epubBytes = await readFile(FIXTURE_EPUB);
    const res = await request(app)
      .post('/api/import')
      .attach('file', epubBytes, { filename: 'sample.epub', contentType: 'application/epub+zip' });
    expect(res.status).toBe(200);
    expect(res.body.candidate.series).toBe('Solway Bay');
    expect(res.body.candidate.seriesFromTitle).toBe(false);
  });
});

/* fs-41/fs-50 seam 3b — per-chapter isLikelyFrontMatter flag on the import candidate. */
describe('POST /api/import — per-chapter isLikelyFrontMatter flag (seam 3b)', () => {
  it('marks a non-English front-matter chapter via the per-chapter flag', async () => {
    /* Uses markdown headings so the parser assigns the expected chapter titles.
       "Derechos de autor" is a Spanish frontMatterKeyword in the language registry,
       detected by isLikelyFrontMatterTitle (seam 3b). */
    const text =
      '# Mi Libro\n\n## Derechos de autor\n\n© 2026.\n\n## Capítulo 1\n\n' +
      'palabra '.repeat(400);
    const res = await request(app).post('/api/import').send({ text }).expect(200);
    const fm = res.body.candidate.chapters.find((c: any) => /Derechos de autor/.test(c.title));
    const ch1 = res.body.candidate.chapters.find((c: any) => /Capítulo 1/.test(c.title));
    expect(fm).toBeTruthy();
    expect(ch1).toBeTruthy();
    expect(fm.isLikelyFrontMatter).toBe(true);
    expect(ch1.isLikelyFrontMatter).toBe(false);
  });

  it('marks a short chapter (wordCount ≤ 150) as isLikelyFrontMatter=true regardless of title', async () => {
    const text = '# My Book\n\n## A Strange Page\n\nShort body.\n\n## Chapter One\n\n' + 'word '.repeat(400);
    const res = await request(app).post('/api/import').send({ text }).expect(200);
    const short = res.body.candidate.chapters.find((c: any) => /A Strange Page/.test(c.title));
    const long = res.body.candidate.chapters.find((c: any) => /Chapter One/.test(c.title));
    expect(short).toBeTruthy();
    expect(long).toBeTruthy();
    expect(short.isLikelyFrontMatter).toBe(true);
    expect(long.isLikelyFrontMatter).toBe(false);
  });

  it('marks an English front-matter chapter (Dedication) as isLikelyFrontMatter=true', async () => {
    const text =
      '# My Book\n\n## Dedication\n\n' + 'word '.repeat(400) +
      '\n\n## Chapter One\n\n' + 'word '.repeat(400);
    const res = await request(app).post('/api/import').send({ text }).expect(200);
    const ded = res.body.candidate.chapters.find((c: any) => /Dedication/.test(c.title));
    const ch1 = res.body.candidate.chapters.find((c: any) => /Chapter One/.test(c.title));
    expect(ded).toBeTruthy();
    expect(ch1).toBeTruthy();
    expect(ded.isLikelyFrontMatter).toBe(true);
    expect(ch1.isLikelyFrontMatter).toBe(false);
  });
});

/* fs-41/fs-50 seam 2 — server-side language detection wired into POST /api/import. */
describe('POST /api/import — language detection (fs-41/fs-50)', () => {
  it('detects the manuscript language and stamps the supported-list on the candidate', async () => {
    const es =
      'El horno se había enfriado hasta el color de un atardecer cubierto de ceniza, y Wren raspaba la última escoria cuando alguien llamó a la puerta de su taller.';
    const res = await request(app).post('/api/import').send({ text: es }).expect(200);
    expect(res.body.candidate.language).toBe('es');
    expect(res.body.candidate.languageSupported).toBe(true);
    expect(res.body.candidate.supportedLanguages).toEqual([
      { code: 'en', label: 'English' },
      { code: 'ru', label: 'Russian' },
      { code: 'es', label: 'Spanish' },
    ]);
  });
});
