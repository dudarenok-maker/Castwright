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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
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

/* #3628 — a passthrough spy so a test can assert the legacy-title backfill
   does not parse the manuscript when no chapter could need it. */
const parseManuscriptSpy = vi.hoisted(() => vi.fn());
vi.mock('../parsers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../parsers/index.js')>();
  parseManuscriptSpy.mockImplementation(actual.parseManuscript);
  return { ...actual, parseManuscript: parseManuscriptSpy };
});

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

vi.mock('../workspace/revisions-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workspace/revisions-store.js')>();
  return { ...real, reconcilePendingAfterRestructure: vi.fn(real.reconcilePendingAfterRestructure) };
});

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

  const { chaptersRestructureRouter } = await import('./chapters-restructure.js');
  const { bookStateRouter } = await import('./book-state.js');
  const { revisionOpsRouter } = await import('./revision-ops.js');
  const { makeBookId } = await import('../workspace/paths.js');
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
  app.use('/api/books', revisionOpsRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  if (cachePath && existsSync(cachePath)) rmSync(cachePath, { force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(async () => {
  /* Cases below overwrite the manuscript; a later case's hydrate parses it, and (#3791) the
     parse's titles are compared with state's, so every case starts from the shared body. */
  writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT_BODY);
  seedState();
  seedManuscriptEdits();
  // Reset audio dir
  if (existsSync(audioRoot)) rmSync(audioRoot, { recursive: true, force: true });
  seedAudio('01-chapter-one');
  seedAudio('02-chapter-two');
  // chapter 3 deliberately has no audio
  if (existsSync(cachePath)) rmSync(cachePath, { force: true });
  // A previous case's restructure left a hints file the next hydrate would read.
  rmSync(join(bookDir, '.audiobook', 'manuscript-hints.json'), { force: true });
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

/* #3791 -- a merge/split/reorder rebuilds state.chapters from the manuscript
   hints, so hints that do not pair one-to-one with state.json's chapters make it
   delete a chapter's audio and orphan its sentences. Hints from a persisted
   manuscript-hints.json pair by id + uuid; hints from a parse fallback carry no
   identity, so they must also agree with state on count, ids and each position's
   title. A mispaired book answers a curated 409 and writes nothing. */
describe('merge/split/reorder refuse when hints do not pair with state.json (#3791)', () => {
  const REFUSAL =
    "This book's chapter list is out of date with its manuscript. Re-parse it from the book's menu in the Library to fix this — re-parsing discards its analysis, cast and audio.";

  /* state.json, manuscript-edits.json and every audio file: the damage #3791
     reported is a deleted/renamed audio file, so the audio dir is in the snapshot. */
  function snapshotDisk(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const dir of [join(bookDir, '.audiobook'), audioRoot]) {
      for (const f of readdirSync(dir).sort()) {
        out[`${dir}/${f}`] = readFileSync(join(dir, f), 'utf8');
      }
    }
    return out;
  }

  /* state.json holds `chapters` (all rendered, slugs 0N-<slug>) while the
     manuscript still parses to Chapter One/Two/Three and no
     manuscript-hints.json exists. Audio is seeded for EVERY state chapter, so a
     refusal that regressed would delete or rename real files. */
  function seedRenderedState(
    chapters: Array<{ id: number; title: string; slug: string; uuid?: string; titleSynthesized?: boolean }>,
  ): void {
    const path = join(bookDir, '.audiobook', 'state.json');
    const state = JSON.parse(readFileSync(path, 'utf8'));
    /* Already in the shape the library scan's lazy migrations leave (uuid,
       duration from the segments file, language, schema), so the scan that runs
       before the refusal does not rewrite state.json and the snapshots compare. */
    state.language = null;
    state.schema = 1;
    state.chapters = chapters.map((c) => ({
      uuid: `u-${c.id}`,
      ...c,
      audioModelKey: 'kokoro-v1',
      audioRenderedAt: '2026-01-01T00:00:00.000Z',
      duration: '00:05',
    }));
    writeFileSync(path, JSON.stringify(state));
    rmSync(audioRoot, { recursive: true, force: true });
    for (const c of chapters) seedAudio(c.slug);
  }

  /* A book reordered before #3703 and restarted: state is [Two, One, Three] but
     the parse is [One, Two, Three], same count, same ids 1..3. */
  function seedPreReorderedBook(): void {
    seedRenderedState([
      { id: 1, title: 'Chapter Two', slug: '01-chapter-two', uuid: 'u-two' },
      { id: 2, title: 'Chapter One', slug: '02-chapter-one', uuid: 'u-one' },
      { id: 3, title: 'Chapter Three', slug: '03-chapter-three', uuid: 'u-three' },
    ]);
  }

  it('merge: 4 state chapters against a 3-chapter parse answers 409 hints_out_of_sync, nothing written', async () => {
    seedRenderedState([
      { id: 1, title: 'Chapter 1', slug: '01-chapter-1' },
      { id: 2, title: 'Chapter 2', slug: '02-chapter-2' },
      { id: 3, title: 'Chapter 3', slug: '03-chapter-3' },
      { id: 4, title: 'Chapter 4', slug: '04-chapter-4' },
    ]);
    const before = snapshotDisk();
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [2, 3] });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: REFUSAL, code: 'hints_out_of_sync' });
    expect(res.body.error).not.toContain(workspaceRoot);
    expect(snapshotDisk()).toEqual(before);
    expect(existsSync(join(bookDir, '.audiobook', 'manuscript-hints.json'))).toBe(false);
  });

  it('merge: equal counts but a state chapter id the hints lack answers 409, nothing written', async () => {
    seedRenderedState([
      { id: 1, title: 'Chapter 1', slug: '01-chapter-1' },
      { id: 2, title: 'Chapter 2', slug: '02-chapter-2' },
      { id: 4, title: 'Chapter 4', slug: '04-chapter-4' },
    ]);
    const before = snapshotDisk();
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [1, 2] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('hints_out_of_sync');
    expect(snapshotDisk()).toEqual(before);
  });

  it('split: equal counts but mismatched ids answers 409, nothing written', async () => {
    seedRenderedState([
      { id: 1, title: 'Chapter 1', slug: '01-chapter-1' },
      { id: 2, title: 'Chapter 2', slug: '02-chapter-2' },
      { id: 4, title: 'Chapter 4', slug: '04-chapter-4' },
    ]);
    const before = snapshotDisk();
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/split`)
      .send({ chapterId: 2, afterSentenceId: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('hints_out_of_sync');
    expect(snapshotDisk()).toEqual(before);
  });

  it('reorder: equal counts but mismatched ids answers 409 (on main: 200 and audio moved), nothing written', async () => {
    seedRenderedState([
      { id: 1, title: 'Chapter 1', slug: '01-chapter-1' },
      { id: 2, title: 'Chapter 2', slug: '02-chapter-2' },
      { id: 4, title: 'Chapter 4', slug: '04-chapter-4' },
    ]);
    const before = snapshotDisk();
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/reorder`)
      .send({ order: [3, 1, 2] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('hints_out_of_sync');
    expect(snapshotDisk()).toEqual(before);
  });

  describe('same count and ids, parse-fallback titles disagree with state (a pre-#3703 reorder)', () => {
    it('merge answers 409, every file byte-identical', async () => {
      seedPreReorderedBook();
      const before = snapshotDisk();
      const res = await request(app)
        .post(`/api/books/${bookId}/chapters/merge`)
        .send({ chapterIds: [2, 3] });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: REFUSAL, code: 'hints_out_of_sync' });
      expect(snapshotDisk()).toEqual(before);
      expect(existsSync(join(bookDir, '.audiobook', 'manuscript-hints.json'))).toBe(false);
    });

    it('split answers 409, every file byte-identical', async () => {
      seedPreReorderedBook();
      const before = snapshotDisk();
      const res = await request(app)
        .post(`/api/books/${bookId}/chapters/split`)
        .send({ chapterId: 1, afterSentenceId: 1 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('hints_out_of_sync');
      expect(snapshotDisk()).toEqual(before);
    });

    it('reorder answers 409, every file byte-identical', async () => {
      seedPreReorderedBook();
      const before = snapshotDisk();
      const res = await request(app)
        .post(`/api/books/${bookId}/chapters/reorder`)
        .send({ order: [2, 1, 3] });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('hints_out_of_sync');
      expect(snapshotDisk()).toEqual(before);
    });

    it('merge answers 409 when an app-titled chapter and a heading chapter were swapped (#3791 pass 2)', async () => {
      /* MANUSCRIPT_BODY parses to [Chapter 1 (app-made: "# Chapter One" becomes the book
         title), Chapter Two, Chapter Three]. Imported for real and reordered [2,1,3] before
         #3703, state is [Chapter Two, Chapter 2 (renumbered, synthesized), Chapter Three]
         with no hints file. Position 0 has no parse title and position 1 holds a synthesized
         one, so a check that skipped synthesized state titles compared neither. */
      seedRenderedState([
        { id: 1, title: 'Chapter Two', slug: '01-chapter-two', uuid: 'u-two' },
        { id: 2, title: 'Chapter 2', slug: '02-chapter-2', uuid: 'u-one', titleSynthesized: true },
        { id: 3, title: 'Chapter Three', slug: '03-chapter-three', uuid: 'u-three' },
      ]);
      const before = snapshotDisk();
      const res = await request(app)
        .post(`/api/books/${bookId}/chapters/merge`)
        .send({ chapterIds: [2, 3] });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: REFUSAL, code: 'hints_out_of_sync' });
      expect(snapshotDisk()).toEqual(before);
      expect(existsSync(join(bookDir, '.audiobook', 'manuscript-hints.json'))).toBe(false);
    });

    it('rename answers the same 409 and writes nothing, so it cannot hide the mispairing from a later merge', async () => {
      seedPreReorderedBook();
      const before = snapshotDisk();
      const merge1 = await request(app)
        .post(`/api/books/${bookId}/chapters/merge`)
        .send({ chapterIds: [2, 3] });
      expect(merge1.status).toBe(409);
      const rename = await request(app)
        .post(`/api/books/${bookId}/chapters/2/rename`)
        .send({ title: 'Interlude' });
      expect(rename.status).toBe(409);
      expect(rename.body).toEqual({ error: REFUSAL, code: 'hints_out_of_sync' });
      const merge2 = await request(app)
        .post(`/api/books/${bookId}/chapters/merge`)
        .send({ chapterIds: [2, 3] });
      expect(merge2.status).toBe(409);
      expect(snapshotDisk()).toEqual(before);
      expect(existsSync(join(bookDir, '.audiobook', 'manuscript-hints.json'))).toBe(false);
    });

    it('refresh-titles answers the same 409 and writes nothing, so its parser-aligned pass cannot hide the mispairing', async () => {
      seedRenderedState([
        { id: 1, title: 'Chapter Two', slug: '01-chapter-two', uuid: 'u-two' },
        { id: 2, title: 'Chapter 2', slug: '02-chapter-2', uuid: 'u-one', titleSynthesized: true },
        { id: 3, title: 'Chapter Three', slug: '03-chapter-three', uuid: 'u-three' },
      ]);
      const before = snapshotDisk();
      const refresh = await request(app).post(`/api/books/${bookId}/chapters/refresh-titles`).send({});
      expect(refresh.status).toBe(409);
      expect(refresh.body).toEqual({ error: REFUSAL, code: 'hints_out_of_sync' });
      const merge = await request(app)
        .post(`/api/books/${bookId}/chapters/merge`)
        .send({ chapterIds: [2, 3] });
      expect(merge.status).toBe(409);
      expect(snapshotDisk()).toEqual(before);
      expect(existsSync(join(bookDir, '.audiobook', 'manuscript-hints.json'))).toBe(false);
    });

    it('exclude still succeeds but writes no hints file, so the mispairing is not made `persisted`', async () => {
      seedPreReorderedBook();
      const res = await request(app)
        .post(`/api/books/${bookId}/chapters/exclude`)
        .send({ chapterIds: [3], excluded: true });
      expect(res.status).toBe(200);
      expect(existsSync(join(bookDir, '.audiobook', 'manuscript-hints.json'))).toBe(false);
      /* ... so a merge afterwards is still refused, not waved through. */
      const { removeManuscript } = await import('../store/manuscripts.js');
      removeManuscript(MANUSCRIPT_ID);
      const merge = await request(app)
        .post(`/api/books/${bookId}/chapters/merge`)
        .send({ chapterIds: [1, 2] });
      expect(merge.status).toBe(409);
    });
  });

  describe('healthy books are not refused', () => {
    it('a persisted hints file that pairs with state merges even though state titles differ from the parse (a reorder)', async () => {
      /* Reorder writes manuscript-hints.json; after a restart the hydrate takes the
         persisted hints, which are NOT title-checked: state is now [Two, One, Three]
         against a parse of [One, Two, Three]. A hydrate that title-checked persisted
         hints would refuse this merge. */
      const reordered = await request(app)
        .post(`/api/books/${bookId}/chapters/reorder`)
        .send({ order: [2, 1, 3] });
      expect(reordered.status).toBe(200);
      expect(existsSync(join(bookDir, '.audiobook', 'manuscript-hints.json'))).toBe(true);
      const { removeManuscript } = await import('../store/manuscripts.js');
      removeManuscript(MANUSCRIPT_ID);

      const res = await request(app)
        .post(`/api/books/${bookId}/chapters/merge`)
        .send({ chapterIds: [1, 2] });
      expect(res.status).toBe(200);
    });

    it('rename and refresh-titles work freely on a persisted-hints book whose titles differ from the parse', async () => {
      const reordered = await request(app)
        .post(`/api/books/${bookId}/chapters/reorder`)
        .send({ order: [2, 1, 3] });
      expect(reordered.status).toBe(200);
      const { removeManuscript } = await import('../store/manuscripts.js');
      removeManuscript(MANUSCRIPT_ID);

      const rename = await request(app)
        .post(`/api/books/${bookId}/chapters/2/rename`)
        .send({ title: 'The Second Part' });
      expect(rename.status).toBe(200);
      const refresh = await request(app).post(`/api/books/${bookId}/chapters/refresh-titles`).send({});
      expect(refresh.status).toBe(200);
    });

    it('rename and refresh-titles work on a healthy parse-fallback book (parse titles agree with state)', async () => {
      const rename = await request(app)
        .post(`/api/books/${bookId}/chapters/2/rename`)
        .send({ title: 'The Second Part' });
      expect(rename.status).toBe(200);
      const refresh = await request(app).post(`/api/books/${bookId}/chapters/refresh-titles`).send({});
      expect(refresh.status).toBe(200);
    });

    it('a parse-fallback book merges when only a titleOverridden chapter differs from the parse', async () => {
      const path = join(bookDir, '.audiobook', 'state.json');
      const state = JSON.parse(readFileSync(path, 'utf8'));
      state.chapters[1].title = 'My own title';
      state.chapters[1].titleOverridden = true;
      writeFileSync(path, JSON.stringify(state));
      const res = await request(app)
        .post(`/api/books/${bookId}/chapters/merge`)
        .send({ chapterIds: [1, 2] });
      expect(res.status).toBe(200);
    });
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
  it('keeps a zero-sentence chapter that still has manuscript text after a merge (#3783)', async () => {
    /* Seed a 4-chapter manuscript where chapter 3 ("Empty Phantom")
       has body content in the source but ZERO sentences in
       manuscript-edits.json — a never-analysed chapter. plan 70a pruned it
       after any merge; #3783 keeps it, because pruning deleted real text and
       renumbered its neighbours. Only a chapter whose body is empty is pruned
       (see the hint-seeded case below). */
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

    expect((res.body.warnings as string[]).some((w) => /empty/i.test(w))).toBe(false);

    // Final chapters: merged (id 1) + Empty Phantom (id 2) + Chapter Four (id 3).
    const state = readState();
    expect(state.chapters.map((c) => c.title)).toEqual([
      'Chapter One',
      'Empty Phantom',
      'Chapter Four',
    ]);
    expect(state.chapters.map((c) => c.id)).toEqual([1, 2, 3]);

    // Delta follows its chapter to the new id 3; Empty Phantom stays sentence-less.
    const edits = readEdits();
    expect(edits.sentences.filter((s) => s.chapterId === 2)).toEqual([]);
    expect(
      edits.sentences.filter((s) => s.chapterId === 3).map((s) => s.text),
    ).toEqual(['Delta.']);
  });

  it('preserves excluded chapters even when they have zero sentences (soft-hide invariant)', async () => {
    writeFileSync(
      join(bookDir, 'manuscript.md'),
      /* The Dedication's body is just its own heading text, so the prune pass
         sees an EMPTY body and only `excluded` keeps it; the parse still yields
         all four chapters and pairs with state.json (#3791). */
      '# Chapter One\n\nAlpha.\n\n# Chapter Two\n\nBeta.\n\n# Dedication\n\nDedication\n\n# Chapter Four\n\nDelta.\n',
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
          { id: 1, title: 'Chapter 1', slug: '01-chapter-1', titleSynthesized: true },
          { id: 2, title: 'Chapter 2', slug: '02-chapter-2', titleSynthesized: true },
          { id: 3, title: 'Chapter 3', slug: '03-chapter-3', titleSynthesized: true },
          { id: 4, title: 'Chapter 4', slug: '04-chapter-4', titleSynthesized: true },
          { id: 5, title: 'Chapter 5', slug: '05-chapter-5', titleSynthesized: true },
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

  it('merge [2,3] on rendered "Chapter N" titles keeps the shifted chapter\'s audio (#3400)', async () => {
    seedDigitTitledBook();
    for (const slug of [
      '01-chapter-1',
      '02-chapter-2',
      '03-chapter-3',
      '04-chapter-4',
      '05-chapter-5',
    ]) {
      seedAudio(slug);
      writeFileSync(join(audioRoot, `${slug}.previous.mp3`), `previous-${slug}`);
    }
    const stPath = join(bookDir, '.audiobook', 'state.json');
    const st = JSON.parse(readFileSync(stPath, 'utf8'));
    for (const c of st.chapters) {
      c.audioModelKey = 'kokoro-v1';
      c.audioRenderedAt = '2026-01-01T00:00:00.000Z';
    }
    writeFileSync(stPath, JSON.stringify(st));

    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [2, 3] });
    expect(res.status).toBe(200);

    // Old chapter 4 is now chapter 3 (slug 03-chapter-3): its audio must exist.
    expect(readState().chapters[2].slug).toBe('03-chapter-3');
    expect(readFileSync(join(audioRoot, '03-chapter-3.mp3'), 'utf8')).toBe('audio-04-chapter-4');
    expect(readFileSync(join(audioRoot, '03-chapter-3.previous.mp3'), 'utf8')).toBe(
      'previous-04-chapter-4',
    );
  });

  function seedRenderedChapters(slugs: string[]): void {
    for (const slug of slugs) {
      seedAudio(slug);
      writeFileSync(join(audioRoot, `${slug}.previous.mp3`), `previous-${slug}`);
    }
    const stPath = join(bookDir, '.audiobook', 'state.json');
    const st = JSON.parse(readFileSync(stPath, 'utf8'));
    for (const c of st.chapters) {
      c.audioModelKey = 'kokoro-v1';
      c.audioRenderedAt = '2026-01-01T00:00:00.000Z';
    }
    writeFileSync(stPath, JSON.stringify(st));
  }

  /* Persist a valid manuscript-hints.json whose chapter `emptyId` has an EMPTY
     body (no parser emits one, so the file is the only way to seed it). Each
     other chapter keeps its real parsed body; state chapters get the uuids the
     file is paired against. */
  async function seedHintsWithEmptyBody(emptyId: number): Promise<void> {
    const { parseManuscript } = await import('../parsers/index.js');
    const { sha256Hex } = await import('../workspace/manuscript-hints.js');
    const stPath = join(bookDir, '.audiobook', 'state.json');
    const st = JSON.parse(readFileSync(stPath, 'utf8'));
    const buffer = readFileSync(join(bookDir, 'manuscript.md'));
    const parsed = await parseManuscript({ buffer, fileName: 'manuscript.md' });
    expect(parsed.chapters).toHaveLength(st.chapters.length);
    st.chapters.forEach((c: { uuid?: string }, i: number) => {
      c.uuid = `00000000-0000-4000-8000-00000000000${i + 1}`;
    });
    writeFileSync(stPath, JSON.stringify(st));
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-hints.json'),
      JSON.stringify({
        schema: 1,
        entries: [
          {
            manuscriptId: MANUSCRIPT_ID,
            manuscriptFile: 'manuscript.md',
            sourceSha256: sha256Hex(buffer),
            writtenAt: '2026-01-01T00:00:00.000Z',
            chapters: st.chapters.map((c: { id: number; uuid: string }, i: number) => ({
              id: c.id,
              uuid: c.uuid,
              body: c.id === emptyId ? '' : parsed.chapters[i]!.body,
            })),
          },
        ],
      }),
    );
  }

  it('merge [4,5] with an empty chapter 2: survivors keep their OWN audio, merged chapter gets none (#3400)', async () => {
    seedDigitTitledBook();
    // #3783: chapter 2 has no sentences AND an empty body (seeded through a valid
    // manuscript-hints.json), so the prune pass drops it and renumbers the rest.
    await seedHintsWithEmptyBody(2);
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [1, 3, 4, 5].map((c) => ({ id: 1, chapterId: c, characterId: 'narr', text: `s${c}.` })),
      }),
    );
    const olds = ['01-chapter-1', '02-chapter-2', '03-chapter-3', '04-chapter-4', '05-chapter-5'];
    seedRenderedChapters(olds);

    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [4, 5] });
    expect(res.status).toBe(200);

    const st = readState();
    expect(st.chapters.map((c) => c.slug)).toEqual(['01-chapter-1', '02-chapter-2', '03-chapter-3']);
    // new chapter 2 is old chapter 3: its audio (and .previous take) moved with it
    expect(readFileSync(join(audioRoot, '02-chapter-2.mp3'), 'utf8')).toBe('audio-03-chapter-3');
    expect(readFileSync(join(audioRoot, '02-chapter-2.previous.mp3'), 'utf8')).toBe(
      'previous-03-chapter-3',
    );
    // the merged chapter (new 3) is content-changed: no stale audio, no rendered stamp
    expect(existsSync(join(audioRoot, '03-chapter-3.mp3'))).toBe(false);
    expect(existsSync(join(audioRoot, '03-chapter-3.previous.mp3'))).toBe(false);
    expect(st.chapters[2].audioRenderedAt).toBeUndefined();
    expect(st.chapters[1].audioRenderedAt).toBeDefined();
    expect(existsSync(join(audioRoot, '04-chapter-4.mp3'))).toBe(false);
    expect(existsSync(join(audioRoot, '05-chapter-5.mp3'))).toBe(false);
  });

  it('exclude: chapters retitled only by the generic-title pass keep their audio at the new slug (#3400)', async () => {
    seedDigitTitledBook();
    const stPath = join(bookDir, '.audiobook', 'state.json');
    const st = JSON.parse(readFileSync(stPath, 'utf8'));
    ['Prologue', 'Chapter 1', 'Chapter 2', 'Chapter 3', 'Chapter 4'].forEach((t, i) => {
      st.chapters[i].title = t;
      st.chapters[i].slug = `${String(i + 1).padStart(2, '0')}-${t.toLowerCase().replace(/ /g, '-')}`;
    });
    writeFileSync(stPath, JSON.stringify(st));
    const olds = st.chapters.map((c: { slug: string }) => c.slug) as string[];
    seedRenderedChapters(olds);

    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/exclude`)
      .send({ chapterIds: [5], excluded: true });
    expect(res.status).toBe(200);

    expect(readState().chapters.map((c) => c.slug)).toEqual([
      '01-prologue',
      '02-chapter-2',
      '03-chapter-3',
      '04-chapter-4',
      '05-chapter-5',
    ]);
    expect(readFileSync(join(audioRoot, '01-prologue.mp3'), 'utf8')).toBe('audio-01-prologue');
    expect(readFileSync(join(audioRoot, '02-chapter-2.mp3'), 'utf8')).toBe('audio-02-chapter-1');
    expect(readFileSync(join(audioRoot, '03-chapter-3.mp3'), 'utf8')).toBe('audio-03-chapter-2');
    expect(readFileSync(join(audioRoot, '04-chapter-4.mp3'), 'utf8')).toBe('audio-04-chapter-3');
    expect(readFileSync(join(audioRoot, '05-chapter-5.mp3'), 'utf8')).toBe('audio-05-chapter-4');
    expect(readFileSync(join(audioRoot, '05-chapter-5.previous.mp3'), 'utf8')).toBe(
      'previous-05-chapter-4',
    );
    expect(existsSync(join(audioRoot, '02-chapter-1.mp3'))).toBe(false);
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
          { id: 1, title: 'Chapter 1', slug: '01-chapter-1', titleSynthesized: true },
          { id: 2, title: 'The Verdict', slug: '02-the-verdict' },
          { id: 3, title: 'Chapter 3', slug: '03-chapter-3', titleSynthesized: true },
          { id: 4, title: 'Chapter 4', slug: '04-chapter-4', titleSynthesized: true },
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
          { id: 1, title: 'Chapter 1 — The Beginning', slug: '01-chapter-1', titleSynthesized: true },
          { id: 2, title: 'Chapter 2 — The Middle', slug: '02-chapter-2', titleSynthesized: true },
          { id: 3, title: 'Chapter 3 — The End', slug: '03-chapter-3', titleSynthesized: true },
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

  it('#3774 un-excluding a never-analysed (zero-sentence) chapter keeps it — not pruned, later audio not renamed', async () => {
    seedAudio('03-chapter-three');
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narr', text: 'A.' },
          { id: 1, chapterId: 3, characterId: 'narr', text: 'C.' },
        ],
      }),
    );
    expect(
      (
        await request(app)
          .post(`/api/books/${bookId}/chapters/exclude`)
          .send({ chapterIds: [2], excluded: true })
      ).status,
    ).toBe(200);
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/exclude`)
      .send({ chapterIds: [2], excluded: false });
    expect(res.status).toBe(200);

    const state = readState();
    expect(state.chapters.map((c) => [c.id, c.slug])).toEqual([
      [1, '01-chapter-one'],
      [2, '02-chapter-two'],
      [3, '03-chapter-three'],
    ]);
    expect(state.chapters.find((c) => c.id === 2)?.excluded).toBeUndefined();
    expect(existsSync(join(audioRoot, '03-chapter-three.mp3'))).toBe(true);
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
          { id: 2, title: 'Chapter 2', slug: '02-chapter-2', titleSynthesized: true },
          { id: 3, title: 'Chapter 3', slug: '03-chapter-3', titleSynthesized: true },
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
          { id: 1, title: 'Chapter 1', slug: '01-chapter-1', titleSynthesized: true },
          { id: 2, title: 'Chapter 2', slug: '02-chapter-2', titleSynthesized: true },
          { id: 3, title: 'Chapter 3', slug: '03-chapter-3', titleSynthesized: true },
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
          { id: 2, title: 'Chapter 2', slug: '02-chapter-2', titleSynthesized: true },
          { id: 3, title: 'Chapter 3', slug: '03-chapter-3', titleSynthesized: true },
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
          { id: 1, title: 'Chapter 1', slug: '01-chapter-1', titleOverridden: true, titleSynthesized: true },
          { id: 2, title: 'Chapter 2', slug: '02-chapter-2', titleSynthesized: true },
          { id: 3, title: 'Chapter 3', slug: '03-chapter-3', titleSynthesized: true },
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

/* -- plan 286: restructure drops stale A/B entries ------------------ */

describe('plan 286 — restructure drops stale A/B entries', () => {
  const revPath = () => join(bookDir, '.audiobook', 'revisions.json');
  const srv = (chapterId: number, id: string) => ({ id, chapterId, characterId: 'narr', playable: true, hasPreviousAudio: true, segments: [], origin: 'server' });
  afterEach(() => rmSync(revPath(), { recursive: true, force: true }));

  it('a merge of chapters 2+3 drops their entries and keeps chapter 1\'s', async () => {
    writeFileSync(revPath(), JSON.stringify({ schema: 1, fileId: '000000000000001-a', rev: 1, pending: [srv(1, 'r1'), srv(2, 'r2')], dismissed: [], acceptedSelections: {}, timeline: {} }));
    const res = await request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [2, 3] });
    expect(res.status).toBe(200);
    const disk = JSON.parse(readFileSync(revPath(), 'utf8'));
    expect(disk.pending.map((p: { id: string }) => p.id)).toEqual(['r1']);
  });

  it('a failing drop still answers 200 and leaks no path', async () => {
    /* A rejection whose message embeds the path: an EISDIR fixture's message carries
       none, so asserting its absence would prove nothing (Invariant 8). */
    const store = await import('../workspace/revisions-store.js');
    vi.mocked(store.reconcilePendingAfterRestructure).mockRejectedValueOnce(Object.assign(
      new Error(`EPERM: operation not permitted, rename '${revPath()}.tmp'`), { code: 'EPERM' }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [2, 3] });
    const errorCalls = err.mock.calls.length; // before mockRestore, which clears mock.calls in vitest 5
    err.mockRestore();
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(workspaceRoot);
    /* JSON doubles each backslash, so on Windows the raw root never matches the serialised body. */
    expect(res.text).not.toContain(JSON.stringify(workspaceRoot).slice(1, -1));
    expect(errorCalls).toBeGreaterThan(0);
  });
});

