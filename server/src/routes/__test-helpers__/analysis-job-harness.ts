/* Plan 291 Task 9 (#4031) - the analysis-job route harness, ported from
   PR #4023's `analysis.keep-prior-id.test.ts` and `analysis.same-book-gate.test.ts`.
   It drives the real `runMainAnalyzerJob` / `runSubsetAnalyzerJob` and reads
   every on-disk surface back. Helpers only: no expectations live here.

   A test file that uses it declares four things itself, because `vi.mock` is
   per file and is hoisted above imports:

     1. an isolated workspace, BEFORE any import binds `BOOKS_ROOT`:
          vi.hoisted(() => { process.env.WORKSPACE_DIR = mkdtempSync(join(tmpdir(), 'x-')); });
        `mkBook` writes under `BOOKS_ROOT` (so the routes can resolve the book)
        and throws if that is not under the OS temp dir.
     2. `vi.mock('../workspace/state-io.js', ...)` as a passthrough with
        `readJson: vi.fn(actual.readJson)` - `blipRemapRead` re-implements it.
     3. `vi.mock('../store/cast-id-history.js', ...)` as a passthrough with
        `retireCharacterId: vi.fn(actual.retireCharacterId)` - `failNextRetirement`.
     4. `vi.mock('../analyzer/select-analyzer.js', ...)` that returns the Phase-1
        selection stored on `globalThis[PHASE1_GLOBAL]` for `phase: 'phase1'`
        and answers `isPerPhaseModelSelectionActive` from `globalThis[PIPELINED_GLOBAL]`.
        These are the same test-only globals #4023 used; analysis.ts needs no seam.

   Also mock `./ollama-health.js` and `../gpu/analyzer-device-state.js` as the
   sibling route tests do, and run with OLLAMA_URL=http://127.0.0.1:1. See
   `analysis.single-matcher.test.ts` for a complete example. */
import { vi } from 'vitest';
import { mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import {
  runMainAnalyzerJob,
  runSubsetAnalyzerJob,
  type AnalysisJob,
} from '../analysis.js';
import { castMergeRouter } from '../cast-merge.js';
import { castMergeSuggestionsRouter } from '../cast-merge-suggestions.js';
import { voiceOverrideLinkedRouter } from '../voice-override-linked.js';
import { bookStateRouter } from '../book-state.js';
import type { Analyzer, AnalyzerSelection } from '../../analyzer/index.js';
import type { CharacterOutput, Stage1ChapterOutput } from '../../handoff/schemas.js';
import {
  cachePath,
  clearAnalysisCache,
  saveAnalysisCache,
  type AnalysisCache,
} from '../../store/analysis-cache.js';
import { putManuscript, removeManuscript, getManuscript } from '../../store/manuscripts.js';
import * as historyStore from '../../store/cast-id-history.js';
import * as stateIo from '../../workspace/state-io.js';
import { BOOKS_ROOT, makeBookId, castMergeSuggestionsJsonPath } from '../../workspace/paths.js';
import type { StoredSuggestion } from '../../store/reanalysis-types.js';

/** Keys of the test-only globals the file's `select-analyzer` mock reads. */
export const PHASE1_GLOBAL = '__single_matcher_phase1';
export const PIPELINED_GLOBAL = '__single_matcher_pipelined';

export type Row = Record<string, unknown>;

export const BODY = '“Are you sure this will work,” Wren asked.\n\nOlga nodded and looked away.';
export const FRESH_ID = 'wren-ashby';
export const PRIOR_ID = 'w2';

export const NARR: CharacterOutput = {
  id: 'narrator',
  name: 'Narrator',
  role: 'narrator',
  color: 'narrator',
} as CharacterOutput;
export const WREN_FRESH = {
  id: FRESH_ID,
  name: 'Wren Ashby',
  role: 'lead',
  color: '#111111',
  gender: 'female',
  evidence: [{ quote: 'Wren asked' }],
} as CharacterOutput;
export const roster = [NARR, WREN_FRESH];
export const PRIOR_WREN: Row = { id: PRIOR_ID, name: 'Wren', voiceState: 'locked' };

/* ---- analyzers ------------------------------------------------------------ */

/* Runs inside the Phase-0 call for a chapter; a test may throw or wait in it to
   stop the job there. Set it with `setPhase0Hook` and clear it after. */
let phase0Hook: ((chapterId: number) => void | Promise<void>) | undefined;
export const setPhase0Hook = (h: typeof phase0Hook): void => {
  phase0Hook = h;
};

/* Runs inside the Phase-1 call for a chapter, before it attributes. */
let phase1Hook: ((chapterId: number) => void | Promise<void>) | undefined;
export const setPhase1Hook = (h: typeof phase1Hook): void => {
  phase1Hook = h;
};

/** The job `run` last started (an abort hook reaches the controller through it). */
let lastJob: AnalysisJob | undefined;
export const getLastJob = (): AnalysisJob | undefined => lastJob;

export function phase0(rosterRows: CharacterOutput[]): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    async runStage1Chapter(_m: string, chapterId: number): Promise<Stage1ChapterOutput> {
      await phase0Hook?.(chapterId);
      return { characters: rosterRows };
    },
    runStage2Chapter: () => Promise.reject(new Error('phase0')),
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.reject(new Error('not used')),
  };
}

