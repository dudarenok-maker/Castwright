/* #3435 decisions E and A — every ending of a main analysis run aborts the
   run's in-flight model calls, and a subset run (Retry / Re-analyse / Include)
   is refused while a main run for the book is live or still draining.

   Main-run cases drive runMainAnalyzerJob against a real workspace book (the
   harness of analysis.reasoning-overflow.test.ts). The stub analyzers' calls
   park until released or until the job's signal aborts, which is what lets a
   test hold a chapter "in flight". Route cases go through supertest. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Analyzer, AnalyzerSelection, StageCall } from '../analyzer/index.js';
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
vi.mock('../analyzer/select-analyzer.js', async () => {
  const actual = await vi.importActual<typeof import('../analyzer/select-analyzer.js')>(
    '../analyzer/select-analyzer.js',
  );
  return {
    ...actual,
    selectAnalyzerForPhase: (opts: { phase: 'phase0' | 'phase1' }) => {
      const sel = (globalThis as G)[opts.phase === 'phase1' ? '__rwm_phase1_selection' : '__rwm_phase0_selection'];
      return sel ?? actual.selectAnalyzerForPhase(opts as Parameters<typeof actual.selectAnalyzerForPhase>[0]);
    },
    isPerPhaseModelSelectionActive: () => (globalThis as G).__rwm_pipelined === true,
  };
});
vi.mock('../store/analysis-cache.js', async () => {
  const actual = await vi.importActual<typeof import('../store/analysis-cache.js')>('../store/analysis-cache.js');
  return {
    ...actual,
    saveAnalysisCache: async (...args: Parameters<typeof actual.saveAnalysisCache>) => {
      const hook = (globalThis as G).__rwm_save_hook as ((c: typeof args[1]) => void | Promise<void>) | undefined;
      await hook?.(args[1]);
      if (args[1].stage1) ((globalThis as G).__rwm_stage1_saved as (() => void) | undefined)?.();
      return actual.saveAnalysisCache(...args);
    },
  };
});
/* Counts Phase-1 workers parked in awaitPhase1Dispatch, so a case can prove every one settles. */
vi.mock('../analyzer/phase-watermark.js', async () => {
  const actual = await vi.importActual<typeof import('../analyzer/phase-watermark.js')>(
    '../analyzer/phase-watermark.js',
  );
  const wrap = (w: ReturnType<typeof actual.createSequentialWatermark>) => {
    const original = w.awaitPhase1Dispatch.bind(w);
    w.awaitPhase1Dispatch = (i: number) => {
      const counter = (globalThis as G).__rwm_parked as { pending: number } | undefined;
      if (counter) counter.pending++;
      return original(i).finally(() => {
        if (counter) counter.pending--;
      });
    };
    return w;
  };
  return {
    ...actual,
    createSequentialWatermark: () => wrap(actual.createSequentialWatermark()),
    createPhaseWatermark: (o: Parameters<typeof actual.createPhaseWatermark>[0]) => wrap(actual.createPhaseWatermark(o)),
  };
});
/* A case can hold the book-dir resolution open (A6). */
vi.mock('../workspace/book-dir-guard.js', async () => {
  const actual = await vi.importActual<typeof import('../workspace/book-dir-guard.js')>('../workspace/book-dir-guard.js');
  return {
    ...actual,
    withVerifiedBookDir: async (...args: Parameters<typeof actual.withVerifiedBookDir>) => {
      const gate = (globalThis as G).__rwm_resolve_gate as Promise<void> | undefined;
      if (gate) await gate;
      return actual.withVerifiedBookDir(...args);
    },
  };
});
/* A case can hold getOrHydrateManuscript open (the late refusal checks, A4). */
vi.mock('../store/manuscripts.js', async () => {
  const actual = await vi.importActual<typeof import('../store/manuscripts.js')>('../store/manuscripts.js');
  return {
    ...actual,
    getOrHydrateManuscript: async (...args: Parameters<typeof actual.getOrHydrateManuscript>) => {
      const gate = (globalThis as G).__rwm_hydrate_gate as (() => Promise<void>) | undefined;
      if (gate) await gate();
      return actual.getOrHydrateManuscript(...args);
    },
  };
});

const AUTHOR = 'Refuse While Main Author';
const SERIES = 'Standalones';
const MODEL = 'gemini-3.6-flash';
const BODIES: Record<number, string> = {
  1: '"The plan is set." Silence followed.',
  2: '"The plan is set." Nobody moved.',
  3: '"The plan is set." Nobody spoke.',
};
const CHAPTER_TITLES: Record<number, string> = { 1: 'Chapter One', 2: 'Chapter Two', 3: 'Chapter Three' };

let workspaceRoot: string;
const originalConcurrency = process.env.ANALYZER_OLLAMA_CONCURRENCY;
const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
const originalMinLag = process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-refuse-while-main-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.ANALYZER_OLLAMA_CONCURRENCY = '2';
  process.env.STAGE2_COVERAGE_RETRIES = '0';
});
beforeAll(async () => {
  await import('./analysis.js');
}, 120_000);
afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  restoreEnv('ANALYZER_OLLAMA_CONCURRENCY', originalConcurrency);
  restoreEnv('STAGE2_COVERAGE_RETRIES', originalCoverageRetries);
});
afterEach(() => {
  for (const k of Object.keys(g)) if (k.startsWith('__rwm_')) delete g[k];
  process.env.ANALYZER_OLLAMA_CONCURRENCY = '2';
  restoreEnv('ANALYZER_PHASE1_MIN_LAG_CHAPTERS', originalMinLag);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
  return { analyzer, engine: 'gemini', model, fallbackModel: null };
}
function stage2For(chapterId: number): Stage2ChapterOutput {
  return {
    sentences: [{ id: chapterId * 100 + 1, chapterId, characterId: 'nova', confidence: 0.9, text: BODIES[chapterId] }],
  };
}
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
      return stage2For(chapterId);
    },
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.resolve(null),
    ...over,
  };
}

