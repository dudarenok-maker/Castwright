/* Integration test for the book-state router's change-log slice.

   Asserts that:
     1. PUT /:bookId/state with slice='changeLog' writes
        .audiobook/change-log.json atomically.
     2. GET /:bookId/state surfaces those events at `body.changeLog`.
     3. The same PUT validates required fields and 400s when slice / patch
        are missing.

   Mirrors the chapter-audio.test.ts setup: tempdir workspace, deferred
   module imports so paths.ts picks up WORKSPACE_DIR, supertest against
   the real router. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE = 'Change Log Book';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-changelog-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ bookStateRouter }, { makeBookId }] = await Promise.all([
    import('./book-state.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
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
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter 1', slug: 'chapter-one' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');

  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('book-state router — changeLog slice', () => {
  it('GET returns changeLog: null when no log has been written yet', async () => {
    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    expect(res.body.changeLog).toBeNull();
  });

  it('PUT slice=changeLog writes .audiobook/change-log.json', async () => {
    const events = [
      { id: 1, at: '2026-05-13T15:00:00.000Z', ts: 'Just now', date: 'today',
        type: 'regenerate', title: 'Regenerated Chapter 1', note: 'Reason: voice tuning updated.',
        actor: 'you', chapterId: 1, revertible: true },
    ];
    const res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'changeLog', patch: { events } });
    expect(res.status).toBe(204);

    const onDisk = join(bookDir, '.audiobook', 'change-log.json');
    expect(existsSync(onDisk)).toBe(true);
    const parsed = JSON.parse(readFileSync(onDisk, 'utf8'));
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].title).toBe('Regenerated Chapter 1');
  });

  it('GET surfaces the persisted events at body.changeLog', async () => {
    /* Depends on the PUT in the previous case — the disk file is shared
       across the test cases inside this describe block, mirroring how the
       frontend persistence middleware writes then reloads. */
    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.changeLog)).toBe(true);
    expect(res.body.changeLog).toHaveLength(1);
    expect(res.body.changeLog[0].chapterId).toBe(1);
  });

  it('PUT 400s when slice or patch is missing', async () => {
    const res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'changeLog' });
    expect(res.status).toBe(400);
  });
});

describe('book-state router — state slice editable metadata', () => {
  it('PUT slice=state round-trips title/author/series/narratorCredit/genre/publicationDate', async () => {
    const patch = {
      title: 'Renamed Title',
      author: 'Different Author',
      series: 'Renamed Series',
      narratorCredit: 'New Narrator',
      genre: 'Sci-fi',
      publicationDate: '2026-12-25',
    };
    const put = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch });
    expect(put.status).toBe(204);

    const onDisk = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(onDisk.title).toBe('Renamed Title');
    expect(onDisk.author).toBe('Different Author');
    expect(onDisk.series).toBe('Renamed Series');
    expect(onDisk.narratorCredit).toBe('New Narrator');
    expect(onDisk.genre).toBe('Sci-fi');
    expect(onDisk.publicationDate).toBe('2026-12-25');
    /* Should NOT have mutated identity / paths. */
    expect(onDisk.bookId).toBe(bookId);
    expect(onDisk.manuscriptId).toBe('m_test');
    expect(onDisk.manuscriptFile).toBe('manuscript.txt');
  });

  it('PUT slice=state preserves prior values when patch fields are absent', async () => {
    /* Touch only narratorCredit; the title from the previous test should stick. */
    const put = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { narratorCredit: 'Yet Another' } });
    expect(put.status).toBe(204);
    const onDisk = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(onDisk.title).toBe('Renamed Title');
    expect(onDisk.narratorCredit).toBe('Yet Another');
  });

  it('PUT slice=state stores explicit null for cleared optional fields', async () => {
    const put = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { genre: null, publicationDate: null } });
    expect(put.status).toBe(204);
    const onDisk = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(onDisk.genre).toBeNull();
    expect(onDisk.publicationDate).toBeNull();
  });

  it('PUT slice=state ignores attempts to overwrite bookId/manuscriptId', async () => {
    const put = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { bookId: 'hacked', manuscriptId: 'hacked' } });
    expect(put.status).toBe(204);
    const onDisk = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(onDisk.bookId).toBe(bookId);
    expect(onDisk.manuscriptId).toBe('m_test');
  });
});

