/* Integration tests for POST /:bookId/chapters/{merge,split,reorder}.
 *
 * Pins:
 *   - Each route end-to-end: state.json + manuscript-edits.json updated,
 *     audio rewritten per the op plan (delete for content-changed, rename
 *     for renumbered-only), analysis cache cleared.
 *   - Validation: malformed payloads → 400.
 *   - Three-write internal consistency: after each route, on-disk state's
 *     chapter ids and manuscript-edits.json's sentence.chapterId values
 *     agree (orphan sentences would be filtered by the GET reconciliation
 *     anyway, but writing a clean shape is the contract).
 *
 * Pattern mirrors book-state.reparse.test.ts: tempdir workspace, deferred
 * imports so paths.ts picks up WORKSPACE_DIR, supertest against the real
 * router. */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, '..', '..');
const CACHE_DIR = join(SERVER_ROOT, 'handoff', 'cache');

const AUTHOR = 'Restructure Test';
const SERIES = 'Standalones';
const TITLE = 'Restructure Test Book';
const MANUSCRIPT_ID = 'm_restructure_test';

let workspaceRoot: string;
let bookDir: string;
let audioRoot: string;
let app: Express;
let bookId: string;
let cachePath: string;

/* Three short chapters; chapter 1 + 2 have rendered audio, chapter 3
 * doesn't (mirrors a real partially-generated book). */
const MANUSCRIPT_BODY =
  '# Chapter One\n\nAlpha first.\nAlpha second.\n\n# Chapter Two\n\nBeta first.\nBeta second.\n\n# Chapter Three\n\nGamma first.\nGamma second.\n';