/* -- #3400: a stale entry surviving a failed drop never acts on another chapter -- */

describe('#3400 — a failed restructure drop leaves an entry that is refused, not applied elsewhere', () => {
  const revPath = () => join(bookDir, '.audiobook', 'revisions.json');
  const UUIDS = ['uuid-ch-1', 'uuid-ch-2', 'uuid-ch-3'];
  /* A server-recorded entry for chapter 1, carrying the identity finalize stamps on it. */
  const entryForCh1 = {
    id: 'revision:1:1', chapterId: 1, characterId: 'narr', playable: true, hasPreviousAudio: true,
    segments: [], origin: 'server', chapterUuid: UUIDS[0], renderedAt: '2026-01-01T00:00:00.000Z',
  };
  const failDropOnce = async () => {
    const store = await import('../workspace/revisions-store.js');
    vi.mocked(store.reconcilePendingAfterRestructure).mockRejectedValueOnce(Object.assign(
      new Error(`EPERM: operation not permitted, rename '${revPath()}.tmp'`), { code: 'EPERM' }));
    return vi.spyOn(console, 'error').mockImplementation(() => {});
  };
  beforeEach(() => {
    const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    state.chapters.forEach((c: { uuid?: string }, i: number) => { c.uuid = UUIDS[i]; });
    writeFileSync(join(bookDir, '.audiobook', 'state.json'), JSON.stringify(state));
    writeFileSync(revPath(), JSON.stringify({ schema: 1, fileId: '000000000000001-a', rev: 1, pending: [entryForCh1], dismissed: [], acceptedSelections: {}, timeline: {} }));
  });
  afterEach(() => rmSync(revPath(), { recursive: true, force: true }));

  for (const op of ['accept', 'reject'] as const) {
    it(`reorder + failed drop: ${op} answers revision_not_found and leaves the id's new chapter's audio untouched`, async () => {
      const err = await failDropOnce();
      const re = await request(app).post(`/api/books/${bookId}/chapters/reorder`).send({ order: [2, 3, 1] });
      err.mockRestore();
      expect(re.status).toBe(200);
      // Id 1 now names the old chapter 2 (renumbered). No take existed before the reorder, so the test writes a .previous.mp3 itself to stand in for another chapter's take.
      const slug = readState().chapters[0].slug;
      expect(readState().chapters[0].uuid).toBe(UUIDS[1]);
      writeFileSync(join(audioRoot, `${slug}.previous.mp3`), 'OTHER-CHAPTERS-OLD-TAKE');
      const live = readFileSync(join(audioRoot, `${slug}.mp3`), 'utf8');

      const res = await request(app).post(`/api/books/${bookId}/revisions/${entryForCh1.id}/${op}`).send({});
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('revision_not_found');
      expect(readFileSync(join(audioRoot, `${slug}.mp3`), 'utf8')).toBe(live);
      expect(existsSync(join(audioRoot, `${slug}.previous.mp3`))).toBe(true);
    });
  }

  it('merge + failed drop: the surviving chapter keeps its uuid but its render changed, so reject is refused', async () => {
    const err = await failDropOnce();
    const re = await request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [1, 2] });
    err.mockRestore();
    expect(re.status).toBe(200);
    const merged = readState().chapters[0];
    expect(merged.uuid).toBe(UUIDS[0]);
    writeFileSync(join(audioRoot, `${merged.slug}.previous.mp3`), 'PRE-MERGE-TAKE');

    const res = await request(app).post(`/api/books/${bookId}/revisions/${entryForCh1.id}/reject`).send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('revision_not_found');
    expect(readFileSync(join(audioRoot, `${merged.slug}.previous.mp3`), 'utf8')).toBe('PRE-MERGE-TAKE');
  });

  it("control: an untouched chapter's entry still rejects normally", async () => {
    writeFileSync(join(audioRoot, '01-chapter-one.previous.mp3'), 'ORIGINAL');
    const res = await request(app).post(`/api/books/${bookId}/revisions/${entryForCh1.id}/reject`).send({});
    expect(res.status).toBe(200);
    expect(readFileSync(join(audioRoot, '01-chapter-one.mp3'), 'utf8')).toBe('ORIGINAL');
  });
});

