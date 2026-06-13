/* Integration tests for the cast-aliases unlink-alias JOURNAL path (srv-1).

   Proves the deterministic lookup beats the chapterCast heuristic AND that
   the chapter-qualified (chapterId, sentenceId) key excludes a colliding id
   from an unrelated chapter — the exact bug a flat number[] design would hit.

   The existing chapterCast-fallback behaviour is covered by cast-aliases.test.ts
   (which writes no journal); this file always seeds a journal.

   All three test scenarios share ONE workspace tempdir (workspaceRoot) and ONE
   express app, because paths.ts resolves WORKSPACE_DIR once at module-load time
   (it is a const export — re-setting the env var after the first import has no
   effect).  Each scenario is a different book inside that workspace. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

/* ── Shared workspace ──────────────────────────────────────────────────────── */

let workspaceRoot: string;
let app: Express;

/* ── Book 1: basic journal path + collision guard ──────────────────────────── */

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE = 'Journal Book';
const MANUSCRIPT_ID = 'm_journal_test';
let bookDir: string;
let bookId: string;
let cachePath: string;

/* Source character carries the alias "Garrow" (merged onto it mid-book). */
const source = {
  id: 'saltgrave-figure',
  name: 'Saltgrave Figure',
  role: 'antagonist',
  color: 'eliza',
  gender: 'male',
  ageRange: 'adult',
  aliases: ['Garrow'],
};

/* manuscript-edits.json — Garrow's lines were merged onto Saltgrave in
   chapters 7/8/9 (ids 5,6 / 3 / 1). Chapter 1 also has Saltgrave lines whose
   ids COLLIDE with the chapter-7 ids (5 and 6) but are NOT Garrow's — a flat
   number[] design would wrongly surface them. */
const editsSentences = [
  { id: 5, chapterId: 1, characterId: 'saltgrave-figure', text: 'ch1 collide a' },
  { id: 6, chapterId: 1, characterId: 'saltgrave-figure', text: 'ch1 collide b' },
  { id: 5, chapterId: 7, characterId: 'saltgrave-figure', text: 'garrow 7a' },
  { id: 6, chapterId: 7, characterId: 'saltgrave-figure', text: 'garrow 7b' },
  { id: 3, chapterId: 8, characterId: 'saltgrave-figure', text: 'garrow 8' },
  { id: 1, chapterId: 9, characterId: 'saltgrave-figure', text: 'garrow 9' },
];

/* ── Book 2: multi-entry union ─────────────────────────────────────────────── */

const TITLE2 = 'Journal Union Book';
const MANUSCRIPT_ID2 = 'm_journal_union_test';
let bookDir2: string;
let bookId2: string;
let cachePath2: string;

const source2 = {
  id: 'kira',
  name: 'Kira',
  role: 'character',
  color: 'narrator',
  aliases: ['Garrow'],
};

/* entry-1 covers ch2/s10; entry-2 covers ch3/s20 + ch4/s30.
   All three sentences remain attributed to 'kira'. */
const editsSentences2 = [
  { id: 10, chapterId: 2, characterId: 'kira', text: 'entry-1 line' },
  { id: 20, chapterId: 3, characterId: 'kira', text: 'entry-2 line a' },
  { id: 30, chapterId: 4, characterId: 'kira', text: 'entry-2 line b' },
];

/* ── Book 3: all reattributed → empty, not fallback ───────────────────────── */

const TITLE3 = 'Journal Empty Book';
const MANUSCRIPT_ID3 = 'm_journal_empty_test';
let bookDir3: string;
let bookId3: string;
let cachePath3: string;

const source3 = {
  id: 'wren',
  name: 'Wren',
  role: 'character',
  color: 'narrator',
  aliases: ['Garrow'],
};

/* No sentences remain attributed to 'wren' — the user reattributed them all. */
const editsSentences3: { id: number; chapterId: number; characterId: string; text: string }[] = [];

