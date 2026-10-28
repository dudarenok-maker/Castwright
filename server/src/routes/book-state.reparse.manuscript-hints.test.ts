/* #3703 part 3 -- reparse / replace-manuscript delete
 * <book>/.audiobook/manuscript-hints.json after the chapter-list rebuild lands,
 * so a restructure the user discarded cannot come back after a restart.
 * Harness mirrors chapters-restructure.test.ts. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';
import { CHAPTER_TITLE_PARSER_VERSION } from '../parsers/version.js';

const removeSpy = vi.hoisted(() => ({ fail: false }));
const stateWriteSpy = vi.hoisted(() => ({ fail: false }));
vi.mock('../workspace/state-migrate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workspace/state-migrate.js')>();
  return {
    ...real,
    /* Fails the write that rebuilds the chapter list (the mutator changes the
       chapter count): the mutator runs before any bytes are written, so this is
       exactly "the state.json write failed". */
    updateStateJsonLocked: vi.fn(async (...args: Parameters<typeof real.updateStateJsonLocked>) => {
      const [path, mutate, ...rest] = args;
      return real.updateStateJsonLocked(
        path,
        async (onDisk) => {
          const next = await mutate(onDisk);
          if (stateWriteSpy.fail && next && next.chapters.length !== onDisk.chapters.length) {
            throw new Error('state write boom');
          }
          return next;
        },
        ...rest,
      );
    }),
  };
});
vi.mock('../workspace/manuscript-hints.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workspace/manuscript-hints.js')>();
  return {
    ...real,
    removeManuscriptHints: vi.fn(async (...args: Parameters<typeof real.removeManuscriptHints>) => {
      if (removeSpy.fail) throw new Error('hints remove boom');
      return real.removeManuscriptHints(...args);
    }),
  };
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, '..', '..');
const CACHE_DIR = join(SERVER_ROOT, 'handoff', 'cache');

const AUTHOR = 'Hints Reparse Test';
const SERIES = 'Standalones';
const TITLE = 'Hints Reparse Test Book';
const MANUSCRIPT_ID = 'm_hints_reparse_test';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let cachePath: string;

const MANUSCRIPT_BODY =
  '# Chapter One\n\nAlpha first.\nAlpha second.\n\n# Chapter Two\n\nBeta first.\nBeta second.\n\n# Chapter Three\n\nGamma first.\nGamma second.\n';

function hintsPath(): string {
  return join(bookDir, '.audiobook', 'manuscript-hints.json');
}

function statePath(): string {
  return join(bookDir, '.audiobook', 'state.json');
}

