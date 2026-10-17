import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

/* Plan 286 Task 4 — hoisted passthrough mock so the plan-286 test below can
   force applyReparse's reset arm to reject. Defaults to the real
   implementation, so the other tests in this file are unaffected. */
vi.mock('../workspace/revisions-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workspace/revisions-store.js')>();
  return { ...real, resetRevisions: vi.fn(real.resetRevisions) };
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, '..', '..');
const CACHE_DIR = join(SERVER_ROOT, 'handoff', 'cache');

const AUTHOR = 'Replace Test';
const SERIES = 'Standalones';
const TITLE = 'Replace Book';
const MANUSCRIPT_ID = 'm_replace_test';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let cachePath: string;

const ORIGINAL_BODY = `# Chapter One\n\nOne.\nTwo.\n`;
const REPLACEMENT_BODY = `## Fresh Chapter A\n\nAlpha.\n\n## Fresh Chapter B\n\nBeta.\nGamma.\n`;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-replace-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Sequential, not `Promise.all` — this file carries a hoisted async-factory
     `vi.mock` (revisions-store.js, plan 286), which a `Promise.all` of dynamic
     imports races (#2083). */
  const { bookStateRouter } = await import('./book-state.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  cachePath = join(CACHE_DIR, `${MANUSCRIPT_ID}.json`);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  if (cachePath && existsSync(cachePath)) rmSync(cachePath, { force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  writeFileSync(join(bookDir, 'manuscript.md'), ORIGINAL_BODY);
  if (existsSync(join(bookDir, 'manuscript.epub'))) rmSync(join(bookDir, 'manuscript.epub'), { force: true });
  if (existsSync(join(bookDir, 'manuscript.txt'))) rmSync(join(bookDir, 'manuscript.txt'), { force: true });
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
      chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [
        {
          id: 'wren',
          name: 'Wren',
          voiceState: 'tuned',
          overrideTtsVoices: { qwen: { name: 'qwen-wren' } },
        },
      ],
    }),
  );
  for (const f of ['change-log.json', 'cast-reuse-carryover.json', 'revisions.json']) {
    const p = join(bookDir, '.audiobook', f);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  if (existsSync(cachePath)) rmSync(cachePath, { force: true });
});

/* A12 / plan 286 — one sentinel per sibling arm of applyReparse's Promise.all. */
function seedSiblingSentinels() {
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters: [] }));
  mkdirSync(join(bookDir, 'audio'), { recursive: true });
  writeFileSync(join(bookDir, 'audio', '01-chapter-one.mp3'), 'LIVE');
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath, '{}');
}
/* The 500 arrives when the reset arm rejects; wait until every sibling
   arm's last fs effect has landed, so none outlives the test. */
async function awaitSiblingArms() {
  await vi.waitFor(() => {
    expect(existsSync(join(bookDir, '.audiobook', 'cast.json'))).toBe(false);
    expect(existsSync(join(bookDir, 'audio'))).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
  });
}