describe('book-state router — POST /chapters/:chapterId/exclude', () => {
  /* The shared state.json was rewritten by earlier tests in this file
     (renamed title, narratorCredit changes). The exclude endpoint
     operates on whatever's currently on disk, so each case here resets
     state.chapters to a known shape before flipping the toggle. */
  function seedTwoChapters(): void {
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const cur = JSON.parse(readFileSync(statePath, 'utf8'));
    cur.chapters = [
      { id: 1, title: 'Dedication',  slug: '01-dedication' },
      { id: 2, title: 'Chapter One', slug: '02-chapter-one' },
    ];
    writeFileSync(statePath, JSON.stringify(cur));
  }

  it('flips excluded=true and persists it to state.json', async () => {
    seedTwoChapters();
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/1/exclude`)
      .send({ excluded: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 1, title: 'Dedication', slug: '01-dedication', excluded: true });

    const onDisk = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(onDisk.chapters.find((c: { id: number }) => c.id === 1).excluded).toBe(true);
    expect(onDisk.chapters.find((c: { id: number }) => c.id === 2).excluded).toBeFalsy();
  });

  it('flips excluded=false (clears the flag) and persists it', async () => {
    seedTwoChapters();
    /* Pre-set excluded on ch1 directly. */
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const cur = JSON.parse(readFileSync(statePath, 'utf8'));
    cur.chapters[0].excluded = true;
    writeFileSync(statePath, JSON.stringify(cur));

    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/1/exclude`)
      .send({ excluded: false });
    expect(res.status).toBe(200);
    expect(res.body.excluded).toBe(false);

    const onDisk = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(onDisk.chapters[0].excluded).toBeFalsy();
  });

  it('deletes any stale chapter audio + segments when newly excluded', async () => {
    seedTwoChapters();
    const audioRoot = join(bookDir, 'audio');
    mkdirSync(audioRoot, { recursive: true });
    /* Drop sentinel files matching the chapter's slug. */
    writeFileSync(join(audioRoot, '01-dedication.mp3'), Buffer.from([0, 0]));
    writeFileSync(join(audioRoot, '01-dedication.segments.json'), '{"durationSec":1}');
    expect(existsSync(join(audioRoot, '01-dedication.mp3'))).toBe(true);

    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/1/exclude`)
      .send({ excluded: true });
    expect(res.status).toBe(200);
    expect(existsSync(join(audioRoot, '01-dedication.mp3'))).toBe(false);
    expect(existsSync(join(audioRoot, '01-dedication.segments.json'))).toBe(false);
  });

  it('400s on a non-boolean excluded payload', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/1/exclude`)
      .send({ excluded: 'yes' });
    expect(res.status).toBe(400);
  });

  it('400s on a non-integer chapterId', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/abc/exclude`)
      .send({ excluded: true });
    expect(res.status).toBe(400);
  });

  it('404s when the chapter id does not exist on this book', async () => {
    seedTwoChapters();
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/999/exclude`)
      .send({ excluded: true });
    expect(res.status).toBe(404);
  });

  it('404s on an unknown bookId', async () => {
    const res = await request(app)
      .post(`/api/books/unknown_book/chapters/1/exclude`)
      .send({ excluded: true });
    expect(res.status).toBe(404);
  });
});

