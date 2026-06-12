/* Integration tests for POST /:bookId/chapters/{merge,split,reorder}.
 *
 * Pins:
 *   - Each route end-to-end: state.json + manuscript-edits.json updated,
 *     audio rewritten per the op plan (delete for content-changed, rename
 *     for renumbered-only), analysis cache rebuilt from manuscript-edits
 *     (plan 70c — earlier code wiped the cache outright, which halted
 *     post-restructure generation).
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
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
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
  /* Plan 45 (vitest pool tuning) — async mkdtemp under Windows tmpdir contention. */
  workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-restructure-test-'));
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
    uuid?: string;
    audioModelKey?: string;
    audioRenderedAt?: string;
    excluded?: boolean;
    titleOverridden?: boolean;
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

  it('srv-35: migrates a legacy (uuid-less) book and carries uuid by identity through reorder', async () => {
    // The seeded state.json has no uuids (legacy book).
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/reorder`)
      .send({ order: [3, 1, 2] });
    expect(res.status).toBe(200);

    const state = readState();
    const UUID_RE = /^[0-9a-f-]{36}$/i;
    // Every chapter now carries a uuid (lazy migration via applyRestructure).
    for (const c of state.chapters) expect(c.uuid).toMatch(UUID_RE);
    // They are distinct (no shared/empty placeholder).
    const uuids = state.chapters.map((c) => c.uuid);
    expect(new Set(uuids).size).toBe(3);
    // old Chapter Two (now id 3) and old Chapter One (now id 2) kept their
    // identities — uuid follows the title, not the position.
    const byTitle = new Map(state.chapters.map((c) => [c.title, c.uuid]));

    // A second reorder back to original order preserves those same uuids.
    await request(app)
      .post(`/api/books/${bookId}/chapters/reorder`)
      .send({ order: [2, 3, 1] });
    const state2 = readState();
    const byTitle2 = new Map(state2.chapters.map((c) => [c.title, c.uuid]));
    expect(byTitle2.get('Chapter One')).toBe(byTitle.get('Chapter One'));
    expect(byTitle2.get('Chapter Two')).toBe(byTitle.get('Chapter Two'));
    expect(byTitle2.get('Chapter Three')).toBe(byTitle.get('Chapter Three'));
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
  it('rebuilds the analysis cache from manuscript-edits.json after a reorder (plan 70c)', async () => {
    /* Plan 70c — the cache used to be deleted outright on every structural
       change, which halted post-restructure generation. It must now be
       rebuilt from manuscript-edits.json so generation finds sentences
       keyed by the new chapter ids. */
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({
        chapters: { 1: [{ id: 1, chapterId: 1, characterId: 'narr', text: 'stale' }] },
      }),
    );
    expect(existsSync(cachePath)).toBe(true);

    await request(app).post(`/api/books/${bookId}/chapters/reorder`).send({ order: [3, 1, 2] });
    expect(existsSync(cachePath)).toBe(true);

    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      chapters: Record<string, Array<{ id: number; chapterId: number; text: string }>>;
    };
    expect(Object.keys(cache.chapters).sort()).toEqual(['1', '2', '3']);
    // After reorder [3,1,2], original chapter 3 is now chapter 1.
    expect(cache.chapters['1'].map((s) => s.text)).toEqual(['Gamma first.', 'Gamma second.']);
    expect(cache.chapters['2'].map((s) => s.text)).toEqual(['Alpha first.', 'Alpha second.']);
    expect(cache.chapters['3'].map((s) => s.text)).toEqual(['Beta first.', 'Beta second.']);
  });

  it('cache survives merge — merged chapter holds both sources concatenated (plan 70c)', async () => {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({
        chapters: { 1: [{ id: 1, chapterId: 1, characterId: 'narr', text: 'stale' }] },
      }),
    );
    await request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [2, 3] });
    expect(existsSync(cachePath)).toBe(true);

    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      chapters: Record<string, Array<{ id: number; chapterId: number; characterId: string; text: string }>>;
    };
    expect(Object.keys(cache.chapters).sort()).toEqual(['1', '2']);
    expect(cache.chapters['1'].map((s) => s.text)).toEqual(['Alpha first.', 'Alpha second.']);
    // Merged chapter 2 = original chapter 2's sentences + original chapter 3's
    // sentences, renumbered 1..4. characterId tags preserved per sentence.
    expect(cache.chapters['2'].map((s) => s.id)).toEqual([1, 2, 3, 4]);
    expect(cache.chapters['2'].map((s) => s.text)).toEqual([
      'Beta first.',
      'Beta second.',
      'Gamma first.',
      'Gamma second.',
    ]);
    expect(cache.chapters['2'][1].characterId).toBe('sam');
  });

  it('cache survives split — sentences partitioned at the split boundary (plan 70c)', async () => {
    mkdirSync(CACHE_DIR, { recursive: true });
    await request(app)
      .post(`/api/books/${bookId}/chapters/split`)
      .send({ chapterId: 2, afterSentenceId: 1 });
    expect(existsSync(cachePath)).toBe(true);

    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      chapters: Record<string, Array<{ id: number; text: string }>>;
    };
    // Pre-split: 3 chapters with 2 sentences each. Split chapter 2 after id 1
    // → 4 chapters, with old (2,1) staying as chapter 2 and old (2,2)
    // becoming chapter 3 sentence 1.
    expect(Object.keys(cache.chapters).sort()).toEqual(['1', '2', '3', '4']);
    expect(cache.chapters['2'].map((s) => s.text)).toEqual(['Beta first.']);
    expect(cache.chapters['3'].map((s) => s.text)).toEqual(['Beta second.']);
    expect(cache.chapters['4'].map((s) => s.text)).toEqual(['Gamma first.', 'Gamma second.']);
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

/* -- plan 70a: orphan recovery + prune-empty + renumber-generic ----- */

describe('plan 70a — orphan recovery (Part F)', () => {
  it('recovers sentences whose chapterId is not in current state — attaches to nearest preceding survivor', async () => {
    /* Seed manuscript-edits with sentences referencing stale chapter ids
       (99, 100) — simulates the user's screenshot scenario where prior
       restructure operations left orphan sentences pointing at chapters
       that no longer exist. After merge, those sentences should be
       recovered onto the nearest preceding surviving chapter rather
       than silently dropped. */
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
          // Orphans — chapter 99 doesn't exist in state
          { id: 1, chapterId: 99, characterId: 'narr', text: 'Orphan one.' },
          { id: 2, chapterId: 99, characterId: 'narr', text: 'Orphan two.' },
        ],
      }),
    );

    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [1, 2] });
    expect(res.status).toBe(200);
    expect(res.body.warnings).toBeDefined();
    const orphanWarning = (res.body.warnings as string[]).find((w) => /orphaned/i.test(w));
    expect(orphanWarning).toBeDefined();
    expect(orphanWarning).toMatch(/2 orphaned/);

    // All 8 sentences survive — 6 originals + 2 recovered orphans.
    const edits = readEdits();
    expect(edits.sentences).toHaveLength(8);

    // Orphans attached to nearest preceding survivor. Old chapter 99 has
    // no preceding survivor (3 is the highest known id), so the orphans
    // fall back to chapter 3 (the highest known id ≤ 99). Chapter 3 in
    // pre-merge becomes chapter 2 post-merge (after merging 1+2).
    const orphanSentences = edits.sentences.filter((s) =>
      /^Orphan /.test(s.text),
    );
    expect(orphanSentences).toHaveLength(2);
    // Both orphans land in the same post-merge chapter.
    const orphanChapterIds = new Set(orphanSentences.map((s) => s.chapterId));
    expect(orphanChapterIds.size).toBe(1);
  });

  it('preserves the original oldChapterId in the response remap for orphans', async () => {
    /* The remap is what the frontend's manuscript-slice consumes to
       rewrite sentence chapterId pointers. If we silently rewrite the
       orphan's oldChapterId in the remap, the frontend's
       `(originalOldChapterId, oldSentenceId)` lookup wouldn't resolve
       and the frontend would drop the orphan a second time. */
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
          { id: 5, chapterId: 77, characterId: 'narr', text: 'Stale.' },
        ],
      }),
    );

    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [1, 2] });
    expect(res.status).toBe(200);
    const remap = res.body.sentenceRemap as Array<{
      oldChapterId: number;
      oldSentenceId: number;
      newChapterId: number;
      newSentenceId: number;
    }>;
    const orphanRemap = remap.find(
      (r) => r.oldChapterId === 77 && r.oldSentenceId === 5,
    );
    expect(orphanRemap).toBeDefined();
    // newChapterId points to a real chapter in the new state.
    expect([1, 2]).toContain(orphanRemap!.newChapterId);
  });
});

describe('plan 70a — prune empty chapters (Part F)', () => {
  it('drops chapters with zero sentences after merge and renumbers survivors', async () => {
    /* Seed a 4-chapter manuscript where chapter 3 ("Empty Phantom")
       has body content in the source but ZERO sentences in
       manuscript-edits.json — mirrors the user's screenshot bug where
       analysis state left a chapter with no attached sentences. After
       any merge, the empty chapter should be auto-pruned and survivors
       renumbered. (Body content is required because parseText drops
       heading-only chapters; the sentence-count gap comes from the
       edits.json side, not the parse side.) */
    writeFileSync(
      join(bookDir, 'manuscript.md'),
      '# Chapter One\n\nAlpha.\n\n# Chapter Two\n\nBeta.\n\n# Empty Phantom\n\nGamma.\n\n# Chapter Four\n\nDelta.\n',
    );
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
          { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
          { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
          { id: 3, title: 'Empty Phantom', slug: '03-empty-phantom' },
          { id: 4, title: 'Chapter Four', slug: '04-chapter-four' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narr', text: 'Alpha.' },
          { id: 1, chapterId: 2, characterId: 'narr', text: 'Beta.' },
          // chapter 3 deliberately empty
          { id: 1, chapterId: 4, characterId: 'narr', text: 'Delta.' },
        ],
      }),
    );

    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [1, 2] });
    expect(res.status).toBe(200);

    const pruneWarning = (res.body.warnings as string[]).find((w) =>
      /empty/i.test(w),
    );
    expect(pruneWarning).toBeDefined();
    expect(pruneWarning).toMatch(/Empty Phantom/);

    // Final chapters: merged (id 1) + Delta (id 2). Empty Phantom pruned.
    const state = readState();
    expect(state.chapters.map((c) => c.title)).toEqual([
      'Chapter One',
      'Chapter Four',
    ]);
    expect(state.chapters.map((c) => c.id)).toEqual([1, 2]);

    // Sentences renumbered to point at the new chapter ids
    const edits = readEdits();
    const ch2Sentences = edits.sentences.filter((s) => s.chapterId === 2);
    expect(ch2Sentences.map((s) => s.text)).toEqual(['Delta.']);
  });

  it('preserves excluded chapters even when they have zero sentences (soft-hide invariant)', async () => {
    writeFileSync(
      join(bookDir, 'manuscript.md'),
      '# Chapter One\n\nAlpha.\n\n# Chapter Two\n\nBeta.\n\n# Dedication\n\n# Chapter Four\n\nDelta.\n',
    );
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
          { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
          { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
          { id: 3, title: 'Dedication', slug: '03-dedication', excluded: true },
          { id: 4, title: 'Chapter Four', slug: '04-chapter-four' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narr', text: 'Alpha.' },
          { id: 1, chapterId: 2, characterId: 'narr', text: 'Beta.' },
          { id: 1, chapterId: 4, characterId: 'narr', text: 'Delta.' },
        ],
      }),
    );

    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [1, 2] });
    expect(res.status).toBe(200);

    const state = readState();
    // Dedication kept despite being empty + has the excluded flag
    expect(state.chapters.map((c) => c.title)).toContain('Dedication');
  });
});

describe('plan 70a — renumber generic titles (Part E)', () => {
  function seedDigitTitledBook(): void {
    /* Note on Markdown heading text: "Chapter 1" is a bare numbered
       heading, and the parser's subtitle-merge logic (text.ts:292-302)
       would try to lift the next line as a subtitle. Pad each chapter
       with multi-line body to keep the subtitle lookahead from gobbling
       narrative text. We then override state.json with the bare titles
       we actually want exposed to the restructure post-pass. */
    writeFileSync(
      join(bookDir, 'manuscript.md'),
      '# Chapter 1\n\nFirst body sentence here.\nMore content.\n\n# Chapter 2\n\nSecond body sentence here.\nMore content.\n\n# Chapter 3\n\nThird body sentence here.\nMore content.\n\n# Chapter 4\n\nFourth body sentence here.\nMore content.\n\n# Chapter 5\n\nFifth body sentence here.\nMore content.\n',
    );
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
          { id: 1, title: 'Chapter 1', slug: '01-chapter-1' },
          { id: 2, title: 'Chapter 2', slug: '02-chapter-2' },
          { id: 3, title: 'Chapter 3', slug: '03-chapter-3' },
          { id: 4, title: 'Chapter 4', slug: '04-chapter-4' },
          { id: 5, title: 'Chapter 5', slug: '05-chapter-5' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narr', text: 'A.' },
          { id: 1, chapterId: 2, characterId: 'narr', text: 'B.' },
          { id: 1, chapterId: 3, characterId: 'narr', text: 'C.' },
          { id: 1, chapterId: 4, characterId: 'narr', text: 'D.' },
          { id: 1, chapterId: 5, characterId: 'narr', text: 'E.' },
        ],
      }),
    );
  }

  it('re-derives "Chapter N" titles against new ids after merge', async () => {
    seedDigitTitledBook();
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [2, 3] });
    expect(res.status).toBe(200);

    const state = readState();
    // After merge 2+3, chapters are now 4 in count.
    // Merged chapter inherits first member's title "Chapter 2" → matches
    // generic pattern → re-derives to "Chapter 2" at new id 2 (no change).
    // Chapter 4 shifts to id 3 → title "Chapter 4" → re-derive to "Chapter 3".
    // Chapter 5 shifts to id 4 → title "Chapter 5" → re-derive to "Chapter 4".
    expect(state.chapters.map((c) => c.title)).toEqual([
      'Chapter 1',
      'Chapter 2',
      'Chapter 3',
      'Chapter 4',
    ]);

    const renumberWarning = (res.body.warnings as string[]).find((w) =>
      /Renumbered/i.test(w),
    );
    expect(renumberWarning).toBeDefined();
  });

  it('preserves user-customized chapter titles during the renumber pass', async () => {
    writeFileSync(
      join(bookDir, 'manuscript.md'),
      '# Chapter 1\n\nFirst body sentence here.\nMore content.\n\n# The Verdict\n\nSecond body sentence here.\nMore content.\n\n# Chapter 3\n\nThird body sentence here.\nMore content.\n\n# Chapter 4\n\nFourth body sentence here.\nMore content.\n',
    );
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
          { id: 1, title: 'Chapter 1', slug: '01-chapter-1' },
          { id: 2, title: 'The Verdict', slug: '02-the-verdict' },
          { id: 3, title: 'Chapter 3', slug: '03-chapter-3' },
          { id: 4, title: 'Chapter 4', slug: '04-chapter-4' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narr', text: 'A.' },
          { id: 1, chapterId: 2, characterId: 'narr', text: 'B.' },
          { id: 1, chapterId: 3, characterId: 'narr', text: 'C.' },
          { id: 1, chapterId: 4, characterId: 'narr', text: 'D.' },
        ],
      }),
    );

    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [1, 2] });
    expect(res.status).toBe(200);

    const state = readState();
    // Merge 1+2: result inherits "Chapter 1" title → generic → "Chapter 1" at id 1.
    // "The Verdict" is GONE because it was merged into chapter 1.
    // Old chapter 3 → id 2 → generic "Chapter 3" → re-derive to "Chapter 2".
    // Old chapter 4 → id 3 → generic → "Chapter 3".
    expect(state.chapters.map((c) => c.title)).toEqual([
      'Chapter 1',
      'Chapter 2',
      'Chapter 3',
    ]);
  });

  it('does not run the renumber post-pass on split', async () => {
    /* Split intentionally bypasses postProcessRestructure — see
       applySplit comment in restructure.ts. This regression test pins
       that contract: split a generic-titled chapter and assert the
       split (cont.) title is preserved verbatim. */
    writeFileSync(
      join(bookDir, 'manuscript.md'),
      '# Chapter 1\n\nFirst body sentence here.\nMore content.\n\n# Chapter 2\n\nSecond body sentence here.\nMore content.\n',
    );
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
          { id: 1, title: 'Chapter 1', slug: '01-chapter-1' },
          { id: 2, title: 'Chapter 2', slug: '02-chapter-2' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narr', text: 'First.' },
          { id: 2, chapterId: 1, characterId: 'narr', text: 'Second.' },
          { id: 1, chapterId: 2, characterId: 'narr', text: 'Beta.' },
        ],
      }),
    );

    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/split`)
      .send({ chapterId: 1, afterSentenceId: 1 });
    expect(res.status).toBe(200);
    const state = readState();
    // Three chapters: split produced "(cont.)" for the second half;
    // post-pass was NOT run so "Chapter 2" stays as id 3 unchanged
    // by the renumber-generic-titles pass.
    expect(state.chapters[0].title).toBe('Chapter 1');
    expect(state.chapters[1].title).toBe('Chapter 1 (cont.)');
    expect(state.chapters[2].title).toBe('Chapter 2');
  });

  it('preserves subtitled generic titles round-trip', async () => {
    writeFileSync(
      join(bookDir, 'manuscript.md'),
      '# Chapter 1 — The Beginning\n\nFirst body.\nMore content.\n\n# Chapter 2 — The Middle\n\nSecond body.\nMore content.\n\n# Chapter 3 — The End\n\nThird body.\nMore content.\n',
    );
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
          { id: 1, title: 'Chapter 1 — The Beginning', slug: '01-chapter-1' },
          { id: 2, title: 'Chapter 2 — The Middle', slug: '02-chapter-2' },
          { id: 3, title: 'Chapter 3 — The End', slug: '03-chapter-3' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narr', text: 'A.' },
          { id: 1, chapterId: 2, characterId: 'narr', text: 'B.' },
          { id: 1, chapterId: 3, characterId: 'narr', text: 'C.' },
        ],
      }),
    );

    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/reorder`)
      .send({ order: [3, 1, 2] });
    expect(res.status).toBe(200);

    const state = readState();
    // Reorder [3,1,2]: chapter 3 at new id 1 — title was "Chapter 3 — The End"
    // → matches generic-with-subtitle → re-derives to "Chapter 1 — The End".
    expect(state.chapters[0].title).toBe('Chapter 1 — The End');
    expect(state.chapters[1].title).toBe('Chapter 2 — The Beginning');
    expect(state.chapters[2].title).toBe('Chapter 3 — The Middle');
  });
});

/* -- plan 70b: exclude + refresh-titles ----------------------------- */

describe('POST /:bookId/chapters/exclude (plan 70b)', () => {
  it('flips Chapter.excluded for the requested ids; sentences untouched', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/exclude`)
      .send({ chapterIds: [2], excluded: true });
    expect(res.status).toBe(200);

    const state = readState();
    expect(state.chapters).toHaveLength(3);
    expect(state.chapters.find((c) => c.id === 2)?.excluded).toBe(true);
    expect(state.chapters.find((c) => c.id === 1)?.excluded).toBeUndefined();
    expect(state.chapters.find((c) => c.id === 3)?.excluded).toBeUndefined();

    const edits = readEdits();
    expect(edits.sentences).toHaveLength(6); // all original sentences preserved
  });

  it('un-excludes when excluded: false (truthy → undefined, matches reducer convention)', async () => {
    // First exclude chapter 2
    await request(app)
      .post(`/api/books/${bookId}/chapters/exclude`)
      .send({ chapterIds: [2], excluded: true });
    // Then un-exclude
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/exclude`)
      .send({ chapterIds: [2], excluded: false });
    expect(res.status).toBe(200);

    const state = readState();
    expect(state.chapters.find((c) => c.id === 2)?.excluded).toBeUndefined();
  });

  it('preserves audio files on disk when excluding', async () => {
    expect(existsSync(join(audioRoot, '02-chapter-two.mp3'))).toBe(true);
    await request(app)
      .post(`/api/books/${bookId}/chapters/exclude`)
      .send({ chapterIds: [2], excluded: true });
    expect(existsSync(join(audioRoot, '02-chapter-two.mp3'))).toBe(true);
  });

  it('400 when chapterIds is missing or empty', async () => {
    const a = await request(app)
      .post(`/api/books/${bookId}/chapters/exclude`)
      .send({ excluded: true });
    expect(a.status).toBe(400);
    const b = await request(app)
      .post(`/api/books/${bookId}/chapters/exclude`)
      .send({ chapterIds: [], excluded: true });
    expect(b.status).toBe(400);
  });

  it('400 when excluded is not a boolean', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/exclude`)
      .send({ chapterIds: [2], excluded: 'yes' });
    expect(res.status).toBe(400);
  });

  it('400 when chapter id does not exist', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/exclude`)
      .send({ chapterIds: [99], excluded: true });
    expect(res.status).toBe(400);
  });

  it('runs the post-process pass — generic titles still re-derive against new positions', async () => {
    writeFileSync(
      join(bookDir, 'manuscript.md'),
      '# Chapter 1\n\nFirst body sentence here.\nMore content.\n\n# Chapter 2\n\nSecond body sentence here.\nMore content.\n\n# Chapter 3\n\nThird body sentence here.\nMore content.\n',
    );
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
          // Chapter 1 has a non-generic title — should be preserved.
          { id: 1, title: 'The Verdict', slug: '01-the-verdict' },
          { id: 2, title: 'Chapter 2', slug: '02-chapter-2' },
          { id: 3, title: 'Chapter 3', slug: '03-chapter-3' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narr', text: 'A.' },
          { id: 1, chapterId: 2, characterId: 'narr', text: 'B.' },
          { id: 1, chapterId: 3, characterId: 'narr', text: 'C.' },
        ],
      }),
    );

    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/exclude`)
      .send({ chapterIds: [3], excluded: true });
    expect(res.status).toBe(200);

    const state = readState();
    // Exclude is soft-hide; ids unchanged. Generic titles still re-derive
    // against THEIR id (no shift since no renumber on exclude). Custom
    // "The Verdict" preserved.
    expect(state.chapters[0].title).toBe('The Verdict');
    expect(state.chapters[1].title).toBe('Chapter 2');
    expect(state.chapters[2].title).toBe('Chapter 3');
    expect(state.chapters[2].excluded).toBe(true);
  });
});