function seedState(): void {
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
      chapters: [
        {
          id: 1,
          title: 'Chapter One',
          slug: '01-chapter-one',
          audioModelKey: 'kokoro-v1',
          audioRenderedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 2,
          title: 'Chapter Two',
          slug: '02-chapter-two',
          audioModelKey: 'kokoro-v1',
          audioRenderedAt: '2026-01-01T00:00:00.000Z',
        },
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

function seedAudio(slug: string): void {
  mkdirSync(audioRoot, { recursive: true });
  writeFileSync(join(audioRoot, `${slug}.mp3`), `audio-${slug}`);
  writeFileSync(
    join(audioRoot, `${slug}.segments.json`),
    JSON.stringify({
      bookId,
      chapterId: 0, // we'll assert this gets rewritten on rename
      chapterTitle: 'OLD',
      durationSec: 5,
      sampleRate: 24000,
      modelKey: 'kokoro-v1',
      synthesizedAt: '2026-01-01T00:00:00.000Z',
      segments: [],
    }),
  );
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-restructure-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ chaptersRestructureRouter }, { bookStateRouter }, { makeBookId }] = await Promise.all([
    import('./chapters-restructure.js'),
    import('./book-state.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  cachePath = join(CACHE_DIR, `${MANUSCRIPT_ID}.json`);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  audioRoot = join(bookDir, 'audio');
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT_BODY);

  app = express();
  app.use(express.json());
  // Mount both routers so we can fetch state.json contents through the GET
  // handler when needed, and exercise the restructure POSTs.
  app.use('/api/books', bookStateRouter);
  app.use('/api/books', chaptersRestructureRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  if (cachePath && existsSync(cachePath)) rmSync(cachePath, { force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(async () => {
  seedState();
  seedManuscriptEdits();
  // Reset audio dir
  if (existsSync(audioRoot)) rmSync(audioRoot, { recursive: true, force: true });
  seedAudio('01-chapter-one');
  seedAudio('02-chapter-two');
  // chapter 3 deliberately has no audio
  if (existsSync(cachePath)) rmSync(cachePath, { force: true });
  // Evict the cached ManuscriptRecord so the next route call re-hydrates
  // ChapterHint[] from the manuscript file on disk — otherwise prior
  // tests' in-memory mutations leak into this case.
  const { removeManuscript } = await import('../store/manuscripts.js');
  removeManuscript(MANUSCRIPT_ID);
});

function readState(): {
  chapters: Array<{
    id: number;
    title: string;
    slug: string;
    audioModelKey?: string;
    audioRenderedAt?: string;
  }>;
} {
  return JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
}

function readEdits(): { sentences: Array<{ id: number; chapterId: number; text: string }> } {
  return JSON.parse(readFileSync(join(bookDir, '.audiobook', 'manuscript-edits.json'), 'utf8'));
}

/* -- merge ---------------------------------------------------------- */

describe('POST /:bookId/chapters/merge', () => {
  it('merges chapters 2+3: state + edits + audio updated', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [2, 3] });
    expect(res.status).toBe(200);
    expect(res.body.chapters).toHaveLength(2);
    expect(res.body.chapters[1].title).toBe('Chapter Two'); // inherits first member's title
    expect(res.body.sentenceRemap.length).toBeGreaterThan(0);

    // state.json on disk reflects the new shape
    const state = readState();
    expect(state.chapters.map((c) => c.id)).toEqual([1, 2]);
    expect(state.chapters[1].slug).toBe('02-chapter-two');
    // Merged chapter loses audio metadata (content changed)
    expect(state.chapters[1].audioModelKey).toBeUndefined();
    expect(state.chapters[1].audioRenderedAt).toBeUndefined();

    // manuscript-edits.json sentence list remapped
    const edits = readEdits();
    expect(edits.sentences.filter((s) => s.chapterId === 1)).toHaveLength(2);
    // Merged chapter 2 now has 4 sentences (2 from old 2 + 2 from old 3), renumbered 1..4
    const ch2 = edits.sentences.filter((s) => s.chapterId === 2);
    expect(ch2.map((s) => s.id)).toEqual([1, 2, 3, 4]);
    expect(ch2.map((s) => s.text)).toEqual([
      'Beta first.',
      'Beta second.',
      'Gamma first.',
      'Gamma second.',
    ]);

    // Audio: old 02-chapter-two deleted (was content-changed merge target)
    expect(existsSync(join(audioRoot, '02-chapter-two.mp3'))).toBe(false);
    // Old 03-chapter-three had no audio so nothing to delete
    // No new audio yet — must regenerate
  });

  it('renames tail audio when merge shifts subsequent chapters down', async () => {
    // Seed chapter 3 with audio so we can verify the renumber-only rename
    // path. Merge chapters 1+2 → 1; chapter 3 shifts to id 2 with its
    // audio renamed from 03-chapter-three to 02-chapter-three.
    seedAudio('03-chapter-three');
    const state = JSON.parse(
      readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'),
    );
    state.chapters[2].audioModelKey = 'kokoro-v1';
    state.chapters[2].audioRenderedAt = '2026-01-01T00:00:00.000Z';
    writeFileSync(join(bookDir, '.audiobook', 'state.json'), JSON.stringify(state));

    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [1, 2] });
    expect(res.status).toBe(200);

    const newState = readState();
    expect(newState.chapters).toHaveLength(2);
    // Chapter 3 is now chapter 2 (renumbered). Audio preserved + renamed.
    expect(newState.chapters[1].id).toBe(2);
    expect(newState.chapters[1].slug).toBe('02-chapter-three');
    expect(newState.chapters[1].audioModelKey).toBe('kokoro-v1');
    expect(newState.chapters[1].audioRenderedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(existsSync(join(audioRoot, '03-chapter-three.mp3'))).toBe(false);
    expect(existsSync(join(audioRoot, '02-chapter-three.mp3'))).toBe(true);

    // segments.json rewritten with new chapter id + title
    const seg = JSON.parse(
      readFileSync(join(audioRoot, '02-chapter-three.segments.json'), 'utf8'),
    );
    expect(seg.chapterId).toBe(2);
    expect(seg.chapterTitle).toBe('Chapter Three');
  });

  it('400 when fewer than 2 ids', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [1] });
    expect(res.status).toBe(400);
  });

  it('400 when ids are non-contiguous', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [1, 3] });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/contiguous/);
  });

  it('400 when payload is missing chapterIds', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('404 when book does not exist', async () => {
    const res = await request(app)
      .post(`/api/books/no-such-book/chapters/merge`)
      .send({ chapterIds: [1, 2] });
    expect(res.status).toBe(404);
  });
});

/* -- split ---------------------------------------------------------- */

describe('POST /:bookId/chapters/split', () => {
  it('splits chapter 2 after sentence 1: chapter count up by 1, audio deleted', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/split`)
      .send({ chapterId: 2, afterSentenceId: 1 });
    expect(res.status).toBe(200);
    const state = readState();
    expect(state.chapters).toHaveLength(4);
    expect(state.chapters.map((c) => c.id)).toEqual([1, 2, 3, 4]);
    // Chapter 2 first half retains title; new chapter 3 gets "(cont.)"
    expect(state.chapters[1].title).toBe('Chapter Two');
    expect(state.chapters[2].title).toBe('Chapter Two (cont.)');
    // Chapter 2 lost audio (content changed)
    expect(state.chapters[1].audioModelKey).toBeUndefined();
    // Old chapter 3 (now id 4) keeps its audio metadata? It had none originally
    // so it's still absent — but its slug should reflect new id.
    expect(state.chapters[3].slug).toBe('04-chapter-three');
    // Audio: 02-chapter-two deleted (content changed); no new audio created
    expect(existsSync(join(audioRoot, '02-chapter-two.mp3'))).toBe(false);
    // 01-chapter-one untouched
    expect(existsSync(join(audioRoot, '01-chapter-one.mp3'))).toBe(true);

    // Sentence remap: original (2,1) stays in chapter 2; original (2,2) moves to chapter 3 with sentence id 1
    const edits = readEdits();
    const ch2 = edits.sentences.filter((s) => s.chapterId === 2);
    const ch3 = edits.sentences.filter((s) => s.chapterId === 3);
    expect(ch2).toEqual([{ id: 1, chapterId: 2, characterId: 'narr', text: 'Beta first.' }]);
    expect(ch3).toEqual([{ id: 1, chapterId: 3, characterId: 'sam', text: 'Beta second.' }]);
  });

  it('400 when splitting after the last sentence', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/split`)
      .send({ chapterId: 2, afterSentenceId: 2 });
    expect(res.status).toBe(400);
  });

  it('400 when sentence id not in chapter', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/split`)
      .send({ chapterId: 2, afterSentenceId: 99 });
    expect(res.status).toBe(400);
  });

  it('400 when payload is malformed', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/split`)
      .send({ chapterId: 'not-a-number' });
    expect(res.status).toBe(400);
  });
});

