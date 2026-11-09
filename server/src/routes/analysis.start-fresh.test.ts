/* Plan 291 Task 14 (#4031), rule 8 - "Start fresh keeps the user's decisions".
   A `fresh: true` run discards the analysis cache and the per-sentence edits and
   re-runs the analyzer, but no longer deletes cast.json, the reparse carryover,
   the merge journal or the suggestions, and no longer strips series links or
   declines from the prior it merges against.

   Most cases STOP the run in Phase 0 (a hook aborts the first chapter's detect
   call). By then the run-start block - where Start fresh used to delete files -
   has fully run and nothing has been written since, so the disk is exactly what
   that block left. The completed-run case covers the other half, the prior the
   merge sees. The mock blocks are the ones the harness header requires. */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import express from 'express';
import request from 'supertest';

vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs');
  const os = process.getBuiltinModule('node:os');
  const path = process.getBuiltinModule('node:path');
  process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-4031-fresh-ws-'));
});

import {
  FRESH_ID,
  NARR,
  PHASE1_GLOBAL,
  cleanupBook,
  mkBook,
  mkJob,
  phase0,
  phase1,
  readCache,
  readCast,
  readJson,
  resetHarness,
  roster,
  sel,
  setPhase0Hook,
  type HarnessBook,
  type Row,
  type Sent,
} from './__test-helpers__/analysis-job-harness.js';
import { runMainAnalyzerJob, type AnalysisJob } from './analysis.js';
import { castAliasesRouter } from './cast-aliases.js';
import { getManuscript } from '../store/manuscripts.js';
import { saveAnalysisCache } from '../store/analysis-cache.js';
import {
  castMergeSuggestionsJsonPath,
  makeBookId,
  manuscriptEditsJsonPath,
} from '../workspace/paths.js';
import type { CastMergeEntry } from '../store/cast-merges.js';

vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return { ...actual, readJson: vi.fn(actual.readJson) };
});
vi.mock('../store/cast-id-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/cast-id-history.js')>();
  return { ...actual, retireCharacterId: vi.fn(actual.retireCharacterId) };
});

const { detectOllamaDeviceMock, setLastKnownAnalyzerDeviceMock } = vi.hoisted(() => ({
  detectOllamaDeviceMock: vi.fn(async (): Promise<'cuda' | 'cpu' | 'unknown'> => 'cuda'),
  setLastKnownAnalyzerDeviceMock: vi.fn(),
}));
vi.mock('./ollama-health.js', () => ({
  detectOllamaDevice: detectOllamaDeviceMock,
  unloadResidentOllama: vi.fn(async () => {}),
}));
vi.mock('../gpu/analyzer-device-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gpu/analyzer-device-state.js')>()),
  setLastKnownAnalyzerDevice: setLastKnownAnalyzerDeviceMock,
}));
vi.mock('../analyzer/select-analyzer.js', async () => {
  const actual = await vi.importActual<typeof import('../analyzer/select-analyzer.js')>(
    '../analyzer/select-analyzer.js',
  );
  return {
    ...actual,
    selectAnalyzerForPhase: (opts: { phase: 'phase0' | 'phase1' }) => {
      const g = globalThis as Record<string, unknown>;
      if (opts.phase === 'phase1' && g.__single_matcher_phase1) return g.__single_matcher_phase1;
      return actual.selectAnalyzerForPhase(
        opts as Parameters<typeof actual.selectAnalyzerForPhase>[0],
      );
    },
    isPerPhaseModelSelectionActive: () =>
      Boolean((globalThis as Record<string, unknown>).__single_matcher_pipelined),
  };
});

/* ---- fixtures ------------------------------------------------------------- */

/* The user's decisions on the prior cast: a series link, a pinned voice, a decline
   edge both ways (a dismissal), and a merge target carrying a merged-away alias. */