/** A promise you can resolve from outside. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

/** A model call that parks until `release` resolves (then returns `value()`), or rejects with
    AnalysisAbortedError the moment the call's signal aborts. `onAbort` observes the abort. */
async function parkedCall<T>(
  call: StageCall,
  release: Promise<void>,
  value: () => T,
  onAbort?: () => void,
): Promise<T> {
  const { AnalysisAbortedError } = await import('../analyzer/errors.js');
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort?.();
      reject(new AnalysisAbortedError('aborted by the job signal'));
    };
    if (call.signal?.aborted) return abort();
    call.signal?.addEventListener('abort', abort, { once: true });
    void release.then(() => {
      call.signal?.removeEventListener('abort', abort);
      resolve(value());
    });
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function buildJob(manuscriptId: string, kind: 'main' | 'subset', bookDir: string | null): AnalysisJob {
  return {
    controller: new AbortController(),
    subscribers: new Set(),
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
}

async function seedBook(
  label: string,
  chapterIds: readonly number[] = [1, 2],
): Promise<{ manuscriptId: string; bookDir: string; job: AnalysisJob }> {
  const manuscriptId = `test-rwm-${label}-${Date.now()}-${Math.random()}`;
  const title = `Refuse While Main ${label}`;
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
  rmSync(bookDir, { recursive: true, force: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  const { makeBookId } = await import('../workspace/paths.js');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: makeBookId(AUTHOR, SERIES, title),
      manuscriptId,
      title,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.md',
      castConfirmed: false,
      language: 'en',
      chapters: chapterIds.map((id) => ({
        id,
        title: CHAPTER_TITLES[id],
        slug: `0${id}-${CHAPTER_TITLES[id].toLowerCase().replace(' ', '-')}`,
      })),
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(
    join(bookDir, 'manuscript.md'),
    chapterIds.map((id) => `# ${CHAPTER_TITLES[id]}\n\n${BODIES[id]}\n`).join('\n'),
  );
  const { putManuscript } = await import('../store/manuscripts.js');
  putManuscript({
    manuscriptId,
    format: 'plaintext',
    title,
    wordCount: 12,
    byteSize: 100,
    uploadedAt: new Date().toISOString(),
    sourceText: chapterIds.map((id) => BODIES[id]).join('\n\n'),
    chapterHints: chapterIds.map((id) => ({ id, title: CHAPTER_TITLES[id], body: BODIES[id] })),
    bookDir,
  });
  return { manuscriptId, bookDir, job: buildJob(manuscriptId, 'main', bookDir) };
}

interface CapturedEvent {
  kind: string;
  code?: string;
  [k: string]: unknown;
}
function captureEvents(job: AnalysisJob, onEvent?: (ev: CapturedEvent) => void): CapturedEvent[] {
  const events: CapturedEvent[] = [];
  const keepAlive = setInterval(() => {}, 100_000);
  clearInterval(keepAlive);
  job.subscribers.add({
    send: (payload: unknown) => {
      const ev = payload as CapturedEvent;
      events.push(ev);
      onEvent?.(ev);
    },
    res: { end: () => {} } as unknown as import('express').Response,
    keepAlive,
  });
  return events;
}

interface SaveSnapshot {
  failedChapterIds?: number[];
  failedChapterErrors?: Record<string, unknown>;
  chapterCast?: Record<number, unknown[]>;
  chapters?: Record<number, unknown>;
  stage1?: unknown;
}
interface MainOpts {
  chapterIds?: number[];
  fresh?: boolean;
  width?: string;
  pipelined?: boolean;
  allowStage1Shrink?: boolean;
  register?: boolean;
  phase0?: Partial<Analyzer>;
  phase1?: Partial<Analyzer>;
  saveHook?: (c: SaveSnapshot, job: AnalysisJob) => void | Promise<void>;
  onEvent?: (ev: CapturedEvent, job: AnalysisJob) => void;
  /** Runs once the run has been launched (before it is awaited). */
  during?: (job: AnalysisJob) => Promise<void>;
}

/** Seeds `seedCache`, runs one main run, returns what it observed. */
async function runMain(label: string, seedCache: Record<string, unknown>, opts: MainOpts = {}) {
  const seed = await seedBook(label, opts.chapterIds ?? [1, 2]);
  const { saveAnalysisCache, loadAnalysisCache, clearAnalysisCache } = await import('../store/analysis-cache.js');
  const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
  const { runMainAnalyzerJob, __testRegisterJobForTest } = await import('./analysis.js');
  await saveAnalysisCache(seed.manuscriptId, seedCache as never);
  const stateBefore = readFileSync(join(seed.bookDir, '.audiobook', 'state.json'), 'utf8');
  const castCalls: number[] = [];
  const stage2Calls: number[] = [];
  let stage1Saved = false;
  g.__rwm_stage1_saved = () => {
    stage1Saved = true;
  };
  g.__rwm_save_hook = async (c: SaveSnapshot) => {
    await opts.saveHook?.(c, seed.job);
  };
  const phase0 = buildSelection(
    stubAnalyzer({
      ...opts.phase0,
      runStage1Chapter: async (m, id, ...rest) => {
        castCalls.push(id);
        return opts.phase0?.runStage1Chapter
          ? opts.phase0.runStage1Chapter(m, id, ...rest)
          : { characters: [novaCharacter()] };
      },
    }),
    'phase0-model',
  );
  g.__rwm_phase1_selection = buildSelection(
    stubAnalyzer({
      ...opts.phase1,
      runStage2Chapter: async (m, id, ...rest) => {
        stage2Calls.push(id);
        return opts.phase1?.runStage2Chapter ? opts.phase1.runStage2Chapter(m, id, ...rest) : stage2For(id);
      },
    }),
    MODEL,
  );
  if (opts.pipelined) {
    g.__rwm_pipelined = true;
    process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS = '0';
  }
  if (opts.width) process.env.ANALYZER_OLLAMA_CONCURRENCY = opts.width;
  if (opts.register) __testRegisterJobForTest(seed.job);
  const events = captureEvents(seed.job, (ev) => opts.onEvent?.(ev, seed.job));
  try {
    const run = runMainAnalyzerJob(seed.job, getManuscript(seed.manuscriptId)! as never, phase0, {
      requestedFresh: opts.fresh ?? false,
      allowStage1Shrink: opts.allowStage1Shrink ?? true,
      requestedModel: undefined,
    });
    await opts.during?.(seed.job);
    await run;
    await sleep(100);
    const after = await loadAnalysisCache(seed.manuscriptId);
    const stateAfter = readFileSync(join(seed.bookDir, '.audiobook', 'state.json'), 'utf8');
    return {
      castCalls,
      stage2Calls,
      events,
      after,
      job: seed.job,
      bookDir: seed.bookDir,
      manuscriptId: seed.manuscriptId,
      stage1Saved,
      stateUnchanged: stateAfter === stateBefore,
    };
  } finally {
    removeManuscript(seed.manuscriptId);
    await clearAnalysisCache(seed.manuscriptId);
  }
}

const BOTH_CAST = { chapterCast: { 1: [novaCharacter()], 2: [novaCharacter()] } };
const errorCodes = (events: CapturedEvent[]) => events.filter((e) => e.kind === 'error').map((e) => e.code);

describe('every ending aborts in-flight work (#3435 decision E)', () => {
  it("a Phase-1 throw aborts the other in-flight chapter's call; that chapter is not cached and has no record", async () => {
    const chapterOneInFlight = gate();
    const fallback = sleep(1500);
    let chapterOneAborted = false;
    const r = await runMain('e-abort', BOTH_CAST, {
      phase1: {
        runStage2Chapter: async (_m, id, _p, call) => {
          if (id === 2) {
            await chapterOneInFlight.promise;
            throw new Error('Phase 1 fails for chapter 2');
          }
          chapterOneInFlight.open();
          return parkedCall(call, fallback, () => stage2For(1), () => {
            chapterOneAborted = true;
          });
        },
      },
    });
    await sleep(1600);
    expect(errorCodes(r.events)).toHaveLength(1);
    expect(errorCodes(r.events)[0]).not.toBe('aborted');
    expect(chapterOneAborted).toBe(true);
    expect(r.job.controller.signal.aborted).toBe(true);
    const { loadAnalysisCache } = await import('../store/analysis-cache.js');
    const after = await loadAnalysisCache(r.manuscriptId);
    expect(after.chapters?.[1]).toBeUndefined();
    expect(after.failedChapterIds ?? []).not.toContain(1);
    expect(r.events.filter((e) => e.kind === 'chapter-failed').map((e) => e.chapterId)).toEqual([2]);
  }, 60_000);

  it('Item A-2: pipelined Phase-1 throw with un-launched cast chapters writes no stage1', async () => {
    const castTwo = gate();
    const castTwoStarted = gate();
    let held = false;
    const r = await runMain('a2', {}, {
      chapterIds: [1, 2, 3],
      pipelined: true,
      width: '1',
      fresh: true,
      phase0: {
        runStage1Chapter: async (_m, id) => {
          /* Chapter 2's cast call ignores the abort and returns only when the test says so. */
          if (id === 2) {
            castTwoStarted.open();
            await castTwo.promise;
          }
          return { characters: [novaCharacter()] };
        },
      },
      phase1: {
        runStage2Chapter: async (_m, id) => {
          if (id === 1) {
            /* Cast chapter 2 is mid-call when attribution halts the run. */
            await castTwoStarted.promise;
            throw new Error('Phase 1 fails for chapter 1');
          }
          return stage2For(id);
        },
      },
      /* Hold the halting chapter's guarded save open while cast chapter 2 returns, so the
         cast pool finishes BEFORE endJob aborts the signal. */
      saveHook: async (c) => {
        if (!held && c.failedChapterErrors?.['1']) {
          held = true;
          castTwo.open();
          await sleep(300);
        }
      },
    });
    castTwo.open();
    expect(errorCodes(r.events)).toHaveLength(1);
    expect(r.castCalls).not.toContain(3);
    expect(r.stage1Saved).toBe(false);
  }, 60_000);

  it('no chapter starts between the halt decision and endJob (the pool catch\'s guarded save is held open)', async () => {
    const castTwo = gate();
    const castTwoStarted = gate();
    let held = false;
    const r = await runMain('gap4', {}, {
      chapterIds: [1, 2, 3],
      pipelined: true,
      width: '1',
      fresh: true,
      phase0: {
        runStage1Chapter: async (_m, id) => {
          if (id === 2) {
            castTwoStarted.open();
            await castTwo.promise;
          }
          return { characters: [novaCharacter()] };
        },
      },
      phase1: {
        runStage2Chapter: async (_m, id) => {
          if (id === 1) {
            /* Cast chapter 2 is mid-call when attribution halts the run. */
            await castTwoStarted.promise;
            throw new Error('Phase 1 fails for chapter 1');
          }
          return stage2For(id);
        },
      },
      saveHook: async (c) => {
        if (!held && c.failedChapterErrors?.['1']) {
          held = true;
          castTwo.open();
          await sleep(300);
        }
      },
    });
    castTwo.open();
    /* Cast chapter 3 was queued when chapter 1's attribution halted the run. */
    expect(r.castCalls).toEqual([1, 2]);
    expect(r.stage2Calls).toEqual([1]);
  }, 60_000);

  it('a Pause during the fold / Phase-2 window ends aborted with no state.json write', async () => {
    const r = await runMain('fold-pause', BOTH_CAST, {
      onEvent: (ev, job) => {
        if (ev.kind === 'phase' && ev.phaseId === 2 && !job.controller.signal.aborted) job.controller.abort();
      },
    });
    expect(errorCodes(r.events)).toEqual(['aborted']);
    expect(r.events.some((e) => e.kind === 'result')).toBe(false);
    expect(r.stateUnchanged).toBe(true);
  }, 60_000);

  it('the non-story classifier call receives the job signal and aborts with the job', async () => {
    const { buildNonStoryClassifier } = await import('./analysis.js');
    const { AnalysisAbortedError } = await import('../analyzer/errors.js');
    const job = buildJob('m_nonstory', 'main', null);
    const never = new Promise<void>(() => {});
    let seen: AbortSignal | undefined;
    const classify = buildNonStoryClassifier({
      job,
      structureBudget: { remainingWindows: 1 },
      analyzer: stubAnalyzer({
        runNonStoryClassification: async (_m: string, _id: number, _p: string, call: StageCall) => {
          seen = call.signal;
          return parkedCall(call, never, () => ({ nonStory: false }));
        },
      } as Partial<Analyzer>),
      manuscriptId: 'm_nonstory',
      bookTitle: null,
      bookLanguage: 'en',
    })!;
    const pending = classify({ id: 1, title: 'Front matter', body: 'Copyright page.' } as never);
    await sleep(10);
    job.controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AnalysisAbortedError);
    expect(seen).toBe(job.controller.signal);
  });

  it('endJob before the watermark exists (language_unset) does not throw', async () => {
    const { endJob } = await import('./analysis.js');
    const job = buildJob('m_no_watermark', 'main', null);
    expect(() => endJob(job, { kind: 'error', code: 'language_unset', message: 'x' })).not.toThrow();
    expect(job.controller.signal.aborted).toBe(true);
  });

  it('a hand-registered test job has ended/halting/left/liveWork initialised', async () => {
    const { __testRegisterJobForTest, endJob } = await import('./analysis.js');
    const job = buildJob('m_hand_registered', 'main', null);
    __testRegisterJobForTest(job);
    expect(job.ended).toBe(false);
    expect(job.halting).toBe(false);
    expect(job.left).toBe(false);
    expect(job.liveWork).toBe(0);
    endJob(job);
  });

  describe('every main ending aborts the controller', () => {
    it('classified error', async () => {
      const r = await runMain('end-classified', BOTH_CAST, {
        width: '1',
        phase1: { runStage2Chapter: () => Promise.reject(new Error('boom')) },
      });
      expect(errorCodes(r.events)).toHaveLength(1);
      expect(r.job.controller.signal.aborted).toBe(true);
    }, 60_000);

    it('overflow', async () => {
      const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
      const r = await runMain('end-overflow', BOTH_CAST, {
        width: '1',
        phase1: { runStage2Chapter: () => Promise.reject(new AnalyzerReasoningOverflowError('gemini', MODEL, 8100)) },
      });
      expect(errorCodes(r.events)).toEqual(['analyzer-reasoning-overflow']);
      expect(r.job.controller.signal.aborted).toBe(true);
    }, 60_000);

    it('cast_incomplete', async () => {
      const r = await runMain('end-cast-incomplete', {}, {
        fresh: true,
        phase0: { runStage1Chapter: () => Promise.reject(new Error('cast failed')) },
      });
      expect(errorCodes(r.events)).toEqual(['cast_incomplete']);
      expect(r.job.controller.signal.aborted).toBe(true);
    }, 60_000);

    it('re-verify shrink refusal', async () => {
      const ghost = (id: string): CharacterOutput => ({
        id,
        name: id,
        role: 'character',
        color: '#abc',
        evidence: [{ quote: `A line ${id} never said.` }],
      });
      const r = await runMain(
        'end-shrink',
        {
          ...BOTH_CAST,
          stage1: {
            characters: [ghost('a'), ghost('b'), ghost('c'), ghost('d')],
            chapters: [1, 2].map((id) => ({ id, title: CHAPTER_TITLES[id] })),
          },
        },
        { allowStage1Shrink: false },
      );
      expect(errorCodes(r.events)).toEqual(['stage1_shrink_refused']);
      expect(r.job.controller.signal.aborted).toBe(true);
    }, 60_000);

    it('attribution_drift', async () => {
      const r = await runMain('end-drift', BOTH_CAST, {
        phase1: {
          runStage2Chapter: async (_m, id) => ({
            sentences: Array.from({ length: 60 }, (_, k) => ({
              id: id * 1000 + k,
              chapterId: id,
              characterId: 'ghost',
              confidence: 0.9,
              text: BODIES[id],
            })),
          }),
        },
      });
      expect(errorCodes(r.events)).toEqual(['attribution_drift']);
      expect(r.job.controller.signal.aborted).toBe(true);
    }, 60_000);

    it('aborted', async () => {
      const { AnalysisAbortedError } = await import('../analyzer/errors.js');
      const r = await runMain('end-aborted', BOTH_CAST, {
        phase1: { runStage2Chapter: () => Promise.reject(new AnalysisAbortedError('paused')) },
      });
      expect(errorCodes(r.events)).toEqual(['aborted']);
      expect(r.job.controller.signal.aborted).toBe(true);
    }, 60_000);

    it('result', async () => {
      const r = await runMain('end-result', BOTH_CAST, {});
      expect(r.events.some((e) => e.kind === 'result')).toBe(true);
      expect(r.job.controller.signal.aborted).toBe(true);
    }, 60_000);
  });

  it("the halt's own error is the terminal even when a sibling's aborted call rejects first", async () => {
    const chapterOneInFlight = gate();
    const r = await runMain('halt-terminal', BOTH_CAST, {
      phase1: {
        runStage2Chapter: async (_m, id, _p, call) => {
          if (id === 2) {
            await chapterOneInFlight.promise;
            throw new Error('Phase 1 fails for chapter 2');
          }
          chapterOneInFlight.open();
          return parkedCall(call, sleep(1500), () => stage2For(1));
        },
      },
      /* Hold the halting chapter's save open: an abort fired in the pool catch would make
         chapter 1 reject first. */
      saveHook: async (c) => {
        if (c.failedChapterErrors?.['2']) await sleep(200);
      },
    });
    expect(errorCodes(r.events)).toHaveLength(1);
    expect(errorCodes(r.events)[0]).not.toBe('aborted');
  }, 60_000);

  it('a parked Phase-1 worker woken by markPhase0ChapterComplete after the halt does not run', async () => {
    const castTwo = gate();
    const castTwoStarted = gate();
    let held = false;
    const r = await runMain('wake-watermark', {}, {
      chapterIds: [1, 2],
      pipelined: true,
      width: '2',
      fresh: true,
      phase0: {
        runStage1Chapter: async (_m, id) => {
          if (id === 2) {
            castTwoStarted.open();
            await castTwo.promise;
          }
          return { characters: [novaCharacter()] };
        },
      },
      phase1: {
        runStage2Chapter: async (_m, id) => {
          if (id === 1) {
            /* Cast chapter 2 is mid-call when attribution halts the run. */
            await castTwoStarted.promise;
            throw new Error('Phase 1 fails for chapter 1');
          }
          return stage2For(id);
        },
      },
      /* Cast chapter 2 completes (advancing the watermark, waking the worker parked on
         Phase-1 chapter 2) while chapter 1's failure save is held open. */
      saveHook: async (c) => {
        if (!held && c.failedChapterErrors?.['1']) {
          held = true;
          castTwo.open();
          await sleep(300);
        }
      },
    });
    castTwo.open();
    expect(r.stage2Calls).toEqual([1]);
  }, 60_000);

  it('a parked Phase-1 worker woken by releaseAll does not run, and every parked worker resolves after endJob', async () => {
    const parked = { pending: 0 };
    g.__rwm_parked = parked;
    const { AnalysisAbortedError } = await import('../analyzer/errors.js');
    let parkedSeen = 0;
    const r = await runMain('wake-release-all', {}, {
      fresh: true,
      phase0: {
        /* Sequential mode: Phase-1 workers park until Phase 0b; a Pause in Phase 0 ends the run. */
        runStage1Chapter: async () => {
          await sleep(100);
          parkedSeen = Math.max(parkedSeen, parked.pending);
          throw new AnalysisAbortedError('paused in Phase 0');
        },
      },
    });
    expect(errorCodes(r.events)).toEqual(['aborted']);
    expect(parkedSeen).toBeGreaterThan(0);
    expect(parked.pending).toBe(0);
    expect(r.stage2Calls).toEqual([]);
  }, 60_000);

  it('the liveWork token is taken before phase1Dispatch returns: endJob in the microtask after the dispatch await still sees liveWork 1', async () => {
    const { endJob, activeAnalysisManuscripts } = await import('./analysis.js');
    let stillAWriter: boolean | undefined;
    let liveWorkSeen: number | undefined;
    const r = await runMain('gap1', {}, {
      chapterIds: [1],
      width: '1',
      fresh: true,
      register: true,
      /* Sequential mode: the worker is woken by Phase 0b's markPhase0AllDone, after every cast
         token is back and just before the Phase-0 arm releases its own, so the body's token is
         the only live work. The cast call is slow enough that the dispatch logs its wait; that
         log is sent synchronously from inside phase1Dispatch, after its last check. */
      phase0: {
        runStage1Chapter: async () => {
          await sleep(400);
          return { characters: [novaCharacter()] };
        },
      },
      onEvent: (ev, job) => {
        if (ev.kind === 'log' && String(ev.message).includes('held back') && liveWorkSeen === undefined) {
          queueMicrotask(() => {
            liveWorkSeen = job.liveWork;
            endJob(job, { kind: 'error', code: 'aborted', message: 'test' });
            stillAWriter = activeAnalysisManuscripts().includes(job.manuscriptId);
          });
        }
      },
    });
    expect(liveWorkSeen).toBe(1);
    expect(stillAWriter).toBe(true);
    /* The body then ran to its end and released the token: the job left. */
    expect(activeAnalysisManuscripts()).not.toContain(r.manuscriptId);
  }, 60_000);
});

describe('writers, draining and busy release (#3435 decision A)', () => {
  it('drain deadline: a unit that ignores the abort is dropped after MAIN_DRAIN_DEADLINE_MS with the deadline log; busy is released once', async () => {
    const { endJob, __testRegisterJobForTest, activeAnalysisManuscripts, takeWork } = await import('./analysis.js');
    const { markAnalysisBusy, isAnalysisBusy, clearAnalysisBusy } = await import('../tts/design-lock.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    const bookDir = join(workspaceRoot, 'deadline-book');
    const job = buildJob('m_deadline', 'main', bookDir);
    __testRegisterJobForTest(job);
    markAnalysisBusy(bookDir); // the sibling's hold
    markAnalysisBusy(bookDir); // this job's hold
    takeWork(job); // a unit that will never observe the abort
    endJob(job, { kind: 'error', code: 'aborted', message: 'x' });
    expect(activeAnalysisManuscripts()).toContain('m_deadline');
    vi.advanceTimersByTime(59_999);
    expect(activeAnalysisManuscripts()).toContain('m_deadline');
    vi.advanceTimersByTime(1);
    expect(activeAnalysisManuscripts()).not.toContain('m_deadline');
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).includes('[analysis] main run drain deadline exceeded manuscript=m_deadline liveWork=1'),
      ),
    ).toBe(true);
    /* One release: the sibling's hold remains. */
    expect(isAnalysisBusy(bookDir)).toBe(true);
    clearAnalysisBusy(bookDir);
    expect(isAnalysisBusy(bookDir)).toBe(false);
  });

  it('busy is released exactly once whether the job leaves from endJob, from a unit\'s finally, or from the deadline', async () => {
    const { endJob, __testRegisterJobForTest, takeWork, releaseWork } = await import('./analysis.js');
    const { markAnalysisBusy, isAnalysisBusy, clearAnalysisBusy } = await import('../tts/design-lock.js');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    const bookDir = join(workspaceRoot, 'once-book');
    /* From endJob (no live work). */
    const a = buildJob('m_once_a', 'main', bookDir);
    __testRegisterJobForTest(a);
    markAnalysisBusy(bookDir); // sibling
    markAnalysisBusy(bookDir); // a
    endJob(a, { kind: 'error', code: 'aborted', message: 'x' });
    vi.advanceTimersByTime(60_000);
    expect(isAnalysisBusy(bookDir)).toBe(true);
    /* From a unit's finally, then the deadline fires too. */
    const b = buildJob('m_once_b', 'main', bookDir);
    __testRegisterJobForTest(b);
    markAnalysisBusy(bookDir); // b
    takeWork(b);
    endJob(b, { kind: 'error', code: 'aborted', message: 'x' });
    releaseWork(b);
    vi.advanceTimersByTime(60_000);
    expect(isAnalysisBusy(bookDir)).toBe(true);
    /* From the deadline, then the unit's finally runs late. */
    const c = buildJob('m_once_c', 'main', bookDir);
    __testRegisterJobForTest(c);
    markAnalysisBusy(bookDir); // c
    takeWork(c);
    endJob(c, { kind: 'error', code: 'aborted', message: 'x' });
    vi.advanceTimersByTime(60_000);
    releaseWork(c);
    expect(isAnalysisBusy(bookDir)).toBe(true);
    clearAnalysisBusy(bookDir);
    expect(isAnalysisBusy(bookDir)).toBe(false);
  });

  it('"Design full cast" busy is held until the main run leaves', async () => {
    const { endJob, __testRegisterJobForTest, takeWork, releaseWork } = await import('./analysis.js');
    const { markAnalysisBusy, isAnalysisBusy } = await import('../tts/design-lock.js');
    const bookDir = join(workspaceRoot, 'design-busy-book');
    const job = buildJob('m_design_busy', 'main', bookDir);
    __testRegisterJobForTest(job);
    markAnalysisBusy(bookDir);
    takeWork(job);
    endJob(job, { kind: 'error', code: 'aborted', message: 'x' });
    expect(isAnalysisBusy(bookDir)).toBe(true);
    releaseWork(job);
    expect(isAnalysisBusy(bookDir)).toBe(false);
  });

  it('activeAnalysisManuscripts includes a draining manuscript', async () => {
    const { endJob, __testRegisterJobForTest, activeAnalysisManuscripts, takeWork, releaseWork } = await import(
      './analysis.js'
    );
    const job = buildJob('m_draining_upgrade', 'main', null);
    __testRegisterJobForTest(job);
    takeWork(job);
    endJob(job, { kind: 'error', code: 'aborted', message: 'x' });
    expect(activeAnalysisManuscripts()).toContain('m_draining_upgrade');
    releaseWork(job);
    expect(activeAnalysisManuscripts()).not.toContain('m_draining_upgrade');
  });

  it('/pause on a manuscript whose main job is draining aborts nothing new, writes no snapshot, and does not reset the deadline', async () => {
    const { endJob, __testRegisterJobForTest, activeAnalysisManuscripts, takeWork, analysisRouter } = await import(
      './analysis.js'
    );
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const { analysisStateJsonPath } = await import('../workspace/paths.js');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seed = await seedBook('pause-draining', [1]);
    const statePath = analysisStateJsonPath(seed.bookDir);
    /* setImmediate stays real, so file I/O can be awaited while setTimeout is faked. */
    const ioTicks = async (n: number) => {
      for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
    };
    __testRegisterJobForTest(seed.job);
    takeWork(seed.job);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    endJob(seed.job, { kind: 'error', code: 'aborted', message: 'x' });
    const abortedSignal = seed.job.controller.signal;
    vi.advanceTimersByTime(30_000);
    /* Let endJob's own paused snapshot land, then remove it so a /pause write would show. */
    for (let i = 0; i < 200 && !existsSync(statePath); i++) await ioTicks(5);
    expect(existsSync(statePath)).toBe(true);
    await ioTicks(20);
    rmSync(statePath, { force: true });
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);
    const res = await supertest(app).post(`/api/manuscripts/${seed.manuscriptId}/analysis/pause`).send({});
    expect(res.body).toEqual({ ok: true, paused: false });
    await ioTicks(50);
    expect(existsSync(statePath)).toBe(false);
    expect(seed.job.controller.signal).toBe(abortedSignal);
    /* The deadline was armed by endJob and is not re-armed by /pause: 30 s more drops it. */
    vi.advanceTimersByTime(29_999);
    expect(activeAnalysisManuscripts()).toContain(seed.manuscriptId);
    vi.advanceTimersByTime(1);
    expect(activeAnalysisManuscripts()).not.toContain(seed.manuscriptId);
  });

  it('a running snapshot whose dir resolves after endJob is not written', async () => {
    const { endJob, trackForReplay } = await import('./analysis.js');
    const { analysisStateJsonPath } = await import('../workspace/paths.js');
    const seed = await seedBook('a6', [1]);
    const resolve = gate();
    g.__rwm_resolve_gate = resolve.promise;
    trackForReplay(seed.job, { kind: 'phase', phaseId: 1, progress: 0.5, label: 'Parsing and attribution' });
    await sleep(20);
    delete g.__rwm_resolve_gate;
    endJob(seed.job, { kind: 'result' });
    await sleep(200);
    resolve.open();
    await sleep(300);
    expect(existsSync(analysisStateJsonPath(seed.bookDir))).toBe(false);
  });
});

