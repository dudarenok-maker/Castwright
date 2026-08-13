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

/* Self-sufficient merge helper (#2040 Task 8 fix round 1, item 6) — appends a
   FRESH, uniquely-named source/target pair (with their own sentences) onto
   whatever cast.json/manuscript-edits.json state the test suite is currently
   in, then merges them. A test built on this never depends on an earlier
   `it` having already run a merge — it seeds and drives its own. Returns the
   merge's response plus the ids/sentence-ids the caller can assert against. */
async function mergeFreshPair(): Promise<{
  res: request.Response;
  sourceId: string;
  targetId: string;
  sentenceIds: number[];
}> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sourceId = `echo-src-${unique}`;
  const targetId = `echo-tgt-${unique}`;

  const cast = readDisk<{ characters: Array<Record<string, unknown>> }>('cast.json');
  cast.characters.push(
    { id: sourceId, name: 'Echo Source', role: 'minor', color: 'halloran', lines: 1, scenes: 1 },
    { id: targetId, name: 'Echo Target', role: 'minor', color: 'halloran', lines: 1, scenes: 1 },
  );
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify(cast));

  const edits = readDisk<{ sentences: Array<Record<string, unknown>> }>('manuscript-edits.json');
  const baseId = Date.now();
  const sentenceIds = [baseId, baseId + 1];
  edits.sentences.push(
    { id: sentenceIds[0], chapterId: 1, characterId: sourceId, text: 'Echo one.' },
    { id: sentenceIds[1], chapterId: 2, characterId: sourceId, text: 'Echo two.' },
  );
  writeFileSync(join(bookDir, '.audiobook', 'manuscript-edits.json'), JSON.stringify(edits));

  const res = await request(app)
    .post(`/api/books/${bookId}/cast/merge`)
    .set('Content-Type', 'application/json')
    .send({ sourceId, targetId });

  return { res, sourceId, targetId, sentenceIds };
}