function seedState(): void {
  writeFileSync(
    statePath(),
    JSON.stringify({
      bookId,
      manuscriptId: MANUSCRIPT_ID,
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapters: [
        { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
        { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
        { id: 3, title: 'Chapter Three', slug: '03-chapter-three' },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
}

function seedManuscriptEdits(): void {
  writeFileSync(
    join(bookDir, '.audiobook', 'manuscript-edits.json'),
    JSON.stringify({
      sentences: [
        { id: 1, chapterId: 1, characterId: 'narr', text: 'Alpha first.' },
        { id: 2, chapterId: 1, characterId: 'narr', text: 'Alpha second.' },
        { id: 1, chapterId: 2, characterId: 'narr', text: 'Beta first.' },
        { id: 2, chapterId: 2, characterId: 'sam', text: 'Beta second.' },
        { id: 1, chapterId: 3, characterId: 'narr', text: 'Gamma first.' },
        { id: 2, chapterId: 3, characterId: 'narr', text: 'Gamma second.' },
      ],
    }),
  );
}

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-hints-reparse-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const { chaptersRestructureRouter } = await import('./chapters-restructure.js');
  const { bookStateRouter } = await import('./book-state.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  cachePath = join(CACHE_DIR, `${MANUSCRIPT_ID}.json`);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });

  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
  app.use('/api/books', chaptersRestructureRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  if (cachePath && existsSync(cachePath)) rmSync(cachePath, { force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(async () => {
  removeSpy.fail = false;
  stateWriteSpy.fail = false;
  writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT_BODY);
  seedState();
  seedManuscriptEdits();
  if (existsSync(cachePath)) rmSync(cachePath, { force: true });
  rmSync(hintsPath(), { force: true });
  const { removeManuscript } = await import('../store/manuscripts.js');
  removeManuscript(MANUSCRIPT_ID);
});

afterEach(() => {
  removeSpy.fail = false;
  stateWriteSpy.fail = false;
});

async function mergeOneAndTwo(): Promise<void> {
  const res = await request(app)
    .post(`/api/books/${bookId}/chapters/merge`)
    .send({ chapterIds: [1, 2] });
  expect(res.status).toBe(200);
  expect(existsSync(hintsPath())).toBe(true);
}

describe('#3703 part 3 -- reparse / replace-manuscript drop manuscript-hints.json', () => {
  it('reparse deletes the hints file once the new chapter list has landed', async () => {
    await mergeOneAndTwo();

    const res = await request(app).post(`/api/books/${bookId}/reparse`);
    expect(res.status).toBe(200);
    expect(existsSync(hintsPath())).toBe(false);
    const state = JSON.parse(readFileSync(statePath(), 'utf8')) as { chapters: unknown[] };
    expect(state.chapters).toHaveLength(3);
  });

  it('a failed state.json write keeps the hints file, so a restart hydrates the restructured book', async () => {
    await mergeOneAndTwo();

    stateWriteSpy.fail = true;
    const res = await request(app).post(`/api/books/${bookId}/reparse`);
    expect(res.status).toBeGreaterThanOrEqual(500);
    stateWriteSpy.fail = false;

    // state.json still holds the merged structure (2 chapters) ...
    const state = JSON.parse(readFileSync(statePath(), 'utf8')) as { chapters: unknown[] };
    expect(state.chapters).toHaveLength(2);

    // ... and a restart hydrates exactly that structure, not a 3-chapter parse.
    const { removeManuscript, getOrHydrateManuscript } = await import('../store/manuscripts.js');
    removeManuscript(MANUSCRIPT_ID);
    const record = await getOrHydrateManuscript(MANUSCRIPT_ID);
    expect(record?.chapterHints).toHaveLength(2);
    expect(record!.chapterHints[0]!.body).toContain('Alpha first.');
    expect(record!.chapterHints[0]!.body).toContain('Beta first.');
  });

  it('replace-manuscript deletes the hints file', async () => {
    await mergeOneAndTwo();

    const res = await request(app)
      .post(`/api/books/${bookId}/replace-manuscript`)
      .attach('file', Buffer.from('# Fresh One\n\nHello there.\n\n# Fresh Two\n\nGeneral Kenobi.\n'), {
        filename: 'fresh.md',
        contentType: 'text/markdown',
      });
    expect(res.status).toBe(200);
    expect(existsSync(hintsPath())).toBe(false);
  });

  it('a failing hints remove does not fail the reparse; the leftover file shares no chapter uuid with the reparsed chapters', async () => {
    await mergeOneAndTwo();

    removeSpy.fail = true;
    const res = await request(app).post(`/api/books/${bookId}/reparse`);
    expect(res.status).toBe(200);
    removeSpy.fail = false;

    const state = JSON.parse(readFileSync(statePath(), 'utf8')) as { chapters: unknown[] };
    expect(state.chapters).toHaveLength(3);
    expect(existsSync(hintsPath())).toBe(true);

    const { removeManuscript, getOrHydrateManuscript } = await import('../store/manuscripts.js');
    removeManuscript(MANUSCRIPT_ID); // restart
    const record = await getOrHydrateManuscript(MANUSCRIPT_ID);
    expect(record?.chapterHints).toHaveLength(3);
  });
});

/* A reparse whose hints delete failed leaves the old file behind (#3828). The GET
   title refresh must treat it as ABSENT -- it shares no chapter uuid with the
   reparsed chapters, which are a fresh parse and so pair by position -- not as a
   stale restructure that skips without a bump forever. A stale restructure keeps
   its chapters' uuids and still skips. */
describe('GET title refresh with a hints file a reparse failed to delete (#3828)', () => {
  type S = { chapters: Array<{ title: string }>; chapterTitleParserVersion?: number };
  const readS = (): S => JSON.parse(readFileSync(statePath(), 'utf8'));
  function owingRefresh(titles: string[]): void {
    const st = readS();
    delete st.chapterTitleParserVersion;
    st.chapters.forEach((c, i) => {
      c.title = titles[i]!;
    });
    writeFileSync(statePath(), JSON.stringify(st));
  }

  it('refreshes by position and bumps the version', async () => {
    await mergeOneAndTwo();
    const oldHints = readFileSync(hintsPath());
    const reparse = await request(app).post(`/api/books/${bookId}/reparse`);
    expect(reparse.status).toBe(200);
    writeFileSync(hintsPath(), oldHints); // what a swallowed EPERM / EBUSY on the rm leaves
    const parsedTitles = readS().chapters.map((c) => c.title);
    owingRefresh(['Old 1', 'Old 2', 'Old 3']);
    const { removeManuscript } = await import('../store/manuscripts.js');
    removeManuscript(MANUSCRIPT_ID);

    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    expect(readS().chapters.map((c) => c.title)).toEqual(parsedTitles);
    expect(readS().chapterTitleParserVersion).toBe(CHAPTER_TITLE_PARSER_VERSION);
  });

  it('control: a stale restructure (its uuids still in state.json) still skips without a bump', async () => {
    /* A reorder keeps the chapter count, so only the stale-file rule -- not the
       positional count gate -- can be what skips: were the file read as absent,
       the positional path would write and bump. */
    const reorder = await request(app)
      .post(`/api/books/${bookId}/chapters/reorder`)
      .send({ order: [3, 1, 2] });
    expect(reorder.status).toBe(200);
    expect(existsSync(hintsPath())).toBe(true);
    const file = JSON.parse(readFileSync(hintsPath(), 'utf8')) as {
      entries: Array<{ sourceSha256: string }>;
    };
    for (const e of file.entries) e.sourceSha256 = 'deadbeef'; // the manuscript changed since
    writeFileSync(hintsPath(), JSON.stringify(file));
    owingRefresh(['Old 1', 'Old 2', 'Old 3']);
    const { removeManuscript } = await import('../store/manuscripts.js');
    removeManuscript(MANUSCRIPT_ID);
    const before = readFileSync(statePath());

    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    expect(readFileSync(statePath()).equals(before)).toBe(true);
    expect(readS().chapterTitleParserVersion).toBeUndefined();
  });
});

/* The cached record's `sourceSha256` is what a later restructure compares to the
   file on disk (chapters-restructure.ts): a record built without it, or from the
   wrong bytes, makes the restructure answer 200 yet persist nothing. */
describe('#3703 -- the record reparse / replace-manuscript cache carries the sha of the on-disk bytes', () => {
  const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

  it('reparse stamps the cached record, and a restructure right after persists a hints entry', async () => {
    const res = await request(app).post(`/api/books/${bookId}/reparse`);
    expect(res.status).toBe(200);

    const { getManuscript } = await import('../store/manuscripts.js');
    const onDisk = readFileSync(join(bookDir, 'manuscript.md'));
    expect(getManuscript(MANUSCRIPT_ID)?.sourceSha256).toBe(sha(onDisk));

    await mergeOneAndTwo(); // asserts the hints file now exists
    const file = JSON.parse(readFileSync(hintsPath(), 'utf8')) as {
      entries: { sourceSha256: string }[];
    };
    expect(file.entries[0]!.sourceSha256).toBe(sha(onDisk));
  });

  it('replace-manuscript stamps the RAW upload bytes (BOM + CRLF), not the decoded text', async () => {
    const upload = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('# Fresh One\r\n\r\nHello there.\r\n\r\n# Fresh Two\r\n\r\nGeneral Kenobi.\r\n'),
    ]);
    const res = await request(app)
      .post(`/api/books/${bookId}/replace-manuscript`)
      .attach('file', upload, { filename: 'fresh.md', contentType: 'text/markdown' });
    expect(res.status).toBe(200);

    const { getManuscript } = await import('../store/manuscripts.js');
    const record = getManuscript(MANUSCRIPT_ID);
    const onDisk = readFileSync(join(bookDir, 'manuscript.md'));
    expect(onDisk.equals(upload)).toBe(true);
    // the decoded text hashes differently, so hashing it instead cannot pass
    expect(sha(record!.sourceText)).not.toBe(sha(upload));
    expect(record?.sourceSha256).toBe(sha(upload));
  });
});