/* ── Single shared beforeAll / afterAll ────────────────────────────────────── */

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-aliases-journal-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ castAliasesRouter }, { makeBookId }] = await Promise.all([
    import('./cast-aliases.js'),
    import('../workspace/paths.js'),
  ]);
  const testFileDir = dirname(fileURLToPath(import.meta.url));

  /* ── Book 1 ── */
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
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
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [1, 7, 8, 9].map((id) => ({ id, title: `Ch ${id}`, slug: `0${id}-ch` })),
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters: [source] }));
  writeFileSync(
    join(bookDir, '.audiobook', 'manuscript-edits.json'),
    JSON.stringify({ sentences: editsSentences }),
  );
  /* The journal records exactly Garrow's chapter-7/8/9 sentences. */
  writeFileSync(
    join(bookDir, '.audiobook', 'cast-merges.json'),
    JSON.stringify({
      entries: [
        {
          ts: '2026-06-14T00:00:00.000Z',
          kind: 'manual',
          sourceId: 'garrow',
          sourceName: 'Garrow',
          targetId: 'saltgrave-figure',
          affected: [
            { chapterId: 7, sentenceId: 5 },
            { chapterId: 7, sentenceId: 6 },
            { chapterId: 8, sentenceId: 3 },
            { chapterId: 9, sentenceId: 1 },
          ],
        },
      ],
    }),
  );
  /* chapterCast deliberately ALSO lists Garrow in chapter 1 — proving the
     journal path ignores it (the fallback path would surface chapter 1). */
  cachePath = resolve(testFileDir, '..', '..', 'handoff', 'cache', `${MANUSCRIPT_ID}.json`);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(
    cachePath,
    JSON.stringify({
      chapterCast: {
        1: [{ id: 'garrow', name: 'Garrow', role: 'minor', color: 'halloran' }],
        7: [{ id: 'garrow', name: 'Garrow', role: 'minor', color: 'halloran' }],
      },
      chapters: {},
      updatedAt: new Date().toISOString(),
    }),
  );

  /* ── Book 2 ── */
  bookId2 = makeBookId(AUTHOR, SERIES, TITLE2);
  bookDir2 = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE2);
  mkdirSync(join(bookDir2, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir2, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: bookId2,
      manuscriptId: MANUSCRIPT_ID2,
      title: TITLE2,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [2, 3, 4].map((id) => ({ id, title: `Ch ${id}`, slug: `0${id}-ch` })),
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir2, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir2, '.audiobook', 'cast.json'),
    JSON.stringify({ characters: [source2] }),
  );
  writeFileSync(
    join(bookDir2, '.audiobook', 'manuscript-edits.json'),
    JSON.stringify({ sentences: editsSentences2 }),
  );
  /* Two journal entries for the same alias / target — simulating a double merge. */
  writeFileSync(
    join(bookDir2, '.audiobook', 'cast-merges.json'),
    JSON.stringify({
      entries: [
        {
          ts: '2026-06-14T00:00:00.000Z',
          kind: 'manual',
          sourceId: 'garrow',
          sourceName: 'Garrow',
          targetId: 'kira',
          affected: [{ chapterId: 2, sentenceId: 10 }],
        },
        {
          ts: '2026-06-14T01:00:00.000Z',
          kind: 'fold',
          sourceId: 'garrow',
          sourceName: 'Garrow',
          targetId: 'kira',
          affected: [
            { chapterId: 3, sentenceId: 20 },
            { chapterId: 4, sentenceId: 30 },
          ],
        },
      ],
    }),
  );
  /* Minimal chapterCast — not expected to be consulted. */
  cachePath2 = resolve(testFileDir, '..', '..', 'handoff', 'cache', `${MANUSCRIPT_ID2}.json`);
  mkdirSync(dirname(cachePath2), { recursive: true });
  writeFileSync(
    cachePath2,
    JSON.stringify({
      chapterCast: {},
      chapters: {},
      updatedAt: new Date().toISOString(),
    }),
  );

  /* ── Book 3 ── */
  bookId3 = makeBookId(AUTHOR, SERIES, TITLE3);
  bookDir3 = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE3);
  mkdirSync(join(bookDir3, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir3, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: bookId3,
      manuscriptId: MANUSCRIPT_ID3,
      title: TITLE3,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [5].map((id) => ({ id, title: `Ch ${id}`, slug: `0${id}-ch` })),
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir3, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir3, '.audiobook', 'cast.json'),
    JSON.stringify({ characters: [source3] }),
  );
  writeFileSync(
    join(bookDir3, '.audiobook', 'manuscript-edits.json'),
    JSON.stringify({ sentences: editsSentences3 }),
  );
  /* Journal records a sentence that was subsequently reattributed away. */
  writeFileSync(
    join(bookDir3, '.audiobook', 'cast-merges.json'),
    JSON.stringify({
      entries: [
        {
          ts: '2026-06-14T00:00:00.000Z',
          kind: 'manual',
          sourceId: 'garrow',
          sourceName: 'Garrow',
          targetId: 'wren',
          affected: [{ chapterId: 5, sentenceId: 99 }],
        },
      ],
    }),
  );
  /* chapterCast lists Garrow in chapter 5 — the fallback would surface it.
     We assert the journal path's empty result wins and chapter 5 is absent. */
  cachePath3 = resolve(testFileDir, '..', '..', 'handoff', 'cache', `${MANUSCRIPT_ID3}.json`);
  mkdirSync(dirname(cachePath3), { recursive: true });
  writeFileSync(
    cachePath3,
    JSON.stringify({
      chapterCast: {
        5: [{ id: 'garrow', name: 'Garrow', role: 'minor', color: 'halloran' }],
      },
      chapters: {},
      updatedAt: new Date().toISOString(),
    }),
  );

  app = express();
  app.use(express.json());
  app.use('/api/books', castAliasesRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  if (cachePath) rmSync(cachePath, { force: true });
  if (cachePath2) rmSync(cachePath2, { force: true });
  if (cachePath3) rmSync(cachePath3, { force: true });
});

