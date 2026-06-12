/* Integration tests for the cast-aliases router.

   Sets up a tempdir workspace with a fake book whose cast has one
   over-merged alias ("Garrow" sitting on "Saltgrave Figure"), plus a
   matching chapterCast snapshot that originally listed "Garrow" as a
   separate character in two specific chapters. Drives the unlink-alias
   route and asserts:
     - cast.json: alias dropped from source; a new standalone character
       minted with the right inherited identity fields
     - response: impactedChapters lists ONLY the chapters where Garrow
       originally appeared, with candidate sentence IDs pulled from
       manuscript-edits.json (only sentences currently attributed to the
       source)
     - manuscript-edits.json is NOT mutated (sentence rewrites happen
       client-side via the reattribute modal calling setSentenceCharacter)

   Also exercises add-alias for the happy + dedup paths.

   Mirrors cast-merge.test.ts's lazy-import pattern: defer module imports
   until WORKSPACE_DIR is set so paths.ts captures the right root. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE = 'Cast Aliases Book';
const MANUSCRIPT_ID = 'm_aliases_test';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let cachePath: string;

const sourceCharacter = {
  id: 'saltgrave-figure',
  name: 'Saltgrave Figure',
  role: 'antagonist',
  color: 'eliza',
  gender: 'male',
  ageRange: 'adult',
  lines: 8,
  scenes: 3,
  /* These four aliases all came from an over-aggressive auto-fold step.
     "Garrow" is the one the test exercises — he's actually a real
     standalone cast member whose dialogue got folded into Saltgrave. */
  aliases: ['Sior', 'Jurek', 'Garrow', 'Shopkeeper'],
};

const otherCharacter = {
  id: 'wren',
  name: 'Wren',
  role: 'protagonist',
  color: 'halloran',
};

/* Manuscript-edits sentences. Chapter 1 has three lines attributed to
   Saltgrave (all candidates for un-link). Chapter 2 has two more (one
   in a chapter Garrow never appeared in originally, so it should NOT
   show as a candidate). Chapter 3 has one Wren line (untouched). */
