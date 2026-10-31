/* #3837 (plan 290) -- the restructure seam of the parse-fallback hints check.
 *
 * A book whose chapter hints come from a fresh parse (`hintsSource: 'parse'`)
 * is checked against its saved analysis sentences before a restructure: a
 * chapter with evidence must find it in its own parse piece (the sentence rule),
 * an evidence-less chapter keeps today's positional title check. The check runs
 * under the `book` lock, never inside the `state-json` leaf (A6), and the leaf
 * re-checks that its inputs did not change in between.
 *
 * Harness mirrors chapters-restructure.test.ts: a tempdir workspace, deferred
 * imports so paths.ts picks up WORKSPACE_DIR, supertest against the real router. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

/* A6 -- set while a `withStateJsonLock` callback runs, so the spy below can
   record whether the check ran inside the leaf. */
const leaf = vi.hoisted(() => ({ inside: false }));
vi.mock('../workspace/file-lock.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workspace/file-lock.js')>();
  return {
    ...real,
    withStateJsonLock: <T>(path: string, fn: () => Promise<T>, timeoutMs?: number) =>
      real.withStateJsonLock(
        path,
        async () => {
          leaf.inside = true;
          try {
            return await fn();
          } finally {
            leaf.inside = false;
          }
        },
        timeoutMs,
      ),
  };
});

/* A passthrough spy on the check: records the leaf flag at every call and runs
   an optional hook after the real check has answered (the leaf re-check tests). */
const proof = vi.hoisted(() => ({
  insideLeaf: [] as boolean[],
  results: [] as Array<{ paired: boolean }>,
  after: null as null | (() => void),
}));
vi.mock('../workspace/hints-proof.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workspace/hints-proof.js')>();
  return {
    ...real,
    checkParseHintsPairing: (input: Parameters<typeof real.checkParseHintsPairing>[0]) => {
      proof.insideLeaf.push(leaf.inside);
      const result = real.checkParseHintsPairing(input);
      proof.results.push(result);
      proof.after?.();
      return result;
    },
  };
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, '..', '..');
const CACHE_DIR = join(SERVER_ROOT, 'handoff', 'cache');

const AUTHOR = 'Hints Proof Test';
const SERIES = 'Standalones';
const TITLE = 'Hints Proof Test Book';
const MANUSCRIPT_ID = 'm_hints_proof_restructure_test';
const REFUSAL =
  "This book's chapter list is out of date with its manuscript. Re-parse it from the book's menu in the Library to fix this — re-parsing discards its analysis, cast and audio.";

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let cachePath: string;

/* Distinct 24+-character lines per chapter, mid-body after a neutral first line
   (a short full sentence, so the parser does not take it as a subtitle). */
const LINES: Record<'harbour' | 'lighthouse' | 'storm', string[]> = {
  harbour: [
    'The harbour lights were burning low across the bay.',
    'Fishing boats rocked gently against the old stone quay.',
    'A gull cried somewhere above the sleeping market square.',
  ],
  lighthouse: [
    'The lighthouse keeper climbed the spiral stairs slowly.',
    'He trimmed the lamp wick before the storm arrived.',
    'Salt crusted the windows of the lantern room again.',
  ],
  storm: [
    'The storm broke over the cliffs before midnight came.',
    'Waves hammered the jetty until the posts gave way.',
    'By dawn the village counted every missing rowboat.',
  ],
};
/* The parse titles, by position. The leading book-title heading keeps the first
   chapter heading a chapter title. */
const PARSE_TITLES = ['Harbour Lights', 'The Lighthouse', 'Storm Season'];
const PIECES = ['harbour', 'lighthouse', 'storm'] as const;