/* -- #3704: a renumbered chapter keeps its pending A/B take -------------- */

describe('#3704 — a renumbered chapter keeps its pending A/B take', () => {
  const revPath = () => join(bookDir, '.audiobook', 'revisions.json');
  const UUIDS = ['uuid-ch-1', 'uuid-ch-2', 'uuid-ch-3'];
  const entryForCh1 = {
    id: 'revision:1:1', chapterId: 1, characterId: 'narr', playable: true, hasPreviousAudio: true,
    segments: [], origin: 'server', chapterUuid: UUIDS[0], renderedAt: '2026-01-01T00:00:00.000Z',
  };
  const pending = () => JSON.parse(readFileSync(revPath(), 'utf8')).pending as Array<Record<string, unknown>>;
  beforeEach(() => {
    const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    state.chapters.forEach((c: { uuid?: string }, i: number) => { c.uuid = UUIDS[i]; });
    writeFileSync(join(bookDir, '.audiobook', 'state.json'), JSON.stringify(state));
    writeFileSync(revPath(), JSON.stringify({ schema: 1, fileId: '000000000000001-a', rev: 1, pending: [entryForCh1], dismissed: [], acceptedSelections: {}, timeline: {} }));
  });
  afterEach(() => rmSync(revPath(), { recursive: true, force: true }));

  it('R1: reorder re-keys the entry to the chapter\'s new id and the take is still rejectable', async () => {
    writeFileSync(join(audioRoot, '01-chapter-one.previous.mp3'), 'ORIGINAL');
    const re = await request(app).post(`/api/books/${bookId}/chapters/reorder`).send({ order: [2, 3, 1] });
    expect(re.status).toBe(200);
    expect(pending()).toEqual([{ ...entryForCh1, chapterId: 3 }]);
    const moved = readState().chapters[2];
    expect(moved.uuid).toBe(UUIDS[0]);
    expect(readFileSync(join(audioRoot, `${moved.slug}.previous.mp3`), 'utf8')).toBe('ORIGINAL');
    const res = await request(app).post(`/api/books/${bookId}/revisions/${entryForCh1.id}/reject`).send({});
    expect(res.status).toBe(200);
    expect(readFileSync(join(audioRoot, `${moved.slug}.mp3`), 'utf8')).toBe('ORIGINAL');
  });

  it('R2 (control): the same reorder without a .previous.mp3 still drops the entry', async () => {
    const re = await request(app).post(`/api/books/${bookId}/chapters/reorder`).send({ order: [2, 3, 1] });
    expect(re.status).toBe(200);
    expect(pending()).toEqual([]);
  });

  it('R3: a merge deletes the take and drops the entry', async () => {
    writeFileSync(join(audioRoot, '01-chapter-one.previous.mp3'), 'ORIGINAL');
    const re = await request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [1, 2] });
    expect(re.status).toBe(200);
    expect(pending()).toEqual([]);
    expect(readdirSync(audioRoot).filter((f) => f.includes('.previous.mp3'))).toEqual([]);
  });
});

