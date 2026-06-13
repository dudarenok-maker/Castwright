/* Integration tests for the reparse-edit-migration path in book-state.ts.

   Covers:
     1. POST /:bookId/reparse preserves manuscript-edits.json (the previous
        behaviour was to delete it, silently destroying user reassignments).
     2. POST /:bookId/reparse appends a 'reparse' entry to change-log.json
        summarising the count of preserved edits.
     3. POST /:bookId/reparse with no edits file writes no change-log entry.
     4. GET /:bookId/state filters orphan edits (ids no longer present in the
        analysis cache and not above its max — i.e. neither a survivor nor a
        likely split offspring) so a previous chapter shape doesn't surface
        zombie sentences in the manuscript view.

   Mirrors the tempdir + supertest pattern from book-state.test.ts. The
   analysis cache (server/handoff/cache/<manuscriptId>.json) is a server-
   relative module constant — we write directly to it for cases that need
   a populated cache and clean up in afterAll. */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, '..', '..');
const CACHE_DIR = join(SERVER_ROOT, 'handoff', 'cache');

const AUTHOR = 'Reparse Test';
const SERIES = 'Standalones';
const TITLE = 'Reparse Migration Book';
const MANUSCRIPT_ID = 'm_reparse_test';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let cachePath: string;

const MANUSCRIPT_BODY = `# Chapter One\n\nFirst sentence.\nSecond sentence.\n\n# Chapter Two\n\nMore text here.\n`;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-reparse-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ bookStateRouter }, { makeBookId }] = await Promise.all([
    import('./book-state.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  cachePath = join(CACHE_DIR, `${MANUSCRIPT_ID}.json`);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT_BODY);

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
  // Reset state.json + remove derived files before each case so tests stay
  // independent (reparse mutates them).
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
  for (const f of [
    'manuscript-edits.json',
    'change-log.json',
    'cast.json',
    'cast-reuse-carryover.json',
    'revisions.json',
  ]) {
    const p = join(bookDir, '.audiobook', f);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  if (existsSync(cachePath)) rmSync(cachePath, { force: true });
});

describe('reparse handler — preserves manuscript-edits.json', () => {
  it('keeps the edits file on disk after reparse', async () => {
    const editsPath = join(bookDir, '.audiobook', 'manuscript-edits.json');
    const originalEdits = {
      sentences: [
        { id: 1, chapterId: 1, characterId: 'eliza', text: 'First sentence.' },
        { id: 2, chapterId: 1, characterId: 'narrator', text: 'Second sentence.' },
      ],
    };
    writeFileSync(editsPath, JSON.stringify(originalEdits));

    const res = await request(app).post(`/api/books/${bookId}/reparse`);
    expect(res.status).toBe(200);

    expect(existsSync(editsPath)).toBe(true);
    const after = JSON.parse(readFileSync(editsPath, 'utf8'));
    expect(after).toEqual(originalEdits);
  });

  it('appends a "reparse" change-log entry with the preserved-edits count', async () => {
    const editsPath = join(bookDir, '.audiobook', 'manuscript-edits.json');
    writeFileSync(
      editsPath,
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'eliza', text: 'a' },
          { id: 2, chapterId: 1, characterId: 'narrator', text: 'b' },
          { id: 3, chapterId: 1, characterId: 'halloran', text: 'c' },
        ],
      }),
    );

    const res = await request(app).post(`/api/books/${bookId}/reparse`);
    expect(res.status).toBe(200);

    const logPath = join(bookDir, '.audiobook', 'change-log.json');
    expect(existsSync(logPath)).toBe(true);
    const log = JSON.parse(readFileSync(logPath, 'utf8'));
    expect(Array.isArray(log.events)).toBe(true);
    expect(log.events).toHaveLength(1);
    expect(log.events[0]).toMatchObject({
      type: 'reparse',
      actor: 'system',
      title: 'Re-parsed manuscript',
    });
    expect(log.events[0].note).toMatch(/3 manuscript edits/);
  });

  it('writes no change-log entry when there were no edits to preserve', async () => {
    const res = await request(app).post(`/api/books/${bookId}/reparse`);
    expect(res.status).toBe(200);

    const logPath = join(bookDir, '.audiobook', 'change-log.json');
    expect(existsSync(logPath)).toBe(false);
  });
});