describe('cast-merge router', () => {
  it('folds source into target, builds aliases, remaps sentences, updates cache', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/merge`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: 'wren', targetId: 'wren-sparrow' });

    expect(res.status).toBe(200);
    const body = res.body as { characters: Array<{ id: string }>; sourceId: string };
    expect(body.characters.map((c) => c.id)).toEqual(['wren-sparrow', 'marlow']);
    // §4.4 call site 5 (#2040 Task 8) — performCastMerge reports the folded-away
    // id so the route can record its retirement.
    expect(body.sourceId).toBe('wren');

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

  it('records a manual journal entry with chapter-qualified affected sentences (#2040 Task 8 fix round 1, item 6 — self-sufficient)', async () => {
    // Self-contained: seeds and merges its OWN pair (mergeFreshPair) rather
    // than relying on the earlier "folds source into target" test having
    // already run — this used to only pass because of execution order.
    const { res, sourceId, targetId, sentenceIds } = await mergeFreshPair();
    expect(res.status).toBe(200);

    const journal = readDisk<{
      entries: Array<{
        kind: string;
        sourceId: string;
        sourceName: string;
        targetId: string;
        affected: Array<{ chapterId: number; sentenceId: number }>;
      }>;
    }>('cast-merges.json');

    const entry = journal.entries.find((e) => e.sourceId === sourceId && e.targetId === targetId);
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      kind: 'manual',
      sourceId,
      sourceName: 'Echo Source',
      targetId,
    });
    expect(entry!.affected).toEqual([
      { chapterId: 1, sentenceId: sentenceIds[0] },
      { chapterId: 2, sentenceId: sentenceIds[1] },
    ]);
  });

  it('records the merge as a retirement in cast-id-history.json (#2040 Task 8; fix round 1 item 6 — self-sufficient)', async () => {
    // §4.4 call site 5: performCastMerge must retire the source id through
    // the SAME choke point every other id-losing path uses, so a segment
    // still tagged with the source id resolves at render time instead of
    // orphaning. Self-contained (mergeFreshPair) rather than relying on an
    // earlier test's merge — see the item-6 note on the sibling test above.
    const { sourceId, targetId } = await mergeFreshPair();
    const { loadCastIdHistory } = await import('../store/cast-id-history.js');
    const history = await loadCastIdHistory(bookDir);
    expect(history.supersededBy).toHaveProperty(sourceId, targetId);
  });

  it('#2133 — a merge that drops a self-loop rejectedPairs entry also clears the matching notLinkedTo edge', async () => {
    // A reject's two writes (the rejectedPairs entry on cast-id-history.json
    // and the one-sided notLinkedTo edge on cast.json) are created together
    // and must be destroyed together — otherwise the surviving edge
    // permanently suppresses §4.4's name matcher for a pairing that no
    // longer exists. Self-sufficient: seeds its own source/target pair,
    // a rejectedPairs entry `{from: targetId, to: sourceId}` (so retiring
    // sourceId INTO targetId repoints pair.to onto targetId, colliding with
    // pair.from and dropping it as a self-loop — the exact M2 shape pinned
    // in cast-id-history.test.ts), and a notLinkedTo self-edge on the
    // TARGET row naming itself (the shape `notLinkedTo` ends up in once a
    // self-loop pair's `from` and `to` both equal the surviving id).
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sourceId = `self-loop-src-${unique}`;
    const targetId = `self-loop-tgt-${unique}`;

    const cast = readDisk<{ characters: Array<Record<string, unknown>> }>('cast.json');
    cast.characters.push(
      { id: sourceId, name: 'Self Loop Source', role: 'minor', color: 'halloran', lines: 1, scenes: 1 },
      {
        id: targetId,
        name: 'Self Loop Target',
        role: 'minor',
        color: 'halloran',
        lines: 1,
        scenes: 1,
        notLinkedTo: [{ bookId, characterId: targetId }],
      },
    );
    writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify(cast));

    const { rejectOrphanedPair, loadCastIdHistory } = await import('../store/cast-id-history.js');
    await rejectOrphanedPair(bookDir, targetId, sourceId);

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/merge`)
      .set('Content-Type', 'application/json')
      .send({ sourceId, targetId });
    expect(res.status).toBe(200);

    // The pair became a self-loop (targetId !-> targetId) and was dropped.
    const history = await loadCastIdHistory(bookDir);
    expect(history.rejectedPairs ?? []).not.toContainEqual(
      expect.objectContaining({ from: targetId }),
    );

    // The matching notLinkedTo edge on the surviving target row is gone too.
    const castAfter = readDisk<{ characters: Array<Record<string, unknown>> }>('cast.json');
    const survivor = castAfter.characters.find((c) => c.id === targetId)!;
    expect(survivor.notLinkedTo ?? []).toEqual([]);
  });

  it('a throwing history write never fails the merge or leaves cast.json and the analysis cache disagreeing (#2040 Wave 2 final review, finding 4)', async () => {
    /* `performCastMerge`'s retirement call sat between the cast.json write
       and the analysis-cache reconciliation with no try/catch — unlike all
       six analysis-path sites, which have been wrapped since Task 8 fix round
       1. An EPERM/ENOSPC/AV-lock on cast-id-history.json therefore rejected
       the whole call with cast.json ALREADY missing the source id while the
       cache still held it — exactly the state the code's own comment below
       that call says must not happen ("leaving the source in here would
       reintroduce the duplicate as soon as the user clicks resume") — plus a
       500 on a half-applied merge.

       The history is a lookup side-table and is never authoritative for
       identity (spec §4.1: "losing the file degrades to today's behaviour…
       at worst it stops helping"), so a failure to write it must cost the
       entry, not the merge.

       No mocking: cast-id-history.json's PATH is occupied by a directory, so
       writeJsonAtomic's rename onto it throws for real. Same technique as
       analysis.test.ts's sibling "a throwing history write never blocks the
       authoritative cast.json persist". */
    const { castIdHistoryPath } = await import('../store/cast-id-history.js');
    const historyPath = castIdHistoryPath(bookDir);

    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sourceId = `eperm-src-${unique}`;
    const targetId = `eperm-tgt-${unique}`;
    const sentenceId = Date.now();

    const cast = readDisk<{ characters: Array<Record<string, unknown>> }>('cast.json');
    cast.characters.push(
      { id: sourceId, name: 'Eperm Source', role: 'minor', color: 'halloran', lines: 1, scenes: 1 },
      { id: targetId, name: 'Eperm Target', role: 'minor', color: 'halloran', lines: 1, scenes: 1 },
    );
    writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify(cast));

    const edits = readDisk<{ sentences: Array<Record<string, unknown>> }>('manuscript-edits.json');
    edits.sentences.push({
      id: sentenceId,
      chapterId: 1,
      characterId: sourceId,
      text: 'Eperm line.',
    });
    writeFileSync(join(bookDir, '.audiobook', 'manuscript-edits.json'), JSON.stringify(edits));

    /* Seed the cache too, so the "cache still holds the source" half of the
       inconsistency is actually observable rather than vacuously true. */
    const cacheBefore = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      stage1: { characters: Array<Record<string, unknown>> };
      chapters: Record<string, Array<Record<string, unknown>>>;
    };
    cacheBefore.stage1.characters.push(
      { id: sourceId, name: 'Eperm Source' },
      { id: targetId, name: 'Eperm Target' },
    );
    cacheBefore.chapters['1'] = [
      ...cacheBefore.chapters['1'],
      { id: sentenceId, chapterId: 1, characterId: sourceId, text: 'Eperm line.' },
    ];
    writeFileSync(cachePath, JSON.stringify(cacheBefore));

    rmSync(historyPath, { recursive: true, force: true });
    mkdirSync(historyPath, { recursive: true });
    try {
      const res = await request(app)
        .post(`/api/books/${bookId}/cast/merge`)
        .set('Content-Type', 'application/json')
        .send({ sourceId, targetId });

      // Not a 500 on a half-applied merge.
      expect(res.status).toBe(200);

      const castAfter = readDisk<{ characters: Array<{ id: string }> }>('cast.json');
      expect(castAfter.characters.map((c) => c.id)).not.toContain(sourceId);

      /* The specific invariant the unwrapped call could break: everything
         AFTER the retirement still ran, so the cache agrees with cast.json.
         An id-only check on cast.json would pass even with the throw
         propagating (that write precedes the retirement), which is why the
         assertions that matter are these. */
      const cacheAfter = JSON.parse(readFileSync(cachePath, 'utf8')) as {
        stage1: { characters: Array<{ id: string }> };
        chapters: Record<string, Array<{ characterId: string }>>;
      };
      expect(cacheAfter.stage1.characters.map((c) => c.id)).not.toContain(sourceId);
      for (const arr of Object.values(cacheAfter.chapters)) {
        for (const s of arr) expect(s.characterId).not.toBe(sourceId);
      }

      // The journal write, last of all, ran too.
      const journal = readDisk<{ entries: Array<{ sourceId: string }> }>('cast-merges.json');
      expect(journal.entries.some((e) => e.sourceId === sourceId)).toBe(true);
    } finally {
      rmSync(historyPath, { recursive: true, force: true });
    }
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

