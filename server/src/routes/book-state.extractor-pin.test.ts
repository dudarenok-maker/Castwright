/* #4217 child 4 — explicit user actions (reparse, replace-manuscript) re-extract
   with version 2 and stamp state.json; the implicit title refresh passes the
   book's own stamp and writes none. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

vi.mock('../parsers/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../parsers/index.js')>();
  return { ...real, parseManuscript: vi.fn(real.parseManuscript) };
});

import { buildEpub } from '../test-utils/empty-href-epub.js';

const AUTHOR = 'Pin Test';
const SERIES = 'Standalones';
const TITLE = 'Pin Book';
const MANUSCRIPT_ID = 'm_extractor_pin_route';

const CHAPTER =
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>' +
  '<div class="p">First para one.</div><div class="p">First para two.</div></body></html>';

let workspaceRoot: string;
let bookDir: string;
let statePath: string;
let app: Express;
let bookId: string;
let epub: Buffer;
let parseManuscriptMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-extractor-pin-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { bookStateRouter } = await import('./book-state.js');
  const { makeBookId } = await import('../workspace/paths.js');
  const parsers = await import('../parsers/index.js');
  parseManuscriptMock = parsers.parseManuscript as unknown as ReturnType<typeof vi.fn>;
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  statePath = join(bookDir, '.audiobook', 'state.json');
  epub = await buildEpub([CHAPTER]);
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function writeState(extra: Record<string, unknown> = {}) {
  writeFileSync(
    statePath,
    JSON.stringify({
      bookId,
      manuscriptId: MANUSCRIPT_ID,
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.epub',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'One', slug: '01-one' }],
      coverGradient: ['#000', '#fff'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...extra,
    }),
  );
}
const readState = () => JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;

beforeEach(async () => {
  writeFileSync(join(bookDir, 'manuscript.epub'), epub);
  parseManuscriptMock.mockClear();
  const { removeManuscript } = await import('../store/manuscripts.js');
  removeManuscript(MANUSCRIPT_ID);
});

describe('explicit actions move to extractor v2 and stamp state.json', () => {
  it('R1: reparse on an unstamped book splits paragraphs and stamps 2', async () => {
    writeState();
    const res = await request(app).post(`/api/books/${bookId}/reparse`);
    expect(res.status).toBe(200);
    const { getManuscript } = await import('../store/manuscripts.js');
    expect(getManuscript(MANUSCRIPT_ID)!.sourceText).toContain('\n\n');
    expect(readState().manuscriptExtractorVersion).toBe(2);
  });

  it('R2: reparse on a book already stamped 2 stays split and stamped 2', async () => {
    writeState({ manuscriptExtractorVersion: 2 });
    const res = await request(app).post(`/api/books/${bookId}/reparse`);
    expect(res.status).toBe(200);
    const { getManuscript } = await import('../store/manuscripts.js');
    expect(getManuscript(MANUSCRIPT_ID)!.sourceText).toContain('\n\n');
    expect(readState().manuscriptExtractorVersion).toBe(2);
  });

  it('R3: replace-manuscript on an unstamped book splits paragraphs and stamps 2', async () => {
    writeState();
    const res = await request(app)
      .post(`/api/books/${bookId}/replace-manuscript`)
      .attach('file', epub, { filename: 'revised.epub', contentType: 'application/epub+zip' });
    expect(res.status).toBe(200);
    const { getManuscript } = await import('../store/manuscripts.js');
    expect(getManuscript(MANUSCRIPT_ID)!.sourceText).toContain('\n\n');
    expect(readState().manuscriptExtractorVersion).toBe(2);
  });
});

describe('implicit title refresh uses the book own stamp', () => {
  it('R4: passes extractorVersion 1 for an unstamped book and writes no stamp', async () => {
    writeState({ chapterTitleParserVersion: 1 });
    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    expect(parseManuscriptMock).toHaveBeenCalledWith(expect.objectContaining({ sourcePath: expect.any(String), extractorVersion: 1 }));
    expect('manuscriptExtractorVersion' in readState()).toBe(false);
  });

  it('R4: passes extractorVersion 2 for a book stamped 2', async () => {
    writeState({ chapterTitleParserVersion: 1, manuscriptExtractorVersion: 2 });
    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    expect(parseManuscriptMock).toHaveBeenCalledWith(expect.objectContaining({ sourcePath: expect.any(String), extractorVersion: 2 }));
  });
});

describe('PUT /state whitelist never moves the stamp', () => {
  /* I2 — mutation: let the `state` slice copy `manuscriptExtractorVersion` from
     the patch and this reads 1. */
  it('I2: a state patch carrying manuscriptExtractorVersion 1 leaves a stamped-2 book at 2', async () => {
    writeState({ manuscriptExtractorVersion: 2 });
    const res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .send({ slice: 'state', patch: { title: TITLE, manuscriptExtractorVersion: 1 } });
    expect(res.status).toBe(200);
    expect(readState().manuscriptExtractorVersion).toBe(2);
  });
});