describe('refusals (#3435 decision A)', () => {
  async function app() {
    const express = (await import('express')).default;
    const { analysisRouter } = await import('./analysis.js');
    const a = express();
    a.use(express.json());
    a.use('/api/manuscripts', analysisRouter);
    return a;
  }
  const sseErrors = (text: string) =>
    text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)) as CapturedEvent)
      .filter((e) => e.kind === 'error');

  it('subset POST while a main job is registered → 409 main_analysis_running, draining:false, no subset job registered', async () => {
    const supertest = (await import('supertest')).default;
    const { __testRegisterJobForTest, endJob, snapshotInFlightAnalysis } = await import('./analysis.js');
    const job = buildJob('m_subset_refused', 'main', null);
    __testRegisterJobForTest(job);
    try {
      const res = await supertest(await app())
        .post('/api/manuscripts/m_subset_refused/analysis/chapters')
        .send({ chapterIds: [1] });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: 'main_analysis_running',
        draining: false,
        message: 'The analysis is still running on this book. Pause it first, then try again.',
      });
      expect(snapshotInFlightAnalysis('m_subset_refused')?.kind).toBe('main');
    } finally {
      endJob(job);
    }
  });

  it('subset POST after /pause while a chapter body is still in its save → 409 draining:true; after it settles and "main run drained" is logged → the subset starts', async () => {
    const supertest = (await import('supertest')).default;
    const log = vi.spyOn(console, 'log');
    const a = await app();
    const saveHeld = gate();
    let saveEntered = false;
    const savingStarted = gate();
    const chapterTwoInFlight = gate();
    let manuscriptId = '';
    const r = await runMain('drain-409', BOTH_CAST, {
      register: true,
      phase1: {
        runStage2Chapter: async (_m, id, _p, call) => {
          if (id === 1) {
            await chapterTwoInFlight.promise;
            return stage2For(1);
          }
          chapterTwoInFlight.open();
          return parkedCall(call, new Promise<void>(() => {}), () => stage2For(2));
        },
      },
      saveHook: async (c) => {
        if (c.chapters?.[1] && !saveEntered) {
          saveEntered = true;
          savingStarted.open();
          await saveHeld.promise;
        }
      },
      during: async (job) => {
        manuscriptId = job.manuscriptId;
        await savingStarted.promise;
        await supertest(a).post(`/api/manuscripts/${manuscriptId}/analysis/pause`).send({});
      },
    }).then(async (res) => res);
    /* The run ended (endJob) while chapter 1's body is still in its save. */
    expect(errorCodes(r.events)).toEqual(['aborted']);
    const refused = await supertest(a).post(`/api/manuscripts/${manuscriptId}/analysis/chapters`).send({ chapterIds: [1] });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: 'main_analysis_running',
      draining: true,
      message: 'The analysis on this book is still finishing the chapters it had started. Try again in a moment.',
    });
    saveHeld.open();
    await vi.waitFor(
      () =>
        expect(log.mock.calls.some((c) => String(c[0]) === `[analysis] main run drained manuscript=${manuscriptId}`)).toBe(
          true,
        ),
      { timeout: 5_000, interval: 20 },
    );
    g.__rwm_phase0_selection = buildSelection(stubAnalyzer({}), 'phase0-model');
    g.__rwm_phase1_selection = buildSelection(stubAnalyzer({}), MODEL);
    const started = await supertest(a)
      .post(`/api/manuscripts/${manuscriptId}/analysis/chapters`)
      .send({ chapterIds: [1] });
    expect(started.status).toBe(200);
    expect(sseErrors(started.text).map((e) => e.code)).not.toContain('main_analysis_running');
  }, 60_000);

  it('the late check: a main job registering while the subset POST awaits getOrHydrateManuscript → SSE error frame main_analysis_running, no subset registered', async () => {
    const supertest = (await import('supertest')).default;
    const { __testRegisterJobForTest, endJob, snapshotInFlightAnalysis } = await import('./analysis.js');
    const seed = await seedBook('late-subset', [1]);
    const hydrate = gate();
    const entered = gate();
    g.__rwm_hydrate_gate = async () => {
      entered.open();
      await hydrate.promise;
    };
    const main = buildJob(seed.manuscriptId, 'main', null);
    try {
      const pending = supertest(await app())
        .post(`/api/manuscripts/${seed.manuscriptId}/analysis/chapters`)
        .send({ chapterIds: [1] })
        .then((x) => x);
      await entered.promise;
      __testRegisterJobForTest(main);
      hydrate.open();
      const res = await pending;
      expect(res.status).toBe(200);
      const errs = sseErrors(res.text);
      expect(errs).toHaveLength(1);
      expect(errs[0]).toMatchObject({
        code: 'main_analysis_running',
        draining: false,
        message: 'The analysis is still running on this book. Pause it first, then try again.',
      });
      expect(snapshotInFlightAnalysis(seed.manuscriptId)?.kind).toBe('main');
    } finally {
      endJob(main);
    }
  });

  it('main POST (start) while a subset is registered → 409 subset_analysis_running; the late check sends the same code as an SSE frame; a main POST that joins a live main is never refused', async () => {
    const supertest = (await import('supertest')).default;
    const { __testRegisterJobForTest, endJob, snapshotInFlightAnalysis } = await import('./analysis.js');
    const a = await app();
    const message = 'A chapter retry is running on this book. Wait for it to finish, then resume the analysis.';
    /* Early: 409. */
    const subset = buildJob('m_main_refused', 'subset', null);
    __testRegisterJobForTest(subset);
    try {
      const res = await supertest(a).post('/api/manuscripts/m_main_refused/analysis').send({});
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'subset_analysis_running', message });
      expect(snapshotInFlightAnalysis('m_main_refused')?.kind).toBe('subset');
    } finally {
      endJob(subset);
    }
    /* Late: SSE frame. */
    const seed = await seedBook('late-main', [1]);
    g.__rwm_phase0_selection = buildSelection(stubAnalyzer({}), 'phase0-model');
    const hydrate = gate();
    const entered = gate();
    g.__rwm_hydrate_gate = async () => {
      entered.open();
      await hydrate.promise;
    };
    const lateSubset = buildJob(seed.manuscriptId, 'subset', null);
    try {
      const pending = supertest(a).post(`/api/manuscripts/${seed.manuscriptId}/analysis`).send({}).then((x) => x);
      await entered.promise;
      __testRegisterJobForTest(lateSubset);
      hydrate.open();
      const res = await pending;
      expect(res.status).toBe(200);
      expect(sseErrors(res.text)).toEqual([{ kind: 'error', code: 'subset_analysis_running', message }]);
      expect(snapshotInFlightAnalysis(seed.manuscriptId)?.kind).toBe('subset');
    } finally {
      endJob(lateSubset);
      delete g.__rwm_hydrate_gate;
    }
    /* Join: never refused, even with a subset registered beside it. */
    const joinSeed = await seedBook('join', [1]);
    const liveMain = buildJob(joinSeed.manuscriptId, 'main', null);
    const sibling = buildJob(joinSeed.manuscriptId, 'subset', null);
    __testRegisterJobForTest(liveMain);
    __testRegisterJobForTest(sibling);
    try {
      const pending = supertest(a).post(`/api/manuscripts/${joinSeed.manuscriptId}/analysis`).send({}).then((x) => x);
      await vi.waitFor(() => expect(liveMain.subscribers.size).toBe(1), { timeout: 5_000, interval: 10 });
      endJob(liveMain, { kind: 'result' });
      const res = await pending;
      expect(res.status).toBe(200);
      expect(sseErrors(res.text)).toEqual([]);
    } finally {
      endJob(sibling);
    }
  });

  it('a non-fresh main start while a previous main drains → 409 main_analysis_running draining:true; fresh:true still displaces', async () => {
    const supertest = (await import('supertest')).default;
    const { __testRegisterJobForTest, endJob, takeWork, releaseWork } = await import('./analysis.js');
    const a = await app();
    const draining = buildJob('m_main_draining', 'main', null);
    __testRegisterJobForTest(draining);
    takeWork(draining);
    endJob(draining, { kind: 'error', code: 'aborted', message: 'x' });
    try {
      const res = await supertest(a).post('/api/manuscripts/m_main_draining/analysis').send({});
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: 'main_analysis_running',
        draining: true,
        message: 'The analysis on this book is still finishing the chapters it had started. Try again in a moment.',
      });
      const fresh = await supertest(a).post('/api/manuscripts/m_main_draining/analysis').send({ fresh: true });
      expect(fresh.status).toBe(200);
      expect(sseErrors(fresh.text).map((e) => e.code)).toEqual(['unknown_manuscript']);
    } finally {
      releaseWork(draining);
    }
  });

  it('control: a Retry when no main job exists runs exactly as today', async () => {
    const supertest = (await import('supertest')).default;
    const res = await supertest(await app())
      .post('/api/manuscripts/m_no_main_here/analysis/chapters')
      .send({ chapterIds: [1] });
    expect(res.status).toBe(200);
    expect(sseErrors(res.text).map((e) => e.code)).toEqual(['unknown_manuscript']);
  });
});