/* #1981 — a dedicated book with two INDEPENDENT merge pairs (a1→a2, b1→b2),
   so two concurrent POST /cast/merge calls for the same book race that
   book's cast.json without any manuscript-edits/analysis-cache/journal
   files present — performCastMerge tolerates all three being absent
   (loadAnalysisCache/readJson return empty defaults; saveCastMerges is
   wrapped in a non-fatal try/catch), so this is the minimal fixture that
   still exercises the real cast.json read-modify-write. Own book/beforeAll
   (spawned into the shared workspaceRoot — a fresh mkdtemp would be
   invisible to the route's frozen BOOKS_ROOT) so it can't collide with the
   other describes' shared character ids. */
describe('#1981 — two /cast/merge calls for one book overlap', () => {
  const RACE_BOOK = 'Race Merge Book';
  const RACE_MANUSCRIPT_ID = 'm_race_merge_test';
  let raceBookId: string;
  let raceBookDir: string;

  beforeAll(async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    raceBookId = makeBookId(AUTHOR, SERIES, RACE_BOOK);
    raceBookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, RACE_BOOK);
    mkdirSync(join(raceBookDir, '.audiobook'), { recursive: true });
    writeFileSync(
      join(raceBookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: raceBookId,
        manuscriptId: RACE_MANUSCRIPT_ID,
        title: RACE_BOOK,
        author: AUTHOR,
        series: SERIES,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters: [],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(join(raceBookDir, 'manuscript.txt'), 'placeholder');
    writeFileSync(
      join(raceBookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          { id: 'a1', name: 'A One', role: 'character', color: 'unset' },
          { id: 'a2', name: 'A Two', role: 'character', color: 'unset' },
          { id: 'b1', name: 'B One', role: 'character', color: 'unset' },
          { id: 'b2', name: 'B Two', role: 'character', color: 'unset' },
        ],
      }),
    );
  });

  it('keeps both merges when two /cast/merge calls for one book overlap', async () => {
    const [resA, resB] = await Promise.all([
      request(app)
        .post(`/api/books/${raceBookId}/cast/merge`)
        .set('Content-Type', 'application/json')
        .send({ sourceId: 'a1', targetId: 'a2' }),
      request(app)
        .post(`/api/books/${raceBookId}/cast/merge`)
        .set('Content-Type', 'application/json')
        .send({ sourceId: 'b1', targetId: 'b2' }),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const cast = JSON.parse(
      readFileSync(join(raceBookDir, '.audiobook', 'cast.json'), 'utf8'),
    ) as { characters: Array<{ id: string; aliases?: string[] }> };
    const ids = cast.characters.map((c) => c.id);
    /* Both sources folded away, both targets survive — a lost merge shows up
       as a source id surviving OR a target id (and its alias) missing. */
    expect(ids).not.toContain('a1');
    expect(ids).not.toContain('b1');
    expect(ids).toContain('a2');
    expect(ids).toContain('b2');
    const a2 = cast.characters.find((c) => c.id === 'a2')!;
    const b2 = cast.characters.find((c) => c.id === 'b2')!;
    expect(a2.aliases).toContain('A One');
    expect(b2.aliases).toContain('B One');
  });
});
