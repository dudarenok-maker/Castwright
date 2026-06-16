/* Integration tests for the cast-merge router.

   Sets up a tempdir workspace with a fake book whose cast contains a known
   duplicate ("wren" + "wren-sparrow"), drives a POST against the route,
   and asserts every persisted file is updated coherently:
     - cast.json drops the source, target gains aliases / evidence / lines
     - manuscript-edits.json sentence attributions are remapped
     - .audiobook analysis-cache.json stage1 + per-chapter sentences updated

   Mirrors book-state.test.ts: defer module imports until WORKSPACE_DIR is
   set so paths.ts captures the right root. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE = 'Cast Merge Book';
const MANUSCRIPT_ID = 'm_merge_test';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let cachePath: string;

const sourceCharacter = {
  id: 'wren',
  name: 'Wren',
  role: 'protagonist',
  color: 'eliza',
  lines: 5,
  scenes: 2,
  attributes: ['curious', 'wry'],
  evidence: [
    { quote: 'Hello world.', note: 'short' },
    { quote: 'Where am I?', note: 'confused' },
  ],
  description: 'A girl.',
  gender: 'female',
  ageRange: 'teen',
};

const targetCharacter = {
  id: 'wren-sparrow',
  name: 'Wren Sparrow',
  role: 'protagonist',
  color: 'eliza',
  lines: 12,
  scenes: 4,
  attributes: ['curious', 'brave'],
  evidence: [
    { quote: 'I have to find him.', note: 'determined' },
    /* Same quote as the source, smart-quote variant — should dedup. */
    { quote: '“Hello world.”', note: 'duplicate via typography' },
  ],
  description: 'A telepathic girl with green eyes who has just discovered the Lost Cities.',
  aliases: ['Foster'],
  tone: { warmth: 60, pace: 50 },
};

const otherCharacter = {
  id: 'marlow',
  name: 'Marlow Halden',
  role: 'sidekick',
  color: 'halloran',
  lines: 7,
  scenes: 3,
};

const sourceSentences = [
  { id: 1, chapterId: 1, characterId: 'wren', text: 'Hello world.' },
  { id: 2, chapterId: 1, characterId: 'wren', text: 'Where am I?' },
  { id: 3, chapterId: 2, characterId: 'wren', text: 'I have to find him.' },
];
const targetSentences = [
  { id: 4, chapterId: 2, characterId: 'wren-sparrow', text: 'Take me with you.' },
  { id: 5, chapterId: 3, characterId: 'wren-sparrow', text: 'I will find a way.' },
];
const otherSentences = [{ id: 6, chapterId: 1, characterId: 'marlow', text: 'Whoa there.' }];

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-merge-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ castMergeRouter }, { makeBookId }] = await Promise.all([
    import('./cast-merge.js'),
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
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({ characters: [targetCharacter, sourceCharacter, otherCharacter] }),
  );
  writeFileSync(
    join(bookDir, '.audiobook', 'manuscript-edits.json'),
    JSON.stringify({ sentences: [...sourceSentences, ...targetSentences, ...otherSentences] }),
  );

  /* Analysis cache lives at server/handoff/cache/<manuscriptId>.json — fixed
     relative to the compiled module, not the workspace. Compute the same
     path from this test file's location: server/src/routes/ ─2 levels→ server/. */
  const testFileDir = dirname(fileURLToPath(import.meta.url));
  cachePath = resolve(testFileDir, '..', '..', 'handoff', 'cache', `${MANUSCRIPT_ID}.json`);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(
    cachePath,
    JSON.stringify({
      stage1: {
        characters: [targetCharacter, sourceCharacter, otherCharacter],
        chapters: [
          { id: 1, title: 'One' },
          { id: 2, title: 'Two' },
          { id: 3, title: 'Three' },
        ],
      },
      chapters: {
        1: sourceSentences.filter((s) => s.chapterId === 1).concat(otherSentences),
        2: [
          ...sourceSentences.filter((s) => s.chapterId === 2),
          ...targetSentences.filter((s) => s.chapterId === 2),
        ],
        3: targetSentences.filter((s) => s.chapterId === 3),
      },
      updatedAt: new Date().toISOString(),
    }),
  );

  app = express();
  app.use(express.json());
  app.use('/api/books', castMergeRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  if (cachePath) rmSync(cachePath, { force: true });
});

function readDisk<T>(rel: string): T {
  return JSON.parse(readFileSync(join(bookDir, '.audiobook', rel), 'utf8')) as T;
}

