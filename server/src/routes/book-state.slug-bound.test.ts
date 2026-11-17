/* #4341 (of #4319, spec §4.3 R4-4 / R5-8 / R6-5) - `PUT /:bookId/state`
   with `chapters` refuses, 409 `slug_bound` and nothing written, when it would
   separate a chapter from its audio. */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { CHAPTER_TITLE_PARSER_VERSION } from '../parsers/version.js';

const AUTHOR = 'Slug Bound Test';
const SERIES = 'Standalones';
const TITLE = 'Slug Bound Book';

type Ch = Record<string, unknown> & { id: number };

let workspaceRoot: string;
let app: Express;
let bookId: string;
let bookDir: string;

const seedChapters = (): Ch[] => [
  { id: 1, title: 'One', slug: '01-one', duration: '0:00', uuid: 'u-1' },
  { id: 2, title: 'Two', slug: '02-two', duration: '0:00', uuid: 'u-2' },
];

const statePathOf = (dir: string) => join(dir, '.audiobook', 'state.json');
const audioPath = (name: string) => join(bookDir, 'audio', name);

function writeState(chapters: Ch[]): void {
  writeFileSync(
    statePathOf(bookDir),
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
      chapterTitleParserVersion: CHAPTER_TITLE_PARSER_VERSION,
      chapters,
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
}

const rawState = () => readFileSync(statePathOf(bookDir), 'utf8');

const putChapters = (chapters: unknown) =>
  request(app).put(`/api/books/${bookId}/state`).send({ slice: 'state', patch: { chapters } });

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-slug-bound-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ bookStateRouter }, { makeBookId }] = await Promise.all([
    import('./book-state.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

beforeEach(() => {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  mkdirSync(join(bookDir, 'audio'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeState(seedChapters());
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

const expectRefused = async (chapters: unknown) => {
  const before = rawState();
  const res = await putChapters(chapters);
  expect(res.status).toBe(409);
  expect(res.body.error).toBe('slug_bound');
  expect(rawState()).toBe(before);
  return res;
};

describe('PUT /:bookId/state chapters - slug binding (#4341)', () => {
  it('B1. a matched chapter that moves to a free slug answers 409 slug_bound', async () => {
    const [c1, c2] = seedChapters();
    await expectRefused([{ ...c1, slug: '09-moved' }, c2]);
  });

  it('B1b. matches by uuid even when the id differs', async () => {
    const [c1, c2] = seedChapters();
    await expectRefused([{ ...c1, id: 7, slug: '07-one' }, c2]);
  });

  it('B2. a new chapter on a free slug with no take is accepted', async () => {
    const res = await putChapters([
      ...seedChapters(),
      { id: 3, title: 'Three', slug: '03-three', duration: '0:00' },
    ]);
    expect(res.status).toBe(200);
  });

  it('B3. a new chapter whose slug has a lone .previous.m4a on disk answers 409', async () => {
    writeFileSync(audioPath('03-three.previous.m4a'), 'x');
    await expectRefused([
      ...seedChapters(),
      { id: 3, title: 'Three', slug: '03-three', duration: '0:00' },
    ]);
  });

  it('B3b. a new chapter that takes a slug a disk chapter holds answers 409', async () => {
    const [c1] = seedChapters();
    await expectRefused([c1, { id: 3, title: 'Dup', slug: '02-two' }]);
  });

  it('B4. omitting a disk chapter with a live take answers 409', async () => {
    writeFileSync(audioPath('02-two.mp3'), 'x');
    await expectRefused([seedChapters()[0]]);
  });

  it('B4b. omitting a disk chapter with only a previous take answers 409', async () => {
    writeFileSync(audioPath('02-two.previous.mp3'), 'x');
    await expectRefused([seedChapters()[0]]);
  });

  it('B4c. omitting a disk chapter with no take is accepted', async () => {
    const res = await putChapters([seedChapters()[0]]);
    expect(res.status).toBe(200);
  });

  it('B5. flipping a matched chapter\'s excluded answers 409', async () => {
    const [c1, c2] = seedChapters();
    await expectRefused([{ ...c1, excluded: true }, c2]);
  });

  it('B6. an unchanged chapters round-trip is accepted', async () => {
    writeFileSync(audioPath('01-one.mp3'), 'x');
    const res = await putChapters(seedChapters());
    expect(res.status).toBe(200);
  });

  it('B7. the 409 body contains no workspace path', async () => {
    const [c1, c2] = seedChapters();
    const res = await expectRefused([{ ...c1, slug: '09-moved' }, c2]);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(workspaceRoot);
    expect(text).not.toContain(AUTHOR);
  });
});
