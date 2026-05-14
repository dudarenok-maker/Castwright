/* Integration tests for the cast-merge router.

   Sets up a tempdir workspace with a fake book whose cast contains a known
   duplicate ("sophie" + "sophie-foster"), drives a POST against the route,
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
  id: 'sophie',
  name: 'Sophie',
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
  id: 'sophie-foster',
  name: 'Sophie Foster',
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
  id: 'keefe',
  name: 'Keefe Sencen',
  role: 'sidekick',
  color: 'halloran',
  lines: 7,
  scenes: 3,
};

const sourceSentences = [
  { id: 1, chapterId: 1, characterId: 'sophie',        text: 'Hello world.' },
  { id: 2, chapterId: 1, characterId: 'sophie',        text: 'Where am I?' },
  { id: 3, chapterId: 2, characterId: 'sophie',        text: 'I have to find him.' },
];
const targetSentences = [
  { id: 4, chapterId: 2, characterId: 'sophie-foster', text: 'Take me with you.' },
  { id: 5, chapterId: 3, characterId: 'sophie-foster', text: 'I will find a way.' },
];
const otherSentences = [
  { id: 6, chapterId: 1, characterId: 'keefe',         text: 'Whoa there.' },
];

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
        { id: 1, title: 'One',   slug: '01-one'   },
        { id: 2, title: 'Two',   slug: '02-two'   },
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
  writeFileSync(cachePath, JSON.stringify({
    stage1: {
      characters: [targetCharacter, sourceCharacter, otherCharacter],
      chapters: [
        { id: 1, title: 'One' },
        { id: 2, title: 'Two' },
        { id: 3, title: 'Three' },
      ],
    },
    chapters: {
      1: sourceSentences.filter(s => s.chapterId === 1).concat(otherSentences),
      2: [...sourceSentences.filter(s => s.chapterId === 2), ...targetSentences.filter(s => s.chapterId === 2)],
      3: targetSentences.filter(s => s.chapterId === 3),
    },
    updatedAt: new Date().toISOString(),
  }));

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
      .send({ sourceId: 'sophie', targetId: 'sophie-foster' });

    expect(res.status).toBe(200);
    const body = res.body as { characters: Array<{ id: string }> };
    expect(body.characters.map(c => c.id)).toEqual(['sophie-foster', 'keefe']);

    /* cast.json on disk has the merged target. */
    const cast = readDisk<{ characters: Array<Record<string, unknown>> }>('cast.json');
    expect(cast.characters.map(c => c.id)).toEqual(['sophie-foster', 'keefe']);

    const merged = cast.characters.find(c => c.id === 'sophie-foster')!;
    /* Aliases: target's "Foster" preserved, source name "Sophie" appended,
       target's own name "Sophie Foster" filtered out (no self-alias). */
    expect(merged.aliases).toEqual(['Foster', 'Sophie']);
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
    const quotes = (merged.evidence as Array<{ quote: string }>).map(e => e.quote);
    expect(quotes).toContain('I have to find him.');
    expect(quotes).toContain('Where am I?');
    /* Exactly one "hello world" variant survives (typography dedup). */
    expect(quotes.filter(q => /hello world/i.test(q))).toHaveLength(1);

    /* Tone: target wins per field, source fills in missing. Target had
       {warmth, pace}; source had no tone — final equals target's. */
    expect(merged.tone).toEqual({ warmth: 60, pace: 50 });
    /* Identity: target had none, source had female/teen — adopted. */
    expect(merged.gender).toBe('female');
    expect(merged.ageRange).toBe('teen');

    /* manuscript-edits.json: every sophie sentence now reads sophie-foster. */
    const edits = readDisk<{ sentences: Array<{ id: number; characterId: string }> }>('manuscript-edits.json');
    expect(edits.sentences.find(s => s.id === 1)!.characterId).toBe('sophie-foster');
    expect(edits.sentences.find(s => s.id === 2)!.characterId).toBe('sophie-foster');
    expect(edits.sentences.find(s => s.id === 3)!.characterId).toBe('sophie-foster');
    /* Other characters untouched. */
    expect(edits.sentences.find(s => s.id === 6)!.characterId).toBe('keefe');

    /* lines/scenes recomputed from the rewritten edits — 5 sentences across
       chapters 1, 2, 3. */
    expect(merged.lines).toBe(5);
    expect(merged.scenes).toBe(3);

    /* Analysis cache stage1 + per-chapter sentences both updated. */
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      stage1: { characters: Array<{ id: string }> };
      chapters: Record<string, Array<{ characterId: string }>>;
    };
    expect(cache.stage1.characters.map(c => c.id)).toEqual(['sophie-foster', 'keefe']);
    /* No surviving 'sophie' attribution anywhere in the per-chapter cache. */
    for (const arr of Object.values(cache.chapters)) {
      for (const s of arr) {
        expect(s.characterId).not.toBe('sophie');
      }
    }
  });

  it('400s when sourceId equals targetId', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/merge`)
      .send({ sourceId: 'keefe', targetId: 'keefe' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must differ/);
  });

  it('400s when either id is missing', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/merge`)
      .send({ sourceId: 'keefe' });
    expect(res.status).toBe(400);
  });

  it('404s when the source character is not in the cast', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/merge`)
      .send({ sourceId: 'ghost', targetId: 'keefe' });
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
