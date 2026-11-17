/* #4217 child 5 -- the restructure route's two parses (the legacy title-flag
   parse and refresh-titles' advisory parse) use the version the book's stamp
   names: absent = 1, a stamp of 2 = 2. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

vi.mock('../parsers/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../parsers/index.js')>();
  return { ...real, parseManuscript: vi.fn(real.parseManuscript) };
});

const AUTHOR = 'Restructure Pin Test';
const SERIES = 'Standalones';
const TITLE = 'Restructure Pin Book';
const MANUSCRIPT_ID = 'm_restructure_extractor_pin';

const MANUSCRIPT = [
  '# Restructure Pin Book',
  '',
  '# Harbour Lights',
  '',
  'It began.',
  'The harbour lights were burning low across the bay.',
  '',
  '# The Lighthouse',
  '',
  'It began.',
  'The lighthouse keeper climbed the spiral stairs slowly.',
  '',
].join('\n');

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let parseManuscriptMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-restructure-pin-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { chaptersRestructureRouter } = await import('./chapters-restructure.js');
  const { makeBookId } = await import('../workspace/paths.js');
  const parsers = await import('../parsers/index.js');
  parseManuscriptMock = parsers.parseManuscript as unknown as ReturnType<typeof vi.fn>;
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  app = express();
  app.use(express.json());
  app.use('/api/books', chaptersRestructureRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

/* Chapter 1 is keyless with a generic title (the legacy-flags trigger); chapter 2
   already carries its flag. */
function seed(extra: object, chapter1Title: string): void {
  rmSync(join(bookDir, '.audiobook'), { recursive: true, force: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT);
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
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
      language: null,
      schema: 1,
      chapters: [
        { id: 1, uuid: 'u-1', slug: '01-one', title: chapter1Title },
        { id: 2, uuid: 'u-2', slug: '02-two', title: 'The Lighthouse', titleSynthesized: false },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...extra,
    }),
  );
}

const post = (path: string, body: object) => request(app).post(`/api/books/${bookId}/${path}`).send(body);

/* Warm the record so the hydrate parse is out of the way, then forget every call:
   what is asserted afterwards is the route's own parse. */
async function warm(): Promise<void> {
  const { removeManuscript, getOrHydrateManuscript } = await import('../store/manuscripts.js');
  removeManuscript(MANUSCRIPT_ID);
  await getOrHydrateManuscript(MANUSCRIPT_ID);
  parseManuscriptMock.mockClear();
}

const versions = () =>
  parseManuscriptMock.mock.calls.map((c) => (c[0] as { extractorVersion?: number }).extractorVersion);

describe('refresh-titles advisory parse uses the book stamp', () => {
  beforeEach(() => {
    parseManuscriptMock.mockClear();
  });

  it('S2: an unstamped book parses with extractorVersion 1', async () => {
    seed({}, 'Harbour Lights');
    await warm();
    const res = await post('chapters/refresh-titles', {});
    expect([200, 409], JSON.stringify(res.body)).toContain(res.status); // the parse runs before the hints check
    expect(versions().length).toBeGreaterThan(0);
    expect(versions().every((v) => v === 1)).toBe(true);
  });

  it('S2: a book stamped 2 parses with extractorVersion 2', async () => {
    seed({ manuscriptExtractorVersion: 2 }, 'Harbour Lights');
    await warm();
    const res = await post('chapters/refresh-titles', {});
    expect([200, 409], JSON.stringify(res.body)).toContain(res.status); // the parse runs before the hints check
    expect(versions().length).toBeGreaterThan(0);
    expect(versions().every((v) => v === 2)).toBe(true);
  });
});

describe('a restructure that needs the legacy title-flag parse uses the book stamp', () => {
  it('S2: unstamped -> 1', async () => {
    seed({}, 'Chapter 1');
    await warm();
    const res = await post('chapters/2/rename', { title: 'A New Name' });
    expect([200, 409], JSON.stringify(res.body)).toContain(res.status); // the parse runs before the hints check
    expect(versions().length).toBeGreaterThan(0);
    expect(versions().every((v) => v === 1)).toBe(true);
  });

  it('S2: stamped 2 -> 2', async () => {
    seed({ manuscriptExtractorVersion: 2 }, 'Chapter 1');
    await warm();
    const res = await post('chapters/2/rename', { title: 'A New Name' });
    expect([200, 409], JSON.stringify(res.body)).toContain(res.status); // the parse runs before the hints check
    expect(versions().length).toBeGreaterThan(0);
    expect(versions().every((v) => v === 2)).toBe(true);
  });
});