/* -- merged-away tombstones (#3400) --------------------------------- */

describe('restructure carries mergedAwayKeys where sentence ids are unchanged (#3400)', () => {
  /* Each chapter ends at sentence 2 and has a trailing tombstone at 3, so the
     chapter's live ids are gap-free and an op that leaves it alone keeps them. */
  function seedTombstones(keys: string[], sentences?: unknown[]): void {
    const base = JSON.parse(
      readFileSync(join(bookDir, '.audiobook', 'manuscript-edits.json'), 'utf8'),
    ) as { sentences: unknown[] };
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({ sentences: sentences ?? base.sentences, mergedAwayKeys: keys }),
    );
  }
  function readKeys(): string[] {
    const e = JSON.parse(
      readFileSync(join(bookDir, '.audiobook', 'manuscript-edits.json'), 'utf8'),
    ) as { mergedAwayKeys?: string[] };
    return [...(e.mergedAwayKeys ?? [])].sort();
  }

  it('reorder re-keys each tombstone to its chapter new id', async () => {
    seedTombstones(['1:3', '2:3', '3:3']);
    const res = await request(app).post(`/api/books/${bookId}/chapters/reorder`).send({ order: [3, 1, 2] });
    expect(res.status).toBe(200);
    // old 3 -> 1, old 1 -> 2, old 2 -> 3
    expect(readKeys()).toEqual(['1:3', '2:3', '3:3']);
  });

  it('reorder re-keys to DIFFERENT ids when the chapter moves (not a no-op)', async () => {
    seedTombstones(['1:5'], [
      { id: 1, chapterId: 1, characterId: 'narr', text: 'a' },
      { id: 2, chapterId: 1, characterId: 'narr', text: 'b' },
      { id: 3, chapterId: 1, characterId: 'narr', text: 'c' },
      { id: 4, chapterId: 1, characterId: 'narr', text: 'd' },
      { id: 1, chapterId: 2, characterId: 'narr', text: 'e' },
      { id: 1, chapterId: 3, characterId: 'narr', text: 'f' },
    ]);
    const res = await request(app).post(`/api/books/${bookId}/chapters/reorder`).send({ order: [3, 1, 2] });
    expect(res.status).toBe(200);
    expect(readKeys()).toEqual(['2:5']);
  });

  it('merge drops the merged chapters tombstones and keeps the untouched chapter', async () => {
    seedTombstones(['1:3', '2:3', '3:3']);
    const res = await request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [2, 3] });
    expect(res.status).toBe(200);
    expect(readKeys()).toEqual(['1:3']);
  });

  it('merge re-keys a shifted later chapter', async () => {
    seedTombstones(['1:3', '2:3', '3:3']);
    const res = await request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [1, 2] });
    expect(res.status).toBe(200);
    expect(readKeys()).toEqual(['2:3']);
  });

  it('split drops the split chapter and re-keys the chapters after it', async () => {
    seedTombstones(['1:3', '2:3', '3:3']);
    const res = await request(app).post(`/api/books/${bookId}/chapters/split`).send({ chapterId: 2, afterSentenceId: 1 });
    expect(res.status).toBe(200);
    expect(readKeys()).toEqual(['1:3', '4:3']);
  });

  it('exclude and rename keep every tombstone', async () => {
    seedTombstones(['1:3', '2:3', '3:3']);
    const ex = await request(app).post(`/api/books/${bookId}/chapters/exclude`).send({ chapterIds: [2], excluded: true });
    expect(ex.status).toBe(200);
    expect(readKeys()).toEqual(['1:3', '2:3', '3:3']);
    const rn = await request(app).post(`/api/books/${bookId}/chapters/1/rename`).send({ title: 'Opening' });
    expect(rn.status).toBe(200);
    expect(readKeys()).toEqual(['1:3', '2:3', '3:3']);
  });

  it('drops a tombstone in a chapter whose live ids the op renumbered (a gap shifts them)', async () => {
    // chapter 1 has ids 1,3 live (2 merged away): the remap renumbers 3 -> 2,
    // so a surviving "1:2" would shadow the live sentence.
    seedTombstones(['1:2', '2:3'], [
      { id: 1, chapterId: 1, characterId: 'narr', text: 'a' },
      { id: 3, chapterId: 1, characterId: 'narr', text: 'c' },
      { id: 1, chapterId: 2, characterId: 'narr', text: 'e' },
      { id: 2, chapterId: 2, characterId: 'narr', text: 'f' },
      { id: 1, chapterId: 3, characterId: 'narr', text: 'g' },
    ]);
    const res = await request(app).post(`/api/books/${bookId}/chapters/reorder`).send({ order: [1, 2, 3] });
    expect(res.status).toBe(200);
    expect(readKeys()).toEqual(['2:3']);
  });

  it('leaves manuscript-edits.json without a mergedAwayKeys field when it had none', async () => {
    const res = await request(app).post(`/api/books/${bookId}/chapters/reorder`).send({ order: [3, 1, 2] });
    expect(res.status).toBe(200);
    expect('mergedAwayKeys' in readEdits()).toBe(false);
  });
});