export function phase1(speakerId: string | string[] | ((chapterId: number) => string)): Analyzer {
  const speakersFor = (chapterId: number): string[] =>
    typeof speakerId === 'function' ? [speakerId(chapterId)] : [speakerId].flat();
  const perChapter =
    typeof speakerId === 'function' || (Array.isArray(speakerId) && speakerId.length > 1) ? 3 : 1;
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () => Promise.reject(new Error('phase1')),
    /* One line per chapter for a single speaker; with several speakers, three
       lines per chapter handed out in turn, so each clears the minor-cast fold. */
    runStage2Chapter: (async (_m: string, chapterId: number) => {
      await phase1Hook?.(chapterId);
      const speakers = speakersFor(chapterId);
      return {
        sentences: Array.from({ length: perChapter }, (_, k) => ({
          id: chapterId * 100 + k + 1,
          chapterId,
          characterId: speakers[(k + (chapterId - 1) * perChapter) % speakers.length],
          confidence: 0.9,
          text: 'Are you sure this will work',
        })),
      };
    }) as unknown as Analyzer['runStage2Chapter'],
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.reject(new Error('no escalation')),
  };
}

export const sel = (analyzer: Analyzer, model: string): AnalyzerSelection => ({
  analyzer,
  engine: 'gemini',
  model,
  fallbackModel: null,
  fallbackEngine: null,
});

/** A Phase-1 hook that aborts the job on its first call (the way a user Stop
    does) and throws the AbortError the pipeline expects. The job comes from
    `getLastJob()`. */
export const abortAtFirstPhase1 = (): ((chapterId: number) => Promise<void>) => {
  const onCall = async (): Promise<void> => {
    getLastJob()?.controller.abort();
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  };
  return onCall;
};

/** Turn the per-phase model-selection flag on or off for the pipelined path. */
export const setPipelined = (on: boolean): void => {
  (globalThis as Record<string, unknown>)[PIPELINED_GLOBAL] = on;
};

/** Reset every module-level knob and global; call from `afterEach`. */
export function resetHarness(): void {
  const g = globalThis as Record<string, unknown>;
  delete g[PHASE1_GLOBAL];
  delete g[PIPELINED_GLOBAL];
  phase0Hook = undefined;
  phase1Hook = undefined;
  lastJob = undefined;
}

/* ---- books ---------------------------------------------------------------- */

export interface HarnessBook {
  bookId: string;
  manuscriptId: string;
  bookDir: string;
}

let bookSeq = 0;

