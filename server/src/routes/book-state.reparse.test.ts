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
     5. #1981 Task 11 — the reparse handler's cast.json delete (one arm of
        applyReparse's Promise.all) is serialised behind the cast lock, so a
        concurrent cast writer can't recreate cast.json from a stale read
        after the delete.
     6. #2099 gap A — reparse's own existingCast read is now inside that
        same cast-lock hold (not just the delete), so a concurrent cast
        writer that starts after reparse begins reading queues behind it
        instead of racing a stale snapshot and having its write silently
        erased.

   Mirrors the tempdir + supertest pattern from book-state.test.ts. The
   analysis cache (server/handoff/cache/<manuscriptId>.json) is a server-
   relative module constant — we write directly to it for cases that need
   a populated cache and clean up in afterAll. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

/* #1981 Task 11 — hoisted `vi.mock` (NOT a runtime `vi.spyOn`) so the race
   describe at the bottom of this file can deterministically intercept
   cast-aliases.ts's OWN `readJson` call (bound at cast-aliases.ts's own
   module-load time, before any runtime spy could attach to it) — same
   rationale as book-state-preserve-voices.test.ts's / qwen-voice.test.ts's
   own #1981 race tests. Defaults to a plain passthrough, so every other test
   in this file behaves exactly as if this mock weren't here; only the one
   race test below overrides `mockImplementation` for the duration of its own
   `it`, then restores it. */
vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return { ...actual, readJson: vi.fn(actual.readJson) };
});

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

  /* Sequential, not `Promise.all` — this file now carries a hoisted
     async-factory `vi.mock` (state-io.js above), which a `Promise.all` of
     dynamic imports races: the factory can lose and a module binds the
     real, unmocked export. */
  const { bookStateRouter } = await import('./book-state.js');
  const { makeBookId } = await import('../workspace/paths.js');
  const { castAliasesRouter } = await import('./cast-aliases.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  cachePath = join(CACHE_DIR, `${MANUSCRIPT_ID}.json`);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT_BODY);

  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
  /* Mounted here, at the file's top-level beforeAll, not inside the race
     describe's own hook below — a router mounted from within a describe's
     hook permanently mutates this shared `app` for every later describe. */
  app.use('/api/books', castAliasesRouter);
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

describe('GET handler — tolerates state.json without analysisProvenance (srv-59 Task 11 back-compat)', () => {
  /* analysisProvenance is additive/optional (server/src/workspace/scan.ts) —
     written only by the analysis routes' post-completion persist sites, and
     the default beforeEach state.json above never includes it. Every other
     case in this file already exercises GET/POST against that same
     provenance-less state.json without incident; this test just names the
     contract explicitly so a future reader that starts requiring the field
     fails loudly here instead of silently.

     The route nests the whole persisted state under `state` in the response
     body (`res.json({ state: stateView, cast, manuscript, ... })` in
     book-state.ts) — so analysisProvenance, when present, surfaces at
     `res.body.state.analysisProvenance`, never at the top level. The
     positive case below proves the route actually surfaces the field at
     that nested path (so the negative case's "undefined" means "this
     state.json has no block", not "the route never returns it at all");
     the negative case then proves an older state.json missing the block
     loads fine and the field reads back as undefined at that same path. */
  it('GET /:bookId/state surfaces analysisProvenance at res.body.state when state.json has it', async () => {
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const cur = JSON.parse(readFileSync(statePath, 'utf8'));
    cur.analysisProvenance = {
      engine: 'ollama',
      model: 'qwen2.5:7b',
      at: '2026-07-01T00:00:00.000Z',
      structureEngineVersion: 1,
      report: {
        alignedPct: 0.92,
        confirmed: 40,
        corrected: 3,
        flagged: 1,
        escalated: 1,
        escalationAccepted: 1,
      },
    };
    writeFileSync(statePath, JSON.stringify(cur));

    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    expect(res.body.state.analysisProvenance).toBeDefined();
    expect(res.body.state.analysisProvenance.model).toBe('qwen2.5:7b');
    expect(res.body.state.analysisProvenance.structureEngineVersion).toBe(1);
  });

  it('GET /:bookId/state succeeds and omits analysisProvenance when state.json predates it', async () => {
    // The default beforeEach state.json has no analysisProvenance block —
    // simulating a legacy book directory written before srv-59 Task 11.
    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    expect(res.body.state.analysisProvenance).toBeUndefined();
  });
});

/* #1981 Task 11 — the reparse handler's cast.json delete races a concurrent
   cast-aliases write on a DIFFERENT (own) book, so it can't disturb the
   order-dependent describes above that share `bookDir`/`bookId`.

   Named deliberately: cast-aliases' add-alias re-reads cast.json INSIDE its
   own lock and refuses with 409 when the cast is absent (see
   cast-aliases.ts) — it is rule-2-compliant, so once serialised against the
   delete it leaves cast.json deleted in BOTH orderings. book-state.ts's OWN
   cast-slice PUT handler is deliberately NOT used here: it writes
   `body.patch` regardless of on-disk state and legitimately recreates
   cast.json when it acquires the lock second — that's its documented
   contract, not a bug, so a race built on it would be ordering-dependent
   rather than lock-dependent (see this task's brief).

   Scripts the interleaving instead of a bare `Promise.all` (a flaky race
   measured 50% detection on this branch): a hoisted `vi.mock` on
   `state-io.js` holds add-alias's own in-lock `readJson(cast.json)` call
   open behind a manually-released gate. The real bytes are read (and so
   captured, stale) BEFORE the delete ever runs; only the JS-visible
   resolution is delayed — so add-alias's read genuinely happens-before the
   delete, matching the resurrection bug's precondition. Reparse is fired
   only once add-alias is confirmed stuck behind the gate, so the FIRST
   interception is deterministically add-alias's read, not reparse's own
   `existingCast` read for the reuse-carryover snapshot — which is, since
   #2099, itself in-lock and directly related (it's the read half of the
   same locked block whose delete half this describe exercises). */
describe('reparse handler — #1981 Task 11: "Start fresh" delete races a concurrent cast writer', () => {
  const RACE_AUTHOR = 'Reparse Race Author';
  const RACE_SERIES = 'Standalones';
  const RACE_TITLE = 'Reparse Race Book';
  let raceBookId: string;
  let raceBookDir: string;

  beforeAll(async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    raceBookId = makeBookId(RACE_AUTHOR, RACE_SERIES, RACE_TITLE);
    raceBookDir = join(workspaceRoot, 'books', RACE_AUTHOR, RACE_SERIES, RACE_TITLE);
  });

  it('an add-alias write does not resurrect cast.json after a concurrent reparse delete', async () => {
    mkdirSync(join(raceBookDir, '.audiobook'), { recursive: true });
    writeFileSync(join(raceBookDir, 'manuscript.md'), MANUSCRIPT_BODY);
    writeFileSync(
      join(raceBookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: raceBookId,
        manuscriptId: 'm_reparse_race',
        title: RACE_TITLE,
        author: RACE_AUTHOR,
        series: RACE_SERIES,
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
    const castPath = join(raceBookDir, '.audiobook', 'cast.json');
    writeFileSync(
      castPath,
      JSON.stringify({
        characters: [{ id: 'nova', name: 'Nova', role: 'character', color: '#abc', aliases: [] }],
      }),
    );

    const stateIo = await import('../workspace/state-io.js');
    const actual = await vi.importActual<typeof import('../workspace/state-io.js')>(
      '../workspace/state-io.js',
    );
    const { castJsonPath } = await import('../workspace/paths.js');
    const raceCastPath = castJsonPath(raceBookDir);
    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    let intercepted = false;
    const spy = vi.mocked(stateIo.readJson).mockImplementation(async (path: string) => {
      if (!intercepted && path === raceCastPath) {
        intercepted = true;
        const value = await actual.readJson(path); // real bytes, now — happens-before the delete
        await gate; // hold the RESOLUTION open until released below
        return value;
      }
      return actual.readJson(path);
    });

    let resAlias: request.Response;
    let castExistsAfterRace = true;
    try {
      const aliasPromise = request(app)
        .post(`/api/books/${raceBookId}/cast/add-alias`)
        .send({ characterId: 'nova', aliasName: 'Supernova' });
      aliasPromise.catch(() => {}); // supertest is lazy — force real dispatch now
      // Let add-alias acquire the cast lock and reach (and get stuck behind)
      // its intercepted in-lock read. Poll rather than a fixed sleep — same
      // precedent as voices.test.ts's #1981 Task 9 races.
      const deadline = Date.now() + 2000;
      while (!intercepted && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(intercepted).toBe(true);

      const reparsePromise = request(app).post(`/api/books/${raceBookId}/reparse`);
      reparsePromise.catch(() => {}); // force dispatch now (see above)
      // Generous head start: the delete either completes immediately
      // (unlocked — the bug window) or queues behind add-alias's held lock
      // (locked — the fix). Not a tight window either way.
      await new Promise((r) => setTimeout(r, 80));

      released();
      resAlias = await aliasPromise;
      const resReparse = await reparsePromise;
      expect(resReparse.status).toBe(200);
      castExistsAfterRace = existsSync(castPath);
    } finally {
      // Not `mockRestore()` — this is a `vi.fn()` wrapper (from the hoisted
      // `vi.mock` factory above), not a `vi.spyOn` spy, so restore its
      // default passthrough behaviour explicitly.
      spy.mockImplementation(actual.readJson);
    }

    expect(resAlias!.status).toBe(200);
    /* The core assertion: cast.json ends up deleted, never resurrected with
       add-alias's stale snapshot. Since #2099 there is only one possible
       ordering here (not "whichever side acquired the lock first" — that
       framing predates the fix): this test's own construction guarantees
       add-alias acquires the cast lock first (the poll above only proceeds
       once add-alias's in-lock read is intercepted), and reparse's entire
       read+snapshot+delete block is now itself inside that same lock, so it
       can only run after add-alias releases. */
    expect(castExistsAfterRace).toBe(false);
  });
});

/* #2099 gap A — reparse's own `existingCast` read used to run OUTSIDE the
   cast lock (see `applyReparse` in book-state.ts): a concurrent cast-aliases
   write could land between that read and the later-locked delete, get
   reported to its caller as a 200, and then be silently erased — reparse's
   stale-read carryover snapshot never included it, and the unconditional
   delete removed cast.json (with the racer's write inside it) entirely. Post
   #2099, the read is inside the SAME `withCastLock` hold as the delete, so
   the racer queues behind it and, once reparse has deleted cast.json and
   released the lock, re-reads an absent cast and refuses with 409 instead of
   being told it succeeded.

   Mirror image of the #1981 Task 11 describe above: there, add-alias's own
   in-lock read is gated and fired FIRST, so reparse is deterministically
   second. Here, REPARSE is fired first and its own (now in-lock)
   `existingCast` read is what's gated, so add-alias is deterministically
   second. Own fresh bookDir — the describes in this file are order-
   dependent and share `bookDir`. */
describe("reparse handler — #2099 gap A: concurrent cast-aliases write during reparse's own cast read", () => {
  const GAPA_AUTHOR = 'Reparse GapA Author';
  const GAPA_SERIES = 'Standalones';
  const GAPA_TITLE = 'Reparse GapA Book';
  let gapaBookId: string;
  let gapaBookDir: string;

  beforeAll(async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    gapaBookId = makeBookId(GAPA_AUTHOR, GAPA_SERIES, GAPA_TITLE);
    gapaBookDir = join(workspaceRoot, 'books', GAPA_AUTHOR, GAPA_SERIES, GAPA_TITLE);
  });

  it("an add-alias write is serialised behind reparse's own (now locked) cast read, not silently vaporised", async () => {
    mkdirSync(join(gapaBookDir, '.audiobook'), { recursive: true });
    writeFileSync(join(gapaBookDir, 'manuscript.md'), MANUSCRIPT_BODY);
    writeFileSync(
      join(gapaBookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: gapaBookId,
        manuscriptId: 'm_reparse_gapa',
        title: GAPA_TITLE,
        author: GAPA_AUTHOR,
        series: GAPA_SERIES,
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
    const castPath = join(gapaBookDir, '.audiobook', 'cast.json');
    const carryoverPath = join(gapaBookDir, '.audiobook', 'cast-reuse-carryover.json');
    writeFileSync(
      castPath,
      JSON.stringify({
        characters: [{ id: 'nova', name: 'Nova', role: 'character', color: '#abc', aliases: [] }],
      }),
    );

    const stateIo = await import('../workspace/state-io.js');
    const actual = await vi.importActual<typeof import('../workspace/state-io.js')>(
      '../workspace/state-io.js',
    );
    const { castJsonPath } = await import('../workspace/paths.js');
    const gapaCastPath = castJsonPath(gapaBookDir);
    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    let intercepted = false;
    const spy = vi.mocked(stateIo.readJson).mockImplementation(async (path: string) => {
      if (!intercepted && path === gapaCastPath) {
        intercepted = true;
        const value = await actual.readJson(path); // real bytes, now — happens-before the racer
        await gate; // hold the RESOLUTION open until released below
        return value;
      }
      return actual.readJson(path);
    });

    let resRacer: request.Response;
    try {
      const reparsePromise = request(app).post(`/api/books/${gapaBookId}/reparse`);
      reparsePromise.catch(() => {}); // supertest is lazy — force real dispatch now

      // Let reparse reach (and get stuck behind) its intercepted cast read.
      // Poll rather than a fixed sleep — same precedent as the describe above.
      const deadline = Date.now() + 2000;
      while (!intercepted && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(intercepted).toBe(true);

      const racerPromise = request(app)
        .post(`/api/books/${gapaBookId}/cast/add-alias`)
        .send({ characterId: 'nova', aliasName: 'Supernova' });
      racerPromise.catch(() => {}); // force dispatch now (see above)
      // Generous head start: the racer either completes freely (unlocked —
      // the bug window, gap A) or queues behind reparse's held lock (locked
      // — the fix). Not a tight window either way.
      await new Promise((r) => setTimeout(r, 80));

      released();
      const resReparse = await reparsePromise;
      resRacer = await racerPromise;
      expect(resReparse.status).toBe(200);
    } finally {
      // Not `mockRestore()` — this is a `vi.fn()` wrapper (from the hoisted
      // `vi.mock` factory above), not a `vi.spyOn` spy, so restore its
      // default passthrough behaviour explicitly.
      spy.mockImplementation(actual.readJson);
    }

    // Partition (outcome), computed unconditionally: if the racer reported
    // success, its mutation must be observable somewhere. Under the bug this
    // is 200-and-nowhere — add-alias's write lands, but reparse's stale-read
    // carryover snapshot never included it and the unconditional delete then
    // removes cast.json (with the write inside it) entirely, so the racer's
    // own alias vanishes without a trace. This must be computed and asserted
    // BEFORE the mechanism assertion below, not inside an
    // `if (status === 200)` guarded on it — a guard placed after that
    // assertion can never run, because under the bug `resRacer!.status` is
    // 200 and `expect(...).toBe(409)` throws first, making the guarded block
    // unreachable in exactly the scenario it exists to catch.
    const survivedInCarryover =
      existsSync(carryoverPath) &&
      (
        (JSON.parse(readFileSync(carryoverPath, 'utf8')).characters ?? []) as Array<{
          aliases?: string[];
        }>
      ).some((c) => (c.aliases ?? []).includes('Supernova'));
    const survivedInCast =
      existsSync(castPath) &&
      (
        (JSON.parse(readFileSync(castPath, 'utf8')).characters ?? []) as Array<{
          aliases?: string[];
        }>
      ).some((c) => (c.aliases ?? []).includes('Supernova'));
    const survived = survivedInCarryover || survivedInCast;
    expect(resRacer!.status === 200 && !survived).toBe(false);

    // Mechanism: the racer was actually serialised behind the lock, not
    // merely lucky — post-fix it re-reads cast.json inside its own lock
    // acquisition, finds the cast reparse just deleted, and refuses with
    // 409 instead of reporting a success it can't back up.
    expect(resRacer!.status).toBe(409);
  });
});

/* #2099 code-review finding 1 — a corrupt (not missing) cast.json used to
   abort the whole reparse. `readJson`'s bare `JSON.parse` returns `null` for
   a missing file but THROWS for a corrupt one; before #2099 that throw ran
   before the `Promise.all` below was constructed, so it aborted the whole
   reparse before the sibling arms (revisions/audio/analysis-cache) ever
   started. Since #2099 the read lives inside one arm of that `Promise.all`,
   so by the time it throws the other three arms are already in flight and
   can't be stopped by a rejection here — leaving revisions.json deleted (a
   sibling arm completed) while cast.json survives (this arm never reached
   its own delete). Fixed with `.catch(() => null)` on the in-lock
   `readJson(castJsonPath(bookDir))` call, degrading a corrupt cast to the
   same path as a missing one.

   Own fresh bookDir, same rationale as the gap A/B describes above — the
   earlier describes in this file are order-dependent and share `bookDir`. */
describe('reparse handler — #2099 code-review finding 1: a corrupt cast.json no longer aborts the reparse', () => {
  const CORRUPT_AUTHOR = 'Reparse Corrupt Author';
  const CORRUPT_SERIES = 'Standalones';
  const CORRUPT_TITLE = 'Reparse Corrupt Cast Book';
  let corruptBookId: string;
  let corruptBookDir: string;

  beforeAll(async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    corruptBookId = makeBookId(CORRUPT_AUTHOR, CORRUPT_SERIES, CORRUPT_TITLE);
    corruptBookDir = join(workspaceRoot, 'books', CORRUPT_AUTHOR, CORRUPT_SERIES, CORRUPT_TITLE);

    mkdirSync(join(corruptBookDir, '.audiobook'), { recursive: true });
    writeFileSync(join(corruptBookDir, 'manuscript.md'), MANUSCRIPT_BODY);
    writeFileSync(
      join(corruptBookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: corruptBookId,
        manuscriptId: 'm_reparse_corrupt',
        title: CORRUPT_TITLE,
        author: CORRUPT_AUTHOR,
        series: CORRUPT_SERIES,
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
  });

  it('completes the reparse and deletes both cast.json and revisions.json when cast.json is corrupt', async () => {
    const castPath = join(corruptBookDir, '.audiobook', 'cast.json');
    const revisionsPath = join(corruptBookDir, '.audiobook', 'revisions.json');
    // Truncated JSON — parses fine as a *file that exists* (existsSync true)
    // but JSON.parse throws on read, which is the case readJson's `null`
    // return for a MISSING file does not cover.
    writeFileSync(castPath, '{"characters":');
    writeFileSync(revisionsPath, JSON.stringify({ revisions: [{ id: 1 }] }));

    const res = await request(app).post(`/api/books/${corruptBookId}/reparse`);

    expect(res.status).toBe(200);
    // cast.json degraded to the missing-file path: deleted, not left corrupt.
    expect(existsSync(castPath)).toBe(false);
    // Cleanup-completeness check, not evidence about the cast arm: the
    // revisions arm's rm() is invoked synchronously while the Promise.all
    // array literal is built, before the cast arm's first await, so
    // revisions.json is gone either way — this passes whether or not the
    // corrupt-read handling above is correct. It would catch a future
    // Promise.allSettled reshape that stopped sibling arms from running to
    // completion.
    expect(existsSync(revisionsPath)).toBe(false);
  });
});

describe('reparse handler — #2099 round-2 finding 1: a non-parse cast.json read failure refuses to discard the cast', () => {
  const BUSY_AUTHOR = 'Reparse Busy Author';
  const BUSY_SERIES = 'Standalones';
  const BUSY_TITLE = 'Reparse Busy Cast Book';
  let busyBookId: string;
  let busyBookDir: string;

  beforeAll(async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    busyBookId = makeBookId(BUSY_AUTHOR, BUSY_SERIES, BUSY_TITLE);
    busyBookDir = join(workspaceRoot, 'books', BUSY_AUTHOR, BUSY_SERIES, BUSY_TITLE);

    mkdirSync(join(busyBookDir, '.audiobook'), { recursive: true });
    writeFileSync(join(busyBookDir, 'manuscript.md'), MANUSCRIPT_BODY);
    writeFileSync(
      join(busyBookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: busyBookId,
        manuscriptId: 'm_reparse_busy',
        title: BUSY_TITLE,
        author: BUSY_AUTHOR,
        series: BUSY_SERIES,
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
  });

  it('500s and leaves an intact cast.json on disk when the in-lock read hits a transient error', async () => {
    const castPath = join(busyBookDir, '.audiobook', 'cast.json');
    writeFileSync(
      castPath,
      JSON.stringify({
        characters: [{ id: 'nova', name: 'Nova', role: 'character', color: '#abc', aliases: [] }],
      }),
    );

    const stateIo = await import('../workspace/state-io.js');
    const actual = await vi.importActual<typeof import('../workspace/state-io.js')>(
      '../workspace/state-io.js',
    );
    const { castJsonPath } = await import('../workspace/paths.js');
    const busyCastPath = castJsonPath(busyBookDir);
    let rejectedOnce = false;
    const spy = vi.mocked(stateIo.readJson).mockImplementation(async (path: string) => {
      if (!rejectedOnce && path === busyCastPath) {
        rejectedOnce = true;
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return actual.readJson(path);
    });

    try {
      const res = await request(app).post(`/api/books/${busyBookId}/reparse`);
      expect(res.status).toBe(500);
      // The intact cast was NOT discarded — this is the round-2 defect: a
      // blanket `.catch(() => null)` would have treated this transient
      // EBUSY identically to "no cast" and deleted it anyway, on a 200.
      expect(existsSync(castPath)).toBe(true);
    } finally {
      // Not `mockRestore()` — this is a `vi.fn()` wrapper (from the hoisted
      // `vi.mock` factory above), not a `vi.spyOn` spy, so restore its
      // default passthrough behaviour explicitly.
      spy.mockImplementation(actual.readJson);
    }
  });
});