const OLGA: Row = {
  id: 'olga',
  name: 'Olga',
  role: 'character',
  color: '#222222',
  voiceId: 'v-olga',
  voiceState: 'locked',
  matchedFrom: { bookId: 'sibling-book', characterId: 'olga-1' }, // retargeted at the real sibling by seedDecisions
  notLinkedTo: ['w2'],
};
const WREN: Row = {
  id: 'w2',
  name: 'Wren',
  role: 'character',
  color: '#333333',
  voiceState: 'locked',
  notLinkedTo: ['olga'],
};
const SALTGRAVE: Row = {
  id: 'saltgrave',
  name: 'Saltgrave Figure',
  role: 'character',
  color: '#444444',
  aliases: ['Garrow'],
};
const PRIOR: Row[] = [{ ...NARR }, OLGA, WREN, SALTGRAVE];
/** PRIOR with Olga's series link pointing at the sibling book seedDecisions wrote. */
let seededPrior: Row[] = PRIOR;
const siblingDirs: string[] = [];
const HISTORY = {
  schema: 1,
  supersededBy: { garrow: 'saltgrave' },
  notSamePerson: [{ a: 'olga', b: 'w2', at: '2026-11-01T00:00:00.000Z' }],
};
const REFS = [
  { chapterId: 1, sentenceId: 1 },
  { chapterId: 3, sentenceId: 2 },
];
const entry = (kind: CastMergeEntry['kind'], sourceId: string, targetId: string): CastMergeEntry => ({
  ts: '2026-11-01T00:00:00.000Z',
  kind,
  sourceId,
  sourceName: sourceId,
  targetId,
  affected: REFS.map((r) => ({ ...r })),
});
const JOURNAL = {
  entries: [
    { ...entry('manual', 'garrow', 'saltgrave'), sourceName: 'Garrow' },
    entry('fold', 'x-fold', 'olga'),
    entry('dedup', 'x-dedup', 'w2'),
  ],
};
const SUGGESTION = {
  sourceId: 'new-wren',
  targetId: 'w2',
  a: 'new-wren',
  b: 'w2',
  reason: 'plan: could be the same person',
  origin: 'plan',
  newRow: 'new-wren',
  candidate: 'w2',
};

const ab = (b: HarnessBook, file: string): string => join(b.bookDir, '.audiobook', file);
const writeAb = (b: HarnessBook, file: string, v: unknown): void =>
  writeFileSync(ab(b, file), JSON.stringify(v));
const readAb = (b: HarnessBook, file: string): any => JSON.parse(readFileSync(ab(b, file), 'utf8'));

/** Seed a book that has everything a Start fresh used to wipe or strip. */
function seedDecisions(): HarnessBook {
  const b = mkBook(PRIOR);
  /* Plan 291: the run start now WRITES the stale-link prune to cast.json, so a link
     must be a valid reuse source (same author and series, an earlier position, same
     language) for "Start fresh keeps series links" to mean anything. */
  const author = 'Author';
  const seriesDir = dirname(b.bookDir);
  const series = basename(seriesDir);
  const siblingDir = join(seriesDir, 'Book One');
  mkdirSync(join(siblingDir, '.audiobook'), { recursive: true });
  siblingDirs.push(siblingDir);
  const siblingId = makeBookId(author, series, 'Book One');
  writeFileSync(
    join(siblingDir, '.audiobook', 'state.json'),
    JSON.stringify({
      ...readJson(b.bookDir, 'state.json'),
      bookId: siblingId,
      manuscriptId: 'sibling-' + b.manuscriptId,
      title: 'Book One',
      seriesPosition: 1,
    }),
  );
  writeFileSync(join(siblingDir, 'manuscript.md'), 'x');
  seededPrior = PRIOR.map((r) => (r.id === 'olga' ? { ...r, matchedFrom: { bookId: siblingId, characterId: 'olga-1' } } : r));
  writeAb(b, 'cast.json', { characters: seededPrior });
  writeAb(b, 'cast-id-history.json', HISTORY);
  writeAb(b, 'cast-merges.json', JOURNAL);
  writeAb(b, 'cast-merge-suggestions.json', { suggestions: [SUGGESTION] });
  return b;
}

