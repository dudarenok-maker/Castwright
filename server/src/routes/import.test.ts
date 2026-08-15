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
import { detectManuscriptLanguage } from '../tts/detect-language.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_EPUB = resolve(__dirname, '..', 'parsers', '__fixtures__', 'sample.epub');
/* The repo's canonical Russian chapter (CLAUDE.md "Canonical end-to-end
   manuscript"). Ad-hoc Russian prose is NOT usable here: the detector has a
   text floor and answers 'en' for a handful of sentences, which would make an
   omitted-language test pass for the wrong reason. */
const FIXTURE_RU_MD = resolve(__dirname, '..', '__fixtures__', 'the-coalfall-commission.ru.md');
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

  /* #2246 Task 3 — a confident detection still fills an omitted language; a
     surrender must NOT be stamped 'en'. This body is REAL English (the /import
     candidate reports languageFallback:false through the exact parse→detect
     pipeline), so omitting the language keeps the detected 'en'. It is the
     control the #2246 null test below needs: it proves the confident path is
     unchanged, so that test cannot pass by nulling everything. (The old
     single-sentence fixture silently surrendered — passing pre-Task-3 only
     because the fallback default masked it — so it proved nothing.) */
  it("keeps 'en' for an ENGLISH book whose confirm body omits the language", async () => {
    const md = `# English Book

## Chapter One

The train arrived at the small station as the morning light broke across the hills. Alice stepped down onto the platform and looked around for her brother. He had promised to meet her here at dawn, but she saw no one in the crowd of tired travellers. A porter pointed at the wooden bench where a man sat reading a newspaper. She walked closer and realized that the man was not her brother at all. He looked up and smiled at her uncertainty. He folded his paper and rose to greet her. They had never met before, yet his face seemed strangely familiar. He told her his name was Martin, and he seemed to know her name already. He explained that he had been waiting for her for three whole days. This confused her far more than she wished to admit. She had no memory of ever writing to a man named Martin. Her brother had only ever mentioned a cousin who lived in the city. She wondered whether this stranger was connected to the letter she received last week. That letter had been unsigned and strangely urgent. It asked her to travel alone without telling anyone where she was going. She had packed a single bag and left her house long before dawn. Now she stood before a man who claimed to know her. The station clock struck six, and the silence between them grew. Martin reached into his coat and produced a yellowed photograph. The image showed a young couple standing in front of an old church. Alice recognized the woman in the picture as her own mother. A cold chill ran through her as the pieces began to fit together. The photograph was dated twenty years before she herself was born.`;

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

  /* #2306 — the defect that cost a 20-hour run. /import detects the language
     from the chapter bodies and returns it, but POST /books used to read ONLY
     body.language and default to English, dropping that detection on the floor.
     A caller that didn't echo the field back got an English book while the
     server held 'ru' in memory from seconds earlier — so there was no language
     preamble, stage 1 romanised every name, and stage 2 read dash-marked
     dialogue as narration (95.7% narrator across 15,100 sentences). */
  it('uses the DETECTED language when the confirm body omits it (#2306)', async () => {
    const md = readFileSync(FIXTURE_RU_MD, 'utf8');
    const importRes = await request(app)
      .post('/api/import')
      .send({ text: md, fileName: 'nochnoy-dozor.md' });
    // If the detection itself were wrong the fallback would prove nothing.
    expect(importRes.body.candidate.language).toBe('ru');

    const confirmRes = await request(app).post('/api/books').send({
      tempId: importRes.body.tempId,
      author: 'Sergei L',
      title: 'Nochnoy Dozor',
      seriesPosition: null,
      isStandalone: true,
      // language deliberately omitted — that is the whole case
    });
    expect(confirmRes.status).toBe(201);
    const stateJson = JSON.parse(
      readFileSync(join(confirmRes.body.paths.dotAudiobook, 'state.json'), 'utf8'),
    );
    expect(stateJson.language).toBe('ru');
  });

  /* #2246 Task 3 (R1) — a surrender is not a decision. When the confirm body
     omits `language` and detection surrendered (languageFallback:true), the
     write must NOT persist the confidence-floor 'en' guess: it writes `null`
     (stated absence, key present) so the book stays unset for the ambiguity
     prompt. This is the "still owed" behaviour #2337 deliberately did not
     deliver. */
  it('writes language: null when the confirm body omits it and detection surrendered (#2246)', async () => {
    const md = '# Terse\n\n## Chapter One\n\nToo short to corroborate itself.';
    const importRes = await request(app).post('/api/import').send({ text: md, fileName: 'terse.md' });
    // Fixture sanity: this text must genuinely surrender, or the test proves nothing.
    expect(importRes.body.candidate.languageFallback).toBe(true);
    const confirmRes = await request(app).post('/api/books').send({
      tempId: importRes.body.tempId,
      author: 'Terse Author',
      title: 'Terse Book',
      seriesPosition: null,
      isStandalone: true,
      // language deliberately omitted — detection surrendered, so no guess
    });
    expect(confirmRes.status).toBe(201);
    const stateJson = JSON.parse(
      readFileSync(join(confirmRes.body.paths.dotAudiobook, 'state.json'), 'utf8'),
    );
    expect('language' in stateJson).toBe(true);
    expect(stateJson.language).toBeNull();
  });

  /* #2337 review F1 — "no choice" is a CLASS, not one spelling. Testing only
     `=== undefined` left `{"language": ""}` (an unfilled form field, or
     `detected ?? ''`) persisting English over a Russian detection: the same
     defect under a different spelling. normaliseBookLanguage maps missing,
     empty AND whitespace to 'en', so each is a way of saying nothing. */
  it.each([
    ['empty string', ''],
    ['whitespace', '   '],
    ['null', null],
  ])('treats %s as no choice and uses the detection', async (label, value) => {
    const md = readFileSync(FIXTURE_RU_MD, 'utf8');
    const importRes = await request(app)
      .post('/api/import')
      .send({ text: md, fileName: 'blank-language.md' });
    expect(importRes.body.candidate.language).toBe('ru');

    const confirmRes = await request(app)
      .post('/api/books')
      .send({
        tempId: importRes.body.tempId,
        author: 'Sergei L',
        // #2337 review N6 — `JSON.stringify(value)` slugged '' and '   ' to the
        // same "blank-language" title, minting one bookId for two of the three
        // cases. `label` (the it.each description) is already distinct per case.
        title: `Blank Language (${label})`,
        seriesPosition: null,
        isStandalone: true,
        language: value,
      });
    expect(confirmRes.status).toBe(201);
    const stateJson = JSON.parse(
      readFileSync(join(confirmRes.body.paths.dotAudiobook, 'state.json'), 'utf8'),
    );
    expect(stateJson.language).toBe('ru');
  });

  it('lets an EXPLICIT language override the detection', async () => {
    /* The confirm screen is user-overridable, so an explicit value must still
       win outright — including an explicit 'en' over a Russian detection. */
    const md = readFileSync(FIXTURE_RU_MD, 'utf8');
    const importRes = await request(app)
      .post('/api/import')
      .send({ text: md, fileName: 'override.md' });
    expect(importRes.body.candidate.language).toBe('ru');

    const confirmRes = await request(app).post('/api/books').send({
      tempId: importRes.body.tempId,
      author: 'Someone',
      title: 'Override Test',
      seriesPosition: null,
      isStandalone: true,
      language: 'en',
    });
    expect(confirmRes.status).toBe(201);
    const stateJson = JSON.parse(
      readFileSync(join(confirmRes.body.paths.dotAudiobook, 'state.json'), 'utf8'),
    );
    expect(stateJson.language).toBe('en');
  });
});

