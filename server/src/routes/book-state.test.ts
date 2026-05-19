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

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  copyFileSync,
} from 'node:fs';
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
      {
        id: 1,
        at: '2026-05-13T15:00:00.000Z',
        ts: 'Just now',
        date: 'today',
        type: 'regenerate',
        title: 'Regenerated Chapter 1',
        note: 'Reason: voice tuning updated.',
        actor: 'you',
        chapterId: 1,
        revertible: true,
      },
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

describe('book-state router — dropped-quotes endpoint', () => {
  it('GET dropped-quotes returns an empty envelope when the file does not exist', async () => {
    /* The book was created in beforeAll with no dropped-quotes.json on
       disk — the loader should fall through to the empty envelope. */
    const res = await request(app).get(`/api/books/${bookId}/dropped-quotes`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ manuscriptId: 'm_test', batches: [] });
  });

  it('GET dropped-quotes returns persisted batches verbatim', async () => {
    /* Write a fixture directly to disk so the test exercises the read
       path (loadDroppedQuotes through the route). */
    const fixture = {
      manuscriptId: 'm_test',
      batches: [
        {
          recordedAt: '2026-05-15T10:00:00.000Z',
          route: 'analysis-stream',
          totalDropped: 2,
          affectedCharacters: 1,
          entries: [
            {
              characterId: 'sophie',
              characterName: 'Sophie',
              quote: 'fabricated dialogue',
              truncated: false,
              reason: 'not_in_source',
            },
            {
              characterId: 'sophie',
              characterName: 'Sophie',
              quote: '   ',
              truncated: false,
              reason: 'empty_after_normalisation',
              note: 'punct-only',
            },
          ],
        },
      ],
    };
    writeFileSync(join(bookDir, '.audiobook', 'dropped-quotes.json'), JSON.stringify(fixture));
    const res = await request(app).get(`/api/books/${bookId}/dropped-quotes`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(fixture);
  });

  it('GET dropped-quotes 404s when the book does not exist', async () => {
    const res = await request(app).get('/api/books/this-id-does-not-exist/dropped-quotes');
    expect(res.status).toBe(404);
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

    /* Title/author/series changes move the on-disk folder. The seed book
       in beforeAll set isStandalone: true, so the on-disk series folder
       is forced to 'Standalones' regardless of the patch's `series`
       value — state.series stays 'Renamed Series' inside state.json but
       the folder is `Standalones/`. Update the shared bookDir variable
       so subsequent cases read from the new location. */
    bookDir = join(workspaceRoot, 'books', 'Different Author', 'Standalones', 'Renamed Title');
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

  /* Plan 67 — per-book editorial notes round-trip via the state slice.
     Free-form text with markdown line breaks preserved verbatim. Empty /
     whitespace-only strings collapse to null on the server side so the
     editor's "clear" gesture has a clean cleared-value signal. */
  it('PUT slice=state round-trips notes with markdown line breaks preserved verbatim (plan 67)', async () => {
    const notesText = 'Source: public-domain edition.\nLicense: CC-BY-SA.\n\nNarration intent: warm.';
    const put = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { notes: notesText } });
    expect(put.status).toBe(204);
    const onDisk = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(onDisk.notes).toBe(notesText);
  });

  it('PUT slice=state preserves notes when patch omits it', async () => {
    const put = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { genre: 'Mystery' } });
    expect(put.status).toBe(204);
    const onDisk = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    /* Carried forward from the previous test in the file. */
    expect(onDisk.notes).toContain('Source: public-domain edition.');
  });

  it('PUT slice=state stores explicit null for cleared notes', async () => {
    const put = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { notes: null } });
    expect(put.status).toBe(204);
    const onDisk = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(onDisk.notes).toBeNull();
  });

  it('PUT slice=state coerces whitespace-only notes to null', async () => {
    const put = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { notes: '   \n   ' } });
    expect(put.status).toBe(204);
    const onDisk = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(onDisk.notes).toBeNull();
  });

  it('PUT slice=state stamps schema=1 on the on-disk file (plan 27 versioning seam)', async () => {
    /* End-to-end check that the migration seam wires through every
       writer hot path. The seed file in beforeAll has no schema field
       (legacy); after any PUT through the state slice, the file must
       carry the current CURRENT_STATE_SCHEMA stamp. Round-trip
       complement to the unit specs in workspace/state-migrate.test.ts. */
    const put = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { narratorCredit: 'Schema Witness' } });
    expect(put.status).toBe(204);
    const onDisk = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(onDisk.schema).toBe(1);
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
      { id: 1, title: 'Dedication', slug: '01-dedication' },
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
    expect(rec!.chapterHints.every((c) => c.body.length > 0)).toBe(true);
    expect(res.body.manuscript.wordCount).toBeGreaterThan(0);
    expect(res.body.manuscript.wordCount).toBeLessThan(rec!.byteSize / 4);
  });
});