/** `runMainAnalyzerJob` with `requestedFresh: true` (the harness `run` is not fresh). */
async function runFresh(
  b: HarnessBook,
  fresh = { roster, speakerId: FRESH_ID as string | string[] },
): Promise<Sent[]> {
  const { job, events } = mkJob(b.manuscriptId, b.bookDir, 'main');
  current = job;
  const rec = getManuscript(b.manuscriptId);
  if (!rec) throw new Error('manuscript missing');
  (globalThis as Record<string, unknown>)[PHASE1_GLOBAL] = sel(phase1(fresh.speakerId), 'phase1-model');
  await runMainAnalyzerJob(job, rec as never, sel(phase0(fresh.roster), 'phase0-model'), {
    requestedFresh: true,
    allowStage1Shrink: true,
    requestedModel: undefined,
  } as never);
  return events;
}

let current: AnalysisJob | undefined;
/** Phase-0 hook that stops the run the way a user Stop does, before anything is written. */
const abortInPhase0 = (): (() => Promise<void>) => async () => {
  current?.controller.abort();
  const e = new Error('aborted');
  e.name = 'AbortError';
  throw e;
};

describe('#4031 rule 8 - Start fresh keeps the user decisions', () => {
  const orig = process.env.STAGE2_COVERAGE_RETRIES;
  const books: HarnessBook[] = [];
  const seed = (): HarnessBook => {
    const b = seedDecisions();
    books.push(b);
    return b;
  };
  beforeEach(() => {
    process.env.STAGE2_COVERAGE_RETRIES = '0';
  });
  afterEach(async () => {
    resetHarness();
    setPhase0Hook(undefined);
    current = undefined;
    if (orig === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
    else process.env.STAGE2_COVERAGE_RETRIES = orig;
    for (const b of books.splice(0)) await cleanupBook(b);
    for (const d of siblingDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('rule 8: Start fresh keeps merges, declines, dismissals and series links', async () => {
    const b = seed();
    /* What a Start fresh still discards: a cached take, the per-sentence edits. */
    await saveAnalysisCache(b.manuscriptId, {
      chapters: { 99: [{ id: 9901, chapterId: 99, characterId: 'olga', confidence: 0.9, text: 'STALE-CACHED' }] },
    } as never);
    writeFileSync(manuscriptEditsJsonPath(b.bookDir), JSON.stringify({ sentences: [] }));
    setPhase0Hook(abortInPhase0());

    const events = await runFresh(b);

    expect(events.some((e) => e.kind === 'result')).toBe(false);
    /* cast.json untouched: every row, with its series link, voice and decline edges. */
    expect(existsSync(ab(b, 'cast.json'))).toBe(true);
    expect(readCast(b.bookDir)).toEqual(seededPrior);
    /* The merge history and the dismissal record. */
    expect(readAb(b, 'cast-id-history.json')).toEqual(HISTORY);
    /* The merge journal keeps every entry (the merges); only the sentence refs go. */
    const journal = readAb(b, 'cast-merges.json') as { entries: CastMergeEntry[] };
    expect(journal.entries.map((e) => [e.kind, e.sourceId, e.sourceName, e.targetId])).toEqual(
      JOURNAL.entries.map((e) => [e.kind, e.sourceId, e.sourceName, e.targetId]),
    );
    expect(journal.entries.map((e) => e.affected)).toEqual([[], [], []]);
    /* The open suggestion. */
    expect(readAb(b, 'cast-merge-suggestions.json').suggestions).toEqual([SUGGESTION]);
    /* Control: what Start fresh still does. */
    expect(readCache(b.manuscriptId)?.chapters?.[99]).toBeUndefined();
    expect(existsSync(manuscriptEditsJsonPath(b.bookDir))).toBe(false);
    const state = readJson(b.bookDir, 'state.json');
    expect(state.castConfirmed).toBe(false);
    expect(typeof state.editEpoch).toBe('string');
  });

  it('A12e: a dismissal (the record and both decline edges) survives a Start fresh', async () => {
    const b = seed();
    setPhase0Hook(abortInPhase0());

    await runFresh(b);

    expect(existsSync(ab(b, 'cast.json'))).toBe(true);
    const cast = readCast(b.bookDir);
    expect(cast.find((c) => c.id === 'olga')?.notLinkedTo).toEqual(['w2']);
    expect(cast.find((c) => c.id === 'w2')?.notLinkedTo).toEqual(['olga']);
    expect(readAb(b, 'cast-id-history.json').notSamePerson).toEqual(HISTORY.notSamePerson);
  });

  it("Q3: a stopped run's plan suggestion survives a Start fresh", async () => {
    const b = seed();
    setPhase0Hook(abortInPhase0());

    await runFresh(b);

    expect(existsSync(castMergeSuggestionsJsonPath(b.bookDir))).toBe(true);
    expect(readAb(b, 'cast-merge-suggestions.json').suggestions).toEqual([SUGGESTION]);
  });

  it('rule 8: a completed Start fresh keeps a prior row it merges against with its voice and declines', async () => {
    const b = seed();
    /* The fresh roster omits Olga: she comes back through the prior, and the old
       Start fresh handed the merge a prior with her voice and declines stripped. */
    const events = await runFresh(b);

    expect(events.some((e) => e.kind === 'result')).toBe(true);
    const olga = readCast(b.bookDir).find((c) => c.id === 'olga');
    expect(olga).toBeDefined();
    expect(olga?.voiceId).toBe('v-olga');
    expect(olga?.notLinkedTo).toContain('w2');
    /* The dismissal record is still there; the run joined Wren (w2) into wren-ashby
       and the retirement repointed the record's w2 side. */
    const records = readAb(b, 'cast-id-history.json').notSamePerson as Array<{ a: string; b: string }>;
    expect(records).toHaveLength(1);
    expect([records[0].a, records[0].b]).toContain('olga');
    /* ...and the surviving row carries the reverse edge. */
    const wren = readCast(b.bookDir).find((c) => c.id === 'wren-ashby');
    expect(wren?.notLinkedTo).toContain('olga');
  });

  it("Start fresh clears every journal entry's affected refs; unlink falls back to alias match", async () => {
    const b = seed();
    setPhase0Hook(abortInPhase0());
    await runFresh(b);
    expect(
      (readAb(b, 'cast-merges.json') as { entries: CastMergeEntry[] }).entries.every(
        (e) => e.affected.length === 0,
      ),
    ).toBe(true);

    /* The new run's Phase-0a roster and attribution: "Garrow" appears in chapter 2
       only. The old journal refs pointed at chapter 1; a kept ref would win. */
    await saveAnalysisCache(b.manuscriptId, {
      chapters: {},
      chapterCast: { 2: [{ id: 'garrow', name: 'Garrow', role: 'character', color: '#555555' }] },
    } as never);
    writeFileSync(
      manuscriptEditsJsonPath(b.bookDir),
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'saltgrave', confidence: 0.9, text: 'one' },
          { id: 1, chapterId: 2, characterId: 'saltgrave', confidence: 0.9, text: 'two' },
        ],
      }),
    );
    const app = express();
    app.use(express.json());
    app.use('/api/books', castAliasesRouter);

    const res = await request(app)
      .post(`/api/books/${b.bookId}/cast/unlink-alias`)
      .send({ sourceCharacterId: 'saltgrave', aliasName: 'Garrow' });

    expect(res.status).toBe(200);
    expect(res.body.impactedChapters).toEqual([{ chapterId: 2, candidateSentenceIds: [1] }]);
  });
});