/* -- state / manuscript saves vs a restructure (#3400) ------------------ */

describe('book-state saves take the book lock a restructure holds (#3400)', () => {
  const RUNS = 24;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /* Start the POST at t=0 and the PUT at `offsetMs` (negative = PUT first). */
  async function race(
    offsetMs: number,
    put: () => Promise<unknown>,
  ): Promise<void> {
    const post = (async () => {
      if (offsetMs < 0) await sleep(-offsetMs);
      return request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [2, 3] });
    })();
    const putP = (async () => {
      if (offsetMs > 0) await sleep(offsetMs);
      return put();
    })();
    const [m, p] = await Promise.all([post, putP]);
    expect((m as { status: number }).status).toBe(200);
    expect((p as { status: number }).status).toBe(200);
  }

  async function reset(): Promise<void> {
    seedState();
    seedManuscriptEdits();
    const raw = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    raw.prosodyAnnotated = true;
    writeFileSync(join(bookDir, '.audiobook', 'state.json'), JSON.stringify(raw));
    const { removeManuscript } = await import('../store/manuscripts.js');
    removeManuscript(MANUSCRIPT_ID);
  }

  it('a state PUT racing a merge never reverts the merged chapter list', async () => {
    for (let i = 0; i < RUNS; i++) {
      await reset();
      await race((i % 8) - 3, () =>
        request(app)
          .put(`/api/books/${bookId}/state`)
          .send({ slice: 'state', patch: { prosodyAnnotated: false } }),
      );
      const state = readState() as { chapters: unknown[]; prosodyAnnotated?: boolean };
      expect(state.chapters, `run ${i}`).toHaveLength(2);
      expect(state.prosodyAnnotated, `run ${i}`).toBe(false);
    }
  });

  /* What the lock can and cannot guarantee for a manuscript PUT (pass-7 1).
     The PUT replaces manuscript-edits.json WHOLESALE, so serialising it only
     decides who writes last: a PUT built BEFORE the restructure that lands
     AFTER it puts the pre-restructure chapter ids back, lock or no lock. In the
     app the client guard (no edits while a restructure is in flight) prevents
     that; the server cannot. So the claim pinned here is serial equivalence,
     not "never lost". */
  const putBody = (i: number) =>
    readEdits().sentences.map((s) =>
      s.chapterId === 1 && s.id === 1 ? { ...s, text: `Edited ${i}.` } : s,
    );

  it('a manuscript PUT that lands BEFORE a merge is re-keyed by it: edits and state agree', async () => {
    await reset();
    const put = await request(app)
      .put(`/api/books/${bookId}/state`)
      .send({ slice: 'manuscript', patch: { sentences: putBody(0) } });
    expect(put.status).toBe(200);
    const merge = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [2, 3] });
    expect(merge.status).toBe(200);
    const stateIds = readState().chapters.map((c) => c.id);
    const edits = readEdits().sentences;
    expect(stateIds).toEqual([1, 2]);
    for (const s of edits) expect(stateIds).toContain(s.chapterId);
    expect(edits.find((s) => s.chapterId === 1 && s.id === 1)?.text).toBe('Edited 0.');
  });

  it('a stale manuscript PUT that lands AFTER a merge replaces the file wholesale (the limit the client guard covers)', async () => {
    await reset();
    const stale = putBody(0);
    await request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [2, 3] });
    await request(app)
      .put(`/api/books/${bookId}/state`)
      .send({ slice: 'manuscript', patch: { sentences: stale } });
    expect(readState().chapters).toHaveLength(2);
    expect(readEdits().sentences.map((s) => s.chapterId)).toContain(3);
  });

  it('a manuscript PUT racing a merge ends in one of the two serial states, never a mix', async () => {
    for (let i = 0; i < RUNS; i++) {
      await reset();
      const body = putBody(i);
      await race((i % 8) - 3, () =>
        request(app)
          .put(`/api/books/${bookId}/state`)
          .send({ slice: 'manuscript', patch: { sentences: body } }),
      );
      const stateIds = readState().chapters.map((c) => c.id);
      const edits = readEdits().sentences;
      expect(stateIds, `run ${i}`).toEqual([1, 2]);
      const putThenMerge =
        edits.every((s) => stateIds.includes(s.chapterId)) &&
        edits.find((s) => s.chapterId === 1 && s.id === 1)?.text === `Edited ${i}.`;
      const mergeThenPut = JSON.stringify(edits) === JSON.stringify(body);
      expect(putThenMerge || mergeThenPut, `run ${i}: ${JSON.stringify(edits)}`).toBe(true);
    }
  });
});