function manuscript(opts: { emptyChapter?: boolean } = {}): string {
  const parts = ['# A Lighthouse Book', ''];
  PIECES.forEach((p, i) => {
    parts.push(`# ${PARSE_TITLES[i]}`, '', 'It began.', ...LINES[p], '');
  });
  /* A chapter with no manuscript text: its body is only its heading, so the
     prune pass drops it once some other chapter has sentences. */
  if (opts.emptyChapter) parts.push('# Dedication', '', 'Dedication', '');
  return parts.join('\n');
}

const statePath = (): string => join(bookDir, '.audiobook', 'state.json');
const editsPath = (): string => join(bookDir, '.audiobook', 'manuscript-edits.json');
const hintsPath = (): string => join(bookDir, '.audiobook', 'manuscript-hints.json');

/* Already in the shape the library scan's lazy migrations leave (uuid,
   language, schema), so the scan before a refusal does not rewrite state.json
   and the snapshots compare. No audio, so no segments backfill. */
function seedState(
  chapters: Array<{ id: number; title: string; titleOverridden?: boolean; excluded?: boolean }>,
  extra: object = {},
): void {
  writeFileSync(
    statePath(),
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
      language: null,
      schema: 1,
      chapters: chapters.map((c) => ({
        uuid: `u-${c.id}-${c.title.length}`,
        slug: `0${c.id}-${c.title.toLowerCase().replace(/[^a-z]+/g, '-')}`,
        ...c,
      })),
      coverGradient: ['#000', '#fff'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...extra,
    }),
  );
}

/* `byChapter[i]` = the lines saved under chapter id i + 1, after the short
   neutral sentence every analysed chapter starts with. */
function seedEdits(byChapter: Array<readonly string[] | null>, extra: object[] = []): void {
  const sentences: object[] = [];
  byChapter.forEach((lines, i) => {
    if (!lines) return;
    ['It began.', ...lines].forEach((text, k) =>
      sentences.push({ id: k + 1, chapterId: i + 1, characterId: 'narr', text }),
    );
  });
  writeFileSync(editsPath(), JSON.stringify({ sentences: [...sentences, ...extra] }));
}

/* Every file under .audiobook: a write anywhere (state.json rotates a backup,
   the edits file, the hints file) shows up here. */
function snapshotDisk(): Record<string, string> {
  const out: Record<string, string> = {};
  const dir = join(bookDir, '.audiobook');
  for (const f of readdirSync(dir).sort()) out[f] = readFileSync(join(dir, f), 'utf8');
  return out;
}

const post = (path: string, body: object) => request(app).post(`/api/books/${bookId}/${path}`).send(body);