/* Issue #1955 — the confirm route is the sole writer of state.language, and
   it persisted whatever primary subtag `normaliseBookLanguage` produced with
   no check that the language is one the app actually supports (the registry
   has exactly seven entries). A direct API call (bypassing the UI-only
   confirm-screen dropdown) could persist e.g. 'pt' onto a book, which would
   only surface later as an opaque chapter_failed at render time
   (sidecarLanguageName's throw in generation.ts). This gate rejects the
   request at the import boundary instead, and persists nothing. */
describe('POST /api/books — unsupported language rejected at the import boundary (#1955)', () => {
  it('returns 400 naming the supported languages for an unsupported code, and persists nothing', async () => {
    const md = '# A Book\n\n## Chapter One\n\nSome opening prose for the parser to chew on.';
    const importRes = await request(app)
      .post('/api/import')
      .send({ text: md, fileName: 'unsupported-lang.md' });
    expect(importRes.status).toBe(200);

    const confirmRes = await request(app).post('/api/books').send({
      tempId: importRes.body.tempId,
      author: 'Unsupported Lang Author',
      title: 'Unsupported Lang Book',
      seriesPosition: null,
      isStandalone: true,
      language: 'pt',
    });

    expect(confirmRes.status).toBe(400);
    expect(confirmRes.body.error).toBe('unsupported_language');
    /* Actionable: names the supported set so the caller can self-correct. */
    expect(confirmRes.body.message).toContain('pt');
    expect(confirmRes.body.supportedLanguages).toEqual([
      { code: 'en', label: 'English' },
      { code: 'ru', label: 'Russian' },
      { code: 'es', label: 'Spanish' },
      { code: 'fr', label: 'French' },
      { code: 'de', label: 'German' },
      { code: 'zh', label: 'Chinese' },
      { code: 'ja', label: 'Japanese' },
    ]);

    /* Nothing persisted: no book directory written to the workspace, and
       the staging entry survives so a corrected retry can still consume it
       (a 410 on retry would mean the reject path already burned the entry —
       a second, quieter way to get "persists nothing" wrong). */
    const bookDir = join(
      workspaceRoot,
      'books',
      'Unsupported Lang Author',
      'Standalones',
      'Unsupported Lang Book',
    );
    expect(existsSync(bookDir)).toBe(false);

    const retryRes = await request(app).post('/api/books').send({
      tempId: importRes.body.tempId,
      author: 'Unsupported Lang Author',
      title: 'Unsupported Lang Book',
      seriesPosition: null,
      isStandalone: true,
      language: 'en',
    });
    expect(retryRes.status).toBe(201);
  });

  it('imports a supported language (fr) unchanged', async () => {
    const md = '# Un Livre\n\n## Chapitre Un\n\nUne ouverture pour le test.';
    const importRes = await request(app)
      .post('/api/import')
      .send({ text: md, fileName: 'french.md' });
    const confirmRes = await request(app).post('/api/books').send({
      tempId: importRes.body.tempId,
      author: 'French Author',
      title: 'French Book',
      seriesPosition: null,
      isStandalone: true,
      language: 'fr',
    });
    expect(confirmRes.status).toBe(201);
    const stateJson = JSON.parse(
      readFileSync(join(confirmRes.body.paths.dotAudiobook, 'state.json'), 'utf8'),
    );
    expect(stateJson.language).toBe('fr');
  });
});

