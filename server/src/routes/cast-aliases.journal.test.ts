/* Integration tests for the cast-aliases unlink-alias JOURNAL path (srv-1).

   Proves the deterministic lookup beats the chapterCast heuristic AND that
   the chapter-qualified (chapterId, sentenceId) key excludes a colliding id
   from an unrelated chapter — the exact bug a flat number[] design would hit.

   The existing chapterCast-fallback behaviour is covered by cast-aliases.test.ts
   (which writes no journal); this file always seeds a journal. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE = 'Journal Book';
const MANUSCRIPT_ID = 'm_journal_test';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
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

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-aliases-journal-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ castAliasesRouter }, { makeBookId }] = await Promise.all([
    import('./cast-aliases.js'),
    import('../workspace/paths.js'),
  ]);
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
  const testFileDir = dirname(fileURLToPath(import.meta.url));
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

  app = express();
  app.use(express.json());
  app.use('/api/books', castAliasesRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  if (cachePath) rmSync(cachePath, { force: true });
});

interface UnlinkRes {
  newCharacter: { id: string; name: string };
  impactedChapters: Array<{ chapterId: number; candidateSentenceIds: number[] }>;
}

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