const editsSentences = [
  { id: 1, chapterId: 1, characterId: 'saltgrave-figure', text: 'The shopkeeper laughed.' },
  { id: 2, chapterId: 1, characterId: 'saltgrave-figure', text: '"Garrow said that?"' },
  { id: 3, chapterId: 1, characterId: 'saltgrave-figure', text: '"He is one of us."' },
  { id: 4, chapterId: 2, characterId: 'saltgrave-figure', text: 'A new line.' },
  { id: 5, chapterId: 4, characterId: 'saltgrave-figure', text: 'Chapter 4 line.' },
  { id: 6, chapterId: 3, characterId: 'wren', text: 'I have to find him.' },
];

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-aliases-test-'));
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
      chapters: [
        { id: 1, title: 'One', slug: '01-one' },
        { id: 2, title: 'Two', slug: '02-two' },
        { id: 3, title: 'Three', slug: '03-three' },
        { id: 4, title: 'Four', slug: '04-four' },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({ characters: [sourceCharacter, otherCharacter] }),
  );
  writeFileSync(
    join(bookDir, '.audiobook', 'manuscript-edits.json'),
    JSON.stringify({ sentences: editsSentences }),
  );

  /* Phase 0a chapterCast: chapters 1 and 4 originally listed "Garrow" in
     their roster; chapter 2 did not (so the chapter-2 sentence currently
     attributed to Saltgrave should NOT surface as a candidate). Chapter
     3 only had Wren. */
  const testFileDir = dirname(fileURLToPath(import.meta.url));
  cachePath = resolve(testFileDir, '..', '..', 'handoff', 'cache', `${MANUSCRIPT_ID}.json`);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(
    cachePath,
    JSON.stringify({
      chapterCast: {
        1: [
          { id: 'garrow', name: 'Garrow', role: 'minor', color: 'halloran' },
          { id: 'wren', name: 'Wren', role: 'protagonist', color: 'halloran' },
        ],
        2: [{ id: 'wren', name: 'Wren', role: 'protagonist', color: 'halloran' }],
        3: [{ id: 'wren', name: 'Wren', role: 'protagonist', color: 'halloran' }],
        4: [{ id: 'garrow', name: 'Garrow', role: 'minor', color: 'halloran' }],
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

function readDisk<T>(rel: string): T {
  return JSON.parse(readFileSync(join(bookDir, '.audiobook', rel), 'utf8')) as T;
}

interface UnlinkRes {
  newCharacter: {
    id: string;
    name: string;
    aliases?: string[];
    gender?: string;
    ageRange?: string;
  };
  impactedChapters: Array<{ chapterId: number; candidateSentenceIds: number[] }>;
}

describe('cast-aliases router — unlink-alias', () => {
  it('strips the alias from the source, mints a standalone character, returns impacted chapters', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/unlink-alias`)
      .set('Content-Type', 'application/json')
      .send({ sourceCharacterId: 'saltgrave-figure', aliasName: 'Garrow' });

    expect(res.status).toBe(200);
    const body = res.body as UnlinkRes;

    /* New standalone character minted. Id is the slug of the alias; name
       preserves chip casing; gender + ageRange inherited from the source
       so the voice picker has something to work with on day one. */
    expect(body.newCharacter.id).toBe('garrow');
    expect(body.newCharacter.name).toBe('Garrow');
    expect(body.newCharacter.gender).toBe('male');
    expect(body.newCharacter.ageRange).toBe('adult');
    expect(body.newCharacter.aliases).toEqual([]);

    /* Impacted chapters derived from chapterCast: chapters 1 and 4 (NOT
       chapter 2 which never had Garrow in its Phase 0a roster). */
    expect(body.impactedChapters.map((c) => c.chapterId)).toEqual([1, 4]);
    /* Chapter 1 candidate sentences = all Saltgrave-attributed lines in
       chapter 1 (ids 1, 2, 3). Chapter 4 has one (id 5). */
    expect(body.impactedChapters[0].candidateSentenceIds).toEqual([1, 2, 3]);
    expect(body.impactedChapters[1].candidateSentenceIds).toEqual([5]);

    /* cast.json on disk: source's aliases trimmed, new character appended. */
    const cast = readDisk<{
      characters: Array<{ id: string; aliases?: string[] }>;
    }>('cast.json');
    expect(cast.characters.map((c) => c.id)).toEqual(['saltgrave-figure', 'wren', 'garrow']);
    const source = cast.characters.find((c) => c.id === 'saltgrave-figure')!;
    expect(source.aliases).toEqual(['Sior', 'Jurek', 'Shopkeeper']);

    /* manuscript-edits.json is NOT mutated — reattribution is the user's
       explicit per-sentence choice via the modal, not a server-side
       rewrite. Every sentence still points where it did before. */
    const edits = readDisk<{ sentences: Array<{ id: number; characterId: string }> }>(
      'manuscript-edits.json',
    );
    expect(edits.sentences.find((s) => s.id === 1)!.characterId).toBe('saltgrave-figure');
    expect(edits.sentences.find((s) => s.id === 5)!.characterId).toBe('saltgrave-figure');
  });

  it('mints a collision-suffixed id when the slug already exists', async () => {
    /* Seed an existing character whose id is the slug-of-target alias so the
       mint helper has to suffix. */
    const cast = readDisk<{ characters: Array<{ id: string; name: string; aliases?: string[] }> }>(
      'cast.json',
    );
    cast.characters.unshift({
      id: 'shopkeeper',
      name: 'A different Shopkeeper',
      aliases: [],
    });
    /* Put Shopkeeper back on Saltgrave as an alias to unlink. */
    const nev = cast.characters.find((c) => c.id === 'saltgrave-figure')!;
    nev.aliases = ['Sior', 'Jurek', 'Shopkeeper'];
    writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify(cast));

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/unlink-alias`)
      .send({ sourceCharacterId: 'saltgrave-figure', aliasName: 'Shopkeeper' });

    expect(res.status).toBe(200);
    const body = res.body as UnlinkRes;
    /* Existing 'shopkeeper' is left in place; the new mint suffixes to
       'shopkeeper-2'. */
    expect(body.newCharacter.id).toBe('shopkeeper-2');
    const updated = readDisk<{ characters: Array<{ id: string }> }>('cast.json');
    expect(updated.characters.some((c) => c.id === 'shopkeeper')).toBe(true);
    expect(updated.characters.some((c) => c.id === 'shopkeeper-2')).toBe(true);
  });

  it('400s when sourceCharacterId or aliasName is missing', async () => {
    const r1 = await request(app)
      .post(`/api/books/${bookId}/cast/unlink-alias`)
      .send({ aliasName: 'Garrow' });
    expect(r1.status).toBe(400);

    const r2 = await request(app)
      .post(`/api/books/${bookId}/cast/unlink-alias`)
      .send({ sourceCharacterId: 'saltgrave-figure' });
    expect(r2.status).toBe(400);
  });

  it('404s when the source character is not in the cast', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/unlink-alias`)
      .send({ sourceCharacterId: 'ghost', aliasName: 'Garrow' });
    expect(res.status).toBe(404);
  });

  it('404s when the alias is not on the source character', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/unlink-alias`)
      .send({ sourceCharacterId: 'wren', aliasName: 'Garrow' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not on/);
  });

  it('404s when the book is unknown', async () => {
    const res = await request(app)
      .post(`/api/books/no-such-book/cast/unlink-alias`)
      .send({ sourceCharacterId: 'saltgrave-figure', aliasName: 'Garrow' });
    expect(res.status).toBe(404);
  });
});

describe('cast-aliases router — add-alias', () => {
  /* Seed a clean cast for the add-alias tests — re-write rather than
     depending on prior describe-block state. */
  beforeAll(() => {
    writeFileSync(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          {
            id: 'wren',
            name: 'Wren',
            role: 'protagonist',
            color: 'halloran',
            aliases: ['Foster'],
          },
        ],
      }),
    );
  });

  it('appends a new alias and dedupes case-insensitively', async () => {
    const r1 = await request(app)
      .post(`/api/books/${bookId}/cast/add-alias`)
      .send({ characterId: 'wren', aliasName: 'Sofi' });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ characterId: 'wren', alias: 'Sofi', alreadyPresent: false });
    /* cast.json on disk reflects the append. */
    const c1 = readDisk<{ characters: Array<{ id: string; aliases?: string[] }> }>(
      'cast.json',
    ).characters.find((c) => c.id === 'wren')!;
    expect(c1.aliases).toEqual(['Foster', 'Sofi']);

    /* Idempotent re-add: lowercased dedup is honoured, response flags
       alreadyPresent=true, on-disk list still length 2. */
    const r2 = await request(app)
      .post(`/api/books/${bookId}/cast/add-alias`)
      .send({ characterId: 'wren', aliasName: 'sofi' });
    expect(r2.status).toBe(200);
    expect(r2.body).toMatchObject({ alreadyPresent: true });
    const c2 = readDisk<{ characters: Array<{ id: string; aliases?: string[] }> }>(
      'cast.json',
    ).characters.find((c) => c.id === 'wren')!;
    expect(c2.aliases).toEqual(['Foster', 'Sofi']);
  });

  it('400s when the alias matches the character\'s own name', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/add-alias`)
      .send({ characterId: 'wren', aliasName: 'Wren' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own name/);
  });

  it('400s when either field is missing', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/add-alias`)
      .send({ characterId: 'wren' });
    expect(res.status).toBe(400);
  });

  it('404s when the character is unknown', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/add-alias`)
      .send({ characterId: 'ghost', aliasName: 'Foo' });
    expect(res.status).toBe(404);
  });
});