/* #2337 review C2 — a non-string `language` used to reach `normaliseBookLanguage`
   (which calls `bcp47.trim()`) unguarded. `languageChosen` only special-cased
   `typeof body.language === 'string'`; any other non-null value (a number,
   boolean, array, object) fell through to `body.language != null`, which is
   true, so the route called `normaliseBookLanguage(42)` → `(42).trim is not a
   function` → an uncaught TypeError → HTTP 500 with the raw internal message
   on a client-facing body. The only defensible answer for a caller that sent
   a non-string, non-null `language` is the same 400 `unsupported_language`
   an unsupported STRING gets — never a 500. */
describe('POST /api/books — a non-string `language` is rejected with 400, never a 500 (#2337 review C2)', () => {
  it.each([
    ['a number', 42],
    ['a boolean', true],
    ['an array', []],
    ['an object', {}],
  ])('rejects %s with 400 unsupported_language, not a 500', async (_label, value) => {
    const md = '# A Book\n\n## Chapter One\n\nSome opening prose for the parser to chew on.';
    const importRes = await request(app)
      .post('/api/import')
      .send({ text: md, fileName: 'nonstring-language.md' });

    const confirmRes = await request(app)
      .post('/api/books')
      .send({
        tempId: importRes.body.tempId,
        author: 'Nonstring Lang Author',
        title: `Nonstring Language ${_label}`,
        seriesPosition: null,
        isStandalone: true,
        language: value,
      });

    expect(confirmRes.status).toBe(400);
    expect(confirmRes.body.error).toBe('unsupported_language');
    // Never the raw TypeError message a non-string reaching normaliseBookLanguage
    // used to produce.
    expect(confirmRes.body.error).not.toMatch(/trim is not a function/);
    expect(confirmRes.body.message).not.toMatch(/trim is not a function/);
  });
});