describe('POST /:bookId/chapters/refresh-titles (plan 70b)', () => {
  it('promotes first-sentence candidate when title is generic and candidate passes heuristics', async () => {
    writeFileSync(
      join(bookDir, 'manuscript.md'),
      '# Chapter 1\n\nFirst body sentence here.\nMore content.\n\n# Chapter 2\n\nSecond body sentence here.\nMore content.\n\n# Chapter 3\n\nThird body sentence here.\nMore content.\n',
    );
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
          { id: 1, title: 'Chapter 1', slug: '01-chapter-1' },
          { id: 2, title: 'Chapter 2', slug: '02-chapter-2' },
          { id: 3, title: 'Chapter 3', slug: '03-chapter-3' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [
          // Title-cased name-like first sentence — should promote.
          {
            id: 1,
            chapterId: 1,
            characterId: 'narr',
            text: 'Registry File For Wren Sparrow',
          },
          // Dialogue — should be rejected.
          {
            id: 1,
            chapterId: 2,
            characterId: 'narr',
            text: '"Hello," she said softly.',
          },
          // Long body sentence — should be rejected by length cap.
          {
            id: 1,
            chapterId: 3,
            characterId: 'narr',
            text: 'A very long opening sentence that runs well past the eighty character limit chapter titles allow for, almost certainly body text not a title.',
          },
        ],
      }),
    );

    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/refresh-titles`)
      .send({ useFirstLine: true });
    expect(res.status).toBe(200);

    const state = readState();
    expect(state.chapters[0].title).toBe('Registry File For Wren Sparrow');
    expect(state.chapters[1].title).toBe('Chapter 2'); // dialogue rejected
    expect(state.chapters[2].title).toBe('Chapter 3'); // too long, rejected
  });

  it('preserves user-customized chapter titles (non-generic pattern)', async () => {
    writeFileSync(
      join(bookDir, 'manuscript.md'),
      '# Chapter 1\n\nFirst body sentence here.\nMore content.\n\n# Chapter 2\n\nSecond body sentence here.\nMore content.\n\n# Chapter 3\n\nThird body sentence here.\nMore content.\n',
    );
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
          { id: 1, title: 'The Verdict', slug: '01-the-verdict' },
          { id: 2, title: 'Chapter 2', slug: '02-chapter-2' },
          { id: 3, title: 'Chapter 3', slug: '03-chapter-3' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [
          // Title-cased candidate for chapter 1 — but title isn't generic.
          {
            id: 1,
            chapterId: 1,
            characterId: 'narr',
            text: 'Some Tempting Candidate',
          },
          { id: 1, chapterId: 2, characterId: 'narr', text: 'Another One' },
          { id: 1, chapterId: 3, characterId: 'narr', text: 'Third Title Here' },
        ],
      }),
    );

    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/refresh-titles`)
      .send({ useFirstLine: true });
    expect(res.status).toBe(200);

    const state = readState();
    expect(state.chapters[0].title).toBe('The Verdict'); // non-generic, preserved
    expect(state.chapters[1].title).toBe('Another One'); // promoted
    expect(state.chapters[2].title).toBe('Third Title Here'); // promoted
  });

  it('skips first-line promotion when useFirstLine: false', async () => {
    writeFileSync(
      join(bookDir, 'manuscript.md'),
      '# Chapter 1\n\nFirst body sentence here.\nMore content.\n',
    );
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
        chapters: [{ id: 1, title: 'Chapter 1', slug: '01-chapter-1' }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narr', text: 'Some Name' },
        ],
      }),
    );

    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/refresh-titles`)
      .send({ useFirstLine: false });
    expect(res.status).toBe(200);
    const state = readState();
    expect(state.chapters[0].title).toBe('Chapter 1'); // not promoted
  });

  it('404 when book does not exist', async () => {
    const res = await request(app)
      .post(`/api/books/no-such-book/chapters/refresh-titles`)
      .send({});
    expect(res.status).toBe(404);
  });

  it('skips chapters with titleOverridden=true (plan 78)', async () => {
    // Seed a generic-title chapter alongside a user-renamed one. The
    // refresh pass should promote the generic title from its first
    // sentence but leave the overridden title alone — even when a
    // strong first-sentence candidate exists in the same chapter.
    // Three chapters because downstream tests in this file (and the
    // file-wide beforeEach) expect a 3-chapter manuscript on disk.
    writeFileSync(
      join(bookDir, 'manuscript.md'),
      '# Chapter 1\n\nFirst body sentence here.\nMore.\n\n# Chapter 2\n\nSecond body sentence here.\nMore.\n\n# Chapter 3\n\nThird body sentence here.\nMore.\n',
    );
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
          // titleOverridden looks generic but is sticky.
          { id: 1, title: 'Chapter 1', slug: '01-chapter-1', titleOverridden: true },
          { id: 2, title: 'Chapter 2', slug: '02-chapter-2' },
          { id: 3, title: 'Chapter 3', slug: '03-chapter-3' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narr', text: 'Tempting Candidate For Chapter One' },
          { id: 1, chapterId: 2, characterId: 'narr', text: 'Tempting Candidate For Chapter Two' },
          { id: 1, chapterId: 3, characterId: 'narr', text: 'Tempting Candidate For Chapter Three' },
        ],
      }),
    );

    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/refresh-titles`)
      .send({ useFirstLine: true });
    expect(res.status).toBe(200);

    const state = readState();
    expect(state.chapters[0].title).toBe('Chapter 1'); // override survives
    expect(state.chapters[1].title).toBe('Tempting Candidate For Chapter Two');
    expect(state.chapters[2].title).toBe('Tempting Candidate For Chapter Three');
  });
});