async function restart(): Promise<void> {
  const { removeManuscript } = await import('../store/manuscripts.js');
  removeManuscript(MANUSCRIPT_ID);
}

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-hints-proof-restructure-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { chaptersRestructureRouter } = await import('./chapters-restructure.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  cachePath = join(CACHE_DIR, `${MANUSCRIPT_ID}.json`);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  app = express();
  app.use(express.json());
  app.use('/api/books', chaptersRestructureRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  if (cachePath && existsSync(cachePath)) rmSync(cachePath, { force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(async () => {
  rmSync(join(bookDir, '.audiobook'), { recursive: true, force: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), manuscript());
  if (existsSync(cachePath)) rmSync(cachePath, { force: true });
  proof.insideLeaf = [];
  proof.results = [];
  proof.after = null;
  await restart();
});

/* The five operations that refuse a mispaired book. Each is valid on the
   3-chapter fixture. */
const REFUSING_OPS: Array<[string, string, object]> = [
  ['merge', 'chapters/merge', { chapterIds: [1, 2] }],
  ['split', 'chapters/split', { chapterId: 1, afterSentenceId: 2 }],
  ['reorder', 'chapters/reorder', { order: [2, 1, 3] }],
  ['rename', 'chapters/2/rename', { title: 'A New Name' }],
  ['refresh-titles', 'chapters/refresh-titles', {}],
];

const ANALYSED = PIECES.map((p) => LINES[p]);
/* A reorder from before #3703: chapter 1 holds the lighthouse lines and chapter 2
   the harbour lines, while the parse is still [harbour, lighthouse, storm]. The
   titles still pair by position, so only the sentences can tell. */
const SWAPPED = [LINES.lighthouse, LINES.harbour, LINES.storm];
const pairedTitles = () => PARSE_TITLES.map((title, i) => ({ id: i + 1, title }));

describe('title drift on analysed chapters is unblocked (round 6)', () => {
  it.each(REFUSING_OPS)('%s answers 200 and writes its hints file', async (_name, path, body) => {
    seedState([
      { id: 1, title: 'Harbour Lights at Night' },
      { id: 2, title: 'The Old Lighthouse' },
      { id: 3, title: 'The Storm Season' },
    ]);
    seedEdits(ANALYSED);
    const res = await post(path, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(existsSync(hintsPath())).toBe(true);
    expect(proof.results.map((r) => r.paired)).toEqual([true]);
  });
});

describe('title drift on an evidence-less chapter is refused (round 6)', () => {
  it.each(REFUSING_OPS)('%s answers 409 and writes nothing', async (_name, path, body) => {
    /* A paused book: only chapter 1 is analysed; the tail's titles drifted. */
    seedState([
      { id: 1, title: 'Harbour Lights' },
      { id: 2, title: 'The Old Lighthouse' },
      { id: 3, title: 'The Storm Season' },
    ]);
    seedEdits([LINES.harbour, null, null]);
    const before = snapshotDisk();
    const res = await post(path, body);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: REFUSAL, code: 'hints_out_of_sync' });
    expect(snapshotDisk()).toEqual(before);
  });
});

describe('a same-count reorder with remapped sentences is refused', () => {
  it.each(REFUSING_OPS)('%s answers 409, every file byte-identical', async (_name, path, body) => {
    seedState(pairedTitles());
    seedEdits(SWAPPED);
    const before = snapshotDisk();
    const res = await post(path, body);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: REFUSAL, code: 'hints_out_of_sync' });
    expect(snapshotDisk()).toEqual(before);
    expect(proof.results.map((r) => r.paired)).toEqual([false]);
  });
});

describe('exclude/include: a toggle writes no hints file (round 8, decision 2)', () => {
  it('on a paired book: 200, no hints file', async () => {
    seedState(pairedTitles());
    seedEdits(ANALYSED);
    const res = await post('chapters/exclude', { chapterIds: [3], excluded: true });
    expect(res.status).toBe(200);
    expect(res.body.chapters[2].excluded).toBe(true);
    expect(existsSync(hintsPath())).toBe(false);
    const include = await post('chapters/exclude', { chapterIds: [3], excluded: false });
    expect(include.status).toBe(200);
    expect(existsSync(hintsPath())).toBe(false);
  });

  it('on an unpaired book: 200 (never refused), no hints file, and a merge afterwards is still refused', async () => {
    seedState(pairedTitles());
    seedEdits(SWAPPED);
    const res = await post('chapters/exclude', { chapterIds: [3], excluded: true });
    expect(res.status).toBe(200);
    expect(existsSync(hintsPath())).toBe(false);
    await restart();
    expect((await post('chapters/merge', { chapterIds: [1, 2] })).status).toBe(409);
  });

  it('on a persisted book: 200 and the existing hints file stays byte-identical', async () => {
    seedState(pairedTitles());
    seedEdits(ANALYSED);
    expect((await post('chapters/reorder', { order: [2, 1, 3] })).status).toBe(200);
    const hintsBefore = readFileSync(hintsPath(), 'utf8');
    await restart();
    const res = await post('chapters/exclude', { chapterIds: [1], excluded: true });
    expect(res.status).toBe(200);
    expect(readFileSync(hintsPath(), 'utf8')).toBe(hintsBefore);
  });
});

describe('exclude/include: a prune writes only on a book that pairs (round 8, decision 2)', () => {
  /* Four chapters, the fourth with no text and no sentences: any exclude prunes
     it and the chapter count drops to three. */
  function seedPruneBook(byChapter: Array<readonly string[] | null>): void {
    writeFileSync(join(bookDir, 'manuscript.md'), manuscript({ emptyChapter: true }));
    seedState([...pairedTitles(), { id: 4, title: 'Dedication' }]);
    seedEdits(byChapter);
  }

  it('on a paired book: 200, the hints file is written, and a restart hydrates `persisted`', async () => {
    seedPruneBook(ANALYSED);
    const res = await post('chapters/exclude', { chapterIds: [3], excluded: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.chapters).toHaveLength(3);
    expect(existsSync(hintsPath())).toBe(true);
    await restart();
    const { getOrHydrateManuscript } = await import('../store/manuscripts.js');
    expect((await getOrHydrateManuscript(MANUSCRIPT_ID))?.hintsSource).toBe('persisted');
  });

  it('on an unpaired book: 409 and every file byte-identical', async () => {
    seedPruneBook(SWAPPED);
    const before = snapshotDisk();
    const res = await post('chapters/exclude', { chapterIds: [3], excluded: true });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: REFUSAL, code: 'hints_out_of_sync' });
    expect(snapshotDisk()).toEqual(before);
  });

  it('on a book with no evidence whose titles pair: 200 and written, as on main', async () => {
    seedPruneBook([['Short one.'], ['Short two.'], ['Short three.']]);
    const res = await post('chapters/exclude', { chapterIds: [3], excluded: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.chapters).toHaveLength(3);
    expect(existsSync(hintsPath())).toBe(true);
  });

  it('in main mode (stale-evidence marker set) on a title-mispaired book: 409 and every file byte-identical', async () => {
    /* The marker keeps the sentence check from running, so the title rule
       judges the prune. */
    writeFileSync(join(bookDir, 'manuscript.md'), manuscript({ emptyChapter: true }));
    seedState(
      [
        { id: 1, title: 'Harbour Lights' },
        { id: 2, title: 'Somewhere Else Entirely' },
        { id: 3, title: 'Storm Season' },
        { id: 4, title: 'Dedication' },
      ],
      { sentencesPredateChapters: true },
    );
    seedEdits(ANALYSED);
    const before = snapshotDisk();
    const res = await post('chapters/exclude', { chapterIds: [3], excluded: true });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: REFUSAL, code: 'hints_out_of_sync' });
    expect(snapshotDisk()).toEqual(before);
    expect(proof.results).toEqual([]);
  });
});

