/* #3828 -- the parse-origin lifecycle, end to end through the real routes and with
 * NO `removeManuscript` between steps, so the in-memory record each route stamped
 * (import, reparse) is what the first restructure persists:
 *
 *   - import / reparse stamp every hint with `parseIndex`; the first restructure
 *     writes it, with the parse's chapter count, into manuscript-hints.json;
 *   - reorder carries it, so a refresh under a CHANGED parser (the hint bodies
 *     rewritten to look like an older parser's, state.json titles stale and no
 *     version stamp) still gives each chapter its own title;
 *   - merge and split drop it, so a merged chapter, and both halves of a split,
 *     keep their titles instead of adopting a sibling's heading.
 *
 * Without the stamp the first restructure writes an origin-less file and the book
 * stays on the body pairing for good. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { CHAPTER_TITLE_PARSER_VERSION } from '../parsers/version.js';

let workspaceRoot: string;
let app: Express;
let seq = 0;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-origin-lifecycle-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ importRouter }, { bookStateRouter }, { chaptersRestructureRouter }] = await Promise.all([
    import('./import.js'),
    import('./book-state.js'),
    import('./chapters-restructure.js'),
  ]);
  app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api', importRouter);
  app.use('/api/books', bookStateRouter);
  app.use('/api/books', chaptersRestructureRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

/* `##`: a leading single `#` is read as the book's title, not a chapter. */
const MD =
  '# A Book\n\n## Alpha\n\nAlpha first.\nAlpha second.\n\n## Beta\n\nBeta first.\nBeta second.\n\n## Gamma\n\nGamma first.\nGamma second.\n';

type Book = { bookId: string; bookDir: string };
type StateFile = {
  chapters: Array<{ title: string; titleSynthesized?: boolean }>;
  chapterTitleParserVersion?: number;
};
type HintsFile = {
  entries: Array<{ parseChapterCount?: number; chapters: Array<{ body: string; parseIndex?: number }> }>;
};

async function importBook(): Promise<Book> {
  const staged = await request(app).post('/api/import').send({ text: MD, fileName: 'book.md' });
  expect(staged.status).toBe(200);
  const confirmed = await request(app)
    .post('/api/books')
    .send({
      tempId: staged.body.tempId,
      author: 'Origin Author',
      title: `Origin Book ${++seq}`,
      seriesPosition: null,
      isStandalone: true,
    });
  expect(confirmed.status).toBe(201);
  const book = { bookId: confirmed.body.bookId as string, bookDir: confirmed.body.paths.bookDir as string };
  /* Split needs the chapter's sentences. */
  writeFileSync(
    join(book.bookDir, '.audiobook', 'manuscript-edits.json'),
    JSON.stringify({
      sentences: ['Alpha', 'Beta', 'Gamma'].flatMap((name, c) => [
        { id: 1, chapterId: c + 1, characterId: 'narr', text: `${name} first.` },
        { id: 2, chapterId: c + 1, characterId: 'narr', text: `${name} second.` },
      ]),
    }),
  );
  return book;
}

const statePath = (b: Book): string => join(b.bookDir, '.audiobook', 'state.json');
const hintsPath = (b: Book): string => join(b.bookDir, '.audiobook', 'manuscript-hints.json');
const readState = (b: Book): StateFile => JSON.parse(readFileSync(statePath(b), 'utf8'));

function readHints(b: Book): HintsFile {
  return JSON.parse(readFileSync(hintsPath(b), 'utf8')) as HintsFile;
}

/* The book as an older release left it: the hint bodies as an older parser wrote
   them, the titles stale (`stale[i]`, or kept where undefined), no version stamp. */
function asLeftByOlderParser(b: Book, stale: Array<string | undefined>): void {
  const hints = readHints(b);
  for (const e of hints.entries) for (const c of e.chapters) c.body = `${c.body} (older parser)`;
  writeFileSync(hintsPath(b), JSON.stringify(hints));
  const s = readState(b);
  delete s.chapterTitleParserVersion;
  s.chapters.forEach((c, i) => {
    if (stale[i] !== undefined) c.title = stale[i]!;
  });
  writeFileSync(statePath(b), JSON.stringify(s));
}

async function post(b: Book, route: string, payload?: object): Promise<void> {
  const res = await request(app).post(`/api/books/${b.bookId}/${route}`).send(payload ?? {});
  expect(res.status).toBe(200);
}

async function refreshedTitles(b: Book): Promise<string[]> {
  const res = await request(app).get(`/api/books/${b.bookId}/state`);
  expect(res.status).toBe(200);
  expect(readState(b).chapterTitleParserVersion).toBe(CHAPTER_TITLE_PARSER_VERSION);
  return readState(b).chapters.map((c) => c.title);
}

describe('parse origin: import / reparse -> restructure -> refresh under a changed parser (#3828)', () => {
  it('import stamps the origin the first reorder persists, and the refresh keeps each chapter\'s title', async () => {
    const book = await importBook();
    await post(book, 'chapters/reorder', { order: [3, 1, 2] });

    const entry = readHints(book).entries[0]!;
    expect(entry.parseChapterCount).toBe(3);
    expect(entry.chapters.map((c) => c.parseIndex)).toEqual([2, 0, 1]);

    asLeftByOlderParser(book, ['Chapter 1', 'Chapter 2', 'Chapter 3']);
    expect(await refreshedTitles(book)).toEqual(['Gamma', 'Alpha', 'Beta']);
  });

  it('reparse stamps the origin the first reorder persists, and the refresh keeps each chapter\'s title', async () => {
    const book = await importBook();
    await post(book, 'reparse');
    await post(book, 'chapters/reorder', { order: [3, 1, 2] });

    const entry = readHints(book).entries[0]!;
    expect(entry.parseChapterCount).toBe(3);
    expect(entry.chapters.map((c) => c.parseIndex)).toEqual([2, 0, 1]);

    asLeftByOlderParser(book, ['Chapter 1', 'Chapter 2', 'Chapter 3']);
    expect(await refreshedTitles(book)).toEqual(['Gamma', 'Alpha', 'Beta']);
  });
});

describe('parse origin: merge and split drop it (#3828)', () => {
  it('a split\'s "(cont.)" half keeps its title; the untouched chapters refresh', async () => {
    const book = await importBook();
    await post(book, 'chapters/split', { chapterId: 2, afterSentenceId: 1 });
    expect(readState(book).chapters.map((c) => c.title)).toEqual(['Alpha', 'Beta', 'Beta (cont.)', 'Gamma']);

    const entry = readHints(book).entries[0]!;
    expect(entry.parseChapterCount).toBe(3);
    expect(entry.chapters.map((c) => c.parseIndex)).toEqual([0, undefined, undefined, 2]);

    asLeftByOlderParser(book, ['Old A', undefined, undefined, 'Old G']);
    expect(await refreshedTitles(book)).toEqual(['Alpha', 'Beta', 'Beta (cont.)', 'Gamma']);
  });

  it('a merged chapter keeps its title; its neighbour refreshes', async () => {
    const book = await importBook();
    await post(book, 'chapters/merge', { chapterIds: [1, 2], mergedTitle: 'Alpha and Beta' });

    const entry = readHints(book).entries[0]!;
    expect(entry.parseChapterCount).toBe(3);
    expect(entry.chapters.map((c) => c.parseIndex)).toEqual([undefined, 2]);

    asLeftByOlderParser(book, [undefined, 'Old G']);
    expect(await refreshedTitles(book)).toEqual(['Alpha and Beta', 'Gamma']);
  });
});