describe('cast-merge router', () => {
  it('folds source into target, builds aliases, remaps sentences, updates cache', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/merge`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: 'wren', targetId: 'wren-sparrow' });

    expect(res.status).toBe(200);
    const body = res.body as { characters: Array<{ id: string }> };
    expect(body.characters.map((c) => c.id)).toEqual(['wren-sparrow', 'marlow']);

    /* cast.json on disk has the merged target. */
    const cast = readDisk<{ characters: Array<Record<string, unknown>> }>('cast.json');
    expect(cast.characters.map((c) => c.id)).toEqual(['wren-sparrow', 'marlow']);

    const merged = cast.characters.find((c) => c.id === 'wren-sparrow')!;
    /* Aliases: target's "Foster" preserved, source name "Wren" appended,
       target's own name "Wren Sparrow" filtered out (no self-alias). */
    expect(merged.aliases).toEqual(['Foster', 'Wren']);
    /* Description: longer wins (target was already longer). */
    expect(merged.description).toMatch(/telepathic/);
    /* Attributes: union dedup, target first. */
    expect(merged.attributes).toEqual(['curious', 'brave', 'wry']);
    /* Evidence: smart-quote variant of "Hello world." dedups against the
       source's straight-quoted copy. Final list: target's two (one of which
       is the typography duplicate kept since it was target's), plus the
       source's "Where am I?". The normalised dedup keeps first-seen, so
       the smart-quote target version wins over the source's plain version. */
    expect(Array.isArray(merged.evidence)).toBe(true);
    const quotes = (merged.evidence as Array<{ quote: string }>).map((e) => e.quote);
    expect(quotes).toContain('I have to find him.');
    expect(quotes).toContain('Where am I?');
    /* Exactly one "hello world" variant survives (typography dedup). */
    expect(quotes.filter((q) => /hello world/i.test(q))).toHaveLength(1);

    /* Tone: target wins per field, source fills in missing. Target had
       {warmth, pace}; source had no tone — final equals target's. */
    expect(merged.tone).toEqual({ warmth: 60, pace: 50 });
    /* Identity: target had none, source had female/teen — adopted. */
    expect(merged.gender).toBe('female');
    expect(merged.ageRange).toBe('teen');

    /* manuscript-edits.json: every wren sentence now reads wren-sparrow. */
    const edits = readDisk<{ sentences: Array<{ id: number; characterId: string }> }>(
      'manuscript-edits.json',
    );
    expect(edits.sentences.find((s) => s.id === 1)!.characterId).toBe('wren-sparrow');
    expect(edits.sentences.find((s) => s.id === 2)!.characterId).toBe('wren-sparrow');
    expect(edits.sentences.find((s) => s.id === 3)!.characterId).toBe('wren-sparrow');
    /* Other characters untouched. */
    expect(edits.sentences.find((s) => s.id === 6)!.characterId).toBe('marlow');

    /* lines/scenes recomputed from the rewritten edits — 5 sentences across
       chapters 1, 2, 3. */
    expect(merged.lines).toBe(5);
    expect(merged.scenes).toBe(3);

    /* Analysis cache stage1 + per-chapter sentences both updated. */
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      stage1: { characters: Array<{ id: string }> };
      chapters: Record<string, Array<{ characterId: string }>>;
    };
    expect(cache.stage1.characters.map((c) => c.id)).toEqual(['wren-sparrow', 'marlow']);
    /* No surviving 'wren' attribution anywhere in the per-chapter cache. */
    for (const arr of Object.values(cache.chapters)) {
      for (const s of arr) {
        expect(s.characterId).not.toBe('wren');
      }
    }
  });

  it('records a manual journal entry with chapter-qualified affected sentences', async () => {
    /* The first test merged wren → wren-sparrow. wren spoke sentences
       id1/id2 (chapter 1) and id3 (chapter 2). The journal must record those
       three as chapter-qualified pairs under a single manual entry. */
    const journal = readDisk<{
      entries: Array<{
        kind: string;
        sourceId: string;
        sourceName: string;
        targetId: string;
        affected: Array<{ chapterId: number; sentenceId: number }>;
      }>;
    }>('cast-merges.json');

    expect(journal.entries).toHaveLength(1);
    const entry = journal.entries[0];
    expect(entry).toMatchObject({
      kind: 'manual',
      sourceId: 'wren',
      sourceName: 'Wren',
      targetId: 'wren-sparrow',
    });
    expect(entry.affected).toEqual([
      { chapterId: 1, sentenceId: 1 },
      { chapterId: 1, sentenceId: 2 },
      { chapterId: 2, sentenceId: 3 },
    ]);
  });

  it('400s when sourceId equals targetId', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/merge`)
      .send({ sourceId: 'marlow', targetId: 'marlow' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must differ/);
  });

  it('400s when either id is missing', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/merge`)
      .send({ sourceId: 'marlow' });
    expect(res.status).toBe(400);
  });

  it('404s when the source character is not in the cast', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/merge`)
      .send({ sourceId: 'ghost', targetId: 'marlow' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/ghost/);
  });

  it('404s when the book is unknown', async () => {
    const res = await request(app)
      .post(`/api/books/no-such-book/cast/merge`)
      .send({ sourceId: 'a', targetId: 'b' });
    expect(res.status).toBe(404);
  });
});

