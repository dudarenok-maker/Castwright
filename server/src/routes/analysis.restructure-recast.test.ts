/* #3506 — a merge or split on a book whose roster is final resets the regrouped
   chapters' `chapterCast` and puts them in the pending set P. Both analysis jobs
   must detect cast for them again, or every later per-chapter run ends
   `cast_incomplete`.

   Each case runs the real restructure route, then a real analyzer job against
   stub analyzers for BOTH phases (the harness of
   analysis.refuse-while-main.test.ts), so no run reaches a real model. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import type { Analyzer, AnalyzerSelection } from '../analyzer/index.js';
import type { CharacterOutput } from '../handoff/schemas.js';
import type { AnalysisJob } from './analysis.js';

type G = Record<string, unknown>;
const g = globalThis as G;

vi.mock('./ollama-health.js', () => ({
  detectOllamaDevice: vi.fn(async () => 'cuda'),
  unloadResidentOllama: vi.fn(async () => {}),
}));
vi.mock('../gpu/analyzer-device-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gpu/analyzer-device-state.js')>()),
  setLastKnownAnalyzerDevice: vi.fn(),
}));
vi.mock('../analyzer/select-analyzer.js', async () => {
  const actual = await vi.importActual<typeof import('../analyzer/select-analyzer.js')>(
    '../analyzer/select-analyzer.js',
  );
  return {
    ...actual,
    selectAnalyzerForPhase: (opts: { phase: 'phase0' | 'phase1' }) => {
      const sel = (globalThis as G)[opts.phase === 'phase1' ? '__rrc_phase1' : '__rrc_phase0'];
      if (!sel) throw new Error(`no stub analyzer for ${opts.phase}`);
      return sel;
    },
    isPerPhaseModelSelectionActive: () => false,
  };
});

const AUTHOR = 'Restructure Recast Author';
const SERIES = 'Standalones';
const MODEL = 'gemini-3.6-flash';
const TITLES = ['Chapter One', 'Chapter Two', 'Chapter Three'];
const LINES: string[][] = [
  ['"The plan is set." Silence followed.', 'Alpha closed the door.'],
  ['"The plan is set." Nobody moved.', 'Beta closed the door.'],
  ['"The plan is set." Nobody spoke.', 'Gamma closed the door.'],
];

let workspaceRoot: string;
let app: Express;
const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
const seeded: string[] = [];

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-restructure-recast-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.STAGE2_COVERAGE_RETRIES = '0';
  await import('./analysis.js');
  const { chaptersRestructureRouter } = await import('./chapters-restructure.js');
  app = express();
  app.use(express.json());
  app.use('/api/books', chaptersRestructureRouter);
}, 120_000);

afterEach(async () => {
  for (const k of Object.keys(g)) if (k.startsWith('__rrc_')) delete g[k];
  const { clearAnalysisCache } = await import('../store/analysis-cache.js');
  const { removeManuscript } = await import('../store/manuscripts.js');
  for (const id of seeded.splice(0)) {
    removeManuscript(id);
    await clearAnalysisCache(id);
  }
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
  else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
});

const character = (id: string, name: string): CharacterOutput => ({
  id,
  name,
  role: 'character',
  color: '#abc',
  evidence: [{ quote: 'The plan is set.' }],
});

interface Book {
  bookId: string;
  manuscriptId: string;
  bookDir: string;
}

/* A three-chapter book past Confirm: stage1, a cast and a take for every chapter. */
async function seedFinalRosterBook(label: string): Promise<Book> {
  const manuscriptId = `test-rrc-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const title = `Restructure Recast ${label}`;
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  const { makeBookId } = await import('../workspace/paths.js');
  const bookId = makeBookId(AUTHOR, SERIES, title);
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId,
      title,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      language: 'en',
      chapters: TITLES.map((t, i) => ({
        id: i + 1,
        title: t,
        slug: `0${i + 1}-${t.toLowerCase().replace(' ', '-')}`,
      })),
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(
    join(bookDir, 'manuscript.md'),
    TITLES.map((t, i) => `# ${t}\n\n${LINES[i].join('\n')}\n`).join('\n'),
  );
  const takes = LINES.map((lines, i) =>
    lines.map((text, n) => ({ id: n + 1, chapterId: i + 1, characterId: 'nova', text })),
  );
  writeFileSync(
    join(bookDir, '.audiobook', 'manuscript-edits.json'),
    JSON.stringify({ sentences: takes.flat() }),
  );
  const { saveAnalysisCache } = await import('../store/analysis-cache.js');
  await saveAnalysisCache(manuscriptId, {
    version: 2,
    confirmReached: true,
    stage1: {
      characters: [character('nova', 'Nova')],
      chapters: TITLES.map((t, i) => ({ id: i + 1, title: t })),
    },
    chapterCast: Object.fromEntries(TITLES.map((_, i) => [i + 1, [character('nova', 'Nova')]])),
    chapters: Object.fromEntries(takes.map((take, i) => [i + 1, take])),
  } as never);
  seeded.push(manuscriptId);
  return { bookId, manuscriptId, bookDir };
}