/* -- held / exclude POSTs vs a restructure (#3400, pass 7) ---------------- */

describe('held / exclude POSTs take the book lock a restructure holds (#3400)', () => {
  const RUNS = 24;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function reset(): Promise<void> {
    seedState();
    seedManuscriptEdits();
    const { removeManuscript } = await import('../store/manuscripts.js');
    removeManuscript(MANUSCRIPT_ID);
  }

  /* Start the merge at t=0 and the other POST at `offsetMs` (negative = it
     goes first). Both must answer 200. */
  async function raceMerge(offsetMs: number, other: () => Promise<{ status: number }>) {
    const merge = (async () => {
      if (offsetMs < 0) await sleep(-offsetMs);
      return request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [2, 3] });
    })();
    const o = (async () => {
      if (offsetMs > 0) await sleep(offsetMs);
      return other();
    })();
    const [m, p] = await Promise.all([merge, o]);
    expect(m.status).toBe(200);
    expect(p.status).toBe(200);
  }

  /* The merged chapter list survives, and manuscript-edits.json agrees with it
     (pass-7 probe 1: the reverted state kept 3 chapters against edits keyed to 2). */
  function expectMergedEndState(run: number) {
    const ids = readState().chapters.map((c) => c.id);
    expect(ids, `run ${run}`).toEqual([1, 2]);
    for (const s of readEdits().sentences) expect(ids, `run ${run}`).toContain(s.chapterId);
  }

  it('a held POST racing a merge of 2+3 never reverts the merged chapter list', async () => {
    for (let i = 0; i < RUNS; i++) {
      await reset();
      await raceMerge((i % 8) - 3, () =>
        request(app).post(`/api/books/${bookId}/chapters/1/held`).send({ held: true }),
      );
      expectMergedEndState(i);
    }
  });

  it('an exclude POST racing a merge of 2+3 never reverts the merged chapter list', async () => {
    for (let i = 0; i < RUNS; i++) {
      await reset();
      await raceMerge((i % 8) - 3, () =>
        request(app).post(`/api/books/${bookId}/chapters/1/exclude`).send({ excluded: true }),
      );
      expectMergedEndState(i);
    }
  });

  it('three parallel exclude POSTs on one book all land (the reparse dialog shape)', async () => {
    for (let i = 0; i < 8; i++) {
      await reset();
      const res = await Promise.all(
        [1, 2, 3].map((id) =>
          request(app).post(`/api/books/${bookId}/chapters/${id}/exclude`).send({ excluded: true }),
        ),
      );
      expect(res.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(
        readState().chapters.map((c) => c.excluded),
        `run ${i}`,
      ).toEqual([true, true, true]);
    }
  });
});

/* -- per-chapter fields a restructure used to drop (#3400, pass 7) -------- */

describe('restructure carries held / audioEngines / audioQa / failure fields', () => {
  type Ch = Record<string, unknown> & { id: number };
  const chapters = () => readState().chapters as unknown as Ch[];
  function patchChapters(fn: (c: Ch[]) => void): void {
    const p = join(bookDir, '.audiobook', 'state.json');
    const s = JSON.parse(readFileSync(p, 'utf8'));
    fn(s.chapters);
    writeFileSync(p, JSON.stringify(s));
  }

  it('hold chapter 1, merge 2+3: chapter 1 stays held (probe 5)', async () => {
    await request(app).post(`/api/books/${bookId}/chapters/1/held`).send({ held: true });
    const res = await request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [2, 3] });
    expect(res.status).toBe(200);
    expect(chapters()[0].held).toBe(true);
    expect(chapters()[1].held).toBeUndefined();
  });

  it('merge: the merged chapter is held when ANY source chapter was (the conservative choice)', async () => {
    await request(app).post(`/api/books/${bookId}/chapters/3/held`).send({ held: true });
    await request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [2, 3] });
    expect(chapters().map((c) => c.held)).toEqual([undefined, true]);
  });

  it('untouched chapters keep audioEngines, audioQa and the failure record through a merge', async () => {
    const qa = { status: 'ok', reasons: [], measuredLufs: -20, truePeakDb: -2, durationSec: 5, expectedSec: 5, checkedAt: 'x' };
    patchChapters((c) => {
      c[0].audioEngines = { kokoro: 2 };
      c[0].audioQa = qa;
      c[0].generationState = 'failed';
      c[0].generationError = 'boom';
      c[0].generationErrorCode = 'E1';
      c[0].generationRemediation = 'retry';
    });
    await request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [2, 3] });
    const c1 = chapters()[0];
    expect(c1.audioEngines).toEqual({ kokoro: 2 });
    expect(c1.audioQa).toEqual(qa);
    expect([c1.generationState, c1.generationError, c1.generationErrorCode, c1.generationRemediation]).toEqual([
      'failed',
      'boom',
      'E1',
      'retry',
    ]);
  });

  it('a merged chapter drops the audio-describing fields (its audio is gone) but keeps no stale failure', async () => {
    patchChapters((c) => {
      c[1].audioEngines = { kokoro: 1 };
      c[1].generationState = 'failed';
    });
    await request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [2, 3] });
    const merged = chapters()[1];
    expect(merged.audioEngines).toBeUndefined();
    expect(merged.generationState).toBeUndefined();
  });

  it('reorder: held follows the chapter to its new id', async () => {
    await request(app).post(`/api/books/${bookId}/chapters/1/held`).send({ held: true });
    await request(app).post(`/api/books/${bookId}/chapters/reorder`).send({ order: [3, 1, 2] });
    expect(chapters().map((c) => c.held)).toEqual([undefined, true, undefined]);
  });

  it('split: both halves of a held chapter are held, the others unchanged', async () => {
    await request(app).post(`/api/books/${bookId}/chapters/2/held`).send({ held: true });
    await request(app).post(`/api/books/${bookId}/chapters/split`).send({ chapterId: 2, afterSentenceId: 1 });
    expect(chapters().map((c) => c.held)).toEqual([undefined, true, true, undefined]);
  });
});

/* -- #3625: state.json writes wait on the per-book state lock ------------- */