describe('POST /:bookId/chapters/:chapterId/rename (plan 78)', () => {
  it('updates state.json with the new title and locks titleOverridden=true', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/2/rename`)
      .send({ title: 'The Hunt Begins' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 2,
      title: 'The Hunt Begins',
      titleOverridden: true,
    });
    expect(res.body.slug).toMatch(/^02-/);

    const state = readState();
    expect(state.chapters[1]).toMatchObject({
      id: 2,
      title: 'The Hunt Begins',
      titleOverridden: true,
    });
    // Other chapters unchanged.
    expect(state.chapters[0].title).toBe('Chapter One');
    expect(state.chapters[2].title).toBe('Chapter Three');
  });

  it('trims whitespace before applying', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/1/rename`)
      .send({ title: '   The Verdict   ' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('The Verdict');
    expect(readState().chapters[0].title).toBe('The Verdict');
  });

  it('renames the existing audio file to follow the new slug', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/1/rename`)
      .send({ title: 'Brand New Name' });
    expect(res.status).toBe(200);
    const audioFiles = readdirSync(audioRoot);
    // Old slug audio is renamed away; new slug audio is present.
    expect(audioFiles.some((f) => f.startsWith('01-brand-new-name'))).toBe(true);
    expect(audioFiles.some((f) => f === '01-chapter-one.mp3')).toBe(false);
  });

  it('survives a refresh-titles pass after rename', async () => {
    const renameRes = await request(app)
      .post(`/api/books/${bookId}/chapters/3/rename`)
      .send({ title: 'My Renamed Finale' });
    expect(renameRes.status).toBe(200);

    const refreshRes = await request(app)
      .post(`/api/books/${bookId}/chapters/refresh-titles`)
      .send({ useFirstLine: true });
    expect(refreshRes.status).toBe(200);

    expect(readState().chapters[2].title).toBe('My Renamed Finale');
  });

  it('rejects empty title with 400', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/2/rename`)
      .send({ title: '   ' });
    expect(res.status).toBe(400);
    expect(readState().chapters[1].title).toBe('Chapter Two'); // unchanged
  });

  it('rejects oversized title with 400', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/2/rename`)
      .send({ title: 'x'.repeat(201) });
    expect(res.status).toBe(400);
  });

  it('rejects missing title field with 400', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/2/rename`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('404 when chapter id does not exist', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/99/rename`)
      .send({ title: 'Nowhere' });
    expect(res.status).toBe(404);
  });

  it('400 when chapterId path param is not a positive integer', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/abc/rename`)
      .send({ title: 'Fine' });
    expect(res.status).toBe(400);
  });

  it('404 when book does not exist', async () => {
    const res = await request(app)
      .post(`/api/books/no-such-book/chapters/1/rename`)
      .send({ title: 'Anything' });
    expect(res.status).toBe(404);
  });
});