describe('reparse handler — reuse/voice carryover (srv-13)', () => {
  const carryoverPath = () => join(bookDir, '.audiobook', 'cast-reuse-carryover.json');
  const castPath = () => join(bookDir, '.audiobook', 'cast.json');

  it('snapshots the reuse/voice slice before deleting cast.json', async () => {
    writeFileSync(
      castPath(),
      JSON.stringify({
        characters: [
          {
            id: 'wren',
            name: 'Wren',
            aliases: ['Wren Sparrow'],
            voiceId: 'wren',
            voiceState: 'reused',
            matchedFrom: { bookId: 'b0', characterId: 'wren', confidence: 0.91 },
            overrideTtsVoices: { qwen: { name: 'qwen-wren' } },
            ttsEngine: 'qwen',
            voiceStyle: 'warm, earnest',
            notLinkedTo: [{ bookId: 'b1', characterId: 'wren-teen' }],
            // analyzer-owned fields that must NOT be snapshotted:
            lines: 99,
            evidence: ['something'],
          },
        ],
      }),
    );

    const res = await request(app).post(`/api/books/${bookId}/reparse`);
    expect(res.status).toBe(200);

    // cast.json deleted (clean slate), carryover written.
    expect(existsSync(castPath())).toBe(false);
    expect(existsSync(carryoverPath())).toBe(true);
    const carry = JSON.parse(readFileSync(carryoverPath(), 'utf8'));
    expect(carry.characters).toHaveLength(1);
    const c = carry.characters[0];
    expect(c).toMatchObject({
      id: 'wren',
      name: 'Wren',
      aliases: ['Wren Sparrow'],
      voiceId: 'wren',
      voiceState: 'reused',
      matchedFrom: { bookId: 'b0', characterId: 'wren', confidence: 0.91 },
      overrideTtsVoices: { qwen: { name: 'qwen-wren' } },
      ttsEngine: 'qwen',
      voiceStyle: 'warm, earnest',
      notLinkedTo: [{ bookId: 'b1', characterId: 'wren-teen' }],
    });
    // analyzer-owned data is NOT carried.
    expect(c.lines).toBeUndefined();
    expect(c.evidence).toBeUndefined();
  });

  it('refreshes the carryover from the CURRENT cast (no resurrection of a removed link)', async () => {
    // Stale carryover from a prior reparse still has the link…
    writeFileSync(
      carryoverPath(),
      JSON.stringify({ characters: [{ id: 'wren', voiceState: 'reused', voiceId: 'wren' }] }),
    );
    // …but the user has since unlinked Wren in the live cast.
    writeFileSync(
      castPath(),
      JSON.stringify({ characters: [{ id: 'wren', name: 'Wren', voiceState: 'generated' }] }),
    );

    const res = await request(app).post(`/api/books/${bookId}/reparse`);
    expect(res.status).toBe(200);

    const carry = JSON.parse(readFileSync(carryoverPath(), 'utf8'));
    expect(carry.characters[0].voiceState).toBe('generated');
    expect(carry.characters[0].voiceId).toBeUndefined();
  });

  it('clears a stale carryover when there is no cast to snapshot', async () => {
    writeFileSync(
      carryoverPath(),
      JSON.stringify({ characters: [{ id: 'old', voiceState: 'reused' }] }),
    );
    // no cast.json on disk

    const res = await request(app).post(`/api/books/${bookId}/reparse`);
    expect(res.status).toBe(200);

    expect(existsSync(carryoverPath())).toBe(false);
  });

  it('preserves the excluded flag across reparse (id match — typical case)', async () => {
    /* Re-parsing the same manuscript usually produces the same id-to-
       chapter map. Seed ch1 as excluded, re-parse, expect the same id
       to remain excluded. */
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const cur = JSON.parse(readFileSync(statePath, 'utf8'));
    cur.chapters = [
      { id: 1, title: 'Chapter One', slug: '01-chapter-one', excluded: true },
      { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
    ];
    writeFileSync(statePath, JSON.stringify(cur));

    const res = await request(app).post(`/api/books/${bookId}/reparse`);
    expect(res.status).toBe(200);

    const after = JSON.parse(readFileSync(statePath, 'utf8'));
    const ch1 = after.chapters.find((c: { id: number }) => c.id === 1);
    const ch2 = after.chapters.find((c: { id: number }) => c.id === 2);
    expect(ch1.excluded).toBe(true);
    expect(ch2.excluded).toBeFalsy();
  });

  it('returns rich chapter records (id, title, slug, wordCount, excluded) in the response', async () => {
    /* The re-parse dialog renders include/exclude checkboxes against
       this list. Without wordCount it can't run the heuristic; without
       excluded it can't pre-tick the server-preserved set; without slug
       the toggle-endpoint can't be addressed. All four fields are
       load-bearing. */
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const cur = JSON.parse(readFileSync(statePath, 'utf8'));
    cur.chapters = [
      { id: 1, title: 'Chapter One', slug: '01-chapter-one', excluded: true },
      { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
    ];
    writeFileSync(statePath, JSON.stringify(cur));

    const res = await request(app).post(`/api/books/${bookId}/reparse`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chapters)).toBe(true);
    expect(res.body.chapters.length).toBe(2);
    for (const c of res.body.chapters as Array<{
      id: number;
      title: string;
      slug: string;
      wordCount: number;
      excluded: boolean;
    }>) {
      expect(typeof c.id).toBe('number');
      expect(typeof c.title).toBe('string');
      expect(typeof c.slug).toBe('string');
      expect(c.slug.length).toBeGreaterThan(0);
      expect(typeof c.wordCount).toBe('number');
      expect(c.wordCount).toBeGreaterThanOrEqual(0);
      expect(typeof c.excluded).toBe('boolean');
    }
    /* The preserved excluded flag must surface as excluded: true on the
       chapter whose id carried over. */
    const preserved = res.body.chapters.find((c: { id: number }) => c.id === 1);
    expect(preserved.excluded).toBe(true);
  });

  it('preserves the excluded flag across reparse (slug match — id shifted)', async () => {
    /* If the parser reshuffles chapter ids but produces a chapter with
       a slug that matches an old excluded one, carry the flag over.
       Simulate by seeding ch1's old slug to what the parser will produce
       for the FIRST chapter after reparse, but under a different id. */
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const cur = JSON.parse(readFileSync(statePath, 'utf8'));
    cur.chapters = [
      { id: 7, title: 'Some Old Title', slug: '01-chapter-1', excluded: true }, // matches what parser emits for ch1
      { id: 8, title: 'Other Old', slug: '02-chapter-two' },
    ];
    writeFileSync(statePath, JSON.stringify(cur));

    const res = await request(app).post(`/api/books/${bookId}/reparse`);
    expect(res.status).toBe(200);

    const after = JSON.parse(readFileSync(statePath, 'utf8'));
    /* Parser produces id=1 with slug '01-chapter-1'. id-match misses
       (no chapter with id=1 in the old list), but slug-match catches
       it and carries the excluded flag forward. */
    const newCh1 = after.chapters.find((c: { id: number }) => c.id === 1);
    expect(newCh1.excluded).toBe(true);
  });

  it('prepends to an existing change-log without dropping prior entries', async () => {
    const editsPath = join(bookDir, '.audiobook', 'manuscript-edits.json');
    writeFileSync(
      editsPath,
      JSON.stringify({
        sentences: [{ id: 1, chapterId: 1, characterId: 'eliza', text: 'a' }],
      }),
    );
    const logPath = join(bookDir, '.audiobook', 'change-log.json');
    writeFileSync(
      logPath,
      JSON.stringify({
        events: [
          {
            id: 99,
            at: '2026-01-01T00:00:00.000Z',
            ts: 'Earlier',
            date: 'earlier',
            type: 'analysis_complete',
            title: 'Analysis complete',
            note: 'old',
            actor: 'system',
          },
        ],
      }),
    );

    const res = await request(app).post(`/api/books/${bookId}/reparse`);
    expect(res.status).toBe(200);

    const log = JSON.parse(readFileSync(logPath, 'utf8'));
    expect(log.events).toHaveLength(2);
    expect(log.events[0].type).toBe('reparse');
    expect(log.events[0].id).toBe(100); // max(99) + 1
    expect(log.events[1].id).toBe(99); // prior entry intact
  });
});

describe('GET handler — filters orphan edits against the analysis cache', () => {
  it('drops edits whose ids fall inside the cache range but are not present', async () => {
    /* Cache has ids [1, 2, 3, 4]. Edits has [1, 2, 99, 100] — id=99 is
       between cache max (4) and beyond, so kept as a likely split offspring;
       id=100 ditto. (Both > maxCacheId=4 = kept.) */
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({
        chapters: {
          1: [
            { id: 1, chapterId: 1, characterId: 'narrator', text: 'a' },
            { id: 2, chapterId: 1, characterId: 'narrator', text: 'b' },
            { id: 3, chapterId: 1, characterId: 'narrator', text: 'c' },
            { id: 4, chapterId: 1, characterId: 'narrator', text: 'd' },
          ],
        },
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'eliza', text: 'a' },
          { id: 2, chapterId: 1, characterId: 'narrator', text: 'b' },
          { id: 99, chapterId: 1, characterId: 'halloran', text: 'split-piece' },
          { id: 100, chapterId: 1, characterId: 'eliza', text: 'split-piece-2' },
        ],
      }),
    );

    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    const ids = (res.body.manuscriptEdits.sentences as Array<{ id: number }>).map((s) => s.id);
    expect(ids.sort((a, b) => a - b)).toEqual([1, 2, 99, 100]);
  });

  it('drops edits whose ids vanished mid-range after a chapter reshape', async () => {
    /* Cache has [1, 2, 5]. Old edits have [1, 2, 3, 4, 100]. After filter:
       - 1, 2 in cache → kept
       - 3, 4 in cache id-range (≤ max=5) but not in cache → dropped (orphans)
       - 100 > max=5 → kept (split offspring) */
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({
        chapters: {
          1: [
            { id: 1, chapterId: 1, characterId: 'narrator', text: 'a' },
            { id: 2, chapterId: 1, characterId: 'narrator', text: 'b' },
            { id: 5, chapterId: 1, characterId: 'narrator', text: 'e' },
          ],
        },
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'eliza', text: 'a' },
          { id: 2, chapterId: 1, characterId: 'eliza', text: 'b' },
          { id: 3, chapterId: 1, characterId: 'eliza', text: 'orphan-3' },
          { id: 4, chapterId: 1, characterId: 'eliza', text: 'orphan-4' },
          { id: 100, chapterId: 1, characterId: 'eliza', text: 'split-offspring' },
        ],
      }),
    );

    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    const ids = (res.body.manuscriptEdits.sentences as Array<{ id: number }>).map((s) => s.id);
    expect(ids.sort((a, b) => a - b)).toEqual([1, 2, 100]);
  });

  it('falls back to cache sentences when no edits file exists', async () => {
    /* Pre-existing fallback path stays intact: an old book whose stage 2 never
       triggered a persistence write returns the analyser sentences directly. */
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({
        chapters: {
          1: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'a' }],
        },
      }),
    );

    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    expect(res.body.manuscriptEdits.sentences).toEqual([
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'a' },
    ]);
  });

  it('keeps edits untouched when no analysis cache exists yet', async () => {
    /* Right after reparse but before re-analysis, the cache is empty. We
       can't reconcile, so trust the edits file as-is rather than wiping it. */
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'eliza', text: 'a' },
          { id: 42, chapterId: 1, characterId: 'halloran', text: 'split' },
        ],
      }),
    );

    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    const ids = (res.body.manuscriptEdits.sentences as Array<{ id: number }>).map((s) => s.id);
    expect(ids.sort((a, b) => a - b)).toEqual([1, 42]);
  });
});