/* #2337 review N2 (round 3) — C2 guarded ONLY `language` against a
   non-string value. Three sibling fields on the same handler share the
   identical shape: `(body.author ?? '').trim()`, `(body.title ?? '').trim()`,
   and (when `!isStandalone`) `(body.series ?? '').trim()` all call `.trim()`
   on whatever a non-string, non-null value slides past the `?? ''`. A
   number/boolean/array/object reaches `.trim()` unguarded, throws a raw
   TypeError, and the handler's generic `catch` at the bottom surfaces it as
   an HTTP 500 carrying the internal message
   ("(body.author ?? \"\").trim is not a function") on a client-facing body —
   the same defect class C2 fixed for `language`, left open for its three
   siblings. */
describe('POST /api/books — a non-string author/title/series is rejected with 400, never a 500 (#2337 review N2)', () => {
  const nonStringValues: [string, unknown][] = [
    ['a number', 42],
    ['a boolean', true],
    ['an array', []],
    ['an object', {}],
  ];

  it.each(nonStringValues)(
    'rejects a non-string author (%s) with 400 naming the field, not a 500',
    async (_label, value) => {
      const md = '# A Book\n\n## Chapter One\n\nSome opening prose for the parser to chew on.';
      const importRes = await request(app)
        .post('/api/import')
        .send({ text: md, fileName: 'nonstring-author.md' });

      const confirmRes = await request(app).post('/api/books').send({
        tempId: importRes.body.tempId,
        author: value,
        title: 'Fallback Title',
        seriesPosition: null,
        isStandalone: true,
      });

      expect(confirmRes.status).toBe(400);
      expect(confirmRes.body.error).toMatch(/author/i);
      expect(confirmRes.body.error).not.toMatch(/trim is not a function/);
    },
  );

  it.each(nonStringValues)(
    'rejects a non-string title (%s) with 400 naming the field, not a 500',
    async (_label, value) => {
      const md = '# A Book\n\n## Chapter One\n\nSome opening prose for the parser to chew on.';
      const importRes = await request(app)
        .post('/api/import')
        .send({ text: md, fileName: 'nonstring-title.md' });

      const confirmRes = await request(app).post('/api/books').send({
        tempId: importRes.body.tempId,
        author: 'Fallback Author',
        title: value,
        seriesPosition: null,
        isStandalone: true,
      });

      expect(confirmRes.status).toBe(400);
      expect(confirmRes.body.error).toMatch(/title/i);
      expect(confirmRes.body.error).not.toMatch(/trim is not a function/);
    },
  );

  it.each(nonStringValues)(
    'rejects a non-string series (%s) with 400 naming the field, not a 500',
    async (_label, value) => {
      const md = '# A Book\n\n## Chapter One\n\nSome opening prose for the parser to chew on.';
      const importRes = await request(app)
        .post('/api/import')
        .send({ text: md, fileName: 'nonstring-series.md' });

      const confirmRes = await request(app).post('/api/books').send({
        tempId: importRes.body.tempId,
        author: 'Fallback Author',
        title: 'Fallback Title',
        seriesPosition: null,
        isStandalone: false,
        series: value,
      });

      expect(confirmRes.status).toBe(400);
      expect(confirmRes.body.error).toMatch(/series/i);
      expect(confirmRes.body.error).not.toMatch(/trim is not a function/);
    },
  );
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
    const sentence =
      'El horno se había enfriado hasta el color de un atardecer cubierto de ceniza, y Wren raspaba la última escoria cuando alguien llamó a la puerta de su taller.';
    // #2263 — POST /api/import now detects per BODY CHAPTER (detectManuscriptLanguageFromChapters),
    // and a single-chapter manuscript (no chapter markers here, so the whole
    // text is one chapter) goes through the same PROSE_UNIT_FLOOR the
    // repair script uses — it can't corroborate itself, so it needs enough
    // sentence-terminal-punctuated units to be trusted. One sentence isn't
    // enough on its own; repeated well past the floor, still Spanish.
    const es = Array(25).fill(sentence).join(' ');
    const res = await request(app).post('/api/import').send({ text: es }).expect(200);
    expect(res.body.candidate.language).toBe('es');
    expect(res.body.candidate.languageSupported).toBe(true);
    // #2276 — a genuine decision, not a surrender guess.
    expect(res.body.candidate.languageFallback).toBe(false);
    expect(res.body.candidate.supportedLanguages).toEqual([
      { code: 'en', label: 'English' },
      { code: 'ru', label: 'Russian' },
      { code: 'es', label: 'Spanish' },
      { code: 'fr', label: 'French' },
      { code: 'de', label: 'German' },
      { code: 'zh', label: 'Chinese' },
      { code: 'ja', label: 'Japanese' },
    ]);
  });

  it('#2263 — resolves to the BODY language when the first chapter is a different (mis-detected) language, proving the call site passes chapters, not sourceText', async () => {
    // A real regression repro, not just a shape: `detectManuscriptLanguage`
    // on the WHOLE document (the pre-#2263 call) genuinely returns 'en' here
    // — the English front-matter chapter is long enough that it, not the
    // Chinese body, sets the CJK/Latin ratio for the flat 20k-char sample.
    // The per-chapter vote isn't fooled: the front-matter chapter votes
    // 'en' on its own, but the two real Chinese chapters vote 'zh' and win
    // the majority (2 of 3). This is the 煤落的委托 defect shape generalised
    // past a single tiny front-matter snippet — a longer English foreword
    // is exactly the case the live issue warned wouldn't be "so lucky".
    const enSentence =
      'Marcel Beaumont and Geneviève Dubois walked along the Champs-Élysées toward the Café de Flore, where Henri Toussaint waited beneath the awning with the morning papers.';
    const zhSentence = '熔炉已经冷却到被灰烬覆盖的落日的颜色，当有人敲响她作坊的门时，雷恩正在刮掉最后的炉渣。';
    const frontMatterEn = Array(15).fill(enSentence).join(' ');
    const zhBody = Array(10).fill(zhSentence).join('');
    const text = [
      '# 煤落的委托',
      '',
      '## Chapter 1',
      '',
      frontMatterEn,
      '',
      '## 第一章',
      '',
      zhBody,
      '',
      '## 第二章',
      '',
      zhBody,
    ].join('\n');

    // Fixture sanity: prove the OLD whole-blob call site would genuinely get
    // this wrong (not just theoretically) before asserting the NEW behaviour.
    // `language` is still the wrong 'en' — that is the defect this whole test
    // pins, and franc's restricted (Latin-only) call still lands there. But
    // since #2337 review C1, `fallback` is no longer a confident `false`
    // here either: an UNRESTRICTED franc call over this same mixed English/
    // Chinese sample lands outside the registry's Latin set too (measured:
    // 'sco', not 'eng'), which is exactly the coercion signal C1 added — so
    // the whole-blob call is honest about not being sure, even though it is
    // still the wrong answer. That is why the per-chapter vote below remains
    // necessary regardless of C1: a flagged guess is still not the right
    // language.
    const wholeBlob = detectManuscriptLanguage(text);
    expect(wholeBlob).toEqual({ language: 'en', supported: true, fallback: true });

    const res = await request(app).post('/api/import').send({ text }).expect(200);
    expect(res.body.candidate.language).toBe('zh');
    expect(res.body.candidate.chapters.length).toBe(3);
  });

  it('#2276 — stamps languageFallback:true on the candidate when detection surrenders (a guess, not a decision)', async () => {
    // Too little text to clear PROSE_UNIT_FLOOR — detectManuscriptLanguageFromChapters
    // surrenders (language:'en', fallback:true). languageSupported alone
    // can't distinguish this from a genuine English decision (both are
    // supported:true) — languageFallback is the field that can, and it must
    // actually reach the wire for the confirm screen to tell a guess from a
    // decision.
    const res = await request(app).post('/api/import').send({ text: 'Too short to corroborate itself.' }).expect(200);
    expect(res.body.candidate.language).toBe('en');
    expect(res.body.candidate.languageFallback).toBe(true);
  });
});

