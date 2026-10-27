/* GET /:bookId/state runs a non-destructive title-only refresh on
   books imported before the parser version bumped. This file pins:

   - Legacy book (no chapterTitleParserVersion field) → titles refreshed
     in place, version bumped, slug/excluded/audio state untouched.
   - Current-version book → parser NOT re-invoked, state file untouched.
   - Chapter-count mismatch (split logic changed) → refresh skipped,
     titles preserved, version field NOT bumped (future fix can retry).
   - Source file missing on disk → refresh skipped, no crash.
   - Parse error (corrupt source) → refresh skipped, no crash.

   See server/src/routes/book-state.ts → refreshChapterTitles and
   server/src/parsers/version.ts. */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { CHAPTER_TITLE_PARSER_VERSION } from '../parsers/version.js';

const AUTHOR = 'Refresh Test';
const SERIES = 'Standalones';
const TITLE = 'Refresh Round Trip Book';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let statePath: string;

/* Markdown source with bare numbered headings + subtitles. New parser
   merges into "Chapter 1 — The Beginning" / "Chapter 2 — A Manifest";
   legacy parser would have produced just "Chapter 1" / "Chapter 2". */
const MANUSCRIPT_BODY = [
  'Chapter 1',
  'The Beginning',
  '',
  'First body line.',
  '',
  'Chapter 2',
  'A Manifest',
  '',
  'Second body line.',
  '',
].join('\n');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-refresh-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ bookStateRouter }, { makeBookId }] = await Promise.all([
    import('./book-state.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  statePath = join(bookDir, '.audiobook', 'state.json');

  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  /* Fresh source file every test — some cases delete it. */
  writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT_BODY);
});

/* Helper: write a state.json with the given chapter list and (optional)
   parser version. Defaults to legacy (no version field) so tests opting
   into the legacy path don't have to spell it out every time. */
