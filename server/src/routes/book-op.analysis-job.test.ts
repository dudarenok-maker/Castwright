/* #3711 task 4 -- an analysis run is a registered `analysis` job (main and subset):
     - while it runs, a folder rename and a DELETE are refused with 409 `book_busy`;
     - its registration is released on every exit path (completion, a selection error
       before the job starts) and a start for a deleted book registers nothing -- the
       client gets an SSE `book_not_found` frame;
     - `job.bookDir` comes from the lease, i.e. the book's CURRENT folder (a registration
       queued behind a rename starts on the new folder);
     - the lease is released only when the run's tracked units have ACTUALLY settled: a
       main run past its drain deadline still holds the book until `liveWork` drains.

   The route cases go through supertest with stub analyzers (the analysis.refuse-while-main
   harness); the drain case drives the exported lifecycle (`endJob` / `takeWork` /
   `releaseWork`) under the real `runBookJob` and the real rename route. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import type { Analyzer, AnalyzerSelection } from '../analyzer/index.js';
import type { CharacterOutput, Stage1ChapterOutput, Stage2ChapterOutput } from '../handoff/schemas.js';
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
/* `__baj_clone_records`: hand out DETACHED copies, so a route's pre-queue `record` snapshot is
   not silently kept current by an in-place `rec.bookDir = newDir` from the rename (the lease
   is then the only source of the new folder). */
vi.mock('../store/manuscripts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/manuscripts.js')>();
  return {
    ...actual,
    getManuscript: (id: string) => {
      const r = actual.getManuscript(id);
      return r && (globalThis as G).__baj_clone_records ? structuredClone(r) : r;
    },
  };
});
/* `__baj_outcome_gate` / `__baj_halted_gate` / `__baj_paused_gate`: park endJob's
   detached terminal writes (the last-outcome file, the halted / paused snapshot) AFTER
   their identity check, so a test can observe the lease while they are still pending. */
vi.mock('../store/analysis-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/analysis-state.js')>();
  return {
    ...actual,
    writeAnalysisLastOutcome: async (...args: Parameters<typeof actual.writeAnalysisLastOutcome>) => {
      const gate = (globalThis as G).__baj_outcome_gate as Promise<void> | undefined;
      if (gate) await gate;
      return actual.writeAnalysisLastOutcome(...args);
    },
    writeAnalysisState: async (...args: Parameters<typeof actual.writeAnalysisState>) => {
      const gate = (globalThis as G).__baj_halted_gate as Promise<void> | undefined;
      if (gate && args[1].state === 'halted') await gate;
      const pausedGate = (globalThis as G).__baj_paused_gate as Promise<void> | undefined;
      if (pausedGate && args[1].state === 'paused') {
        (globalThis as G).__baj_paused_parked = true;
        await pausedGate;
      }
      return actual.writeAnalysisState(...args);
    },
  };
});
vi.mock('../analyzer/select-analyzer.js', async () => {
  const actual = await vi.importActual<typeof import('../analyzer/select-analyzer.js')>(
    '../analyzer/select-analyzer.js',
  );
  return {
    ...actual,
    selectAnalyzerForPhase: (opts: { phase: 'phase0' | 'phase1' }) => {
      if ((globalThis as G).__baj_select_throws) throw new Error('no analyzer is configured for this test');
      const sel = (globalThis as G)[opts.phase === 'phase1' ? '__baj_phase1_selection' : '__baj_phase0_selection'];
      return sel ?? actual.selectAnalyzerForPhase(opts as Parameters<typeof actual.selectAnalyzerForPhase>[0]);
    },
    isPerPhaseModelSelectionActive: () => false,
  };
});

const AUTHOR = 'Analysis Job Author';
const SERIES = 'The Series';
const BODIES: Record<number, string> = { 1: '"The plan is set." Silence followed.' };