describe('POST /:bookId/chapters/merge — state lock (#3625)', () => {
  const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
  const statePathNow = () => join(bookDir, '.audiobook', 'state.json');

  /* Locks a failing assertion left held; released in afterEach so one red case
     cannot starve the next one into a lock timeout. */
  const openHolds: Array<() => void> = [];
  afterEach(() => {
    while (openHolds.length) openHolds.pop()!();
  });

  async function holdLock(): Promise<{ release: () => void; held: Promise<void> }> {
    const { withStateJsonLock } = await import('../workspace/file-lock.js');
    const { stateJsonPath: stateJsonPathForLock } = await import('../workspace/paths.js');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const got = new Promise<void>((r) => (acquired = r));
    const held = withStateJsonLock(stateJsonPathForLock(bookDir), async () => {
      acquired();
      await gate;
    });
    await got;
    openHolds.push(release);
    return { release, held };
  }

  const sendMerge = (ids: number[]) =>
    request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: ids })
      .then((r) => r);

  it('waits on the lock: state.json is unchanged while held, restructured after release', async () => {
    const { release, held } = await holdLock();
    const pending = sendMerge([2, 3]);
    await settle(200);
    // Compare the chapter list, not the bytes: findBookByBookId's own lazy
    // migration may re-serialise the file before the restructure's lock wait.
    expect(readState().chapters.map((c) => c.id)).toEqual([1, 2, 3]);
    release();
    await held;
    const res = await pending;
    expect(res.status).toBe(200);
    expect(readState().chapters.map((c) => c.id)).toEqual([1, 2]);
  });

  it('derives the restructure from a read taken inside the lock (stale-snapshot)', async () => {
    const { release, held } = await holdLock();
    const pending = sendMerge([1, 2]);
    await settle(200);
    // A concurrent writer stamps the surviving chapter 3 while the merge waits.
    const cur = readState();
    cur.chapters[2].audioRenderedAt = '2026-09-09T09:09:09.000Z';
    writeFileSync(statePathNow(), JSON.stringify(cur));
    release();
    await held;
    const res = await pending;
    expect(res.status).toBe(200);
    const after = readState();
    expect(after.chapters).toHaveLength(2);
    expect(after.chapters[1].slug).toBe('02-chapter-three');
    expect(after.chapters[1].audioRenderedAt).toBe('2026-09-09T09:09:09.000Z');
  });
});

describe('#3628 — titleSynthesized does not outlive the title it describes', () => {
  it('a chapter retitled through PUT /state is no longer renumbered by a later restructure', async () => {
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const seeded = JSON.parse(readFileSync(statePath, 'utf8'));
    seeded.chapters[1] = { ...seeded.chapters[1], title: 'Chapter 2', titleSynthesized: true };
    seeded.chapters[2] = { ...seeded.chapters[2], title: 'Chapter 3', titleSynthesized: true };
    writeFileSync(statePath, JSON.stringify(seeded));

    const put = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({
        slice: 'state',
        patch: {
          chapters: readState().chapters.map((c) => (c.id === 3 ? { ...c, title: 'Chapter 9' } : c)),
        },
      });
    expect(put.status).toBe(200);
    expect(
      (JSON.parse(readFileSync(statePath, 'utf8')).chapters[2] as { titleSynthesized?: boolean })
        .titleSynthesized,
    ).toBeUndefined();

    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/exclude`)
      .send({ chapterIds: [1], excluded: true });
    expect(res.status).toBe(200);
    const titles = readState().chapters.map((c) => c.title);
    expect(titles[1]).toBe('Chapter 2'); // still app-made: kept (and renumbered to its own id)
    expect(titles[2]).toBe('Chapter 9'); // user-retitled: left alone
  });
});

describe('#3628 — refresh-titles hands the parser\'s app-made flags to the transform', () => {
  it('a re-derived title the parser itself made up stays flagged', async () => {
    // No heading in the manuscript: the parser titles the lone chapter "Chapter 1" (app-made).
    writeFileSync(join(bookDir, 'manuscript.md'), 'Just some opening prose here.\nAnd more of it.\n');
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
        chapters: [{ id: 1, title: 'Chapter 7', slug: '01-chapter-7', titleSynthesized: true }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [{ id: 1, chapterId: 1, characterId: 'narr', text: 'Just some opening prose here.' }],
      }),
    );

    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/refresh-titles`)
      .send({ useFirstLine: false });
    expect(res.status).toBe(200);

    const ch = readState().chapters[0] as { title: string; titleSynthesized?: boolean };
    expect(ch.title).toBe('Chapter 1');
    expect(ch.titleSynthesized).toBe(true);
  });
});