/* Downgrade flow — seeds a second book into the SAME workspace (BOOKS_ROOT
   is frozen at module load, so spawning a fresh mkdtemp here would just be
   invisible to the route). The book has a descriptor-named speaker
   ("Rescuer") with enough lines to escape the auto-fold, plus a real
   survivor. POST a merge with targetId='unknown-female' — a bucket id NOT
   on the roster yet — and assert the route synthesises the bucket on the
   fly, folds source into it, and remaps every sentence. */
describe('cast-merge downgrade to bucket', () => {
  const D_AUTHOR = 'Downgrade Author';
  const D_SERIES = 'Standalones';
  const D_TITLE = 'Downgrade Book';
  const D_MANUSCRIPT_ID = 'm_downgrade_test';

  let dBookDir: string;
  let dBookId: string;
  let dCachePath: string;

  beforeAll(async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    dBookId = makeBookId(D_AUTHOR, D_SERIES, D_TITLE);
    dBookDir = join(workspaceRoot, 'books', D_AUTHOR, D_SERIES, D_TITLE);
    mkdirSync(join(dBookDir, '.audiobook'), { recursive: true });

    writeFileSync(
      join(dBookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: dBookId,
        manuscriptId: D_MANUSCRIPT_ID,
        title: D_TITLE,
        author: D_AUTHOR,
        series: D_SERIES,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters: [
          { id: 1, title: 'One', slug: '01-one' },
          { id: 2, title: 'Two', slug: '02-two' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(join(dBookDir, 'manuscript.txt'), 'placeholder');

    /* Cast: one descriptor-named character + one real character. No bucket
       on the roster — the downgrade endpoint must synthesise it. */
    writeFileSync(
      join(dBookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          {
            id: 'rescuer',
            name: 'Rescuer',
            role: 'background',
            color: 'halloran',
            lines: 26,
            scenes: 2,
            gender: 'female',
            attributes: ['restrained', 'wry'],
            evidence: [{ quote: 'Get behind me.', note: 'protective' }],
          },
          {
            id: 'garrow',
            name: 'Garrow',
            role: 'Goblin Bodyguard',
            color: 'eliza',
            lines: 9,
            scenes: 2,
            gender: 'male',
          },
        ],
      }),
    );

    const sents = [
      { id: 1, chapterId: 1, characterId: 'rescuer', text: 'Get behind me.' },
      { id: 2, chapterId: 2, characterId: 'rescuer', text: 'Stay quiet.' },
      { id: 3, chapterId: 1, characterId: 'garrow', text: 'On it.' },
    ];
    writeFileSync(
      join(dBookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({ sentences: sents }),
    );

    const testFileDir = dirname(fileURLToPath(import.meta.url));
    dCachePath = resolve(testFileDir, '..', '..', 'handoff', 'cache', `${D_MANUSCRIPT_ID}.json`);
    mkdirSync(dirname(dCachePath), { recursive: true });
    writeFileSync(
      dCachePath,
      JSON.stringify({
        stage1: {
          characters: [
            {
              id: 'rescuer',
              name: 'Rescuer',
              role: 'background',
              color: 'halloran',
              gender: 'female',
            },
            {
              id: 'garrow',
              name: 'Garrow',
              role: 'Goblin Bodyguard',
              color: 'eliza',
              gender: 'male',
            },
          ],
          chapters: [
            { id: 1, title: 'One' },
            { id: 2, title: 'Two' },
          ],
        },
        chapters: {
          1: [sents[0], sents[2]],
          2: [sents[1]],
        },
        updatedAt: new Date().toISOString(),
      }),
    );
  });

  afterAll(() => {
    if (dCachePath) rmSync(dCachePath, { force: true });
  });

  it('synthesises the unknown-female bucket when missing and folds source into it', async () => {
    const res = await request(app)
      .post(`/api/books/${dBookId}/cast/merge`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: 'rescuer', targetId: 'unknown-female' });

    expect(res.status).toBe(200);
    const body = res.body as { characters: Array<Record<string, unknown>> };
    /* garrow preserved, rescuer folded into a newly-minted unknown-female. */
    const ids = body.characters.map((c) => c.id);
    expect(ids).toContain('garrow');
    expect(ids).toContain('unknown-female');
    expect(ids).not.toContain('rescuer');

    const bucket = body.characters.find((c) => c.id === 'unknown-female')!;
    /* Bucket name + role come from the shared makeBucket factory. */
    expect(bucket.name).toBe('Unknown female');
    expect(bucket.role).toBe('background');
    expect(bucket.gender).toBe('female');
    /* Source's name lands in the bucket's aliases — same contract as the
       per-character manual merge. */
    expect(bucket.aliases).toContain('Rescuer');
    /* Lines/scenes recomputed against the remapped sentence list (2 lines
       across 2 chapters). */
    expect(bucket.lines).toBe(2);
    expect(bucket.scenes).toBe(2);

    /* manuscript-edits.json: rescuer sentences now point at unknown-female. */
    const editsRaw = readFileSync(join(dBookDir, '.audiobook', 'manuscript-edits.json'), 'utf8');
    const edits = JSON.parse(editsRaw) as { sentences: Array<{ id: number; characterId: string }> };
    expect(edits.sentences.find((s) => s.id === 1)!.characterId).toBe('unknown-female');
    expect(edits.sentences.find((s) => s.id === 2)!.characterId).toBe('unknown-female');
    expect(edits.sentences.find((s) => s.id === 3)!.characterId).toBe('garrow');

    /* Analysis cache stage1 also gained the bucket. */
    const cache = JSON.parse(readFileSync(dCachePath, 'utf8')) as {
      stage1: { characters: Array<{ id: string }> };
      chapters: Record<string, Array<{ characterId: string }>>;
    };
    const cacheIds = cache.stage1.characters.map((c) => c.id);
    expect(cacheIds).toContain('unknown-female');
    expect(cacheIds).not.toContain('rescuer');
    for (const arr of Object.values(cache.chapters)) {
      for (const s of arr) expect(s.characterId).not.toBe('rescuer');
    }
  });
});

describe('cast-merge downgrade to bucket — Russian book (Wave D, plan 221)', () => {
  const R_AUTHOR = 'Russian Downgrade Author';
  const R_SERIES = 'Standalones';
  const R_TITLE = 'Russian Downgrade Book';
  const R_MANUSCRIPT_ID = 'm_ru_downgrade_test';

  let rBookDir: string;
  let rBookId: string;
  let rCachePath: string;

  beforeAll(async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    rBookId = makeBookId(R_AUTHOR, R_SERIES, R_TITLE);
    rBookDir = join(workspaceRoot, 'books', R_AUTHOR, R_SERIES, R_TITLE);
    mkdirSync(join(rBookDir, '.audiobook'), { recursive: true });

    writeFileSync(
      join(rBookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: rBookId,
        manuscriptId: R_MANUSCRIPT_ID,
        title: R_TITLE,
        author: R_AUTHOR,
        series: R_SERIES,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        language: 'ru',
        chapters: [{ id: 1, title: 'Один', slug: '01-odin' }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(join(rBookDir, 'manuscript.txt'), 'placeholder');

    writeFileSync(
      join(rBookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          {
            id: 'prohozhiy',
            name: 'Прохожий',
            role: 'background',
            color: 'halloran',
            lines: 2,
            scenes: 1,
            gender: 'male',
          },
          {
            id: 'anton',
            name: 'Антон',
            role: 'protagonist',
            color: 'eliza',
            lines: 9,
            scenes: 1,
            gender: 'male',
          },
        ],
      }),
    );

    const sents = [
      { id: 1, chapterId: 1, characterId: 'prohozhiy', text: 'Привет.' },
      { id: 2, chapterId: 1, characterId: 'anton', text: 'Здравствуйте.' },
    ];
    writeFileSync(
      join(rBookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({ sentences: sents }),
    );

    const testFileDir = dirname(fileURLToPath(import.meta.url));
    rCachePath = resolve(testFileDir, '..', '..', 'handoff', 'cache', `${R_MANUSCRIPT_ID}.json`);
    mkdirSync(dirname(rCachePath), { recursive: true });
    writeFileSync(
      rCachePath,
      JSON.stringify({
        stage1: {
          characters: [
            { id: 'prohozhiy', name: 'Прохожий', role: 'background', gender: 'male' },
            { id: 'anton', name: 'Антон', role: 'protagonist', gender: 'male' },
          ],
          chapters: [{ id: 1, title: 'Один' }],
        },
        chapters: { 1: [sents[0], sents[1]] },
        updatedAt: new Date().toISOString(),
      }),
    );
  });

  afterAll(() => {
    if (rCachePath) rmSync(rCachePath, { force: true });
  });

  it('mints the Russian-named unknown-male bucket on a manual downgrade', async () => {
    const res = await request(app)
      .post(`/api/books/${rBookId}/cast/merge`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: 'prohozhiy', targetId: 'unknown-male' });

    expect(res.status).toBe(200);
    const body = res.body as { characters: Array<Record<string, unknown>> };
    const bucket = body.characters.find((c) => c.id === 'unknown-male')!;
    /* Book language ru → bucket carries the localized name, matching the fold. */
    expect(bucket.name).toBe('Незнакомый Парень');
    expect(bucket.gender).toBe('male');
  });
});