describe('book-state router — chapterCharacters reflects the post-fold roster', () => {
  /* Regression: the GET handler previously sourced chapterCharacters
     from the raw analysis cache, which intentionally keeps pre-fold
     descriptor ids ("the-jogger", "drooly-boy"). The synth pipeline
     reads from manuscript-edits.json (post-fold), so on hydrate the
     Generate-view chapter rows showed phantom Queued pills for
     descriptor characters the synth job would never advance.
     manuscript-edits.json is the source of truth for which ids will
     actually be processed — derive chapterCharacters from it. */
  const FOLD_TITLE = 'Fold Bug Test';
  const FOLD_MANUSCRIPT_ID = 'm_fold_bug_test';
  let foldBookId: string;
  let foldBookDir: string;

  beforeAll(async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    foldBookId = makeBookId(AUTHOR, SERIES, FOLD_TITLE);
    foldBookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, FOLD_TITLE);
    mkdirSync(join(foldBookDir, '.audiobook'), { recursive: true });

    writeFileSync(join(foldBookDir, 'manuscript.txt'), 'placeholder');
    writeFileSync(
      join(foldBookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: foldBookId,
        manuscriptId: FOLD_MANUSCRIPT_ID,
        title: FOLD_TITLE,
        author: AUTHOR,
        series: SERIES,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters: [{ id: 8, title: 'Chapter Eight', slug: '08-chapter-eight' }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  });

  afterAll(async () => {
    const { clearAnalysisCache } = await import('../store/analysis-cache.js');
    await clearAnalysisCache(FOLD_MANUSCRIPT_ID);
  });

  it('uses post-fold ids from manuscript-edits.json even when the cache still holds the pre-fold descriptor', async () => {
    /* Cache: simulate the analyzer's pre-fold output. Chapter 8 has
       one descriptor speaker ("the-jogger") alongside named cast.
       Sentence ids 1..3 will get rewritten by the fold; 4 stays. */
    const { saveAnalysisCache } = await import('../store/analysis-cache.js');
    await saveAnalysisCache(FOLD_MANUSCRIPT_ID, {
      chapters: {
        8: [
          { id: 1, chapterId: 8, characterId: 'the-jogger', text: 'Watch out!' },
          { id: 2, chapterId: 8, characterId: 'the-jogger', text: 'Coming through!' },
          { id: 3, chapterId: 8, characterId: 'the-jogger', text: 'Move!' },
          { id: 4, chapterId: 8, characterId: 'sophie', text: 'Sorry!' },
        ],
      },
    });

    /* manuscript-edits.json: the actual on-disk post-fold list the
       synth pipeline reads. the-jogger has been collapsed into
       unknown-male; the sentence ids remain stable so the cache-vs-
       edits reconciliation in the GET handler treats them as live. */
    writeFileSync(
      join(foldBookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 8, characterId: 'unknown-male', text: 'Watch out!' },
          { id: 2, chapterId: 8, characterId: 'unknown-male', text: 'Coming through!' },
          { id: 3, chapterId: 8, characterId: 'unknown-male', text: 'Move!' },
          { id: 4, chapterId: 8, characterId: 'sophie', text: 'Sorry!' },
        ],
      }),
    );

    const res = await request(app).get(`/api/books/${foldBookId}/state`);
    expect(res.status).toBe(200);
    const speakers = (res.body.chapterCharacters?.[8] ?? []) as string[];
    expect(speakers).toContain('unknown-male');
    expect(speakers).toContain('sophie');
    /* The pre-fold descriptor id must NOT leak through to the
       Generate view — that's the phantom-Queued-row bug. */
    expect(speakers).not.toContain('the-jogger');
  });

  it('falls back to the cache when manuscript-edits.json is absent (analysis in flight)', async () => {
    /* Tear down the edits file from the previous case so we can
       exercise the cache-only path. */
    rmSync(join(foldBookDir, '.audiobook', 'manuscript-edits.json'), { force: true });

    const res = await request(app).get(`/api/books/${foldBookId}/state`);
    expect(res.status).toBe(200);
    const speakers = (res.body.chapterCharacters?.[8] ?? []) as string[];
    /* No edits on disk → cache is the only source. The Generate view
       isn't reachable in this state (it requires manuscript-edits.json
       to synthesise from), so showing the pre-fold roster on the
       analysing view is the existing intended behaviour — pin it. */
    expect(speakers).toContain('the-jogger');
    expect(speakers).toContain('sophie');
  });
});