/* #3837 fix round 1 (owner round 9, "Refuse it"): for a prune, "pairs" includes
   count/id. Without it, the prune keeps only the hints whose ids survive, which
   can leave hints and state the same length and write a persisted file whose
   bodies are not the chapters'. */
describe('exclude/include on a parse book whose count/id fails', () => {
  /* The parse splits Storm Season in two (split drift, 4 pieces against 3 state
     chapters). Titles pair at positions 0-2; Dedication has no sentences and an
     empty body. */
  const SPLIT_DRIFT = [
    '# A Lighthouse Book',
    '',
    '# Harbour Lights',
    '',
    'It began.',
    ...LINES.harbour,
    '',
    '# Dedication',
    '',
    'Dedication',
    '',
    '# Storm Season',
    '',
    'It began.',
    ...LINES.storm.slice(0, 2),
    '',
    '# Storm Season Part Two',
    '',
    'It began.',
    LINES.storm[2],
    '',
  ].join('\n');

  it('a prune with more parse pieces than chapters (m > n): 409 and every file byte-identical', async () => {
    writeFileSync(join(bookDir, 'manuscript.md'), SPLIT_DRIFT);
    seedState([
      { id: 1, title: 'Harbour Lights' },
      { id: 2, title: 'Dedication' },
      { id: 3, title: 'Storm Season' },
    ]);
    seedEdits([LINES.harbour, null, LINES.storm]);
    const before = snapshotDisk();
    const res = await post('chapters/exclude', { chapterIds: [1], excluded: true });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: REFUSAL, code: 'hints_out_of_sync' });
    expect(snapshotDisk()).toEqual(before);
  });

  it('a prune with fewer parse pieces than chapters (m < n): 409 and every file byte-identical', async () => {
    writeFileSync(join(bookDir, 'manuscript.md'), manuscript({ emptyChapter: true }));
    seedState([
      { id: 1, title: 'Harbour Lights' },
      { id: 2, title: 'The Lighthouse' },
      { id: 3, title: 'Storm Season' },
      { id: 4, title: 'Dedication' },
      { id: 5, title: 'Afterword' },
    ]);
    seedEdits([...ANALYSED, null, ['A short afterword.']]);
    const before = snapshotDisk();
    const res = await post('chapters/exclude', { chapterIds: [1], excluded: true });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: REFUSAL, code: 'hints_out_of_sync' });
    expect(snapshotDisk()).toEqual(before);
  });

  it('a toggle (no prune) still answers 200 and writes no hints file', async () => {
    writeFileSync(join(bookDir, 'manuscript.md'), SPLIT_DRIFT);
    /* Dedication is excluded, so it is not pruned: the exclude is a toggle. */
    seedState([
      { id: 1, title: 'Harbour Lights' },
      { id: 2, title: 'Dedication', excluded: true },
      { id: 3, title: 'Storm Season' },
    ]);
    seedEdits([LINES.harbour, null, LINES.storm]);
    const res = await post('chapters/exclude', { chapterIds: [1], excluded: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.chapters).toHaveLength(3);
    expect(existsSync(hintsPath())).toBe(false);
  });
});