describe('book-state router — rehydrate on GET populates real chapter bodies', () => {
  /* Regression: an earlier "lightweight" rehydrate path inserted a
     ManuscriptRecord with chapterHints[].body='' and sourceText=raw
     utf-8 bytes of the file. For EPUBs that meant the ZIP archive's
     binary bytes ended up as sourceText, producing wordCount values
     orders of magnitude too low, and the analyzer ran against empty
     chapters so cast detection produced "0 chars" per chapter. The
     analysis route's getOrHydrateManuscript short-circuited on the
     poisoned record, so the bug persisted through the whole run.

     This test uses a multi-chapter .txt manuscript (the text parser
     gives deterministic chapter splits without binary handling), and
     verifies the post-GET in-memory record carries real chapter
     bodies and a real wordCount instead of the placeholder shape. */
  let manuscriptId: string;
  let rehydrateBookId: string;
  let rehydrateBookDir: string;

  beforeAll(async () => {
    manuscriptId = 'm_rehydrate_test';
    const TITLE_HERE = 'Rehydrate Test Book';
    const { makeBookId } = await import('../workspace/paths.js');
    rehydrateBookId = makeBookId(AUTHOR, SERIES, TITLE_HERE);
    rehydrateBookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE_HERE);
    mkdirSync(join(rehydrateBookDir, '.audiobook'), { recursive: true });

    /* Plain text with explicit "Chapter N" headings — parseText
       recognises these and emits a multi-chapter ParsedManuscript. */
    const manuscriptText = [
      'Chapter 1',
      '',
      'Once upon a time the keeper climbed the lighthouse stairs.',
      'The cold light slipped across Solway Bay.',
      '',
      'Chapter 2',
      '',
      'The next morning she discovered the lamp had failed.',
      'Sophie ran down the cliff path to find help.',
    ].join('\n');
    writeFileSync(join(rehydrateBookDir, 'manuscript.txt'), manuscriptText);

    writeFileSync(
      join(rehydrateBookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: rehydrateBookId,
        manuscriptId,
        title: TITLE_HERE,
        author: AUTHOR,
        series: SERIES,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: false,
        chapters: [
          { id: 1, title: 'Chapter 1', slug: '01-chapter-1' },
          { id: 2, title: 'Chapter 2', slug: '02-chapter-2' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  });

  it('populates the in-memory store with parsed chapter bodies (not empty strings)', async () => {
    /* Cold path: ensure nothing left over from another suite is
       pre-populating the store under this manuscriptId. */
    const { getManuscript } = await import('../store/manuscripts.js');
    expect(getManuscript(manuscriptId)).toBeUndefined();

    const res = await request(app).get(`/api/books/${rehydrateBookId}/state`);
    expect(res.status).toBe(200);

    const rec = getManuscript(manuscriptId);
    expect(rec).toBeDefined();
    expect(rec!.chapterHints).toHaveLength(2);
    /* Each chapter body must carry the real parsed text — not the
       empty placeholder the broken rehydrate used to write. */
    for (const ch of rec!.chapterHints) {
      expect(ch.body.length).toBeGreaterThan(0);
    }
    expect(rec!.chapterHints[0].body).toMatch(/keeper climbed/);
    expect(rec!.chapterHints[1].body).toMatch(/Sophie ran/);
  });

  it('reports a wordCount matching the parsed source (not the raw file byte count)', async () => {
    const res = await request(app).get(`/api/books/${rehydrateBookId}/state`);
    expect(res.status).toBe(200);
    /* The manuscript above has ~24 real prose words across the two
       chapters. The broken path counted whitespace tokens of the raw
       file (which for a .txt happens to coincide), but for EPUB it
       produced binary-byte gibberish. Pin both halves: wordCount is
       a small positive integer aligned with the prose, not zero
       and not in the hundreds-of-thousands. */
    expect(res.body.manuscript).toEqual({
      wordCount: expect.any(Number),
      format: 'plaintext',
    });
    expect(res.body.manuscript.wordCount).toBeGreaterThan(15);
    expect(res.body.manuscript.wordCount).toBeLessThan(40);
  });

  it('reports the parsed wordCount for EPUB (not the ZIP archive byte count)', async () => {
    /* Direct reproduction of the user-reported regression: a real
       on-disk EPUB rehydrated via GET must report the parsed prose
       wordCount, never the raw byte length of the ZIP archive.

       Pre-fix, this case returned wordCount derived from
       readFile(.epub, 'utf8') splitting binary bytes on whitespace,
       which yielded a number wildly out of proportion to byteSize
       (897k chars ÷ 20k words ≈ 43 chars/word in the original bug). */
    const epubBookTitle = 'EPUB Rehydrate Test';
    const epubManuscriptId = 'm_epub_rehydrate';
    const { makeBookId } = await import('../workspace/paths.js');
    const epubBookId = makeBookId(AUTHOR, SERIES, epubBookTitle);
    const epubBookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, epubBookTitle);
    mkdirSync(join(epubBookDir, '.audiobook'), { recursive: true });

    const here = dirname(fileURLToPath(import.meta.url));
    const fixturePath = resolve(here, '../parsers/__fixtures__/sample.epub');
    copyFileSync(fixturePath, join(epubBookDir, 'manuscript.epub'));

    writeFileSync(
      join(epubBookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: epubBookId,
        manuscriptId: epubManuscriptId,
        title: epubBookTitle,
        author: AUTHOR,
        series: SERIES,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.epub',
        castConfirmed: false,
        chapters: [
          { id: 1, title: 'Chapter 1', slug: '01-chapter-1' },
          { id: 2, title: 'Chapter 2', slug: '02-chapter-2' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );

    const { getManuscript } = await import('../store/manuscripts.js');
    expect(getManuscript(epubManuscriptId)).toBeUndefined();

    const res = await request(app).get(`/api/books/${epubBookId}/state`);
    expect(res.status).toBe(200);
    expect(res.body.manuscript.format).toBe('epub');

    /* sample.epub's combined prose is short — a few sentences across
       two chapters. The raw .epub on disk is a ZIP archive of a few
       KB. A correct parse yields a wordCount in the dozens, well
       under any plausible byte count of the file. */
    const rec = getManuscript(epubManuscriptId);
    expect(rec).toBeDefined();
    expect(rec!.chapterHints.every(c => c.body.length > 0)).toBe(true);
    expect(res.body.manuscript.wordCount).toBeGreaterThan(0);
    expect(res.body.manuscript.wordCount).toBeLessThan(rec!.byteSize / 4);
  });
});