describe('merge/split propagate titleOverridden (plan 78)', () => {
  it('merge with explicit mergedTitle sets titleOverridden=true on the merged chapter', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [2, 3], mergedTitle: 'Combined Finale' });
    expect(res.status).toBe(200);
    const state = readState();
    const merged = state.chapters.find((c) => c.title === 'Combined Finale');
    expect(merged?.titleOverridden).toBe(true);
  });

  it('merge without mergedTitle leaves titleOverridden absent on the merged chapter', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [2, 3] });
    expect(res.status).toBe(200);
    const state = readState();
    // Merged chapter inherits Chapter Two's title — content changed, no
    // explicit override → flag stays absent so a future refresh-titles
    // pass can still improve it.
    const merged = state.chapters[1];
    expect(merged.titleOverridden).toBeUndefined();
  });

  it('split with explicit newTitle sets titleOverridden=true on the new chapter', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/split`)
      .send({ chapterId: 1, afterSentenceId: 1, newTitle: 'Aftermath' });
    expect(res.status).toBe(200);
    const state = readState();
    const newChapter = state.chapters.find((c) => c.title === 'Aftermath');
    expect(newChapter?.titleOverridden).toBe(true);
  });

  it('reorder preserves titleOverridden across the renumber', async () => {
    // Seed chapter 1 as renamed, then reorder so it becomes id 3.
    const state = JSON.parse(
      readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'),
    );
    state.chapters[0].title = 'Sticky One';
    state.chapters[0].titleOverridden = true;
    state.chapters[0].slug = '01-sticky-one';
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify(state),
    );

    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/reorder`)
      .send({ order: [2, 3, 1] });
    expect(res.status).toBe(200);

    const after = readState();
    // The "Sticky One" chapter is now at position 3 (id 3).
    const sticky = after.chapters.find((c) => c.title === 'Sticky One');
    expect(sticky?.id).toBe(3);
    expect(sticky?.titleOverridden).toBe(true);
  });
});