let workspaceRoot: string;
let app: Express;
let makeBookId: typeof import('../workspace/paths.js').makeBookId;
let bookJobKinds: typeof import('../workspace/book-op-lock.js').bookJobKinds;
let runBookJob: typeof import('../workspace/book-jobs.js').runBookJob;
let BOOK_GONE: typeof import('../workspace/book-op-lock.js').BOOK_GONE;
let analysisModule: typeof import('./analysis.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-analysis-job-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.STAGE2_COVERAGE_RETRIES = '0';
  analysisModule = await import('./analysis.js');
  const { bookStateRouter } = await import('./book-state.js');
  makeBookId = (await import('../workspace/paths.js')).makeBookId;
  const opLock = await import('../workspace/book-op-lock.js');
  bookJobKinds = opLock.bookJobKinds;
  BOOK_GONE = opLock.BOOK_GONE;
  runBookJob = (await import('../workspace/book-jobs.js')).runBookJob;
  app = express();
  app.use(express.json());
  app.use('/api/manuscripts', analysisModule.analysisRouter);
  app.use('/api/books', bookStateRouter);
}, 120_000);

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.STAGE2_COVERAGE_RETRIES;
});

afterEach(() => {
  for (const k of Object.keys(g)) if (k.startsWith('__baj_')) delete g[k];
  vi.useRealTimers();
});

function novaCharacter(): CharacterOutput {
  return { id: 'nova', name: 'Nova', role: 'character', color: '#abc', evidence: [{ quote: 'The plan is set.' }] };
}
function stubAnalyzer(over: Partial<Analyzer>): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    async runStage1Chapter(): Promise<Stage1ChapterOutput> {
      return { characters: [novaCharacter()] };
    },
    async runStage2Chapter(_m: string, chapterId: number): Promise<Stage2ChapterOutput> {
      return {
        sentences: [{ id: chapterId * 100 + 1, chapterId, characterId: 'nova', confidence: 0.9, text: BODIES[chapterId] }],
      };
    },
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.resolve(null),
    ...over,
  };
}
const selectionFor = (analyzer: Analyzer): AnalyzerSelection => ({
  analyzer,
  engine: 'gemini',
  model: 'gemini-3.6-flash',
  fallbackModel: null,
  fallbackEngine: null,
});

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

interface Seeded {
  manuscriptId: string;
  bookId: string;
  bookDir: string;
  newTitle: string;
  newDir: string;
}

/** A real book on disk plus its in-memory manuscript record (carrying bookId/bookDir). */
async function seedBook(label: string, opts: { onDisk?: boolean } = {}): Promise<Seeded> {
  const manuscriptId = `test-baj-${label}-${Date.now()}-${Math.random()}`;
  const title = `Analysis Job ${label}`;
  const newTitle = `${title} Renamed`;
  const bookId = makeBookId(AUTHOR, SERIES, title);
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
  rmSync(bookDir, { recursive: true, force: true });
  if (opts.onDisk !== false) {
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId,
        manuscriptId,
        title,
        author: AUTHOR,
        series: SERIES,
        seriesPosition: 1,
        isStandalone: false,
        manuscriptFile: 'manuscript.md',
        castConfirmed: false,
        language: 'en',
        chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(join(bookDir, 'manuscript.md'), `# Chapter One\n\n${BODIES[1]}\n`);
  }
  const { putManuscript } = await import('../store/manuscripts.js');
  putManuscript({
    manuscriptId,
    format: 'plaintext',
    title,
    wordCount: 12,
    byteSize: 100,
    uploadedAt: new Date().toISOString(),
    sourceText: BODIES[1],
    chapterHints: [{ id: 1, title: 'Chapter One', body: BODIES[1] }],
    bookId,
    bookDir,
  });
  return { manuscriptId, bookId, bookDir, newTitle, newDir: join(workspaceRoot, 'books', AUTHOR, SERIES, newTitle) };
}

const renameOf = (s: Seeded) =>
  request(app)
    .put(`/api/books/${s.bookId}/state`)
    .set('Content-Type', 'application/json')
    .send({ slice: 'state', patch: { title: s.newTitle } });