describe('#3628 — a legacy book (no titleSynthesized key) is backfilled before a restructure', () => {
  // Parses to [Chapter 1 (app-made: prose before any heading), Prologue, Epilogue].
  const LEGACY_MANUSCRIPT =
    'Opening prose here.\n\nPrologue\n\nProse two.\n\nEpilogue\n\nProse three.\n';

  function seedLegacy(titles: string[], extra: Record<number, object> = {}): void {
    writeFileSync(join(bookDir, 'manuscript.md'), LEGACY_MANUSCRIPT);
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
        chapters: titles.map((t, i) => ({
          id: i + 1,
          title: t,
          slug: `0${i + 1}-x`,
          ...(extra[i + 1] ?? {}),
        })),
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [1, 2, 3].map((c) => ({ id: 1, chapterId: c, characterId: 'narr', text: `S${c}.` })),
      }),
    );
  }

  const reorder = () =>
    request(app).post(`/api/books/${bookId}/chapters/reorder`).send({ order: [2, 1, 3] });

  it('a title that still matches the import is recognised as app-made and renumbered', async () => {
    seedLegacy(['Chapter 1', 'Prologue', 'Epilogue']);
    expect((await reorder()).status).toBe(200);
    // Old chapter 1 is now id 2: renumbered because the backfill flagged it.
    expect(readState().chapters.map((c) => c.title)).toEqual(['Prologue', 'Chapter 2', 'Epilogue']);
  });

  it('a user-edited title is not backfilled', async () => {
    seedLegacy(['Chapter 1 — My Own Subtitle', 'Prologue', 'Epilogue']);
    expect((await reorder()).status).toBe(200);
    expect(readState().chapters.map((c) => c.title)).toEqual([
      'Prologue',
      'Chapter 1 — My Own Subtitle',
      'Epilogue',
    ]);
  });

  it('a chapter-count mismatch causes no backfill', async () => {
    seedLegacy(['Chapter 1', 'Prologue']);
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [1, 2].map((c) => ({ id: 1, chapterId: c, characterId: 'narr', text: `S${c}.` })),
      }),
    );
    // The manuscript parses to 3 chapters, the book has 2: no backfill.
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/exclude`)
      .send({ chapterIds: [2], excluded: true });
    expect(res.status).toBe(200);
    expect(readState().chapters.some((c) => 'titleSynthesized' in c)).toBe(false);
  });

  // The backfill is the only caller that passes `sourcePath` (the hydrate path doesn't).
  const backfillParses = () =>
    parseManuscriptSpy.mock.calls.filter(([arg]) => (arg as { sourcePath?: string }).sourcePath).length;

  it('a book with no generic-looking titles does not parse the manuscript', async () => {
    seedLegacy(['Opening', 'Prologue', 'Epilogue']);
    parseManuscriptSpy.mockClear();
    expect((await reorder()).status).toBe(200);
    expect(backfillParses()).toBe(0);
  });

  it('control: a generic-looking keyless title still triggers the parse', async () => {
    seedLegacy(['Chapter 1', 'Prologue', 'Epilogue']);
    parseManuscriptSpy.mockClear();
    expect((await reorder()).status).toBe(200);
    expect(backfillParses()).toBe(1);
  });

  it('the legacy-title parse runs OUTSIDE the state-json lock (#3700)', async () => {
    seedLegacy(['Chapter 1', 'Prologue', 'Epilogue']);
    const { withStateJsonLock } = await import('../workspace/file-lock.js');
    const statePath = join(bookDir, '.audiobook', 'state.json');
    let lockFreeDuringParse: boolean | undefined;
    parseManuscriptSpy.mockClear();
    const actualImpl = parseManuscriptSpy.getMockImplementation()!;
    parseManuscriptSpy.mockImplementation(async (arg: { sourcePath?: string }) => {
      if (arg.sourcePath) {
        // A short-budget acquire: it times out iff the restructure still holds the lock.
        lockFreeDuringParse = await withStateJsonLock(statePath, async () => true, 50).catch(() => false);
      }
      return actualImpl(arg);
    });
    try {
      expect((await reorder()).status).toBe(200);
    } finally {
      parseManuscriptSpy.mockImplementation(actualImpl);
    }
    expect(lockFreeDuringParse, 'parse never ran').toBeDefined();
    expect(lockFreeDuringParse).toBe(true);
  });

  it('an explicit titleSynthesized: false is preserved', async () => {
    seedLegacy(['Chapter 1', 'Prologue', 'Epilogue'], { 1: { titleSynthesized: false } });
    expect((await reorder()).status).toBe(200);
    expect(readState().chapters.map((c) => c.title)).toEqual(['Prologue', 'Chapter 1', 'Epilogue']);
  });
});

/* -- analysis running (restructure refused) ------------------------- */

describe('restructure while an analysis job runs', () => {
  async function registerJob(kind: 'main' | 'subset') {
    const { __testRegisterJobForTest } = await import('./analysis.js');
    const job = {
      controller: new AbortController(),
      subscribers: new Set(),
      manuscriptId: MANUSCRIPT_ID,
      kind,
      bookDir: null,
      engine: 'gemini',
      replay: {
        logs: [],
        lastPhase: null,
        lastEta: null,
        lastCastUpdate: null,
        failedByChapterId: new Map(),
        lastSeriesPrior: null,
        warnings: new Map(),
      },
      lastDiskWriteAt: 0,
    } as unknown as import('./analysis.js').AnalysisJob;
    __testRegisterJobForTest(job);
    return job;
  }

  async function finish(job: import('./analysis.js').AnalysisJob) {
    const { endJob } = await import('./analysis.js');
    endJob(job, { kind: 'result' });
  }

  // The scan that locates the book may heal derived fields (uuid, duration); a restructure would change id/title/slug.
  const stateBefore = () => JSON.stringify(readState().chapters.map((c) => ({ id: c.id, title: c.title, slug: c.slug })));
  const editsBefore = () => readFileSync(join(bookDir, '.audiobook', 'manuscript-edits.json'), 'utf8');

  const ROUTES: Array<[string, string, unknown]> = [
    ['merge', 'chapters/merge', { chapterIds: [2, 3] }],
    ['split', 'chapters/split', { chapterId: 2, afterSentenceId: 1 }],
    ['reorder', 'chapters/reorder', { order: [3, 1, 2] }],
    ['exclude', 'chapters/exclude', { chapterIds: [2], excluded: true }],
    ['rename', 'chapters/2/rename', { title: 'Renamed' }],
    ['refresh-titles', 'chapters/refresh-titles', {}],
  ];

  for (const kind of ['main', 'subset'] as const) {
    it.each(ROUTES)(`409s %s while a ${kind} job runs and touches nothing`, async (_n, path, body) => {
      const job = await registerJob(kind);
      try {
        const s = stateBefore();
        const e = editsBefore();
        const res = await request(app).post(`/api/books/${bookId}/${path}`).send(body as object);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('analysis_running');
        expect(res.body.error).toMatch(/analysis/i);
        expect(JSON.stringify(res.body)).not.toContain(workspaceRoot);
        /* JSON doubles each backslash, so on Windows the raw root never matches the serialised body. */
        expect(JSON.stringify(res.body)).not.toContain(JSON.stringify(workspaceRoot).slice(1, -1));
        expect(stateBefore()).toBe(s);
        expect(editsBefore()).toBe(e);
      } finally {
        await finish(job);
      }
    });
  }

  it('succeeds once the job has ended', async () => {
    const job = await registerJob('main');
    const refused = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [2, 3] });
    expect(refused.status).toBe(409);
    await finish(job);
    const ok = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [2, 3] });
    expect(ok.status).toBe(200);
  });

  it('refuses an analysis start while a restructure holds the book', async () => {
    const { beginRestructure, endRestructure } = await import('../workspace/restructure-gate.js');
    const { mainStartRefusalForTest, subsetRefusalForTest } = await import('./analysis.js');
    expect(beginRestructure(MANUSCRIPT_ID)).toBe(true);
    try {
      expect(mainStartRefusalForTest(MANUSCRIPT_ID)?.error).toBe('chapters_restructuring');
      expect(subsetRefusalForTest(MANUSCRIPT_ID)?.error).toBe('chapters_restructuring');
    } finally {
      endRestructure(MANUSCRIPT_ID);
    }
    expect(mainStartRefusalForTest(MANUSCRIPT_ID)).toBeNull();
  });
});

/* #3400 pass 8 -- the gate claim `applyRestructure` takes is released on EVERY
   exit path. A leaked claim would refuse every analysis start for the book
   until a restart, and nothing else would clear it. */
describe('the restructure claim is released on every exit path (#3400)', () => {
  it('releases after a successful restructure', async () => {
    const { isRestructuring } = await import('../workspace/restructure-gate.js');
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [2, 3] });
    expect(res.status).toBe(200);
    expect(isRestructuring(MANUSCRIPT_ID)).toBe(false);
  });

  it('releases after a transform refusal (400)', async () => {
    const { isRestructuring } = await import('../workspace/restructure-gate.js');
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [98, 99] });
    expect(res.status).toBe(400);
    expect(isRestructuring(MANUSCRIPT_ID)).toBe(false);
  });

  it('releases when the manuscript is not on disk (404)', async () => {
    const { isRestructuring } = await import('../workspace/restructure-gate.js');
    const manuscript = join(bookDir, 'manuscript.md');
    rmSync(manuscript, { force: true });
    try {
      const res = await request(app)
        .post(`/api/books/${bookId}/chapters/merge`)
        .send({ chapterIds: [2, 3] });
      expect(res.status).toBe(404);
      expect(isRestructuring(MANUSCRIPT_ID)).toBe(false);
    } finally {
      writeFileSync(manuscript, MANUSCRIPT_BODY);
    }
  });

  it('releases when a write throws (500)', async () => {
    const { isRestructuring } = await import('../workspace/restructure-gate.js');
    const editsPath = join(bookDir, '.audiobook', 'manuscript-edits.json');
    rmSync(editsPath, { force: true });
    mkdirSync(editsPath); // a directory where the file belongs: the read / write throws
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(app)
        .post(`/api/books/${bookId}/chapters/merge`)
        .send({ chapterIds: [2, 3] });
      expect(res.status).toBe(500);
      expect(isRestructuring(MANUSCRIPT_ID)).toBe(false);
    } finally {
      err.mockRestore();
      rmSync(editsPath, { recursive: true, force: true });
    }
  });
});

/* #3400 pass 8 -- the `manuscript` slice of the book-state PUT is taken under
   the book lock. The race tests above accept both serial outcomes and their
   offsets never produce the interleaving the lock prevents, so pin it
   deterministically: a holder owns the lock, the PUT must not have written
   while it does. */
describe('the manuscript slice of the state PUT waits for the book lock (#3400)', () => {
  it('writes nothing while a restructure-style holder owns the lock, then lands', async () => {
    const { withBookLock } = await import('../workspace/book-lock.js');
    /* Locate once first so the scan's own self-heal writes (uuid mint), which
       take this lock themselves, are already done: otherwise a mutant that
       locates OUTSIDE the lock would still be held back by the heal. */
    const { findBookByBookId } = await import('../workspace/scan.js');
    await findBookByBookId(bookId);
    const editsPath = join(bookDir, '.audiobook', 'manuscript-edits.json');
    const before = readFileSync(editsPath, 'utf8');
    const sentences = readEdits().sentences.map((s) =>
      s.chapterId === 1 && s.id === 1 ? { ...s, text: 'Edited while held.' } : s,
    );

    let release!: () => void;
    let entered!: () => void;
    const holderIn = new Promise<void>((r) => (entered = r));
    const holder = withBookLock(bookId, async () => {
      entered();
      await new Promise<void>((r) => (release = r));
    });
    await holderIn;

    const put = request(app)
      .put(`/api/books/${bookId}/state`)
      .send({ slice: 'manuscript', patch: { sentences } })
      .then((r) => r);
    await new Promise((r) => setTimeout(r, 200));
    expect(readFileSync(editsPath, 'utf8')).toBe(before);

    release();
    await holder;
    const res = await put;
    expect(res.status).toBe(200);
    expect(readEdits().sentences.find((s) => s.chapterId === 1 && s.id === 1)?.text).toBe(
      'Edited while held.',
    );
  });
});

/* #3711 reconciled with #3594 -- a restructure takes its locks in the order
   book-op -> restructure gate -> book: while a `book`-only holder (the scan's
   self-heal shape) owns the book lock, the restructure has already claimed
   book-op (a second book-op caller queues) and the analysis gate, and has
   written nothing. */
describe('a restructure takes book-op, then the gate, then the book lock (#3711)', () => {
  it('holds book-op and the gate while it waits for the book lock, then lands', async () => {
    const { withBookLock } = await import('../workspace/book-lock.js');
    const { isRestructuring } = await import('../workspace/restructure-gate.js');
    const { withBookOp } = await import('../workspace/book-op-lock.js');
    const { __keyWaitersForTest } = await import('../workspace/file-lock.js');
    /* Settle the scan's self-heal writes first (they take the book lock). */
    const { findBookByBookId } = await import('../workspace/scan.js');
    await findBookByBookId(bookId);
    const before = readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8');

    let release!: () => void;
    let entered!: () => void;
    const holderIn = new Promise<void>((r) => (entered = r));
    const holder = withBookLock(bookId, async () => {
      entered();
      await new Promise<void>((r) => (release = r));
    });
    await holderIn;

    const merge = request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [2, 3] })
      .then((r) => r);
    await vi.waitFor(() => expect(isRestructuring(MANUSCRIPT_ID)).toBe(true), { timeout: 5_000 });

    let sawChapters = -1;
    const queued = withBookOp(bookId, async (b) => {
      sawChapters = b.state.chapters.length;
    });
    await vi.waitFor(() => expect(__keyWaitersForTest(`book-op:${bookId}`)).toBeGreaterThanOrEqual(1), {
      timeout: 5_000,
    });
    expect(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8')).toBe(before);

    release();
    await holder;
    expect((await merge).status).toBe(200);
    await queued;
    expect(sawChapters).toBe(2);
    expect(isRestructuring(MANUSCRIPT_ID)).toBe(false);
  });
});