describe('book-state router — state slice series-membership + on-disk rename', () => {
  /* Each case in this block creates its own book on disk so the test
     observing the post-rename layout doesn't tread on the shared bookId
     used by the earlier suites. The book is removed in afterEach so a
     case can't leak its renamed folder into a sibling. */
  const RENAME_AUTHOR = 'Rename Author';
  const RENAME_INITIAL_SERIES = 'Initial Series';
  const RENAME_INITIAL_TITLE = 'Initial Title';
  let renameBookId: string;
  let renameBookDir: string;
  const RENAME_MANUSCRIPT_ID = 'm_rename_test';

  async function seedBook(
    opts: {
      author?: string;
      series?: string;
      title?: string;
      seriesPosition?: number | null;
      isStandalone?: boolean;
    } = {},
  ): Promise<void> {
    const { makeBookId } = await import('../workspace/paths.js');
    const author = opts.author ?? RENAME_AUTHOR;
    const series = opts.series ?? RENAME_INITIAL_SERIES;
    const title = opts.title ?? RENAME_INITIAL_TITLE;
    renameBookId = makeBookId(author, series, title);
    renameBookDir = join(workspaceRoot, 'books', author, series, title);
    mkdirSync(join(renameBookDir, '.audiobook'), { recursive: true });
    writeFileSync(join(renameBookDir, 'manuscript.txt'), 'placeholder body for rename tests');
    writeFileSync(
      join(renameBookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: renameBookId,
        manuscriptId: RENAME_MANUSCRIPT_ID,
        title,
        author,
        series,
        seriesPosition: opts.seriesPosition ?? 1,
        isStandalone: opts.isStandalone ?? false,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters: [{ id: 1, title: 'Chapter 1', slug: '01-chapter-1' }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  afterEach(async () => {
    /* Walk the books root and wipe anything left behind so the next
       case starts clean — rename tests scatter folders across new
       author/series trees and we don't want stragglers to influence
       findBookByBookId or scanLibrary. */
    const booksRoot = join(workspaceRoot, 'books');
    if (existsSync(booksRoot)) {
      const { readdirSync } = await import('node:fs');
      for (const author of readdirSync(booksRoot)) {
        const dir = join(booksRoot, author);
        if (author === AUTHOR) continue; // keep the shared test author tree
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('persists seriesPosition + isStandalone updates', async () => {
    await seedBook({ seriesPosition: 1, isStandalone: false });
    const res = await request(app)
      .put(`/api/books/${renameBookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { seriesPosition: 4 } });
    expect(res.status).toBe(204);
    const onDisk = JSON.parse(
      readFileSync(join(renameBookDir, '.audiobook', 'state.json'), 'utf8'),
    );
    expect(onDisk.seriesPosition).toBe(4);
    expect(onDisk.isStandalone).toBe(false);
  });

  it('toggling isStandalone=true forces Standalones folder + clears seriesPosition', async () => {
    await seedBook({ seriesPosition: 3, isStandalone: false });
    const res = await request(app)
      .put(`/api/books/${renameBookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { isStandalone: true } });
    expect(res.status).toBe(204);
    const newDir = join(workspaceRoot, 'books', RENAME_AUTHOR, 'Standalones', RENAME_INITIAL_TITLE);
    expect(existsSync(newDir)).toBe(true);
    expect(existsSync(renameBookDir)).toBe(false);
    const onDisk = JSON.parse(readFileSync(join(newDir, '.audiobook', 'state.json'), 'utf8'));
    expect(onDisk.isStandalone).toBe(true);
    expect(onDisk.seriesPosition).toBeNull();
    /* Original series label kept in state.json so flipping back doesn't lose it. */
    expect(onDisk.series).toBe(RENAME_INITIAL_SERIES);
  });

  it('renaming the title moves the on-disk folder and findBookByBookId resolves the new path', async () => {
    await seedBook();
    const res = await request(app)
      .put(`/api/books/${renameBookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { title: 'Renamed Properly' } });
    expect(res.status).toBe(204);

    const newDir = join(
      workspaceRoot,
      'books',
      RENAME_AUTHOR,
      RENAME_INITIAL_SERIES,
      'Renamed Properly',
    );
    expect(existsSync(newDir)).toBe(true);
    expect(existsSync(renameBookDir)).toBe(false);

    /* bookId is unchanged — the rename preserves identity. */
    const { findBookByBookId } = await import('../workspace/scan.js');
    const located = await findBookByBookId(renameBookId);
    expect(located?.bookDir).toBe(newDir);
    expect(located?.state.bookId).toBe(renameBookId);
    expect(located?.state.title).toBe('Renamed Properly');
  });

  it('renaming author + series creates the new tree and prunes the now-empty old parents', async () => {
    await seedBook();
    const res = await request(app)
      .put(`/api/books/${renameBookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { author: 'Different Author', series: 'Different Series' } });
    expect(res.status).toBe(204);

    const newDir = join(
      workspaceRoot,
      'books',
      'Different Author',
      'Different Series',
      RENAME_INITIAL_TITLE,
    );
    expect(existsSync(newDir)).toBe(true);
    /* Original author tree was emptied by the rename — cleanup should
       have removed both the empty series dir and the empty author dir. */
    expect(existsSync(join(workspaceRoot, 'books', RENAME_AUTHOR))).toBe(false);
  });

  it('rename to an existing folder returns 409 and leaves state.json at the old path', async () => {
    await seedBook();
    /* Pre-create a colliding target so the rename refuses. */
    const collidingDir = join(
      workspaceRoot,
      'books',
      RENAME_AUTHOR,
      RENAME_INITIAL_SERIES,
      'Existing Other',
    );
    mkdirSync(collidingDir, { recursive: true });

    const res = await request(app)
      .put(`/api/books/${renameBookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { title: 'Existing Other' } });
    expect(res.status).toBe(409);

    /* The original folder still holds the unchanged state.json. */
    const stillThere = JSON.parse(
      readFileSync(join(renameBookDir, '.audiobook', 'state.json'), 'utf8'),
    );
    expect(stillThere.title).toBe(RENAME_INITIAL_TITLE);
  });

  it('rename refreshes the in-memory ManuscriptRecord.bookDir', async () => {
    await seedBook();
    /* Seed an in-memory record so the rename path takes the refresh
       branch. Mirrors what the analysis route would have populated. */
    const { putManuscript, getManuscript } = await import('../store/manuscripts.js');
    putManuscript({
      manuscriptId: RENAME_MANUSCRIPT_ID,
      format: 'plaintext',
      title: RENAME_INITIAL_TITLE,
      wordCount: 5,
      byteSize: 32,
      uploadedAt: new Date().toISOString(),
      sourceText: 'placeholder body for rename tests',
      chapterHints: [{ id: 1, title: 'Chapter 1', body: 'placeholder body for rename tests' }],
      bookId: renameBookId,
      bookDir: renameBookDir,
    });

    const res = await request(app)
      .put(`/api/books/${renameBookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { title: 'Refreshed Record Title' } });
    expect(res.status).toBe(204);

    const newDir = join(
      workspaceRoot,
      'books',
      RENAME_AUTHOR,
      RENAME_INITIAL_SERIES,
      'Refreshed Record Title',
    );
    const rec = getManuscript(RENAME_MANUSCRIPT_ID);
    expect(rec?.bookDir).toBe(newDir);
  });
});

/* Cold-boot rehydration for the AnalysisPill across browser reload +
   server restart. The endpoint reads from .audiobook/analysis-state.json
   (written by analysis.ts at phase boundaries and on terminal events).
   See docs/features/32-sticky-analysis.md "Cold-boot rehydration". */
describe('book-state router — GET /:bookId/analysis/state', () => {
  const COLD_BOOT_AUTHOR = 'ColdBoot Author';
  const COLD_BOOT_SERIES = 'Standalones';
  const COLD_BOOT_TITLE = 'Cold Boot Book';
  const COLD_BOOT_MANUSCRIPT_ID = 'm_cold_boot';
  let coldBootBookId: string;
  let coldBootBookDir: string;

  async function seedColdBootBook(): Promise<void> {
    const { makeBookId } = await import('../workspace/paths.js');
    coldBootBookId = makeBookId(COLD_BOOT_AUTHOR, COLD_BOOT_SERIES, COLD_BOOT_TITLE);
    coldBootBookDir = join(
      workspaceRoot,
      'books',
      COLD_BOOT_AUTHOR,
      COLD_BOOT_SERIES,
      COLD_BOOT_TITLE,
    );
    mkdirSync(join(coldBootBookDir, '.audiobook'), { recursive: true });
    writeFileSync(join(coldBootBookDir, 'manuscript.txt'), 'placeholder');
    writeFileSync(
      join(coldBootBookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: coldBootBookId,
        manuscriptId: COLD_BOOT_MANUSCRIPT_ID,
        title: COLD_BOOT_TITLE,
        author: COLD_BOOT_AUTHOR,
        series: COLD_BOOT_SERIES,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: false,
        chapters: [{ id: 1, title: 'Chapter 1', slug: '01-chapter-1' }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  afterEach(() => {
    /* Wipe any cold-boot book the case created. The shared workspace
       root has the original test book under AUTHOR, untouched. */
    if (coldBootBookDir && existsSync(coldBootBookDir)) {
      const authorDir = join(workspaceRoot, 'books', COLD_BOOT_AUTHOR);
      rmSync(authorDir, { recursive: true, force: true });
    }
  });

  it('404s when the book does not exist', async () => {
    const res = await request(app).get('/api/books/does-not-exist/analysis/state');
    expect(res.status).toBe(404);
  });

  it('404s when the book exists but no analysis-state.json is on disk', async () => {
    await seedColdBootBook();
    const res = await request(app).get(`/api/books/${coldBootBookId}/analysis/state`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no analysis state/i);
  });

  it('returns the paused snapshot verbatim when written to disk', async () => {
    await seedColdBootBook();
    const { writeAnalysisState } = await import('../store/analysis-state.js');
    await writeAnalysisState(coldBootBookDir, {
      manuscriptId: COLD_BOOT_MANUSCRIPT_ID,
      phaseId: 1,
      phaseLabel: 'Parsing and attribution',
      phaseProgress: 0.42,
      state: 'paused',
      lastTickAt: 1_700_000_000_000,
    });

    const res = await request(app).get(`/api/books/${coldBootBookId}/analysis/state`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      manuscriptId: COLD_BOOT_MANUSCRIPT_ID,
      phaseId: 1,
      phaseLabel: 'Parsing and attribution',
      phaseProgress: 0.42,
      state: 'paused',
      lastTickAt: 1_700_000_000_000,
    });
  });

  it('returns the halted snapshot with haltCode + haltReason when written to disk', async () => {
    await seedColdBootBook();
    const { writeAnalysisState } = await import('../store/analysis-state.js');
    await writeAnalysisState(coldBootBookDir, {
      manuscriptId: COLD_BOOT_MANUSCRIPT_ID,
      phaseId: 1,
      phaseLabel: 'Parsing and attribution',
      phaseProgress: 0.7,
      state: 'halted',
      haltCode: 'attribution_drift',
      haltReason: 'Phase 1 demoted 412 of 5234 sentences (8%) to narrator.',
      lastTickAt: 1_700_000_000_000,
    });

    const res = await request(app).get(`/api/books/${coldBootBookId}/analysis/state`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('halted');
    expect(res.body.haltCode).toBe('attribution_drift');
    expect(res.body.haltReason).toContain('Phase 1 demoted 412');
  });

  it('coerces running on disk → paused in the response when there is no live job', async () => {
    /* This is THE invariant of the cold-boot path: a server restart
       leaves the disk file at state:'running' (the last phase-boundary
       write before the crash), but the in-flight map is empty. The
       endpoint promotes it to 'paused' so the pill shows Resume
       affordance instead of pretending the analyzer is still ticking. */
    await seedColdBootBook();
    const { writeAnalysisState } = await import('../store/analysis-state.js');
    await writeAnalysisState(coldBootBookDir, {
      manuscriptId: COLD_BOOT_MANUSCRIPT_ID,
      phaseId: 0,
      phaseLabel: 'Detecting characters',
      phaseProgress: 0.6,
      state: 'running',
      lastTickAt: 1_700_000_000_000,
    });

    const res = await request(app).get(`/api/books/${coldBootBookId}/analysis/state`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('paused');
    /* Phase + progress + manuscriptId pass through unchanged so the
       pill renders the right phase label even after the coercion. */
    expect(res.body.phaseId).toBe(0);
    expect(res.body.phaseProgress).toBe(0.6);
    expect(res.body.phaseLabel).toBe('Detecting characters');
  });

  it('404s when state.json exists but has no manuscriptId (book created via a path that never analysed)', async () => {
    /* Defence-in-depth: a partial book on disk without a manuscriptId
       can't have an analyzer job (the in-flight map is keyed on
       manuscriptId), and we shouldn't even read the disk file because
       it shouldn't exist for such a book. Endpoint returns 404. */
    await seedColdBootBook();
    /* Rewrite state.json to drop manuscriptId. */
    const statePath = join(coldBootBookDir, '.audiobook', 'state.json');
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    delete parsed.manuscriptId;
    writeFileSync(statePath, JSON.stringify(parsed));

    const res = await request(app).get(`/api/books/${coldBootBookId}/analysis/state`);
    expect(res.status).toBe(404);
  });
});

describe('book-state router — listen-progress slice (plan 47)', () => {
  /* Earlier state-slice tests rename the shared bookId's on-disk
     folder via PUT slice=state, after which the rename block's
     afterEach wipes anything outside `Test Author`. Seed a fresh
     book here so we don't depend on the shared-bookId disk state. */
  const LP_AUTHOR = 'Listen Progress Author';
  const LP_SERIES = 'Standalones';
  const LP_TITLE = 'Listen Progress Book';
  let lpBookId: string;
  let lpBookDir: string;

  beforeAll(async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    lpBookId = makeBookId(LP_AUTHOR, LP_SERIES, LP_TITLE);
    lpBookDir = join(workspaceRoot, 'books', LP_AUTHOR, LP_SERIES, LP_TITLE);
    mkdirSync(join(lpBookDir, '.audiobook'), { recursive: true });
    writeFileSync(
      join(lpBookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: lpBookId,
        manuscriptId: 'm_listen_progress',
        title: LP_TITLE,
        author: LP_AUTHOR,
        series: LP_SERIES,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters: [
          { id: 1, title: 'Chapter 1', slug: 'chapter-one' },
          { id: 2, title: 'Chapter 2', slug: 'chapter-two' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(join(lpBookDir, 'manuscript.txt'), 'placeholder');
  });

  it('GET returns null when no listen-progress.json has been written yet', async () => {
    const res = await request(app).get(`/api/books/${lpBookId}/listen-progress`);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it('PUT then GET round-trips chapterId + currentSec with a server-stamped updatedAt', async () => {
    const before = Date.now();
    const put = await request(app)
      .put(`/api/books/${lpBookId}/listen-progress`)
      .set('Content-Type', 'application/json')
      .send({ chapterId: 3, currentSec: 83.5 });
    const after = Date.now();
    expect(put.status).toBe(200);
    expect(put.body.chapterId).toBe(3);
    expect(put.body.currentSec).toBe(83.5);
    expect(typeof put.body.updatedAt).toBe('string');
    const stamped = Date.parse(put.body.updatedAt);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);

    const onDisk = join(lpBookDir, '.audiobook', 'listen-progress.json');
    expect(existsSync(onDisk)).toBe(true);
    const parsed = JSON.parse(readFileSync(onDisk, 'utf8'));
    expect(parsed).toEqual(put.body);

    const get = await request(app).get(`/api/books/${lpBookId}/listen-progress`);
    expect(get.status).toBe(200);
    expect(get.body).toEqual(put.body);
  });

  it('PUT overwrites the previous record on a fresh save', async () => {
    const put = await request(app)
      .put(`/api/books/${lpBookId}/listen-progress`)
      .set('Content-Type', 'application/json')
      .send({ chapterId: 4, currentSec: 12 });
    expect(put.status).toBe(200);
    expect(put.body.chapterId).toBe(4);
    expect(put.body.currentSec).toBe(12);

    const get = await request(app).get(`/api/books/${lpBookId}/listen-progress`);
    expect(get.body.chapterId).toBe(4);
    expect(get.body.currentSec).toBe(12);
  });

  it('PUT 400s when chapterId is missing', async () => {
    const res = await request(app)
      .put(`/api/books/${lpBookId}/listen-progress`)
      .set('Content-Type', 'application/json')
      .send({ currentSec: 5 });
    expect(res.status).toBe(400);
  });

  it('PUT 400s when chapterId is not a number', async () => {
    const res = await request(app)
      .put(`/api/books/${lpBookId}/listen-progress`)
      .set('Content-Type', 'application/json')
      .send({ chapterId: 'not-a-number', currentSec: 5 });
    expect(res.status).toBe(400);
  });

  it('PUT 400s when currentSec is negative', async () => {
    const res = await request(app)
      .put(`/api/books/${lpBookId}/listen-progress`)
      .set('Content-Type', 'application/json')
      .send({ chapterId: 1, currentSec: -1 });
    expect(res.status).toBe(400);
  });

  it('PUT 400s when currentSec is not a finite number', async () => {
    const res = await request(app)
      .put(`/api/books/${lpBookId}/listen-progress`)
      .set('Content-Type', 'application/json')
      .send({ chapterId: 1, currentSec: 'fifteen' });
    expect(res.status).toBe(400);
  });

  it('GET 404s when the book does not exist', async () => {
    const res = await request(app).get('/api/books/missing__book__id/listen-progress');
    expect(res.status).toBe(404);
  });

  it('PUT 404s when the book does not exist', async () => {
    const res = await request(app)
      .put('/api/books/missing__book__id/listen-progress')
      .set('Content-Type', 'application/json')
      .send({ chapterId: 1, currentSec: 5 });
    expect(res.status).toBe(404);
  });

  /* Plan 53 — validator accepts + persists the optional playbackRate
     and markers fields. */
  it('PUT round-trips an optional playbackRate field', async () => {
    const put = await request(app)
      .put(`/api/books/${lpBookId}/listen-progress`)
      .set('Content-Type', 'application/json')
      .send({ chapterId: 1, currentSec: 10, playbackRate: 1.5 });
    expect(put.status).toBe(200);
    expect(put.body.playbackRate).toBe(1.5);

    const get = await request(app).get(`/api/books/${lpBookId}/listen-progress`);
    expect(get.body.playbackRate).toBe(1.5);
  });

  it('PUT 400s when playbackRate is below 0.25 or above 4.0', async () => {
    const low = await request(app)
      .put(`/api/books/${lpBookId}/listen-progress`)
      .set('Content-Type', 'application/json')
      .send({ chapterId: 1, currentSec: 10, playbackRate: 0.1 });
    expect(low.status).toBe(400);

    const high = await request(app)
      .put(`/api/books/${lpBookId}/listen-progress`)
      .set('Content-Type', 'application/json')
      .send({ chapterId: 1, currentSec: 10, playbackRate: 10 });
    expect(high.status).toBe(400);

    const nonNumeric = await request(app)
      .put(`/api/books/${lpBookId}/listen-progress`)
      .set('Content-Type', 'application/json')
      .send({ chapterId: 1, currentSec: 10, playbackRate: 'fast' });
    expect(nonNumeric.status).toBe(400);
  });

  it('PUT round-trips an optional markers array', async () => {
    const markers = [
      {
        id: 'mk_1',
        chapterId: 2,
        sec: 83.5,
        label: 're-record this',
        kind: 'rerecord',
        createdAt: '2026-05-19T10:00:00.000Z',
      },
      {
        id: 'mk_2',
        chapterId: 1,
        sec: 10,
        label: '',
        kind: 'note',
        createdAt: '2026-05-19T10:01:00.000Z',
      },
    ];
    const put = await request(app)
      .put(`/api/books/${lpBookId}/listen-progress`)
      .set('Content-Type', 'application/json')
      .send({ chapterId: 1, currentSec: 5, markers });
    expect(put.status).toBe(200);
    expect(put.body.markers).toEqual(markers);

    const get = await request(app).get(`/api/books/${lpBookId}/listen-progress`);
    expect(get.body.markers).toEqual(markers);
  });

  it('PUT 400s when a marker carries an unknown kind', async () => {
    const res = await request(app)
      .put(`/api/books/${lpBookId}/listen-progress`)
      .set('Content-Type', 'application/json')
      .send({
        chapterId: 1,
        currentSec: 5,
        markers: [
          {
            id: 'mk_bad',
            chapterId: 1,
            sec: 5,
            label: 'huh',
            kind: 'mystery',
            createdAt: '2026-05-19T10:00:00.000Z',
          },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/kind/i);
  });

  it('PUT 400s when markers is not an array', async () => {
    const res = await request(app)
      .put(`/api/books/${lpBookId}/listen-progress`)
      .set('Content-Type', 'application/json')
      .send({ chapterId: 1, currentSec: 5, markers: { not: 'an array' } });
    expect(res.status).toBe(400);
  });

  it('PUT 400s when a marker is missing required fields', async () => {
    const res = await request(app)
      .put(`/api/books/${lpBookId}/listen-progress`)
      .set('Content-Type', 'application/json')
      .send({
        chapterId: 1,
        currentSec: 5,
        markers: [{ id: 'mk_partial', chapterId: 1, sec: 5, label: 'x', kind: 'note' }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/createdAt/);
  });
});