async function merge(book: Book, chapterIds: number[]): Promise<void> {
  const res = await request(app).post(`/api/books/${book.bookId}/chapters/merge`).send({ chapterIds });
  expect(res.status).toBe(200);
}

async function split(book: Book, chapterId: number): Promise<void> {
  const res = await request(app)
    .post(`/api/books/${book.bookId}/chapters/split`)
    .send({ chapterId, afterSentenceId: 1 });
  expect(res.status).toBe(200);
}

interface CapturedEvent {
  kind: string;
  code?: string;
  message?: string;
  [k: string]: unknown;
}

interface RunOpts {
  /** Chapter ids whose cast detection throws. */
  failCast?: number[];
}

async function runJob(book: Book, kind: 'main' | 'subset', subsetIds: number[], opts: RunOpts = {}) {
  const { runMainAnalyzerJob, runSubsetAnalyzerJob } = await import('./analysis.js');
  const { getOrHydrateManuscript } = await import('../store/manuscripts.js');
  const { loadAnalysisCache } = await import('../store/analysis-cache.js');
  const record = (await getOrHydrateManuscript(book.manuscriptId))!;
  /* Both phases, in call order. */
  const calls: string[] = [];
  const analyzer: Analyzer = {
    runStage1: () => Promise.reject(new Error('not used')),
    async runStage1Chapter(_m, chapterId) {
      calls.push(`phase0:${chapterId}`);
      if (opts.failCast?.includes(chapterId)) throw new Error(`cast detection fails for ${chapterId}`);
      return { characters: [character('nova', 'Nova')] };
    },
    async runStage2Chapter(_m, chapterId) {
      calls.push(`phase1:${chapterId}`);
      const body = record.chapterHints.find((h) => h.id === chapterId)!.body;
      return {
        sentences: [{ id: 1, chapterId, characterId: 'nova', confidence: 0.9, text: body }],
      };
    },
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.resolve(null),
  };
  const selection: AnalyzerSelection = {
    analyzer,
    engine: 'gemini',
    model: MODEL,
    fallbackModel: null,
    fallbackEngine: null,
  };
  g.__rrc_phase0 = selection;
  g.__rrc_phase1 = selection;

  const events: CapturedEvent[] = [];
  const keepAlive = setInterval(() => {}, 100_000);
  clearInterval(keepAlive);
  const job = {
    controller: new AbortController(),
    subscribers: new Set(),
    manuscriptId: book.manuscriptId,
    kind,
    bookDir: book.bookDir,
    engine: 'gemini',
    replay: {
      logs: [],
      lastPhase: null,
      lastEta: null,
      lastCastUpdate: null,
      failedByChapterId: new Map(),
      lastSeriesPrior: null,
      warnings: new Map(),
    },
    lastDiskWriteAt: 0,
  } as unknown as AnalysisJob;
  job.subscribers.add({
    send: (payload: unknown) => events.push(payload as CapturedEvent),
    res: { end: () => {} } as unknown as import('express').Response,
    keepAlive,
  });

  if (kind === 'main') {
    await runMainAnalyzerJob(job, record, selection, {
      requestedFresh: false,
      allowStage1Shrink: true,
      requestedModel: undefined,
    });
  } else {
    const toRun = record.chapterHints.filter((h) => subsetIds.includes(h.id));
    await runSubsetAnalyzerJob(job, record, selection, selection, toRun, false);
  }
  const terminal = events.filter((e) => e.kind === 'result' || e.kind === 'error');
  return {
    calls,
    terminal: terminal.map((e) => (e.kind === 'error' ? `error:${e.code}` : e.kind)),
    errorMessage: terminal.find((e) => e.kind === 'error')?.message,
    events,
    after: await loadAnalysisCache(book.manuscriptId),
  };
}

const castKeys = (cache: { chapterCast?: Record<number, unknown> }) =>
  Object.keys(cache.chapterCast ?? {}).sort();