/** Seed a confirmed book under `BOOKS_ROOT` (its own series, so a series-mate
    fan-out never reaches another test's book) with three chapters, the given
    cast.json rows, an optional cast-id-history, and a registered manuscript. */
export function mkBook(
  characters: Row[],
  supersededBy?: Record<string, string>,
  body: string = BODY,
): HarnessBook {
  const rel = relative(tmpdir(), BOOKS_ROOT);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `harness: BOOKS_ROOT (${BOOKS_ROOT}) is not under the OS temp dir - set WORKSPACE_DIR in vi.hoisted() before importing`,
    );
  }
  bookSeq += 1;
  const author = 'Author';
  const series = `Series ${bookSeq}`;
  const title = 'Book Two';
  const bookId = makeBookId(author, series, title);
  const manuscriptId = `t4031-${Date.now()}-${Math.random()}`;
  const bookDir = join(BOOKS_ROOT, author, series, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId,
      title,
      author,
      language: 'en',
      series,
      seriesPosition: 2,
      isStandalone: false,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapters: [
        { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
        { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
        { id: 3, title: 'Chapter Three', slug: '03-chapter-three' },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.md'), body);
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
  if (supersededBy) {
    writeFileSync(
      join(bookDir, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({ schema: 1, supersededBy }),
    );
  }
  const chapterHints = [
    { id: 1, title: 'Chapter One', body },
    { id: 2, title: 'Chapter Two', body },
    { id: 3, title: 'Chapter Three', body },
  ];
  putManuscript({
    manuscriptId,
    format: 'plaintext',
    title,
    wordCount: 100,
    byteSize: 1000,
    uploadedAt: new Date().toISOString(),
    sourceText: chapterHints.map((c) => c.body).join('\n\n'),
    chapterHints,
    bookId,
    bookDir,
  });
  return { bookId, manuscriptId, bookDir };
}

/** Forget a seeded book: manuscript, analysis cache and folder. */
export async function cleanupBook(book: HarnessBook): Promise<void> {
  removeManuscript(book.manuscriptId);
  await clearAnalysisCache(book.manuscriptId);
  rmSync(book.bookDir, { recursive: true, force: true });
}

/* ---- jobs ----------------------------------------------------------------- */

export type Sent = { kind: string; response?: { characters: Row[]; sentences: Row[] }; [k: string]: unknown };

export function mkJob(
  manuscriptId: string,
  bookDir: string,
  kind: 'main' | 'subset',
): { job: AnalysisJob; events: Sent[] } {
  const events: Sent[] = [];
  const job = {
    controller: new AbortController(),
    subscribers: new Set([
      { send: (e: Sent) => events.push(e), res: { end() {} }, keepAlive: undefined },
    ]),
    manuscriptId,
    kind,
    bookDir,
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
  return { job, events };
}

export interface RunOpts {
  /** Called with the job before it starts (attach `recordCastUpdateFrames` here). */
  onJob?: (job: AnalysisJob) => void;
  /** Subset only. Default true: pre-seed `cache.stage1` so the subset takes the
      book-already-analysed branch. False leaves the cache as the last run left it. */
  seedCache?: boolean;
}

export async function run(
  manuscriptId: string,
  bookDir: string,
  kind: 'main' | 'subset',
  fresh: { roster: CharacterOutput[]; speakerId: string | string[] } = { roster, speakerId: FRESH_ID },
  opts: RunOpts = {},
): Promise<Sent[]> {
  const { job, events } = mkJob(manuscriptId, bookDir, kind);
  lastJob = job;
  opts.onJob?.(job);
  const rec = getManuscript(manuscriptId);
  if (!rec) throw new Error('manuscript missing');
  const phase1Sel = sel(phase1(fresh.speakerId), 'phase1-model');
  if (kind === 'subset') {
    if (opts.seedCache !== false) {
      await saveAnalysisCache(manuscriptId, {
        chapters: {},
        stage1: {
          characters: fresh.roster,
          chapters: rec.chapterHints.map((c) => ({ id: c.id, title: c.title })),
        },
      } as never);
    }
    await runSubsetAnalyzerJob(
      job,
      rec as never,
      sel(phase0(fresh.roster), 'phase0-model'),
      phase1Sel,
      rec.chapterHints,
      true,
    );
    return events;
  }
  (globalThis as Record<string, unknown>)[PHASE1_GLOBAL] = phase1Sel;
  await runMainAnalyzerJob(job, rec as never, sel(phase0(fresh.roster), 'phase0-model'), {
    requestedFresh: false,
    allowStage1Shrink: true,
    requestedModel: undefined,
  } as never);
  return events;
}

/** Replay a subset run on the cache the previous run left behind (a
    `cast_incomplete` Retry): same as `run(..., 'subset')` without re-seeding. */
export function runSubsetRetry(
  book: HarnessBook,
  fresh?: { roster: CharacterOutput[]; speakerId: string | string[] },
  opts: Omit<RunOpts, 'seedCache'> = {},
): Promise<Sent[]> {
  return run(book.manuscriptId, book.bookDir, 'subset', fresh, { ...opts, seedCache: false });
}

/** Capture every SSE `cast-update` frame the job sends, deep-copied at send
    time so later mutation of the roster cannot rewrite history. Attach it
    before the run starts (`run(..., { onJob: (j) => { rec = recordCastUpdateFrames(j) } })`). */
export function recordCastUpdateFrames(job: AnalysisJob): { frames: Row[][] } {
  const rec: { frames: Row[][] } = { frames: [] };
  for (const sub of job.subscribers as unknown as Set<{ send: (e: Sent) => void }>) {
    const orig = sub.send;
    sub.send = (e: Sent) => {
      if (e.kind === 'cast-update') {
        rec.frames.push(JSON.parse(JSON.stringify((e as unknown as { characters: Row[] }).characters)));
      }
      orig(e);
    };
  }
  return rec;
}

/* ---- readers -------------------------------------------------------------- */

export const readJson = (bookDir: string, file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(bookDir, '.audiobook', file), 'utf8'));
export const readCast = (bookDir: string): Row[] => readJson(bookDir, 'cast.json').characters as Row[];
export const readEdits = (bookDir: string): Row[] =>
  readJson(bookDir, 'manuscript-edits.json').sentences as Row[];
export const readHistory = (bookDir: string): { supersededBy: Record<string, string> } =>
  readJson(bookDir, 'cast-id-history.json') as never;

/** `lines` of every cast.json row, by id (undefined when the row has none). */
export const linesById = (bookDir: string): Record<string, number | undefined> =>
  Object.fromEntries(readCast(bookDir).map((c) => [String(c.id), c.lines as number | undefined]));

/** The stored merge suggestions (`[]` when the file is absent). */
export function readSuggestions(bookDir: string): StoredSuggestion[] {
  const p = castMergeSuggestionsJsonPath(bookDir);
  if (!existsSync(p)) return [];
  return (JSON.parse(readFileSync(p, 'utf8')) as { suggestions?: StoredSuggestion[] }).suggestions ?? [];
}

/** The book's parsed analysis cache, or null when no cache file exists. */
export function readCache(manuscriptId: string): AnalysisCache | null {
  const p = cachePath(manuscriptId);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as AnalysisCache) : null;
}

/* ---- routes --------------------------------------------------------------- */

/** An express app with the routers the harness drives mounted at /api/books. */
export function mkApp(): Express {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/books', bookStateRouter);
  app.use('/api/books', castMergeRouter);
  app.use('/api/books', castMergeSuggestionsRouter);
  app.use('/api/books', voiceOverrideLinkedRouter);
  return app;
}

/** Whole-slice cast PUT (what the client's cast save sends). */
export const putCast = (app: Express, bookId: string, characters: Row[]) =>
  request(app)
    .put(`/api/books/${bookId}/state`)
    .set('Content-Type', 'application/json')
    .send({ slice: 'cast', patch: { characters } });

/** Assign a voice to `id` through the `voice-override-linked` route. */
export const routeVoice = (app: Express, bookId: string, id: string, name = `route-voice-${id}`) =>
  request(app)
    .post(`/api/books/${bookId}/cast/${id}/voice-override-linked`)
    .set('Content-Type', 'application/json')
    .send({ override: { engine: 'qwen', name } });

/** Install a one-shot hook that merges `sourceId` into `targetId` through the
    merge route the first time the run reaches `phase`. `done` resolves with the
    route's response once it has been answered (null if the phase never ran). */
export function mergeMidRun(
  app: Express,
  bookId: string,
  sourceId: string,
  targetId: string,
  phase: 'phase0' | 'phase1' = 'phase1',
): { done: Promise<request.Response | null> } {
  let resolve!: (r: request.Response | null) => void;
  const done = new Promise<request.Response | null>((r) => {
    resolve = r;
  });
  let fired = false;
  const hook = async (): Promise<void> => {
    if (fired) return;
    fired = true;
    resolve(
      await request(app)
        .post(`/api/books/${bookId}/cast/merge`)
        .set('Content-Type', 'application/json')
        .send({ sourceId, targetId }),
    );
  };
  if (phase === 'phase0') phase0Hook = hook;
  else phase1Hook = hook;
  return { done };
}

/* ---- fault injection ------------------------------------------------------ */

/** Make the next `retireCharacterId` call throw (a transient EBUSY on the
    history write). Needs the file's passthrough mock of
    `../store/cast-id-history.js`. `calls()` counts the failures delivered. */
export function failNextRetirement(): { calls: () => number } {
  if (!vi.isMockFunction(historyStore.retireCharacterId)) {
    throw new Error('harness: mock ../store/cast-id-history.js (retireCharacterId: vi.fn(actual.retireCharacterId))');
  }
  let calls = 0;
  vi.mocked(historyStore.retireCharacterId).mockImplementationOnce(async () => {
    calls += 1;
    throw new Error('EBUSY: resource busy or locked (simulated retirement write failure)');
  });
  return { calls: () => calls };
}

/** Make the first read of cast-id-history.json that a job function itself issues
    throw (a transient AV / cloud-sync EBUSY). Discriminated by stack: the frame
    after `readerFn` must be `runMainAnalyzerJob` / `runSubsetAnalyzerJob`, so the
    stores' and routes' own reads are untouched. #4023 named its reader
    `loadIdHistoryForRemap`; that function does not exist on this branch, so the
    default is the store reader the jobs call today. */
export const blipRemapRead = async (
  readerFn = 'loadCastIdHistoryWithStatus',
): Promise<{ count: () => number; restore: () => void }> => {
  if (!vi.isMockFunction(stateIo.readJson)) {
    throw new Error('harness: mock ../workspace/state-io.js (readJson: vi.fn(actual.readJson))');
  }
  const actualReadJson = (
    await vi.importActual<typeof import('../../workspace/state-io.js')>('../../workspace/state-io.js')
  ).readJson;
  let blips = 0;
  vi.mocked(stateIo.readJson).mockImplementation(async (path: string) => {
    if (path.endsWith('cast-id-history.json') && blips === 0) {
      const frames = (new Error().stack ?? '').split(String.fromCharCode(10)).map((l) => l.trim());
      const at = frames.findIndex((l) => l.includes(readerFn));
      const caller = at >= 0 ? (frames[at + 1] ?? '') : '';
      if (/(runMainAnalyzerJob|runSubsetAnalyzerJob)/.test(caller)) {
        blips += 1;
        throw new Error('EBUSY: resource busy or locked (simulated transient read blip)');
      }
    }
    return actualReadJson(path);
  });
  return {
    count: () => blips,
    restore: () => vi.mocked(stateIo.readJson).mockImplementation(actualReadJson),
  };
};