describe('replace-manuscript handler', () => {
  it('replaces chapters from the uploaded file and resets castConfirmed', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/replace-manuscript`)
      .attach('file', Buffer.from(REPLACEMENT_BODY), 'revised.md');
    expect(res.status).toBe(200);
    expect(res.body.chapterCount).toBe(2);
    expect(res.body.chapterTitles).toEqual(['Fresh Chapter A', 'Fresh Chapter B']);

    const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.castConfirmed).toBe(false);
    expect(state.chapters).toHaveLength(2);
  });

  it('snapshots the designed-voice carryover before clearing cast.json', async () => {
    await request(app)
      .post(`/api/books/${bookId}/replace-manuscript`)
      .attach('file', Buffer.from(REPLACEMENT_BODY), 'revised.md');

    const carryoverPath = join(bookDir, '.audiobook', 'cast-reuse-carryover.json');
    expect(existsSync(carryoverPath)).toBe(true);
    const carryover = JSON.parse(readFileSync(carryoverPath, 'utf8'));
    expect(carryover.characters[0]).toMatchObject({
      id: 'wren',
      overrideTtsVoices: { qwen: { name: 'qwen-wren' } },
    });
    expect(existsSync(join(bookDir, '.audiobook', 'cast.json'))).toBe(false);
  });

  it('swaps the on-disk file and updates manuscriptFile when the extension changes', async () => {
    await request(app)
      .post(`/api/books/${bookId}/replace-manuscript`)
      .attach('file', Buffer.from(REPLACEMENT_BODY), 'revised.txt');

    expect(existsSync(join(bookDir, 'manuscript.md'))).toBe(false);
    expect(existsSync(join(bookDir, 'manuscript.txt'))).toBe(true);
    const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.manuscriptFile).toBe('manuscript.txt');
  });

  it('404s for an unknown book', async () => {
    const res = await request(app)
      .post(`/api/books/does-not-exist/replace-manuscript`)
      .attach('file', Buffer.from(REPLACEMENT_BODY), 'revised.md');
    expect(res.status).toBe(404);
  });

  it('400s when no file is attached', async () => {
    const res = await request(app).post(`/api/books/${bookId}/replace-manuscript`);
    expect(res.status).toBe(400);
  });

  it('plan 285 — replace resets revisions.json to a NEW fileId and never deletes it', async () => {
    const revisionsPath = join(bookDir, '.audiobook', 'revisions.json');
    const OLD = '000000000000001-aaaaaaaa';
    writeFileSync(
      revisionsPath,
      JSON.stringify({
        schema: 1,
        fileId: OLD,
        rev: 7,
        pending: [
          { id: 'revision:1:1', chapterId: 1, characterId: 'wren', playable: true, hasPreviousAudio: true, segments: [], origin: 'server' },
        ],
      }),
    );
    const res = await request(app)
      .post(`/api/books/${bookId}/replace-manuscript`)
      .attach('file', Buffer.from(REPLACEMENT_BODY), 'revised.md');
    expect(res.status).toBe(200);
    expect(existsSync(revisionsPath)).toBe(true);
    const after = JSON.parse(readFileSync(revisionsPath, 'utf8'));
    expect(after).toMatchObject({ schema: 1, rev: 0, pending: [] });
    expect(after.fileId).not.toBe(OLD);
  });

  it('plan 285 — replace refuses a NEWER-schema revisions.json BEFORE touching the manuscript or cast', async () => {
    const revisionsPath = join(bookDir, '.audiobook', 'revisions.json');
    writeFileSync(revisionsPath, JSON.stringify({ schema: 2, pending: [] }));
    const res = await request(app)
      .post(`/api/books/${bookId}/replace-manuscript`)
      .attach('file', Buffer.from(REPLACEMENT_BODY), 'revised.md');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/schema=2/);
    expect(readFileSync(join(bookDir, 'manuscript.md'), 'utf8')).toBe(ORIGINAL_BODY);
    expect(existsSync(join(bookDir, '.audiobook', 'cast.json'))).toBe(true);
  });

  /* Plan 286 (Task 4, invariant 8) — replace-manuscript reaches the same
     applyReparse reset arm as reparse; a path-bearing reset failure must not
     reach the client. */
  it('plan 286 — a revisions reset failure naming a path answers a fixed sentence', async () => {
    seedSiblingSentinels();
    const { resetRevisions } = await import('../workspace/revisions-store.js');
    vi.mocked(resetRevisions).mockRejectedValueOnce(
      Object.assign(
        new Error(
          "EPERM: operation not permitted, rename 'C:\\SECRET-WORKSPACE\\book\\.audiobook\\revisions.json.tmp'",
        ),
        { code: 'EPERM' },
      ),
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app)
      .post(`/api/books/${bookId}/replace-manuscript`)
      .attach('file', Buffer.from('# Chapter One\n\nNew text.'), 'revised.md');
    await awaitSiblingArms();
    err.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Couldn't reset this book's A/B review history." });
    expect(res.text).not.toContain('SECRET-WORKSPACE');
  });
});