describe('#3506 — analysis detects cast again for merged and split chapters', () => {
  it('after a merge, a subset run on an unrelated chapter refills the merged cast and ends result', async () => {
    const book = await seedFinalRosterBook('merge-subset');
    await merge(book, [1, 2]);

    const r = await runJob(book, 'subset', [2]);

    expect(r.terminal).toEqual(['result']);
    /* The merged chapter gets cast detection only; its attribution stays pending. */
    expect(r.calls).toEqual(['phase0:1', 'phase0:2', 'phase1:2']);
    expect(castKeys(r.after)).toEqual(['1', '2']);
    expect(r.after.pendingAttributionChapterIds).toEqual([1]);
  }, 60_000);

  it('after a split, a subset run on an unrelated chapter refills both halves and ends result', async () => {
    const book = await seedFinalRosterBook('split-subset');
    await split(book, 1);

    const r = await runJob(book, 'subset', [3]);

    expect(r.terminal).toEqual(['result']);
    expect(r.calls).toEqual(['phase0:1', 'phase0:2', 'phase0:3', 'phase1:3']);
    expect(castKeys(r.after)).toEqual(['1', '2', '3', '4']);
    expect(r.after.pendingAttributionChapterIds).toEqual([1, 2]);
  }, 60_000);

  it('a subset run on the merged chapter itself detects its cast once', async () => {
    const book = await seedFinalRosterBook('merge-self');
    await merge(book, [1, 2]);

    const r = await runJob(book, 'subset', [1]);

    expect(r.terminal).toEqual(['result']);
    expect(r.calls).toEqual(['phase0:1', 'phase1:1']);
    expect(r.after.pendingAttributionChapterIds).toEqual([]);
  }, 60_000);

  it('after a merge, a non-fresh main run refills the cast before attributing; a later subset run ends result', async () => {
    const book = await seedFinalRosterBook('merge-main');
    await merge(book, [1, 2]);
    const { loadAnalysisCache } = await import('../store/analysis-cache.js');
    const stage1Before = (await loadAnalysisCache(book.manuscriptId)).stage1;

    const main = await runJob(book, 'main', []);

    expect(main.terminal).toEqual(['result']);
    expect(main.calls).toEqual(['phase0:1', 'phase1:1']);
    expect(castKeys(main.after)).toEqual(['1', '2']);
    expect(main.after.pendingAttributionChapterIds).toEqual([]);
    expect(main.after.stage1?.characters.map((c) => c.id)).toEqual(
      stage1Before?.characters.map((c) => c.id),
    );

    const subset = await runJob(book, 'subset', [2]);
    expect(subset.terminal).toEqual(['result']);
    expect(subset.calls).toEqual(['phase0:2', 'phase1:2']);
  }, 60_000);

  it('a failed refill in a main run attributes nothing and keeps the chapter pending; the next main run retries it', async () => {
    const book = await seedFinalRosterBook('main-fail');
    await merge(book, [1, 2]);

    const failed = await runJob(book, 'main', [], { failCast: [1] });

    expect(failed.terminal).toEqual(['error:cast_incomplete']);
    expect(failed.errorMessage).toContain('Chapter One');
    expect(failed.calls.filter((c) => c.startsWith('phase1'))).toEqual([]);
    expect(failed.after.pendingAttributionChapterIds).toEqual([1]);
    expect(failed.after.failedChapterIds).toEqual([1]);
    expect(failed.after.failedChapterErrors?.['1']?.phase).toBe('cast');
    expect(failed.after.stage1).toBeDefined();

    const retried = await runJob(book, 'main', []);

    expect(retried.terminal).toEqual(['result']);
    expect(retried.calls).toEqual(['phase0:1', 'phase1:1']);
    expect(retried.after.failedChapterIds).toEqual([]);
    expect(retried.after.pendingAttributionChapterIds).toEqual([]);
  }, 60_000);

  it('a failed refill in a subset run names the chapter and keeps it pending; re-analysing it recovers', async () => {
    const book = await seedFinalRosterBook('subset-fail');
    await merge(book, [1, 2]);

    const failed = await runJob(book, 'subset', [2], { failCast: [1] });

    expect(failed.terminal).toEqual(['error:cast_incomplete']);
    expect(failed.errorMessage).toContain('Chapter One');
    expect(failed.calls.filter((c) => c.startsWith('phase1'))).toEqual([]);
    expect(failed.after.pendingAttributionChapterIds).toEqual([1]);
    expect(failed.after.failedChapterErrors?.['1']?.phase).toBe('cast');

    /* Another per-chapter run leaves the failed chapter to its Retry. */
    const other = await runJob(book, 'subset', [2]);
    expect(other.terminal).toEqual(['error:cast_incomplete']);
    expect(other.errorMessage).toContain('Chapter One');
    expect(other.calls).toEqual(['phase0:2']);

    const retried = await runJob(book, 'subset', [1]);

    expect(retried.terminal).toEqual(['result']);
    expect(retried.calls).toEqual(['phase0:1', 'phase1:1']);
    expect(retried.after.failedChapterIds).toEqual([]);
    expect(retried.after.pendingAttributionChapterIds).toEqual([]);
  }, 60_000);
});

describe('pendingChapterIdsNeedingCast', () => {
  const hints = [{ id: 1 }, { id: 2, excluded: true }, { id: 3 }, { id: 4 }, { id: 5 }];
  const cache = {
    chapterCast: { 3: [], 4: [] },
    pendingAttributionChapterIds: [1, 2, 3, 4],
  };

  it('picks the non-excluded pending chapters with no cast entry', async () => {
    const { pendingChapterIdsNeedingCast } = await import('./analysis.js');
    /* 2 is excluded, 3 and 4 have an entry (`[]` is a legal cast), 5 is not pending. */
    expect([...pendingChapterIdsNeedingCast(cache, hints)]).toEqual([1]);
  });

  it('also picks a pending chapter named as a cast failure', async () => {
    const { pendingChapterIdsNeedingCast } = await import('./analysis.js');
    expect([...pendingChapterIdsNeedingCast(cache, hints, [3, 5])]).toEqual([1, 3]);
  });
});
