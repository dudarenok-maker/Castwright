/* Integration tests for the cast-merge router.

   Sets up a tempdir workspace with a fake book whose cast contains a known
   duplicate ("wren" + "wren-sparrow"), drives a POST against the route,
   and asserts every persisted file is updated coherently:
     - cast.json drops the source, target gains aliases / evidence / lines
     - manuscript-edits.json sentence attributions are remapped
     - .audiobook analysis-cache.json stage1 + per-chapter sentences updated

   Mirrors book-state.test.ts: defer module imports until WORKSPACE_DIR is
   set so paths.ts captures the right root. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

/* #3773 — hoisted `vi.mock`s (passthrough by default) so the cast-lock-alone
   race test can park the in-lock cast.json `readJson` (bound at the route
   module's own load time) and count entries into the cast lock. Every other
   test in this file sees the real implementations. */
vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return {
    ...actual,
    readJson: vi.fn(actual.readJson),
    writeJsonAtomic: vi.fn(actual.writeJsonAtomic),
  };
});
vi.mock('../workspace/cast-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/cast-lock.js')>();
  return { ...actual, withCastLock: vi.fn(actual.withCastLock) };
});

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

  const { castMergeSuggestionsRouter } = await import('./cast-merge-suggestions.js');
  app = express();
  app.use(express.json());
  app.use('/api/books', castMergeRouter);
  app.use('/api/books', castMergeSuggestionsRouter);
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

    /* #4031 — per-chapter takes are remapped; the RAW stage1 roster is no
       longer edited (the cached plan is what a resume applies; replaces the old
       "stage1 loses the source" assertion). */
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      stage1: { characters: Array<{ id: string }> };
      chapters: Record<string, Array<{ characterId: string }>>;
    };
    expect(cache.stage1.characters.map((c) => c.id)).toEqual(['wren-sparrow', 'wren', 'marlow']);
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

  it('C3: a merge whose history write fails with EPERM finishes every write, then answers a curated 500', async () => {
    /* REPLACES "a throwing history write never fails the merge or leaves
       cast.json and the analysis cache disagreeing" (#2040 Wave 2 final review,
       finding 4), which pinned the opposite outcome: a 200 with a swallowed
       warn. A swallowed retirement reported success on a merge whose id
       history was never recorded — #4031 rule 13 / C3 flips it. The half the
       old test existed for is KEPT and is still the load-bearing assertion:
       the failure is parked, so everything after the retirement (the cache
       reconciliation, the journal) still runs and cast.json and the cache
       agree; only then does the request fail, loud, with a curated body that
       leaks no path.

       The fault is a REAL write error (EPERM on the history file's write), via
       the passthrough `writeJsonAtomic` mock — not an unreadable history
       (that is the degraded case, which is skipped and answers success; see
       the next test). */
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

    const { writeJsonAtomic } = await import('../workspace/state-io.js');
    const real = await vi.importActual<typeof import('../workspace/state-io.js')>(
      '../workspace/state-io.js',
    );
    vi.mocked(writeJsonAtomic).mockImplementation(async (path, ...rest) => {
      if (String(path).endsWith('cast-id-history.json')) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${path}'`), {
          code: 'EPERM',
          syscall: 'rename',
          path,
        });
      }
      return real.writeJsonAtomic(path, ...rest);
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(app)
        .post(`/api/books/${bookId}/cast/merge`)
        .set('Content-Type', 'application/json')
        .send({ sourceId, targetId });

      // Loud: the request fails, with a curated body that names no path.
      expect(res.status).toBe(500);
      expect(res.type).toBe('application/json');
      expect(res.body.error).not.toContain(historyPath);
      expect(res.body.error).not.toContain('cast-id-history');
      expect(res.body.error).not.toContain(workspaceRoot);

      const castAfter = readDisk<{ characters: Array<{ id: string }> }>('cast.json');
      expect(castAfter.characters.map((c) => c.id)).not.toContain(sourceId);

      /* The specific invariant a throw at the retirement site would break:
         everything AFTER the retirement still ran, so the cache agrees with
         cast.json. An id-only check on cast.json would pass even with the throw
         propagating (that write precedes the retirement), which is why the
         assertions that matter are these. */
      const cacheAfter = JSON.parse(readFileSync(cachePath, 'utf8')) as {
        stage1: { characters: Array<{ id: string }> };
        chapters: Record<string, Array<{ characterId: string }>>;
      };
      for (const arr of Object.values(cacheAfter.chapters)) {
        for (const s of arr) expect(s.characterId).not.toBe(sourceId);
      }

      // The journal write, last of all, ran too.
      const journal = readDisk<{ entries: Array<{ sourceId: string }> }>('cast-merges.json');
      expect(journal.entries.some((e) => e.sourceId === sourceId)).toBe(true);
    } finally {
      vi.mocked(writeJsonAtomic).mockImplementation(real.writeJsonAtomic);
      errSpy.mockRestore();
    }
  });

  it('degraded history is not a merge failure: the retirement is skipped and the merge answers 200', async () => {
    /* #4031 ruling: an UNREADABLE cast-id-history.json (CastIdHistoryUnreadableError)
       is skipped and logged server-side — matching "Retirements are skipped and
       logged" and the dismiss route — and the merge succeeds. Only a real write
       error is parked (the C3 test above). The history path is occupied by a
       directory, so the read fails for real. */
    const { castIdHistoryPath, loadCastIdHistory } = await import('../store/cast-id-history.js');
    const historyPath = castIdHistoryPath(bookDir);
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sourceId = `degr-src-${unique}`;
    const targetId = `degr-tgt-${unique}`;
    const cast = readDisk<{ characters: Array<Record<string, unknown>> }>('cast.json');
    cast.characters.push(
      { id: sourceId, name: 'Degr Source', role: 'minor', color: 'halloran', lines: 1, scenes: 1 },
      { id: targetId, name: 'Degr Target', role: 'minor', color: 'halloran', lines: 1, scenes: 1 },
    );
    writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify(cast));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    rmSync(historyPath, { recursive: true, force: true });
    mkdirSync(historyPath, { recursive: true });
    try {
      const res = await request(app)
        .post(`/api/books/${bookId}/cast/merge`)
        .set('Content-Type', 'application/json')
        .send({ sourceId, targetId });
      expect(res.status).toBe(200);
      const castAfter = readDisk<{ characters: Array<{ id: string }> }>('cast.json');
      expect(castAfter.characters.map((c) => c.id)).not.toContain(sourceId);
      const journal = readDisk<{ entries: Array<{ sourceId: string }> }>('cast-merges.json');
      expect(journal.entries.some((e) => e.sourceId === sourceId)).toBe(true);
    } finally {
      rmSync(historyPath, { recursive: true, force: true });
      warnSpy.mockRestore();
    }
    /* No retirement was recorded: the history is a fresh, empty one. */
    expect((await loadCastIdHistory(bookDir)).supersededBy ?? {}).not.toHaveProperty(sourceId);
  });

  it('cast-merge round trip keeps phase', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sourceId = `phase-src-${unique}`;
    const targetId = `phase-tgt-${unique}`;
    const cast = readDisk<{ characters: Array<Record<string, unknown>> }>('cast.json');
    cast.characters.push(
      { id: sourceId, name: 'Phase Source', role: 'minor', color: 'halloran', lines: 1, scenes: 1 },
      { id: targetId, name: 'Phase Target', role: 'minor', color: 'halloran', lines: 1, scenes: 1 },
    );
    writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify(cast));
    /* An UNTAGGED legacy failure record (stage1 present, attribution-* code) plus
       a cached take that names the source, so the merge re-saves the cache. */
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>;
    (cache.chapters as Record<string, unknown[]>)['3'] = [
      { id: 900, chapterId: 3, characterId: sourceId, text: 'Phase line.' },
    ];
    cache.failedChapterIds = [3];
    cache.failedChapterErrors = {
      '3': { code: 'attribution-incomplete', message: 'm', remediation: 'r' },
    };
    writeFileSync(cachePath, JSON.stringify(cache));

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/merge`)
      .set('Content-Type', 'application/json')
      .send({ sourceId, targetId });
    expect(res.status).toBe(200);

    const after = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      failedChapterErrors: Record<string, { phase?: string }>;
    };
    expect(after.failedChapterErrors['3'].phase).toBe('attribution');
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

    /* #4031 — the raw stage1 roster is no longer edited (it neither gains the
       bucket nor loses 'rescuer'); the cached takes are re-attributed. Replaces
       the old "stage1 also gained the bucket" assertion. */
    const cache = JSON.parse(readFileSync(dCachePath, 'utf8')) as {
      stage1: { characters: Array<{ id: string }> };
      chapters: Record<string, Array<{ characterId: string }>>;
    };
    expect(cache.stage1.characters.map((c) => c.id)).toEqual(['rescuer', 'garrow']);
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

  const seedRaceCast = () =>
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
    seedRaceCast();
  });

  /* Re-seeded before EACH test: the two race tests below fold the same
     characters, and a fold the first test already left on disk would let the
     second pass without its own write ever landing. */
  beforeEach(() => {
    seedRaceCast();
  });

  /* #3773 — cast-lock-alone proof. The route-level race below is NOT cast-lock
     proof: both /cast/merge calls hold `book-op:<bookId>` (#3711), which
     serialises them on its own, so it stays green with `withCastLock` replaced
     by a no-op (confirmed: no-op cast lock green; no-op cast lock AND book-op
     red). Here the real /cast/merge is parked at its in-lock cast.json read
     while the second writer, `performCastMerge` (the shared helper both merge
     routes call: cast lock, NO book-op), merges the other pair directly. */
  it('#3773 — cast lock alone: a /cast/merge and a cast-lock-only merge of a different pair both survive', async () => {
    const stateIo = await import('../workspace/state-io.js');
    const actual = await vi.importActual<typeof import('../workspace/state-io.js')>(
      '../workspace/state-io.js',
    );
    const castLock = await import('../workspace/cast-lock.js');
    const { castJsonPath } = await import('../workspace/paths.js');
    const { performCastMerge } = await import('./cast-merge.js');
    const raceCastPath = castJsonPath(raceBookDir);
    const state = JSON.parse(readFileSync(join(raceBookDir, '.audiobook', 'state.json'), 'utf8'));
    const castLockEntries = () =>
      vi.mocked(castLock.withCastLock).mock.calls.filter(([dir]) => dir === raceBookDir).length;
    const entriesBefore = castLockEntries();
    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    let intercepted = false;
    let signalRead!: () => void;
    const readReached = new Promise<void>((resolve) => {
      signalRead = resolve;
    });
    /* performCastMerge's FIRST cast.json read is the in-lock one (the route's
       book-op span reads state.json only): park its resolution behind the
       gate. */
    const spy = vi.mocked(stateIo.readJson).mockImplementation(async (path: string) => {
      if (path !== raceCastPath || intercepted) return actual.readJson(path);
      intercepted = true;
      signalRead();
      const value = await actual.readJson(path); // real bytes, now — happens-before the second writer's write
      await gate;
      return value;
    });

    let resMerge: request.Response;
    let second: unknown;
    let mergePromise: request.Test | undefined;
    let secondPromise: Promise<unknown> | undefined;
    try {
      mergePromise = request(app)
        .post(`/api/books/${raceBookId}/cast/merge`)
        .set('Content-Type', 'application/json')
        .send({ sourceId: 'a1', targetId: 'a2' });
      mergePromise.catch(() => {}); // supertest is lazy — force real dispatch now
      let reachTimer!: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          readReached,
          new Promise<never>((_, rej) => {
            reachTimer = setTimeout(
              () => rej(new Error('HANG: /cast/merge never reached its in-lock cast.json read')),
              8_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(reachTimer);
      }
      expect(intercepted).toBe(true);

      secondPromise = performCastMerge({
        bookId: raceBookId,
        bookDir: raceBookDir,
        state,
        sourceId: 'b1',
        targetId: 'b2',
      });
      secondPromise.catch(() => {}); // force dispatch now (see above)
      // Generous head start: completes fully when unlocked (the bug window)
      // or queues behind /cast/merge's still-held lock when locked.
      await new Promise((r) => setTimeout(r, 50));
      /* Pin the premise: the second writer really reached the cast lock (the
         route's entry + its own) while /cast/merge was parked. Its first
         cast.json read is inside the lock, so a read count cannot show this
         when the lock holds. Wrap it in book-op and it blocks before the lock
         — this goes red instead of silently decaying. */
      expect(castLockEntries() - entriesBefore).toBeGreaterThanOrEqual(2);

      released();
      [resMerge, second] = await Promise.all([mergePromise, secondPromise]);
    } finally {
      released(); // idempotent — a throw above still releases the held read
      spy.mockImplementation(actual.readJson);
      await Promise.allSettled([mergePromise, secondPromise]);
    }
    expect(resMerge.status).toBe(200);
    expect((second as { sourceId: string }).sourceId).toBe('b1');

    const cast = JSON.parse(
      readFileSync(join(raceBookDir, '.audiobook', 'cast.json'), 'utf8'),
    ) as { characters: Array<{ id: string; aliases?: string[] }> };
    const ids = cast.characters.map((c) => c.id);
    /* /cast/merge's own fold survived: a1 gone, a2 carries the alias. */
    expect(ids).not.toContain('a1');
    expect(cast.characters.find((c) => c.id === 'a2')!.aliases).toContain('A One');
    /* the second writer's own fold survived too — the lost-update this test
       pins. */
    expect(ids).not.toContain('b1');
    expect(cast.characters.find((c) => c.id === 'b2')!.aliases).toContain('B One');
  });

  it('keeps both merges when two /cast/merge calls for one book overlap (end-to-end through book-op AND the cast lock)', async () => {
    /* Route-level coverage only: both calls hold `book-op:<bookId>`, which by
       itself serialises them — this stays green with a no-op cast lock
       (#3773), so it does NOT prove the cast lock; the test above does. */
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

/* #4031 Task 13 — manual merge and accept under the single matcher: declines
   are unioned, the cached plan is re-targeted inside the cache op, and a
   dismissal record dies with the merge that collapses its pair. Each test
   seeds its own uniquely-named pair onto the shared book. */
describe('cast-merge — single matcher (#4031 Task 13)', () => {
  const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  function row(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id, name: `Row ${id}`, role: 'minor', color: 'halloran', lines: 1, scenes: 1, ...extra };
  }

  function seedRows(rows: Array<Record<string, unknown>>): void {
    const cast = readDisk<{ characters: Array<Record<string, unknown>> }>('cast.json');
    cast.characters.push(...rows);
    writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify(cast));
  }

  function castRow(id: string): Record<string, unknown> | undefined {
    return readDisk<{ characters: Array<Record<string, unknown>> }>('cast.json').characters.find(
      (c) => c.id === id,
    );
  }

  function seedCache(cache: Record<string, unknown>): void {
    writeFileSync(cachePath, JSON.stringify({ version: 2, updatedAt: new Date().toISOString(), ...cache }));
  }

  function readCacheFile(): {
    stage1?: { characters: Array<{ id: string }> };
    matchPlan?: { decisions: Record<string, Record<string, unknown>> };
    addedRows?: Record<string, unknown>;
    chapters: Record<string, Array<{ characterId: string }>>;
  } {
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  }

  function merge(sourceId: string, targetId: string) {
    return request(app)
      .post(`/api/books/${bookId}/cast/merge`)
      .set('Content-Type', 'application/json')
      .send({ sourceId, targetId });
  }

  it("a merge unions the source's declines but never a same-book one naming either row", async () => {
    const u = uniq();
    const src = `dec-src-${u}`;
    const tgt = `dec-tgt-${u}`;
    seedRows([
      row(src, {
        notLinkedTo: [
          { bookId: 'series-book-1', characterId: 'zed' },
          { bookId, characterId: tgt },
          { bookId, characterId: 'third-row' },
        ],
      }),
      row(tgt, {
        notLinkedTo: [
          { bookId: 'series-book-1', characterId: 'yan' },
          { bookId, characterId: src },
        ],
      }),
    ]);

    const res = await merge(src, tgt);
    expect(res.status).toBe(200);

    expect(castRow(tgt)!.notLinkedTo).toEqual([
      { bookId: 'series-book-1', characterId: 'yan' },
      { bookId: 'series-book-1', characterId: 'zed' },
      { bookId, characterId: 'third-row' },
    ]);
  });

  it('item 13: a cross-book entry whose characterId equals targetId survives', async () => {
    const u = uniq();
    const src = `x13-src-${u}`;
    const tgt = `x13-tgt-${u}`;
    seedRows([
      row(src, { notLinkedTo: [{ bookId: 'series-book-2', characterId: tgt }] }),
      row(tgt),
    ]);

    expect((await merge(src, tgt)).status).toBe(200);

    expect(castRow(tgt)!.notLinkedTo).toEqual([{ bookId: 'series-book-2', characterId: tgt }]);
  });

  it("A23b: a merge re-targets the cached plan and chapters and drops the source's ledger entry", async () => {
    const u = uniq();
    const src = `a23-src-${u}`;
    const tgt = `a23-tgt-${u}`;
    seedRows([row(src), row(tgt)]);
    seedCache({
      stage1: { characters: [{ id: 'raw-a' }, { id: 'raw-b' }], chapters: [{ id: 1, title: 'One' }] },
      chapters: { 1: [{ id: 91, chapterId: 1, characterId: src, text: 'a' }] },
      matchPlan: {
        version: 1,
        runToken: 't1',
        decisions: {
          'raw-a': { kind: 'join', rawId: 'raw-a', priorId: src, tier: 'id' },
          'raw-b': { kind: 'join', rawId: 'raw-b', priorId: tgt, tier: 'id' },
        },
      },
      addedRows: {
        [src]: { state: 'run-owned', fp: 'fp-source' },
        [tgt]: { state: 'run-owned', fp: 'fp-target' },
      },
    });

    expect((await merge(src, tgt)).status).toBe(200);

    const cache = readCacheFile();
    expect(cache.matchPlan!.decisions['raw-a']).toEqual({
      kind: 'join',
      rawId: 'raw-a',
      priorId: tgt,
      tier: 'merge',
    });
    expect(cache.matchPlan!.decisions['raw-b']).toMatchObject({ priorId: tgt, tier: 'id' });
    expect(cache.chapters['1'][0].characterId).toBe(tgt);
    /* The source's entry is dropped; the target keeps ITS OWN fingerprint. */
    expect(cache.addedRows).toEqual({ [tgt]: { state: 'run-owned', fp: 'fp-target' } });
    /* The raw roster is not edited. */
    expect(cache.stage1!.characters.map((c) => c.id)).toEqual(['raw-a', 'raw-b']);
  });

  it("item 12: merging a new row into another new row copies the target's decision", async () => {
    const u = uniq();
    const src = `i12-src-${u}`;
    const tgt = `i12-tgt-${u}`;
    seedRows([row(src), row(tgt)]);
    const targetDecision = {
      kind: 'new',
      rawId: 'raw-t',
      id: tgt,
      minted: true,
      suggest: ['cand-1'],
      inheritedDeclines: [{ bookId: 'series-book-1', characterId: 'zed' }],
    };
    seedCache({
      stage1: { characters: [{ id: 'raw-s' }, { id: 'raw-t' }] },
      chapters: {},
      matchPlan: {
        version: 1,
        runToken: 't1',
        decisions: {
          'raw-s': { kind: 'new', rawId: 'raw-s', id: src, minted: true, suggest: [], inheritedDeclines: [] },
          'raw-t': targetDecision,
        },
      },
    });

    expect((await merge(src, tgt)).status).toBe(200);

    expect(readCacheFile().matchPlan!.decisions['raw-s']).toEqual({ ...targetDecision, rawId: 'raw-s' });
    expect(readCacheFile().matchPlan!.decisions['raw-t']).toEqual(targetDecision);
  });

  it("PR #4103 pass 2 P2-1: merging a fold bucket deletes the bucket's plan decisions instead of re-targeting them", async () => {
    const tgt = `p21-tgt-${uniq()}`;
    /* A bucket from an earlier test on this shared book is cleared first. */
    const cast = readDisk<{ characters: Array<Record<string, unknown>> }>('cast.json');
    cast.characters = cast.characters.filter((c) => c.id !== 'unknown-male');
    writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify(cast));
    seedRows([row('unknown-male', { name: 'Unknown male' }), row(tgt)]);
    const other = { kind: 'join', rawId: 'raw-o', priorId: tgt, tier: 'id' };
    seedCache({
      chapters: {},
      matchPlan: {
        version: 1,
        runToken: 't1',
        decisions: {
          'unknown-male': { kind: 'new', rawId: 'unknown-male', id: 'unknown-male', minted: false, suggest: [], inheritedDeclines: [] },
          'raw-o': other,
        },
      },
    });

    expect((await merge('unknown-male', tgt)).status).toBe(200);

    /* R49: the bucket settles by its own id only, so the next persist re-plans it; a
       re-targeted `join -> tgt` would leave its raw key covered and undecided. */
    expect(readCacheFile().matchPlan!.decisions).toEqual({ 'raw-o': other });
  });

  it('R53 / R56 (PR #4103 passes 4-5): a merge of a fold bucket moves its lines and leaves a render-only record, as main did', async () => {
    const u = uniq();
    const tgt = `r53-tgt-${u}`;
    const down = `r53-down-${u}`;
    const cast = readDisk<{ characters: Array<Record<string, unknown>> }>('cast.json');
    cast.characters = cast.characters.filter((c) => c.id !== 'unknown-male');
    writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify(cast));
    seedRows([row(down), row('unknown-male', { name: 'Unknown male' }), row(tgt)]);
    /* An earlier "Downgrade to a background voice" of another character. */
    expect((await merge(down, 'unknown-male')).status).toBe(200);
    seedCache({ chapters: {}, addedRows: { 'unknown-male': { state: 'added-once' }, [tgt]: { state: 'added-once' } } });

    expect((await merge('unknown-male', tgt)).status).toBe(200);

    expect(castRow('unknown-male')).toBeUndefined();
    const { loadCastIdHistory } = await import('../store/cast-id-history.js');
    const h = await loadCastIdHistory(bookDir);
    /* R56: the bucket is retired onto the target and the downgrade's entry is repointed with
       it, so both ids' rendered lines resolve to the target. Matching never follows the
       bucket key (`followableHistory`, pinned in cast-id-history.test.ts). */
    expect(h.supersededBy['unknown-male']).toBe(tgt);
    expect(h.supersededBy[down]).toBe(tgt);
    /* The bucket's ledger entry goes; the target's stays. */
    expect(readCacheFile().addedRows).toEqual({ [tgt]: { state: 'added-once' } });
  });

  async function notSamePersonNaming(...ids: string[]): Promise<unknown[]> {
    const { loadCastIdHistory } = await import('../store/cast-id-history.js');
    const h = await loadCastIdHistory(bookDir);
    return (h.notSamePerson ?? []).filter((r) => ids.includes(r.a) || ids.includes(r.b));
  }

  it('F9: dismiss then merge the pair removes the record and both edges', async () => {
    const u = uniq();
    const src = `f9-src-${u}`;
    const tgt = `f9-tgt-${u}`;
    seedRows([row(src), row(tgt)]);
    const dismissed = await request(app)
      .post(`/api/books/${bookId}/cast/merge-suggestions/dismiss`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: src, targetId: tgt });
    expect(dismissed.status).toBe(200);
    expect(await notSamePersonNaming(src, tgt)).toHaveLength(1);
    expect(castRow(tgt)!.notLinkedTo).toEqual([{ bookId, characterId: src }]);

    expect((await merge(src, tgt)).status).toBe(200);

    expect(await notSamePersonNaming(src, tgt)).toEqual([]);
    expect(castRow(src)).toBeUndefined();
    expect(castRow(tgt)!.notLinkedTo ?? []).toEqual([]);
  });

  function seedSuggestions(pairs: Array<[string, string]>): void {
    writeFileSync(
      join(bookDir, '.audiobook', 'cast-merge-suggestions.json'),
      JSON.stringify({ suggestions: pairs.map(([a, b]) => ({ sourceId: a, targetId: b, reason: 'same?' })) }),
    );
  }

  function storedSuggestionPairs(): string[] {
    return readDisk<{ suggestions: Array<{ sourceId: string; targetId: string }> }>(
      'cast-merge-suggestions.json',
    ).suggestions.map((s) => `${s.sourceId}>${s.targetId}`);
  }

  it('A12d: both routes drop a dismissed pair\'s record, edges and suggestion', async () => {
    /* (1) accept route. */
    const u = uniq();
    const src = `a12d-src-${u}`;
    const tgt = `a12d-tgt-${u}`;
    seedRows([row(src), row(tgt)]);
    await request(app)
      .post(`/api/books/${bookId}/cast/merge-suggestions/dismiss`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: src, targetId: tgt });
    expect(await notSamePersonNaming(src, tgt)).toHaveLength(1);
    /* A later run can re-raise the pair only by writing the file directly. */
    seedSuggestions([[src, tgt]]);

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/merge-suggestions/accept`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: src, targetId: tgt });
    expect(res.status).toBe(200);
    expect(await notSamePersonNaming(src, tgt)).toEqual([]);
    expect(castRow(tgt)!.notLinkedTo ?? []).toEqual([]);
    expect(storedSuggestionPairs()).toEqual([]);

    /* (2) manual merge route. */
    const src2 = `a12d-src2-${u}`;
    const tgt2 = `a12d-tgt2-${u}`;
    seedRows([row(src2), row(tgt2)]);
    await request(app)
      .post(`/api/books/${bookId}/cast/merge-suggestions/dismiss`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: src2, targetId: tgt2 });
    seedSuggestions([[src2, tgt2]]);

    expect((await merge(src2, tgt2)).status).toBe(200);
    expect(await notSamePersonNaming(src2, tgt2)).toEqual([]);
    expect(castRow(tgt2)!.notLinkedTo ?? []).toEqual([]);
    expect(storedSuggestionPairs()).toEqual([]);
  });

  it("R32: a manual merge removes its own pair's suggestion and keeps the others", async () => {
    const u = uniq();
    const src = `r32-src-${u}`;
    const tgt = `r32-tgt-${u}`;
    const other = `r32-other-${u}`;
    const other2 = `r32-other2-${u}`;
    seedRows([row(src), row(tgt), row(other), row(other2)]);
    seedSuggestions([
      [src, tgt],
      [other, other2],
    ]);

    expect((await merge(tgt, src)).status).toBe(200); // opposite direction: the pair is unordered

    expect(storedSuggestionPairs()).toEqual([`${other}>${other2}`]);
  });

  it('R32: the pair removal survives an EPERM history write error (parked, finished, then 500)', async () => {
    const u = uniq();
    const src = `r32e-src-${u}`;
    const tgt = `r32e-tgt-${u}`;
    seedRows([row(src), row(tgt)]);
    seedSuggestions([[src, tgt]]);
    const { writeJsonAtomic } = await import('../workspace/state-io.js');
    const real = await vi.importActual<typeof import('../workspace/state-io.js')>(
      '../workspace/state-io.js',
    );
    vi.mocked(writeJsonAtomic).mockImplementation(async (path, ...rest) => {
      if (String(path).endsWith('cast-id-history.json')) {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
      return real.writeJsonAtomic(path, ...rest);
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await merge(src, tgt)).status).toBe(500);
    } finally {
      vi.mocked(writeJsonAtomic).mockImplementation(real.writeJsonAtomic);
      errSpy.mockRestore();
    }
    expect(castRow(src)).toBeUndefined();
    expect(storedSuggestionPairs()).toEqual([]);
  });

  /* A superseded target: tgt was retired into the live row R, so retiring
     src into tgt resolves to R and a (src, R) dismissal record collapses to
     (R, R). R is NOT one of the two merging rows, so only the
     dropped-record edge clear can remove R's edge naming src. */
  async function seedSupersededTargetFixture(u: string, withRejectedPair: boolean) {
    const src = `sup-src-${u}`;
    const tgt = `sup-tgt-${u}`;
    const live = `sup-live-${u}`;
    const bystander = `sup-by-${u}`;
    seedRows([
      row(src),
      row(tgt),
      row(live, { notLinkedTo: [{ bookId, characterId: src }] }),
      row(bystander, { notLinkedTo: [{ bookId, characterId: live }] }),
    ]);
    const history = await import('../store/cast-id-history.js');
    await history.recordNotSamePerson(bookDir, src, live);
    if (withRejectedPair) await history.rejectOrphanedPair(bookDir, live, src);
    await history.retireCharacterId(bookDir, tgt, live);
    return { src, tgt, live, bystander };
  }

  it('a dropped dismissal record clears the edge on the row it collapsed into (superseded target)', async () => {
    const { src, tgt, live } = await seedSupersededTargetFixture(uniq(), false);

    expect((await merge(src, tgt)).status).toBe(200);

    expect(await notSamePersonNaming(src, live)).toEqual([]);
    expect(castRow(live)!.notLinkedTo ?? []).toEqual([]);
  });

  it('both dropped-edge clears run: a self-loop rejection AND a dismissal record in one merge', async () => {
    const { src, tgt, live, bystander } = await seedSupersededTargetFixture(uniq(), true);

    expect((await merge(src, tgt)).status).toBe(200);

    /* the rejectedPairs self-loop's edge (naming `live`) on the bystander... */
    expect(castRow(bystander)!.notLinkedTo ?? []).toEqual([]);
    /* ...and the dismissal record's edge on `live`. A short-circuiting `||`
       skips the second clear whenever the first changed something. */
    expect(castRow(live)!.notLinkedTo ?? []).toEqual([]);
  });

  it('GET merge-suggestions returns only pairs whose two ids are both live rows', async () => {
    const u = uniq();
    const a = `get-a-${u}`;
    const b = `get-b-${u}`;
    seedRows([row(a), row(b)]);
    seedSuggestions([
      [a, b],
      [a, `get-deleted-${u}`],
    ]);

    const res = await request(app).get(`/api/books/${bookId}/cast/merge-suggestions`);
    expect(res.status).toBe(200);
    expect(res.body.suggestions.map((s: { sourceId: string; targetId: string }) => `${s.sourceId}>${s.targetId}`)).toEqual([
      `${a}>${b}`,
    ]);
  });
});