describe('reparse handler — legacy text-masquerading-as-binary fallback', () => {
  /* Pre-fix versions of the import route wrote the *extracted text* to
     manuscript.epub instead of the original binary. The reparse handler
     must detect that, route the read through parseText, and produce a
     valid chapter list — instead of crashing with "Invalid/missing file"
     from epub2's adm-zip when it's handed plain text. */

  const LEGACY_AUTHOR = 'Legacy Test';
  const LEGACY_SERIES = 'Standalones';
  const LEGACY_TITLE = 'Legacy Text As Epub';
  const LEGACY_MANUSCRIPT_ID = 'm_legacy_text_as_epub';
  let legacyBookDir: string;
  let legacyBookId: string;
  let legacyCachePath: string;

  beforeAll(async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    legacyBookId = makeBookId(LEGACY_AUTHOR, LEGACY_SERIES, LEGACY_TITLE);
    legacyBookDir = join(workspaceRoot, 'books', LEGACY_AUTHOR, LEGACY_SERIES, LEGACY_TITLE);
    legacyCachePath = join(CACHE_DIR, `${LEGACY_MANUSCRIPT_ID}.json`);
    mkdirSync(join(legacyBookDir, '.audiobook'), { recursive: true });
    /* Plain text written to a .epub-named file — the exact pre-fix
       failure mode. H2 (`##`) for both chapters so neither gets eaten
       as the document title (parseText reserves the FIRST H1 for that). */
    writeFileSync(
      join(legacyBookDir, 'manuscript.epub'),
      `## Chapter One\n\nFirst legacy sentence.\n\n## Chapter Two\n\nSecond legacy sentence.\n`,
    );
    writeFileSync(
      join(legacyBookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: legacyBookId,
        manuscriptId: LEGACY_MANUSCRIPT_ID,
        title: LEGACY_TITLE,
        author: LEGACY_AUTHOR,
        series: LEGACY_SERIES,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.epub',
        castConfirmed: true,
        chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  });

  afterAll(() => {
    if (existsSync(legacyCachePath)) rmSync(legacyCachePath, { force: true });
  });

  it('routes through parseText when the on-disk .epub is actually plain text and produces a chapter list', async () => {
    const res = await request(app).post(`/api/books/${legacyBookId}/reparse`);
    expect(res.status).toBe(200);
    expect(res.body.chapterCount).toBe(2);
    expect(res.body.chapterTitles).toEqual(['Chapter One', 'Chapter Two']);
  });
});