/* fs-59 W2 task 2.7 — CJK-aware word count so a spaceless CJK chapter isn't
   pre-ticked for front-matter exclusion (countWords splits on \s+, which
   yields ~1 "word" per CJK paragraph). */
describe('POST /api/import — CJK-aware word count (fs-59 W2)', () => {
  it('does not flag a spaceless ~2000-char CJK chapter as front matter and reports a plausible (hundreds, not ~40) word count', async () => {
    const sentence = '这是一个用来测试字数统计功能是否正确无误的句子';
    const body = sentence.repeat(Math.ceil(2000 / sentence.length));
    const text = ['第一章', '', body].join('\n');
    const res = await request(app).post('/api/import').send({ text }).expect(200);
    const ch1 = res.body.candidate.chapters.find((c: any) => c.title === '第一章');
    expect(ch1).toBeTruthy();
    expect(ch1.isLikelyFrontMatter).toBe(false);
    expect(ch1.wordCount).toBeGreaterThan(300);
    expect(ch1.wordCount).toBeLessThan(2000);
  });

  it('still flags a short CJK chapter (word-equivalent count <= 150) as front matter, threshold unaffected', async () => {
    const sentence = '这是一个用来测试字数统计功能是否正确无误的句子';
    const longBody = sentence.repeat(Math.ceil(2000 / sentence.length));
    const text = ['序章', '', '这是一段很短的引子。', '', '第一章', '', longBody].join('\n');
    const res = await request(app).post('/api/import').send({ text }).expect(200);
    const prologue = res.body.candidate.chapters.find((c: any) => c.title === '序章');
    const ch1 = res.body.candidate.chapters.find((c: any) => c.title === '第一章');
    expect(prologue).toBeTruthy();
    expect(ch1).toBeTruthy();
    expect(prologue.isLikelyFrontMatter).toBe(true);
    expect(ch1.isLikelyFrontMatter).toBe(false);
  });

  it('keeps the Latin whitespace-token path byte-identical for non-CJK text', async () => {
    const text = ['Chapter One', '', 'word '.repeat(400)].join('\n');
    const res = await request(app).post('/api/import').send({ text }).expect(200);
    const ch1 = res.body.candidate.chapters.find((c: any) => c.title === 'Chapter One');
    expect(ch1).toBeTruthy();
    expect(ch1.wordCount).toBe(400);
  });

  it('does not double-count mixed Latin + CJK text', async () => {
    /* "hello world" (2 Latin whitespace-tokens) + "你好世界" (4 Han chars,
       no separating whitespace from the CJK char-equivalent count) —
       2 + round(4 / 1.7) = 2 + 2 = 4. A naive implementation that counts
       the CJK run as a Latin whitespace-token (1) AND separately as a
       char-equivalent (2) would over-count to 5. */
    const text = ['第一章', '', 'hello world 你好世界'].join('\n');
    const res = await request(app).post('/api/import').send({ text }).expect(200);
    const ch1 = res.body.candidate.chapters.find((c: any) => c.title === '第一章');
    expect(ch1).toBeTruthy();
    expect(ch1.wordCount).toBe(4);
  });
});