describe('evidence-less positions keep the title rule at restructure (M12)', () => {
  it('a book with no evidence and a title mismatch: merge answers 409', async () => {
    seedState([
      { id: 1, title: 'Harbour Lights' },
      { id: 2, title: 'Somewhere Else Entirely' },
      { id: 3, title: 'Storm Season' },
    ]);
    seedEdits([['Short one.'], ['Short two.'], ['Short three.']]);
    const before = snapshotDisk();
    const res = await post('chapters/merge', { chapterIds: [1, 2] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('hints_out_of_sync');
    expect(snapshotDisk()).toEqual(before);
  });
});

describe('orphan sentences are ignored by the check (plan 70a keeps working)', () => {
  it('merge answers 200 and the orphans are recovered onto a surviving chapter', async () => {
    seedState(pairedTitles());
    const orphans = [
      'An orphaned line that names the harbour lights again.',
      'Another orphaned line about the lighthouse keeper.',
    ].map((text, k) => ({ id: k + 1, chapterId: 99, characterId: 'narr', text }));
    seedEdits(ANALYSED, orphans);
    const res = await post('chapters/merge', { chapterIds: [1, 2] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const edits = JSON.parse(readFileSync(editsPath(), 'utf8')) as {
      sentences: Array<{ chapterId: number; text: string }>;
    };
    expect(edits.sentences.some((s) => s.chapterId === 99)).toBe(false);
    for (const o of orphans) {
      const kept = edits.sentences.find((s) => s.text === o.text);
      expect(kept && [1, 2]).toContain(kept?.chapterId);
    }
  });
});

describe("the gate: books the check cannot judge take main's rule (M19)", () => {
  it('an impure record (hints without parse origins) is not sentence-checked', async () => {
    seedState(pairedTitles());
    seedEdits(SWAPPED);
    const { getOrHydrateManuscript, putManuscript } = await import('../store/manuscripts.js');
    const rec = (await getOrHydrateManuscript(MANUSCRIPT_ID))!;
    expect(rec.hintsSource).toBe('parse');
    putManuscript({ ...rec, chapterHints: rec.chapterHints.map(({ parseIndex: _p, ...h }) => h) });
    /* main's rule: the titles pair, so the merge goes through. */
    const res = await post('chapters/merge', { chapterIds: [1, 2] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(proof.results).toEqual([]);
  });

  it('state ids out of order (count/id still passes) are not sentence-checked', async () => {
    /* ids [2, 1, 3]: the transforms pair by id, so chapter id 2 (lighthouse by
       id) holds the lighthouse lines and the book is fine by id. A check pairing
       by index would read it as mispaired. Titles pair by position. */
    seedState([
      { id: 2, title: 'Harbour Lights' },
      { id: 1, title: 'The Lighthouse' },
      { id: 3, title: 'Storm Season' },
    ]);
    seedEdits(ANALYSED);
    const res = await post('chapters/3/rename', { title: 'Storm Season Renamed' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(proof.results).toEqual([]);
  });

  it('a BOM-prefixed edits file is read as `ok` and checked', async () => {
    seedState(pairedTitles());
    seedEdits(SWAPPED);
    writeFileSync(editsPath(), '﻿' + readFileSync(editsPath(), 'utf8'));
    const res = await post('chapters/merge', { chapterIds: [1, 2] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('hints_out_of_sync');
    expect(proof.results.map((r) => r.paired)).toEqual([false]);
  });

  it("a corrupt edits file takes main's path and answers exactly what main answers", async () => {
    seedState(pairedTitles());
    writeFileSync(editsPath(), '{ "sentences": [ not json');
    /* What main answers for the same book: its leaf `readJson` throws the
       SyntaxError, and the route curates it through requestFailureMessageFs. */
    const { readJson } = await import('../workspace/state-io.js');
    const { requestFailureMessageFs } = await import('../workspace/file-lock.js');
    const thrown = await readJson(editsPath()).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(thrown).toBeInstanceOf(SyntaxError);
    const res = await post('chapters/merge', { chapterIds: [1, 2] });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: requestFailureMessageFs(thrown, thrown!.message || 'Merge failed.') });
    expect(proof.results).toEqual([]);
  });
});

describe('the check never runs inside the state-json leaf (A6, M15)', () => {
  it.each(REFUSING_OPS)('%s: every check call ran outside withStateJsonLock', async (_name, path, body) => {
    seedState(pairedTitles());
    seedEdits(ANALYSED);
    const res = await post(path, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(proof.insideLeaf.length).toBeGreaterThan(0);
    expect(proof.insideLeaf.every((inside) => inside === false)).toBe(true);
  });
});

describe('the leaf re-checks the inputs the check judged (M16)', () => {
  it('a chapter id sequence changed after the check answers 409 and writes no hints file', async () => {
    seedState(pairedTitles());
    seedEdits(ANALYSED);
    proof.after = () => {
      const s = JSON.parse(readFileSync(statePath(), 'utf8'));
      s.chapters = s.chapters.map((c: { id: number }, i: number) => ({ ...c, id: [1, 3, 2][i] }));
      writeFileSync(statePath(), JSON.stringify(s));
    };
    const res = await post('chapters/merge', { chapterIds: [1, 2] });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: REFUSAL, code: 'hints_out_of_sync' });
    expect(existsSync(hintsPath())).toBe(false);
  });

  it('an edits file changed after the check answers 409 and writes no hints file', async () => {
    seedState(pairedTitles());
    seedEdits(ANALYSED);
    proof.after = () => {
      const e = JSON.parse(readFileSync(editsPath(), 'utf8'));
      e.sentences.push({ id: 9, chapterId: 3, characterId: 'narr', text: 'One more line saved after the check.' });
      writeFileSync(editsPath(), JSON.stringify(e));
    };
    const res = await post('chapters/merge', { chapterIds: [1, 2] });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: REFUSAL, code: 'hints_out_of_sync' });
    expect(existsSync(hintsPath())).toBe(false);
  });
});
