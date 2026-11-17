/* GET /:bookId/state `paragraphsMergedChapters` (#2254, spec §3.2 "Tests").
   One book per case: state.json is rewritten in beforeEach and a fresh record is
   put into the store per test. A `parse`-hinted record is built with
   `putManuscript({ hintsSource: 'parse', parseTitles })` directly. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

vi.mock('../analyzer/dialogue-structure/legibility.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../analyzer/dialogue-structure/legibility.js')>();
  return { ...real, isParagraphDegraded: vi.fn(real.isParagraphDegraded) };
});

const AUTHOR = 'Merged Test';
const SERIES = 'Standalones';
const TITLE = 'Merged Paragraphs Book';
const MANUSCRIPT_ID = 'm_paragraphs_merged_test';

/* 12 turn openers inside one paragraph: degraded (>= 10). */
const MERGED = '— Привет.' + ' — Да.'.repeat(12);
const CLEAN = 'Он вошёл в комнату и сел у окна.';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let putManuscript: typeof import('../store/manuscripts.js').putManuscript;
let removeManuscript: typeof import('../store/manuscripts.js').removeManuscript;
let isParagraphDegraded: ReturnType<typeof vi.fn>;
let realIsParagraphDegraded: (body: string, language: string) => boolean | undefined;
let NOTICE_LANGUAGES: readonly string[];

type Ch = { id: number; title: string; slug: string; excluded?: boolean; titleOverridden?: boolean };
const CHAPTERS: Ch[] = [
  { id: 1, title: 'One', slug: '01-one' },
  { id: 2, title: 'Two', slug: '02-two' },
  { id: 3, title: 'Three', slug: '03-three' },
];