/* -- reorder -------------------------------------------------------- */

describe('POST /:bookId/chapters/reorder', () => {
  it('reorders [3,1,2] → ids 1..3: ALL audio renamed (no deletes), sentence chapterIds remapped', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/reorder`)
      .send({ order: [3, 1, 2] });
    expect(res.status).toBe(200);
    const state = readState();
    expect(state.chapters.map((c) => c.title)).toEqual([
      'Chapter Three',
      'Chapter One',
      'Chapter Two',
    ]);
    expect(state.chapters[1].slug).toBe('02-chapter-one');
    expect(state.chapters[2].slug).toBe('03-chapter-two');
    // Audio metadata preserved on reordered chapters
    expect(state.chapters[1].audioModelKey).toBe('kokoro-v1');
    expect(state.chapters[2].audioModelKey).toBe('kokoro-v1');

    // Audio files renamed (not deleted). Chapter 3 had no audio so 01-c-three has none.
    expect(existsSync(join(audioRoot, '01-chapter-one.mp3'))).toBe(false);
    expect(existsSync(join(audioRoot, '02-chapter-one.mp3'))).toBe(true);
    expect(existsSync(join(audioRoot, '03-chapter-two.mp3'))).toBe(true);
    // No temp .relabel-* files left over
    const audioFiles = readdirSync(audioRoot);
    expect(audioFiles.filter((n) => /\.relabel-/.test(n))).toEqual([]);

    // segments.json metadata rewritten for renamed files
    const seg = JSON.parse(
      readFileSync(join(audioRoot, '02-chapter-one.segments.json'), 'utf8'),
    );
    expect(seg.chapterId).toBe(2);
    expect(seg.chapterTitle).toBe('Chapter One');

    // Sentence chapterIds remapped
    const edits = readEdits();
    // Old chapter 1 sentences → new chapter 2; old 2 → new 3; old 3 → new 1
    const ch1 = edits.sentences.filter((s) => s.chapterId === 1);
    const ch2 = edits.sentences.filter((s) => s.chapterId === 2);
    const ch3 = edits.sentences.filter((s) => s.chapterId === 3);
    expect(ch1.map((s) => s.text)).toEqual(['Gamma first.', 'Gamma second.']);
    expect(ch2.map((s) => s.text)).toEqual(['Alpha first.', 'Alpha second.']);
    expect(ch3.map((s) => s.text)).toEqual(['Beta first.', 'Beta second.']);
  });

  it('400 when order length mismatches chapter count', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/reorder`)
      .send({ order: [1, 2] });
    expect(res.status).toBe(400);
  });

  it('400 when order contains duplicates', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/reorder`)
      .send({ order: [1, 1, 2] });
    expect(res.status).toBe(400);
  });

  it('400 when order is missing a chapter id', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/reorder`)
      .send({ order: [1, 2, 99] });
    expect(res.status).toBe(400);
  });

  it('400 when payload has no order array', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/reorder`)
      .send({});
    expect(res.status).toBe(400);
  });
});

/* -- cross-cutting -------------------------------------------------- */

describe('chapters-restructure shared behaviour', () => {
  it('clears the analysis cache after any structural change', async () => {
    // Seed a fake analysis cache file so we can verify it gets removed
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({ chapters: { 1: [{ id: 1, chapterId: 1, characterId: 'narr', text: 'x' }] } }),
    );
    expect(existsSync(cachePath)).toBe(true);

    await request(app)
      .post(`/api/books/${bookId}/chapters/reorder`)
      .send({ order: [3, 1, 2] });
    expect(existsSync(cachePath)).toBe(false);
  });

  it('keeps state.json and manuscript-edits.json internally consistent', async () => {
    await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [1, 2] });
    const state = readState();
    const edits = readEdits();
    const validChapterIds = new Set(state.chapters.map((c) => c.id));
    for (const sent of edits.sentences) {
      expect(validChapterIds.has(sent.chapterId)).toBe(true);
    }
  });
});