function sseFrames(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));
}

describe('POST /:id/analysis is a registered analysis job (#3711)', () => {
  it('refuses rename and DELETE with 409 while the run is in flight, then allows them', async () => {
    const s = await seedBook('running');
    const entered = gate();
    const release = gate();
    g.__baj_phase0_selection = selectionFor(
      stubAnalyzer({
        runStage1Chapter: async () => {
          entered.open();
          await release.promise;
          return { characters: [novaCharacter()] };
        },
      }),
    );
    g.__baj_phase1_selection = selectionFor(stubAnalyzer({}));
    const run = request(app)
      .post(`/api/manuscripts/${s.manuscriptId}/analysis`)
      .send({})
      .then((r) => r);
    await entered.promise;
    expect(bookJobKinds(s.bookId)).toEqual(['analysis']);

    const rename = await renameOf(s);
    expect(rename.status).toBe(409);
    expect(rename.body.code).toBe('book_busy');
    expect(rename.body.error).toMatch(/analysis is running/i);
    const del = await request(app).delete(`/api/books/${s.bookId}`);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('book_busy');
    expect(existsSync(s.bookDir)).toBe(true);
    expect(existsSync(s.newDir)).toBe(false);

    release.open();
    const res = await run;
    expect(sseFrames(res.text).some((f) => f.kind === 'result')).toBe(true);
    await vi.waitFor(() => expect(bookJobKinds(s.bookId)).toEqual([]));
    expect((await renameOf(s)).status).toBe(200);
    expect(existsSync(s.newDir)).toBe(true);
  });

  it('releases the registration when the analyzer selection fails before the job starts', async () => {
    const s = await seedBook('select-throws');
    g.__baj_select_throws = true;
    const res = await request(app).post(`/api/manuscripts/${s.manuscriptId}/analysis`).send({});
    expect(sseFrames(res.text).some((f) => f.kind === 'error')).toBe(true);
    expect(bookJobKinds(s.bookId)).toEqual([]);
    expect(analysisModule.isAnalysisJobRunning(s.manuscriptId)).toBe(false);
    expect((await renameOf(s)).status).toBe(200);
  });

  it('a start after the book was deleted answers an SSE book_not_found frame and registers nothing', async () => {
    const s = await seedBook('deleted', { onDisk: false });
    const res = await request(app).post(`/api/manuscripts/${s.manuscriptId}/analysis`).send({});
    expect(sseFrames(res.text).find((f) => f.kind === 'error')).toMatchObject({
      code: 'book_not_found',
      message: 'Book not found.',
    });
    expect(bookJobKinds(s.bookId)).toEqual([]);
    expect(analysisModule.isAnalysisJobRunning(s.manuscriptId)).toBe(false);
  });

  it('a subset start after the book was deleted answers the same frame and registers nothing', async () => {
    const s = await seedBook('subset-deleted', { onDisk: false });
    const res = await request(app).post(`/api/manuscripts/${s.manuscriptId}/analysis/chapters`).send({ chapterIds: [1] });
    expect(sseFrames(res.text).find((f) => f.kind === 'error')).toMatchObject({ code: 'book_not_found' });
    expect(bookJobKinds(s.bookId)).toEqual([]);
  });

  it("a registration queued behind a rename starts on the NEW folder (the job's bookDir comes from the lease)", async () => {
    const s = await seedBook('lease-dir');
    const paths = await import('../workspace/paths.js');
    const fileLock = await import('../workspace/file-lock.js');
    /* Park the rename inside book-op via the book's state-json lock, then queue an
       analysis registration on book-op behind it. */
    const open = gate();
    const held = gate();
    void fileLock.withStateJsonLock(paths.stateJsonPath(s.bookDir), async () => {
      held.open();
      await open.promise;
    });
    await held.promise;
    const renameP = Promise.resolve(renameOf(s) as unknown as PromiseLike<request.Response>);
    while (fileLock.__keyWaitersForTest(`state-json:${paths.stateJsonPath(s.bookDir)}`) < 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    let leaseDir = '';
    const registeredP = runBookJob(s.bookId, 'analysis', async (lease) => {
      leaseDir = lease.bookDir;
    });
    while (fileLock.__keyWaitersForTest(`book-op:${s.bookId}`) < 1) await new Promise((r) => setTimeout(r, 5));
    open.open();
    const [renameRes, registered] = await Promise.all([renameP, registeredP]);
    expect(renameRes.status).toBe(200);
    if (registered === BOOK_GONE) throw new Error('book vanished');
    await registered.done;
    expect(leaseDir).toBe(s.newDir);
  });
});

describe('the analysis lease is released only when the tracked units settle (#3711)', () => {
  it('a main run past its drain deadline still holds the book until liveWork drains', async () => {
    const s = await seedBook('drain');
    const { endJob, takeWork, releaseWork, MAIN_DRAIN_DEADLINE_MS, __testRegisterJobForTest } = analysisModule;
    const job = {
      controller: new AbortController(),
      subscribers: new Set(),
      manuscriptId: s.manuscriptId,
      kind: 'main',
      bookDir: s.bookDir,
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
    job.settled = new Promise<void>((resolve) => {
      job.resolveSettled = resolve;
    });
    __testRegisterJobForTest(job);

    /* The route's registration: its fn awaits the job's `settled`, as startMain does. */
    const registered = await runBookJob(s.bookId, 'analysis', async () => {
      await job.settled;
    });
    if (registered === BOOK_GONE) throw new Error('book vanished');
    let leaseReleased = false;
    void registered.done.then(() => {
      leaseReleased = true;
    });

    takeWork(job); // a tracked unit that has not yet observed the abort
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    endJob(job); // armed: the drain-deadline timer
    expect(job.ended).toBe(true);
    vi.advanceTimersByTime(MAIN_DRAIN_DEADLINE_MS + 1);
    vi.useRealTimers();
    expect(job.left).toBe(true); // the deadline fired: busy flag and pin released ...

    /* ... but the book is still held, because a unit is still running. */
    await Promise.resolve();
    expect(leaseReleased).toBe(false);
    expect(bookJobKinds(s.bookId)).toEqual(['analysis']);
    const refused = await renameOf(s);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('book_busy');
    expect(existsSync(s.newDir)).toBe(false);

    releaseWork(job); // the last unit settles
    await registered.done;
    expect(leaseReleased).toBe(true);
    expect(bookJobKinds(s.bookId)).toEqual([]);
    expect((await renameOf(s)).status).toBe(200);
    expect(existsSync(s.newDir)).toBe(true);
  });
});

describe("the analysis lease covers endJob's detached terminal writes (#3714 review pass 1)", () => {
  it('a failed run holds the book until its last-outcome file and halted snapshot have landed', async () => {
    const s = await seedBook('terminal-writes');
    const outcome = gate();
    const halted = gate();
    const entered = gate();
    g.__baj_outcome_gate = outcome.promise;
    g.__baj_halted_gate = halted.promise;
    g.__baj_phase0_selection = selectionFor(
      stubAnalyzer({
        runStage1Chapter: async () => {
          entered.open();
          throw new Error('phase 0 failed for this test');
        },
      }),
    );
    g.__baj_phase1_selection = selectionFor(stubAnalyzer({}));
    const run = request(app)
      .post(`/api/manuscripts/${s.manuscriptId}/analysis`)
      .send({})
      .then((r) => r);
    await entered.promise;
    await vi.waitFor(() => expect(analysisModule.isAnalysisJobRunning(s.manuscriptId)).toBe(false));
    /* Both writes are parked past their identity check: the book is still held. */
    expect(bookJobKinds(s.bookId)).toEqual(['analysis']);
    let refused = await renameOf(s);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('book_busy');

    outcome.open();
    await run;
    /* The outcome landed, the halted snapshot has not: still held. */
    await vi.waitFor(() =>
      expect(existsSync(join(s.bookDir, '.audiobook', 'analysis-last-outcome.json'))).toBe(true),
    );
    expect(bookJobKinds(s.bookId)).toEqual(['analysis']);
    refused = await renameOf(s);
    expect(refused.status).toBe(409);

    halted.open();
    await vi.waitFor(() => expect(bookJobKinds(s.bookId)).toEqual([]));
    expect((await renameOf(s)).status).toBe(200);
    /* Both files moved with the book; the old folder was not recreated. */
    expect(existsSync(s.bookDir)).toBe(false);
    expect(existsSync(join(s.newDir, '.audiobook', 'analysis-last-outcome.json'))).toBe(true);
    expect(existsSync(join(s.newDir, '.audiobook', 'analysis-state.json'))).toBe(true);
  });

  it('a second endJob call does not shed the first call\'s writes, and its own writes hold the lease', async () => {
    const s = await seedBook('end-twice');
    const { endJob, __testRegisterJobForTest } = analysisModule;
    const job = {
      controller: new AbortController(),
      subscribers: new Set(),
      manuscriptId: s.manuscriptId,
      kind: 'main',
      bookDir: s.bookDir,
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
    job.settled = new Promise<void>((resolve) => {
      job.resolveSettled = resolve;
    });
    __testRegisterJobForTest(job);
    const registered = await runBookJob(s.bookId, 'analysis', async () => {
      await job.settled;
    });
    if (registered === BOOK_GONE) throw new Error('book vanished');

    const halted = gate();
    g.__baj_halted_gate = halted.promise;
    endJob(job); // clean teardown: only a fast snapshot delete
    endJob(job, { kind: 'error', code: 'boom', message: 'second ending' }); // gated halted snapshot
    /* Let the first call's fast write land: pre-fix, `settled` resolves here. */
    await new Promise((r) => setTimeout(r, 50));
    expect(bookJobKinds(s.bookId)).toEqual(['analysis']);
    expect((await renameOf(s)).status).toBe(409);

    halted.open();
    await registered.done;
    expect(bookJobKinds(s.bookId)).toEqual([]);
    expect(existsSync(join(s.bookDir, '.audiobook', 'analysis-state.json'))).toBe(true);
    expect((await renameOf(s)).status).toBe(200);
    expect(existsSync(s.bookDir)).toBe(false);
  });

  it("two endJob calls while a tracked unit runs: the second call's landing does not shed the first's pending write", async () => {
    /* PR #3714 review pass 2 -- pins the APPEND (not just the re-check loop): both
       calls happen while `liveWork > 0`, so settlement is decided only afterwards,
       from whatever `job.terminalWrites` holds by then. */
    const s = await seedBook('end-twice-live');
    const { endJob, takeWork, releaseWork, __testRegisterJobForTest } = analysisModule;
    const job = {
      controller: new AbortController(),
      subscribers: new Set(),
      manuscriptId: s.manuscriptId,
      kind: 'main',
      bookDir: s.bookDir,
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
    job.settled = new Promise<void>((resolve) => {
      job.resolveSettled = resolve;
    });
    __testRegisterJobForTest(job);
    const registered = await runBookJob(s.bookId, 'analysis', async () => {
      await job.settled;
    });
    if (registered === BOOK_GONE) throw new Error('book vanished');

    const paused = gate();
    const halted = gate();
    g.__baj_paused_gate = paused.promise;
    g.__baj_halted_gate = halted.promise;
    takeWork(job); // a tracked unit still running: neither endJob settles the job
    endJob(job, { kind: 'error', code: 'aborted', message: 'first ending' }); // gated paused snapshot
    endJob(job, { kind: 'error', code: 'boom', message: 'second ending' }); // gated halted snapshot

    /* Only the SECOND call's write lands... */
    halted.open();
    await vi.waitFor(() =>
      expect(
        JSON.parse(readFileSync(join(s.bookDir, '.audiobook', 'analysis-state.json'), 'utf8')).state,
      ).toBe('halted'),
    );
    /* ...and the last unit settles. The first call's paused write is still parked. */
    releaseWork(job);
    await new Promise((r) => setTimeout(r, 50));
    expect(bookJobKinds(s.bookId)).toEqual(['analysis']);
    expect((await renameOf(s)).status).toBe(409);

    paused.open();
    await registered.done;
    expect(bookJobKinds(s.bookId)).toEqual([]);
    expect((await renameOf(s)).status).toBe(200);
    expect(existsSync(s.bookDir)).toBe(false);
  });
});

describe('POST /:id/analysis/pause holds the lease until its own paused snapshot lands (#3714 review pass 2)', () => {
  it('a job that ends on its own while the pause write is parked keeps the book held', async () => {
    const s = await seedBook('pause-write');
    const { endJob, __testRegisterJobForTest } = analysisModule;
    const job = {
      controller: new AbortController(),
      subscribers: new Set(),
      manuscriptId: s.manuscriptId,
      kind: 'main',
      bookDir: s.bookDir,
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
    job.settled = new Promise<void>((resolve) => {
      job.resolveSettled = resolve;
    });
    __testRegisterJobForTest(job);
    const registered = await runBookJob(s.bookId, 'analysis', async () => {
      await job.settled;
    });
    if (registered === BOOK_GONE) throw new Error('book vanished');

    const paused = gate();
    g.__baj_paused_gate = paused.promise;
    const pauseP = Promise.resolve(
      request(app).post(`/api/manuscripts/${s.manuscriptId}/analysis/pause`).send({}) as unknown as PromiseLike<request.Response>,
    );
    await vi.waitFor(() => expect(g.__baj_paused_parked).toBe(true));
    /* The job ends on its own (a clean teardown: one fast snapshot delete) while
       the route's paused write is still parked. */
    endJob(job);
    await new Promise((r) => setTimeout(r, 50));
    expect(bookJobKinds(s.bookId)).toEqual(['analysis']);
    expect((await renameOf(s)).status).toBe(409);

    paused.open();
    expect((await pauseP).status).toBe(200);
    await registered.done;
    expect(bookJobKinds(s.bookId)).toEqual([]);
    expect((await renameOf(s)).status).toBe(200);
    expect(existsSync(s.bookDir)).toBe(false);
  });
});

/* Park a rename inside book-op (via the book's state-json lock) and queue the REAL route POST
   behind it on book-op; returns once both are queued. `go()` lets the rename finish, so the
   POST's registration then starts on the NEW folder. */
async function queuePostBehindRename(s: Seeded, url: string, body: object) {
  const paths = await import('../workspace/paths.js');
  const fileLock = await import('../workspace/file-lock.js');
  const open = gate();
  const held = gate();
  void fileLock.withStateJsonLock(paths.stateJsonPath(s.bookDir), async () => {
    held.open();
    await open.promise;
  });
  await held.promise;
  const renameP = Promise.resolve(renameOf(s) as unknown as PromiseLike<request.Response>);
  while (fileLock.__keyWaitersForTest(`state-json:${paths.stateJsonPath(s.bookDir)}`) < 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const postP = Promise.resolve(request(app).post(url).send(body) as unknown as PromiseLike<request.Response>);
  while (fileLock.__keyWaitersForTest(`book-op:${s.bookId}`) < 1) await new Promise((r) => setTimeout(r, 5));
  return { renameP, postP, go: () => open.open() };
}

describe('the REAL analysis POST routes (#3711 review)', () => {
  it('main POST: the lease is held past the drain deadline until the last tracked unit settles', async () => {
    const s = await seedBook('route-drain');
    const { takeWork, releaseWork, __inFlightJobForTest } = analysisModule;
    let held: AnalysisJob | undefined;
    g.__baj_phase0_selection = selectionFor(
      stubAnalyzer({
        runStage1Chapter: async () => {
          held = __inFlightJobForTest(s.manuscriptId, 'main');
          takeWork(held!); // a tracked unit that outlives the run
          return { characters: [novaCharacter()] };
        },
      }),
    );
    g.__baj_phase1_selection = selectionFor(stubAnalyzer({}));
    const timers: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...a: unknown[]) => {
      if (ms === analysisModule.MAIN_DRAIN_DEADLINE_MS) {
        timers.push(fn);
        return { unref() {} } as unknown as NodeJS.Timeout;
      }
      return (realSetTimeout as unknown as (...x: unknown[]) => NodeJS.Timeout)(fn, ms, ...a);
    }) as unknown as typeof setTimeout);
    try {
      const res = await request(app).post(`/api/manuscripts/${s.manuscriptId}/analysis`).send({});
      expect(sseFrames(res.text).some((f) => f.kind === 'result')).toBe(true);
      expect(held?.ended).toBe(true);
      expect(timers).toHaveLength(1);
      timers[0](); // the drain deadline fires: busy flag + pin released ...
      expect(held?.left).toBe(true);
      /* ... but the unit is still running, so the book is still held. */
      expect(bookJobKinds(s.bookId)).toEqual(['analysis']);
      const refused = await renameOf(s);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('book_busy');
      expect(existsSync(s.newDir)).toBe(false);
      releaseWork(held!);
      await vi.waitFor(() => expect(bookJobKinds(s.bookId)).toEqual([]));
      expect((await renameOf(s)).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it('main POST queued behind a rename runs on the NEW folder (job.bookDir from the lease)', async () => {
    const s = await seedBook('route-lease-main');
    const entered = gate();
    const release = gate();
    let seenDir: string | null | undefined;
    g.__baj_phase0_selection = selectionFor(
      stubAnalyzer({
        runStage1Chapter: async () => {
          seenDir = analysisModule.__inFlightJobForTest(s.manuscriptId, 'main')?.bookDir;
          entered.open();
          await release.promise;
          return { characters: [novaCharacter()] };
        },
      }),
    );
    g.__baj_phase1_selection = selectionFor(stubAnalyzer({}));
    g.__baj_clone_records = true;
    const q = await queuePostBehindRename(s, `/api/manuscripts/${s.manuscriptId}/analysis`, {});
    q.go();
    expect((await q.renameP).status).toBe(200);
    await entered.promise;
    expect(seenDir).toBe(s.newDir);
    release.open();
    await q.postP;
    await vi.waitFor(() => expect(bookJobKinds(s.bookId)).toEqual([]));
  });

  it('subset POST queued behind a rename runs on the NEW folder (job.bookDir from the lease)', async () => {
    const s = await seedBook('route-lease-subset');
    const entered = gate();
    const release = gate();
    let seenDir: string | null | undefined;
    const hold = async () => {
      seenDir ??= analysisModule.__inFlightJobForTest(s.manuscriptId, 'subset')?.bookDir;
      entered.open();
      await release.promise;
    };
    g.__baj_phase0_selection = selectionFor(
      stubAnalyzer({
        runStage1Chapter: async () => {
          await hold();
          return { characters: [novaCharacter()] };
        },
      }),
    );
    g.__baj_phase1_selection = selectionFor(
      stubAnalyzer({
        runStage2Chapter: async (_m: string, chapterId: number) => {
          await hold();
          return { sentences: [{ id: chapterId * 100 + 1, chapterId, characterId: 'nova', confidence: 0.9, text: BODIES[chapterId] }] };
        },
      }),
    );
    g.__baj_clone_records = true;
    const q = await queuePostBehindRename(s, `/api/manuscripts/${s.manuscriptId}/analysis/chapters`, { chapterIds: [1] });
    q.go();
    expect((await q.renameP).status).toBe(200);
    await entered.promise;
    expect(seenDir).toBe(s.newDir);
    release.open();
    await q.postP;
    await vi.waitFor(() => expect(bookJobKinds(s.bookId)).toEqual([]));
  });
});

/* #3774 H' — the SERVER reports a live subset run's origin on GET /analysis/state, so a book
   switch, a reload or a second tab (each of which rebuilds the client snapshot from this
   answer) keeps the include-origin job-start block. */
describe('GET /analysis/state reports the live subset run\'s origin (#3774)', () => {
  async function stateWhileSubsetRuns(label: string, body: Record<string, unknown>) {
    const s = await seedBook(label);
    const entered = gate();
    const release = gate();
    g.__baj_phase0_selection = selectionFor(
      stubAnalyzer({
        runStage1Chapter: async () => {
          entered.open();
          await release.promise;
          return { characters: [novaCharacter()] };
        },
      }),
    );
    g.__baj_phase1_selection = selectionFor(stubAnalyzer({}));
    const run = request(app)
      .post(`/api/manuscripts/${s.manuscriptId}/analysis/chapters`)
      .send({ chapterIds: [1], ...body })
      .then((r) => r);
    await entered.promise;
    const state = await request(app).get(`/api/books/${s.bookId}/analysis/state`);
    release.open();
    await run;
    await vi.waitFor(() => expect(bookJobKinds(s.bookId)).toEqual([]));
    return state;
  }

  it('origin include on the start POST -> state answers subsetOrigin include', async () => {
    const state = await stateWhileSubsetRuns('origin-include', { origin: 'include' });
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ state: 'running', kind: 'subset', subsetChapterIds: [1], subsetOrigin: 'include' });
  });

  it('no origin on the start POST -> state answers subsetOrigin reanalyse (backward compatible default)', async () => {
    const state = await stateWhileSubsetRuns('origin-default', {});
    expect(state.body).toMatchObject({ state: 'running', kind: 'subset', subsetOrigin: 'reanalyse' });
  });

  it('an unknown origin value is treated as reanalyse, never as include', async () => {
    const state = await stateWhileSubsetRuns('origin-junk', { origin: 'banana' });
    expect(state.body.subsetOrigin).toBe('reanalyse');
  });

  it('a subscribe POST that joins the live run does not change its origin', async () => {
    const s = await seedBook('origin-join');
    const entered = gate();
    const release = gate();
    g.__baj_phase0_selection = selectionFor(
      stubAnalyzer({
        runStage1Chapter: async () => {
          entered.open();
          await release.promise;
          return { characters: [novaCharacter()] };
        },
      }),
    );
    g.__baj_phase1_selection = selectionFor(stubAnalyzer({}));
    const url = `/api/manuscripts/${s.manuscriptId}/analysis/chapters`;
    const run = request(app).post(url).send({ chapterIds: [1], origin: 'include' }).then((r) => r);
    await entered.promise;
    const join = request(app).post(url).send({ chapterIds: [1] }).then((r) => r);
    /* wait on the join itself, not a fixed sleep: the run's own request is subscriber
       one, so a second means the joiner has attached to the live job */
    await vi.waitFor(() =>
      expect(analysisModule.__inFlightJobForTest(s.manuscriptId, 'subset')?.subscribers.size).toBe(2),
    );
    const state = await request(app).get(`/api/books/${s.bookId}/analysis/state`);
    release.open();
    await Promise.all([run, join]);
    expect(state.body.subsetOrigin).toBe('include');
  });

  it('a live main run carries no subsetOrigin', async () => {
    const s = await seedBook('origin-main');
    const entered = gate();
    const release = gate();
    g.__baj_phase0_selection = selectionFor(
      stubAnalyzer({
        runStage1Chapter: async () => {
          entered.open();
          await release.promise;
          return { characters: [novaCharacter()] };
        },
      }),
    );
    g.__baj_phase1_selection = selectionFor(stubAnalyzer({}));
    const run = request(app).post(`/api/manuscripts/${s.manuscriptId}/analysis`).send({}).then((r) => r);
    await entered.promise;
    const state = await request(app).get(`/api/books/${s.bookId}/analysis/state`);
    release.open();
    await run;
    expect(state.body.kind).toBe('main');
    expect(state.body.subsetOrigin).toBeUndefined();
  });
});