interface UnlinkRes {
  newCharacter: { id: string; name: string };
  impactedChapters: Array<{ chapterId: number; candidateSentenceIds: number[] }>;
}

/* ── Test 1: basic journal path + id-collision guard ───────────────────────── */

describe('cast-aliases unlink-alias — journal path', () => {
  it('surfaces exactly the journal-recorded sentences and excludes colliding ids from other chapters', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/unlink-alias`)
      .send({ sourceCharacterId: 'saltgrave-figure', aliasName: 'Garrow' });

    expect(res.status).toBe(200);
    const body = res.body as UnlinkRes;
    expect(body.newCharacter.name).toBe('Garrow');

    /* ONLY chapters 7, 8, 9 — NOT chapter 1 (chapterCast lists Garrow there,
       but the journal path ignores chapterCast entirely). */
    expect(body.impactedChapters.map((c) => c.chapterId)).toEqual([7, 8, 9]);
    /* Chapter 7 has exactly Garrow's ids 5 and 6. The chapter-1 sentences with
       the SAME ids (5, 6) are excluded by the composite key. */
    const ch7 = body.impactedChapters.find((c) => c.chapterId === 7)!;
    expect(ch7.candidateSentenceIds).toEqual([5, 6]);
    expect(body.impactedChapters.find((c) => c.chapterId === 8)!.candidateSentenceIds).toEqual([3]);
    expect(body.impactedChapters.find((c) => c.chapterId === 9)!.candidateSentenceIds).toEqual([1]);
    expect(body.impactedChapters.some((c) => c.chapterId === 1)).toBe(false);
  });
});

/* ── Test 2: multi-entry union ─────────────────────────────────────────────── */

describe('cast-aliases unlink-alias — multi-entry journal union', () => {
  it('returns the union of affected sentences across both journal entries', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId2}/cast/unlink-alias`)
      .send({ sourceCharacterId: 'kira', aliasName: 'Garrow' });

    expect(res.status).toBe(200);
    const body = res.body as UnlinkRes;
    expect(body.newCharacter.name).toBe('Garrow');

    /* All three chapters from both entries must appear. */
    expect(body.impactedChapters.map((c) => c.chapterId)).toEqual([2, 3, 4]);
    expect(body.impactedChapters.find((c) => c.chapterId === 2)!.candidateSentenceIds).toEqual([
      10,
    ]);
    expect(body.impactedChapters.find((c) => c.chapterId === 3)!.candidateSentenceIds).toEqual([
      20,
    ]);
    expect(body.impactedChapters.find((c) => c.chapterId === 4)!.candidateSentenceIds).toEqual([
      30,
    ]);
  });
});

/* ── Test 3: all reattributed → empty, not fallback ────────────────────────── */

describe('cast-aliases unlink-alias — all reattributed (empty, no fallback)', () => {
  it('returns [] when all journal sentences have been reattributed, without falling back to chapterCast', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId3}/cast/unlink-alias`)
      .send({ sourceCharacterId: 'wren', aliasName: 'Garrow' });

    expect(res.status).toBe(200);
    const body = res.body as UnlinkRes;
    expect(body.newCharacter.name).toBe('Garrow');

    /* Empty — not the chapterCast fallback (which would surface chapter 5). */
    expect(body.impactedChapters).toEqual([]);
    expect(body.impactedChapters.some((c) => c.chapterId === 5)).toBe(false);
  });
});