function writeState(over: { language?: string | null; chapters?: Ch[] } = {}): void {
  const state: Record<string, unknown> = {
    bookId,
    manuscriptId: MANUSCRIPT_ID,
    title: TITLE,
    author: AUTHOR,
    series: SERIES,
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile: 'manuscript.md',
    castConfirmed: true,
    chapters: over.chapters ?? CHAPTERS,
    coverGradient: ['#000', '#fff'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const language = 'language' in over ? over.language : 'ru';
  if (language !== undefined) state.language = language;
  writeFileSync(join(bookDir, '.audiobook', 'state.json'), JSON.stringify(state));
}

function readState(): { chapters: Ch[] } & Record<string, unknown> {
  return JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
}

function saveState(state: unknown): void {
  writeFileSync(join(bookDir, '.audiobook', 'state.json'), JSON.stringify(state));
}

function put(
  opts: {
    bodies?: string[];
    hintsSource?: 'persisted' | 'parse';
    parseTitles?: Array<string | null>;
  } = {},
): void {
  const bodies = opts.bodies ?? [CLEAN, MERGED, CLEAN];
  putManuscript({
    manuscriptId: MANUSCRIPT_ID,
    format: 'markdown',
    title: TITLE,
    wordCount: 10,
    byteSize: 10,
    uploadedAt: new Date().toISOString(),
    sourceText: bodies.join('\n\n'),
    chapterHints: bodies.map((body, i) => ({ id: i + 1, title: CHAPTERS[i]?.title ?? `C${i + 1}`, body })),
    ...(opts.hintsSource ? { hintsSource: opts.hintsSource } : {}),
    ...(opts.parseTitles ? { parseTitles: opts.parseTitles } : {}),
  });
}

async function getMerged(): Promise<number[] | undefined> {
  const res = await request(app).get(`/api/books/${bookId}/state`);
  expect(res.status).toBe(200);
  return res.body.paragraphsMergedChapters;
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-merged-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { bookStateRouter } = await import('./book-state.js');
  const { makeBookId } = await import('../workspace/paths.js');
  const manuscripts = await import('../store/manuscripts.js');
  putManuscript = manuscripts.putManuscript;
  removeManuscript = manuscripts.removeManuscript;
  const legibility = await import('../analyzer/dialogue-structure/legibility.js');
  isParagraphDegraded = legibility.isParagraphDegraded as unknown as ReturnType<typeof vi.fn>;
  NOTICE_LANGUAGES = legibility.NOTICE_LANGUAGES;
  realIsParagraphDegraded = (
    await vi.importActual<typeof import('../analyzer/dialogue-structure/legibility.js')>(
      '../analyzer/dialogue-structure/legibility.js',
    )
  ).isParagraphDegraded;
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), '# One\n\nText.\n');
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(() => {
  removeManuscript?.(MANUSCRIPT_ID);
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  writeState();
  removeManuscript(MANUSCRIPT_ID);
  isParagraphDegraded.mockClear();
});

describe('GET /:bookId/state paragraphsMergedChapters', () => {
  it('lists the chapter whose body has a 12-opener line (ru)', async () => {
    put();
    expect(await getMerged()).toEqual([2]);
  });

  it('is absent for an English book', async () => {
    writeState({ language: 'en' });
    put();
    expect(await getMerged()).toBeUndefined();
  });

  it('is absent when the book language is null', async () => {
    writeState({ language: null });
    put();
    expect(await getMerged()).toBeUndefined();
  });

  it('is absent when the book has no language key', async () => {
    writeState({ language: undefined });
    put();
    expect(await getMerged()).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['missing', undefined],
  ] as const)(
    'an unset (%s) language reads as not measured even if the default "en" were a notice language',
    async (_label, language) => {
      /* bookStateLanguage() defaults an unset language to 'en'. Make 'en' a
         notice language and force every body to measure as degraded, so that
         reading would emit ids; the null-aware reading must still omit the key. */
      const notice = NOTICE_LANGUAGES as string[];
      notice.push('en');
      isParagraphDegraded.mockImplementation(() => true);
      try {
        writeState({ language });
        put();
        expect(await getMerged()).toBeUndefined();
      } finally {
        notice.splice(notice.indexOf('en'), 1);
        isParagraphDegraded.mockReset();
        isParagraphDegraded.mockImplementation(realIsParagraphDegraded);
      }
    },
  );

  it('is absent when there is no usable manuscript record', async () => {
    /* No record in the store, and the hydrate fallback finds a one-chapter
       parse with no merged turns. */
    expect(await getMerged()).toBeUndefined();
  });

  it('omits excluded chapters, including after an exclude toggle on the same cached record', async () => {
    put();
    expect(await getMerged()).toEqual([2]);
    /* Rewrite state.json directly: the cached record is NOT replaced. */
    const state = readState();
    state.chapters[1].excluded = true;
    saveState(state);
    expect(await getMerged()).toBeUndefined();
  });

  it('is absent for a parse-hinted record whose chapter count differs from state.json', async () => {
    put({ bodies: [CLEAN, MERGED], hintsSource: 'parse', parseTitles: ['One', 'Two'] });
    expect(await getMerged()).toBeUndefined();
  });

  it('is absent for a parse-hinted same-count record whose parse titles do not pair', async () => {
    put({ hintsSource: 'parse', parseTitles: ['One', 'Zwei', 'Three'] });
    expect(await getMerged()).toBeUndefined();
  });

  it('re-pairs per request on a cached record: titleOverridden makes it appear, reverting hides it', async () => {
    put({ hintsSource: 'parse', parseTitles: ['One', 'Zwei', 'Three'] });
    expect(await getMerged()).toBeUndefined();
    const state = readState();
    state.chapters[1].titleOverridden = true;
    saveState(state);
    expect(await getMerged()).toEqual([2]);
    delete state.chapters[1].titleOverridden;
    saveState(state);
    expect(await getMerged()).toBeUndefined();
  });

  it('computes once per record: two requests measure each chapter once', async () => {
    put();
    await getMerged();
    await getMerged();
    expect(isParagraphDegraded).toHaveBeenCalledTimes(CHAPTERS.length);
  });

  it('recomputes for a replaced record', async () => {
    put();
    await getMerged();
    const before = isParagraphDegraded.mock.calls.length;
    put({ bodies: [MERGED, CLEAN, CLEAN] });
    expect(await getMerged()).toEqual([1]);
    expect(isParagraphDegraded.mock.calls.length).toBeGreaterThan(before);
  });

  it('recomputes when the book language changes under the same record', async () => {
    put();
    await getMerged();
    const before = isParagraphDegraded.mock.calls.length;
    writeState({ language: 'ru-RU' });
    expect(await getMerged()).toEqual([2]);
    expect(isParagraphDegraded.mock.calls.length).toBeGreaterThan(before);
  });
});