function writeState(opts: {
  chapters: Array<{
    id: number;
    title: string;
    slug: string;
    uuid?: string;
    excluded?: boolean;
    audioRenderedAt?: string;
    titleOverridden?: boolean;
    titleSynthesized?: boolean;
  }>;
  parserVersion?: number;
}) {
  const state: Record<string, unknown> = {
    bookId,
    manuscriptId: 'm_refresh_test',
    title: TITLE,
    author: AUTHOR,
    series: SERIES,
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile: 'manuscript.md',
    castConfirmed: true,
    chapters: opts.chapters,
    coverGradient: ['#000', '#fff'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  if (opts.parserVersion !== undefined) {
    state.chapterTitleParserVersion = opts.parserVersion;
  }
  writeFileSync(statePath, JSON.stringify(state));
}

describe('GET /:bookId/state — title-only refresh on legacy books', () => {
  it('refreshes titles and bumps version when the version field is absent', async () => {
    writeState({
      chapters: [
        { id: 1, title: 'Chapter 1', slug: '01-chapter-1' },
        { id: 2, title: 'Chapter 2', slug: '02-chapter-2' },
      ],
    });

    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    expect(res.body.state.chapters.map((c: { title: string }) => c.title)).toEqual([
      'Chapter 1 — The Beginning',
      'Chapter 2 — A Manifest',
    ]);
    expect(res.body.state.chapterTitleParserVersion).toBe(CHAPTER_TITLE_PARSER_VERSION);

    /* Verify the refresh persisted to disk (next GET short-circuits). */
    const onDisk = JSON.parse(readFileSync(statePath, 'utf8')) as {
      chapters: Array<{ title: string }>;
      chapterTitleParserVersion?: number;
    };
    expect(onDisk.chapters.map((c) => c.title)).toEqual([
      'Chapter 1 — The Beginning',
      'Chapter 2 — A Manifest',
    ]);
    expect(onDisk.chapterTitleParserVersion).toBe(CHAPTER_TITLE_PARSER_VERSION);
  });

  it('preserves slug, excluded flag, and audioRenderedAt across the refresh', async () => {
    writeState({
      chapters: [
        {
          id: 1,
          title: 'Chapter 1',
          slug: '01-original-slug-keep-me',
          excluded: true,
          audioRenderedAt: '2026-02-15T10:00:00.000Z',
        },
        { id: 2, title: 'Chapter 2', slug: '02-other-slug' },
      ],
    });

    await request(app).get(`/api/books/${bookId}/state`);
    const onDisk = JSON.parse(readFileSync(statePath, 'utf8')) as {
      chapters: Array<{ slug: string; excluded?: boolean; audioRenderedAt?: string }>;
    };
    expect(onDisk.chapters[0].slug).toBe('01-original-slug-keep-me');
    expect(onDisk.chapters[0].excluded).toBe(true);
    expect(onDisk.chapters[0].audioRenderedAt).toBe('2026-02-15T10:00:00.000Z');
    expect(onDisk.chapters[1].slug).toBe('02-other-slug');
  });

  it('refreshes when version is below current (1 < CHAPTER_TITLE_PARSER_VERSION)', async () => {
    writeState({
      chapters: [
        { id: 1, title: 'Chapter 1', slug: '01-chapter-1' },
        { id: 2, title: 'Chapter 2', slug: '02-chapter-2' },
      ],
      parserVersion: 1,
    });

    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.body.state.chapters[0].title).toBe('Chapter 1 — The Beginning');
    expect(res.body.state.chapterTitleParserVersion).toBe(CHAPTER_TITLE_PARSER_VERSION);
  });

  it('does NOT re-parse when version is already current — state.json mtime unchanged', async () => {
    writeState({
      /* uuids present so srv-35's lazy backfill has nothing to migrate —
         this test isolates the title-refresh no-rewrite invariant. */
      chapters: [
        { id: 1, title: 'Preserved Title', slug: '01-preserved', uuid: 'u-1' },
        { id: 2, title: 'Another Preserved', slug: '02-another', uuid: 'u-2' },
      ],
      parserVersion: CHAPTER_TITLE_PARSER_VERSION,
    });
    const mtimeBefore = statSync(statePath).mtimeMs;

    /* Sleep briefly so any rewrite would visibly change mtime. */
    await new Promise((r) => setTimeout(r, 20));

    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.body.state.chapters.map((c: { title: string }) => c.title)).toEqual([
      'Preserved Title',
      'Another Preserved',
    ]);
    const mtimeAfter = statSync(statePath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it('skips refresh when chapter count mismatches — titles preserved, version field NOT bumped', async () => {
    /* Three chapters on disk, but the manuscript only parses to two —
       refresh should leave the file alone. */
    writeState({
      chapters: [
        { id: 1, title: 'Chapter 1', slug: '01-c1' },
        { id: 2, title: 'Chapter 2', slug: '02-c2' },
        { id: 3, title: 'Chapter 3', slug: '03-c3' },
      ],
    });

    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.body.state.chapters.map((c: { title: string }) => c.title)).toEqual([
      'Chapter 1',
      'Chapter 2',
      'Chapter 3',
    ]);
    /* Version stays unset so a future fix can re-attempt. */
    expect(res.body.state.chapterTitleParserVersion).toBeUndefined();
  });

  it('skips refresh when the source file is missing on disk — no crash', async () => {
    rmSync(join(bookDir, 'manuscript.md'), { force: true });
    writeState({
      chapters: [{ id: 1, title: 'Chapter 1', slug: '01-c1' }],
    });

    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    expect(res.body.state.chapters[0].title).toBe('Chapter 1');
  });

  it('plan 78 — skips chapters with titleOverridden=true; refreshes neighbours; bumps version', async () => {
    /* Two chapters: the first is user-renamed (sticky), the second is
       legacy-generic. Both go through the refresh on a legacy book —
       the override survives, the neighbour gets the parser-aligned
       title, and the parser version bump still lands so the refresh
       isn't re-attempted on every GET. */
    writeFileSync(statePath, JSON.stringify({
      bookId,
      manuscriptId: 'm_refresh_test',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapters: [
        { id: 1, title: 'My Sticky Name', slug: '01-my-sticky-name', titleOverridden: true },
        { id: 2, title: 'Chapter 2', slug: '02-chapter-2' },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));

    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);

    const onDisk = JSON.parse(readFileSync(statePath, 'utf8')) as {
      chapters: Array<{ title: string; titleOverridden?: boolean }>;
      chapterTitleParserVersion?: number;
    };
    expect(onDisk.chapters[0].title).toBe('My Sticky Name');
    expect(onDisk.chapters[0].titleOverridden).toBe(true);
    expect(onDisk.chapters[1].title).toBe('Chapter 2 — A Manifest');
    expect(onDisk.chapterTitleParserVersion).toBe(CHAPTER_TITLE_PARSER_VERSION);
  });

  it('skips refresh on parse error (corrupt EPUB) — no crash, titles preserved', async () => {
    /* Replace the source with a .epub-named file containing non-zip
       bytes that ALSO isn't valid UTF-8 (so the legacy-text-as-binary
       fallback won't kick in). Strict 0xFF/0xFE start triggers a UTF-8
       decode + parse failure. */
    writeFileSync(join(bookDir, 'broken.epub'), Buffer.from([0xff, 0xfe, 0x00, 0x42]));
    writeState({
      chapters: [{ id: 1, title: 'Chapter 1', slug: '01-c1' }],
    });
    /* Override manuscriptFile to point at the broken file. */
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.manuscriptFile = 'broken.epub';
    writeFileSync(statePath, JSON.stringify(state));

    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    expect(res.body.state.chapters[0].title).toBe('Chapter 1');
  });
});

describe('GET /:bookId/state — titleSynthesized through the title refresh (#3628)', () => {
  it('gains the flag on a made-up title, drops a stale one, and leaves a titleOverridden chapter alone', async () => {
    writeFileSync(
      join(bookDir, 'manuscript.md'),
      'Opening words before any heading.\n\n## Prologue\n\nThe prologue body has a few sentences of narrative content in it.\n\n## Chapter 1\n\nFirst body.\n',
    );
    writeState({
      chapters: [
        { id: 1, title: 'Old lead', slug: '01-old-lead' },
        { id: 2, title: 'Stale', slug: '02-stale', titleSynthesized: true },
        { id: 3, title: 'My Sticky Name', slug: '03-sticky', titleOverridden: true, titleSynthesized: true },
      ],
      parserVersion: 1,
    });

    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);

    const onDisk = JSON.parse(readFileSync(statePath, 'utf8')) as {
      chapters: Array<{ title: string; titleOverridden?: boolean; titleSynthesized?: boolean }>;
    };
    expect(onDisk.chapters[0].title).toBe('Chapter 1');
    expect(onDisk.chapters[0].titleSynthesized).toBe(true);
    expect(onDisk.chapters[1].title).toBe('Prologue');
    expect('titleSynthesized' in onDisk.chapters[1]).toBe(false);
    expect(onDisk.chapters[2].title).toBe('My Sticky Name');
    expect(onDisk.chapters[2].titleOverridden).toBe(true);
    expect(onDisk.chapters[2].titleSynthesized).toBe(true);
  });
});

/* #3828 -- on a book restructured after #3703 (a valid manuscript-hints.json), the
   GET title refresh aligns each chapter to its parse chapter by BODY, not by
   position: a reorder moves bodies, a merge changes the count. The restructure
   is driven through the real router so the persisted bodies are the ones a real
   reorder / merge writes (reorder keeps each body verbatim; merge joins them with
   a blank line, so a merged body equals no parse chapter). */
describe('GET /:bookId/state — title refresh aligns by body on a restructured book (#3828)', () => {
  const PROLOGUE_BODY = 'The prologue body has a few sentences of narrative content in it.';
  /* Parses to [Chapter 1 (app-made: prose before any heading), Prologue]. */
  const REORDER_MANUSCRIPT = `Opening words before any heading.\n\n## Prologue\n\n${PROLOGUE_BODY}\n`;
  /* Parses to [Alpha, Beta, Gamma]. */
  const MERGE_MANUSCRIPT = '# Alpha\n\nAlpha body line.\n\n# Beta\n\nBeta body line.\n\n# Gamma\n\nGamma body line.\n';
  const hintsPath = (): string => join(bookDir, '.audiobook', 'manuscript-hints.json');

  let restructureApp: Express;

  beforeAll(async () => {
    const [{ chaptersRestructureRouter }, { bookStateRouter }] = await Promise.all([
      import('./chapters-restructure.js'),
      import('./book-state.js'),
    ]);
    restructureApp = express();
    restructureApp.use(express.json());
    restructureApp.use('/api/books', bookStateRouter);
    restructureApp.use('/api/books', chaptersRestructureRouter);
  });

  async function removeRecord(): Promise<void> {
    const { removeManuscript } = await import('../store/manuscripts.js');
    removeManuscript('m_refresh_test');
  }

  function readState(): {
    chapters: Array<{ title: string; titleSynthesized?: boolean }>;
    chapterTitleParserVersion?: number;
  } {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  }

  /* Back to "owes a title refresh": the restructure stamps nothing, but a
     book restructured before the parser version bumped is exactly this. */
  function markOwingRefresh(patch?: (s: ReturnType<typeof readState>) => void): void {
    const s = readState();
    delete s.chapterTitleParserVersion;
    patch?.(s);
    writeFileSync(statePath, JSON.stringify(s));
  }

  beforeEach(async () => {
    rmSync(hintsPath(), { force: true });
    await removeRecord();
  });

  it('a reordered book keeps each chapter\'s own title (body B is not relabelled "Chapter 1", body A not "Prologue")', async () => {
    writeFileSync(join(bookDir, 'manuscript.md'), REORDER_MANUSCRIPT);
    writeState({
      chapters: [
        { id: 1, title: 'Chapter 1', slug: '01-chapter-1', titleSynthesized: true },
        { id: 2, title: 'Prologue', slug: '02-prologue' },
      ],
      parserVersion: CHAPTER_TITLE_PARSER_VERSION,
    });
    const reorder = await request(restructureApp)
      .post(`/api/books/${bookId}/chapters/reorder`)
      .send({ order: [2, 1] });
    expect(reorder.status).toBe(200);
    /* The app-made title renumbered with its new position. */
    expect(readState().chapters.map((c) => c.title)).toEqual(['Prologue', 'Chapter 2']);
    expect(existsSync(hintsPath())).toBe(true);
    markOwingRefresh();
    await removeRecord();

    const res = await request(restructureApp).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);

    const onDisk = readState();
    expect(onDisk.chapters.map((c) => c.title)).toEqual(['Prologue', 'Chapter 2']);
    expect(onDisk.chapters[1].titleSynthesized).toBe(true);
    expect(onDisk.chapterTitleParserVersion).toBe(CHAPTER_TITLE_PARSER_VERSION);
  });

  it('POST /chapters/refresh-titles on a reordered book does not relabel the app-made chapter "Prologue" or "Chapter 1"', async () => {
    writeFileSync(join(bookDir, 'manuscript.md'), REORDER_MANUSCRIPT);
    writeState({
      chapters: [
        { id: 1, title: 'Chapter 1', slug: '01-chapter-1', titleSynthesized: true },
        { id: 2, title: 'Prologue', slug: '02-prologue' },
      ],
      parserVersion: CHAPTER_TITLE_PARSER_VERSION,
    });
    const reorder = await request(restructureApp)
      .post(`/api/books/${bookId}/chapters/reorder`)
      .send({ order: [2, 1] });
    expect(reorder.status).toBe(200);
    await removeRecord();

    const res = await request(restructureApp)
      .post(`/api/books/${bookId}/chapters/refresh-titles`)
      .send({ useFirstLine: false });
    expect(res.status).toBe(200);

    expect(readState().chapters.map((c) => c.title)).toEqual(['Prologue', 'Chapter 2']);
  });

  it('a merged book keeps the merged chapter\'s title and still refreshes its neighbour', async () => {
    writeFileSync(join(bookDir, 'manuscript.md'), MERGE_MANUSCRIPT);
    writeState({
      chapters: [
        { id: 1, title: 'Alpha', slug: '01-alpha' },
        { id: 2, title: 'Beta', slug: '02-beta' },
        { id: 3, title: 'Gamma', slug: '03-gamma' },
      ],
      parserVersion: CHAPTER_TITLE_PARSER_VERSION,
    });
    const merge = await request(restructureApp)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [1, 2], mergedTitle: 'Alpha and Beta' });
    expect(merge.status).toBe(200);
    /* Gamma carries a stale title, as a book imported by an older parser would. */
    markOwingRefresh((s) => {
      s.chapters[1].title = 'Chapter 2';
    });
    await removeRecord();

    const res = await request(restructureApp).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);

    const onDisk = readState();
    expect(onDisk.chapters.map((c) => c.title)).toEqual(['Alpha and Beta', 'Gamma']);
    expect(onDisk.chapterTitleParserVersion).toBe(CHAPTER_TITLE_PARSER_VERSION);
  });

  it('a stale hints file skips the refresh: nothing written, version not bumped', async () => {
    writeFileSync(join(bookDir, 'manuscript.md'), REORDER_MANUSCRIPT);
    writeState({
      chapters: [
        { id: 1, title: 'Chapter 1', slug: '01-chapter-1', titleSynthesized: true },
        { id: 2, title: 'Prologue', slug: '02-prologue' },
      ],
      parserVersion: CHAPTER_TITLE_PARSER_VERSION,
    });
    const reorder = await request(restructureApp)
      .post(`/api/books/${bookId}/chapters/reorder`)
      .send({ order: [2, 1] });
    expect(reorder.status).toBe(200);
    /* The manuscript bytes changed since the restructure wrote the file. */
    const file = JSON.parse(readFileSync(hintsPath(), 'utf8')) as {
      entries: Array<{ sourceSha256: string }>;
    };
    for (const e of file.entries) e.sourceSha256 = 'deadbeef';
    writeFileSync(hintsPath(), JSON.stringify(file));
    markOwingRefresh();
    await removeRecord();
    const before = readFileSync(statePath);

    const res = await request(restructureApp).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);

    expect(readFileSync(statePath).equals(before)).toBe(true);
    expect(readState().chapterTitleParserVersion).toBeUndefined();
    expect(readState().chapters.map((c) => c.title)).toEqual(['Prologue', 'Chapter 2']);
  });
});
