/* #3084 wave 2b, P20 — "stop new spend" after a reasoning overflow, driven
   through runMainAnalyzerJob against a real workspace book (the harness of
   analysis.rename-midrun.test.ts: a tmpdir workspace, the analyzer/GPU mocks,
   lazy imports). A stage-2 overflow in chapter 2 ends the run while chapter 1
   is still calling the model. Chapter 1's call is aborted when the run ends
   (#3435 decision E, superseding N4's "it finishes and caches"): it caches
   nothing, starts no escalation window, and the job's terminal `halted`
   snapshot keeps its code.

   The deterministic structure engine stays ON (its default): the untagged
   quoted line below flags a crossExamine window, which is what sends a chapter
   to escalation (analysis.rename-midrun.test.ts:78-83). The positive control
   proves this fixture reaches escalation at all, so "no escalation call" in
   the overflow case cannot pass vacuously. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Analyzer, AnalyzerSelection, StageCall } from '../analyzer/index.js';
import type { CharacterOutput, Stage1ChapterOutput, Stage2ChapterOutput } from '../handoff/schemas.js';
import type { AnalysisJob } from './analysis.js';

const { detectOllamaDeviceMock, setLastKnownAnalyzerDeviceMock } = vi.hoisted(() => ({
  detectOllamaDeviceMock: vi.fn(async (): Promise<'cuda' | 'cpu' | 'unknown'> => 'cuda'),
  setLastKnownAnalyzerDeviceMock: vi.fn(),
}));
vi.mock('./ollama-health.js', () => ({
  detectOllamaDevice: detectOllamaDeviceMock,
  /* endJob calls this for engine:'local' jobs; stub it so it can never make a real HTTP unload. */
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
      if (opts.phase === 'phase1' && g.__overflow_spend_test_phase1_selection) {
        return g.__overflow_spend_test_phase1_selection;
      }
      return actual.selectAnalyzerForPhase(opts as Parameters<typeof actual.selectAnalyzerForPhase>[0]);
    },
    /* Sequential mode, unless a case sets __overflow_spend_test_pipelined: the
       Phase-0 dispatch check is reachable only in pipelined mode (P20). */
    isPerPhaseModelSelectionActive: () =>
      (globalThis as Record<string, unknown>).__overflow_spend_test_pipelined === true,
  };
});

/* Passthrough spy: reports every save that already carries Phase 0b's stage1 roster. Reading the
   cache FILE instead is racy — Phase 1's own saves of the shared cache object can land after (and
   clobber) Phase 0b's write, so the file can lack stage1 even though Phase 0b ran. */
vi.mock('../store/analysis-cache.js', async () => {
  const actual = await vi.importActual<typeof import('../store/analysis-cache.js')>('../store/analysis-cache.js');
  return {
    ...actual,
    saveAnalysisCache: async (...args: Parameters<typeof actual.saveAnalysisCache>) => {
      /* A case sets this to make chosen saves throw (fs failure: ENOSPC, rename retries exhausted). */
      await (globalThis as Record<string, unknown> & { __overflow_spend_test_save_hook?: (c: typeof args[1]) => void | Promise<void> }).__overflow_spend_test_save_hook?.(args[1]);
      if (args[1].stage1) (globalThis as Record<string, unknown> & { __overflow_spend_test_stage1_saved?: () => void }).__overflow_spend_test_stage1_saved?.();
      return actual.saveAnalysisCache(...args);
    },
  };
});

const AUTHOR = 'Overflow Spend Author';
const SERIES = 'Standalones';
const MODEL = 'gemini-3.6-flash';
/* Untagged quoted dialogue. The evidence quote verbatim-matches each body, so
   Phase 0b keeps `nova`; the missing dialogue tag leaves a window crossExamine
   flags for escalation. Chapter 3 is used only by the pipelined Phase-0 case. */
const BODIES: Record<number, string> = {
  1: '"The plan is set." Silence followed.',
  2: '"The plan is set." Nobody moved.',
  3: '"The plan is set." Nobody spoke.',
};
const CHAPTER_TITLES: Record<number, string> = { 1: 'Chapter One', 2: 'Chapter Two', 3: 'Chapter Three' };

let workspaceRoot: string;
const originalConcurrency = process.env.ANALYZER_OLLAMA_CONCURRENCY;
const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-overflow-spend-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Both pools size from analyzerPoolWidth() (analysis.ts:1277-1280): 2 puts
     both chapters in flight at once. */
  process.env.ANALYZER_OLLAMA_CONCURRENCY = '2';
  process.env.STAGE2_COVERAGE_RETRIES = '0';
});

/* Warm the cold `./analysis.js` import once, with a generous budget, so the
   first case doesn't pay it inside its own timeout (flaky under CPU load). */
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
  delete (globalThis as Record<string, unknown>).__overflow_spend_test_phase1_selection;
  delete (globalThis as Record<string, unknown>).__overflow_spend_test_pipelined;
  delete (globalThis as Record<string, unknown>).__overflow_spend_test_save_hook;
});

function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
  return { analyzer, engine: 'gemini', model, fallbackModel: null };
}

function stage2For(chapterId: number): Stage2ChapterOutput {
  return {
    sentences: [{ id: chapterId * 100 + 1, chapterId, characterId: 'nova', confidence: 0.9, text: BODIES[chapterId] }],
  };
}

/** The roster the Phase-0 stub returns and the seeded cache below carries. Its
    evidence quote appears verbatim in every BODIES entry, so Phase 0b's
    verifyEvidenceAgainstSource / dropEvidencelessCast keep it. */
function novaCharacter(): CharacterOutput {
  return { id: 'nova', name: 'Nova', role: 'character', color: '#abc', evidence: [{ quote: 'The plan is set.' }] };
}

function stubAnalyzer(over: Partial<Analyzer>): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () => Promise.reject(new Error('not used')),
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

/** A workspace book (chapters 1 and 2 unless `chapterIds` says otherwise), its
    ManuscriptRecord, a main job and the Phase-0 selection.

    `opts.fullCache` additionally seeds a cache that already carries Phase 0's
    stage1. Without it the SUBSET cases never reach their Phase-1 loop —
    runSubsetAnalyzerJob bails at `!stage1Existed`, so `toRun` is never
    dispatched. The main-route cases build their own cache state. Mirrors the
    subset fixture in analysis.merge-base-detect.test.ts:646-650, which seeds
    stage1 for the same branch. */
async function seedBook(
  label: string,
  chapterIds: readonly number[] = [1, 2],
  opts: { fullCache?: boolean; unconfirmed?: boolean } = {},
): Promise<{
  manuscriptId: string;
  bookDir: string;
  job: AnalysisJob;
  phase0Selection: AnalyzerSelection;
}> {
  const manuscriptId = `test-overflow-spend-${label}-${Date.now()}-${Math.random()}`;
  const title = `Overflow Spend ${label}`;
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
      /* `unconfirmed`: a book that has not reached Confirm (#3435 decision F),
         so the subset result gate S14 is not relaxed for it (O2). */
      castConfirmed: !opts.unconfirmed,
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

  if (opts.fullCache) {
    /* The subset (Retry) route only reaches Phase 1 on a book whose cache
       already looks like a finished main run: `stage1Existed = !!cache.stage1`
       is the clean signal that picks flow (a) — attribute the new chapters —
       over flow (b), which ends after Phase 0a (analysis.ts:7104-7119). Seeding
       `{ chapters: {}, stage1 }` is exactly what analysis.merge-base-detect.test.ts
       seeds for the same route (:650). Phase 0a still runs for every toRun
       chapter and fills chapterCast, so the coverage gate past it passes. */
    const { saveAnalysisCache } = await import('../store/analysis-cache.js');
    await saveAnalysisCache(manuscriptId, {
      chapters: {},
      stage1: {
        characters: [novaCharacter()],
        chapters: chapterIds.map((id) => ({ id, title: CHAPTER_TITLES[id] })),
      },
    });
  }

  const phase0Analyzer = stubAnalyzer({
    async runStage1Chapter(): Promise<Stage1ChapterOutput> {
      return { characters: [novaCharacter()] };
    },
    runStage2Chapter: () => Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
  });

  const job = {
    controller: new AbortController(),
    subscribers: new Set(),
    manuscriptId,
    kind: 'main',
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

  return { manuscriptId, bookDir, job, phase0Selection: buildSelection(phase0Analyzer, 'phase0-model') };
}

interface CapturedEvent {
  kind: string;
  code?: string;
  [k: string]: unknown;
}

function captureEvents(job: AnalysisJob, onError?: () => void): CapturedEvent[] {
  const events: CapturedEvent[] = [];
  const keepAlive = setInterval(() => {}, 100_000);
  clearInterval(keepAlive);
  job.subscribers.add({
    send: (payload: unknown) => {
      const ev = payload as CapturedEvent;
      events.push(ev);
      if (ev.kind === 'error') onError?.();
    },
    res: { end: () => {} } as unknown as import('express').Response,
    keepAlive,
  });
  return events;
}

describe('a reasoning overflow stops new spend and aborts work in flight (#3084 P20, #3435 decision E)', () => {
  it('positive control: with no overflow, this fixture reaches attribution escalation', async () => {
    const seed = await seedBook('control');
    const escalate = vi.fn(async () => null);
    (globalThis as Record<string, unknown>).__overflow_spend_test_phase1_selection = buildSelection(
      stubAnalyzer({ runAttributionEscalation: escalate }),
      MODEL,
    );
    const { runMainAnalyzerJob } = await import('./analysis.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { clearAnalysisCache } = await import('../store/analysis-cache.js');
    try {
      await runMainAnalyzerJob(seed.job, getManuscript(seed.manuscriptId)! as never, seed.phase0Selection, {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });
      /* If this fails, the fixture no longer flags a window: fix the fixture
         before trusting the overflow case's "no escalation call". */
      expect(escalate).toHaveBeenCalled();
    } finally {
      removeManuscript(seed.manuscriptId);
      await clearAnalysisCache(seed.manuscriptId);
    }
  }, 30_000);

  it("after a stage-2 overflow in chapter 2, chapter 1's in-flight call is aborted, chapter 1 is not cached, no escalation window starts, and the halted snapshot keeps its code", async () => {
    const seed = await seedBook('overflow');
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    const escalate = vi.fn(async () => null);
    let markChapterOneInFlight!: () => void;
    const chapterOneInFlight = new Promise<void>((resolve) => {
      markChapterOneInFlight = resolve;
    });
    let markRunEnded!: () => void;
    const runEnded = new Promise<void>((resolve) => {
      markRunEnded = resolve;
    });
    const { AnalysisAbortedError } = await import('../analyzer/errors.js');
    let chapterOneAborted = false;
    (globalThis as Record<string, unknown>).__overflow_spend_test_phase1_selection = buildSelection(
      stubAnalyzer({
        runAttributionEscalation: escalate,
        async runStage2Chapter(_m: string, chapterId: number, _p: string, call: StageCall): Promise<Stage2ChapterOutput> {
          if (chapterId === 2) {
            await chapterOneInFlight;
            throw new AnalyzerReasoningOverflowError('gemini', MODEL, 8100);
          }
          markChapterOneInFlight();
          /* Chapter 1's model call would return only after the run has ended on chapter 2's
             overflow; it rejects as soon as the job's signal aborts. */
          await new Promise<void>((resolve, reject) => {
            call.signal?.addEventListener(
              'abort',
              () => {
                chapterOneAborted = true;
                reject(new AnalysisAbortedError('aborted by the job signal'));
              },
              { once: true },
            );
            void runEnded.then(() => setTimeout(resolve, 200));
          });
          return stage2For(1);
        },
      }),
      MODEL,
    );
    const events = captureEvents(seed.job, markRunEnded);
    const { runMainAnalyzerJob } = await import('./analysis.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { clearAnalysisCache, loadAnalysisCache } = await import('../store/analysis-cache.js');
    const { analysisStateJsonPath } = await import('../workspace/paths.js');
    try {
      await runMainAnalyzerJob(seed.job, getManuscript(seed.manuscriptId)! as never, seed.phase0Selection, {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });
      /* The run ended on the overflow while chapter 1 was still in flight. */
      expect(events.filter((e) => e.kind === 'error').map((e) => e.code)).toEqual(['analyzer-reasoning-overflow']);
      expect(seed.job.reasoningOverflowed).toBe(true);
      // #3084 F7 — end to end through the real Phase-1 pool catch, not just the unit helper.
      expect(seed.job.reasoningOverflowChapter).toEqual({ id: 2, title: 'Chapter Two' });
      // #3084 F7 — the terminal handler passed that chapter to classifyAnalysisFailure,
      // so the SSE error's message names it by title rather than saying "a chapter".
      expect(events.find((e) => e.kind === 'error')!.message).toContain('chapter "Chapter Two"');

      /* #3435 decision E — the run's end aborted chapter 1's call: it caches nothing (the
         call would have returned 200 ms after the run ended; wait past that). */
      expect(seed.job.controller.signal.aborted).toBe(true);
      await vi.waitFor(() => expect(chapterOneAborted).toBe(true), { timeout: 5_000, interval: 20 });
      await new Promise((r) => setTimeout(r, 500));
      expect((await loadAnalysisCache(seed.manuscriptId)).chapters?.[1]).toBeUndefined();
      /* P20 — and it started no escalation window. */
      expect(escalate).not.toHaveBeenCalled();
      expect(events.some((e) => e.kind === 'result')).toBe(false);

      /* Read the persisted snapshot, not only the first event: nothing after the end may
         overwrite the terminal state or its code. endJob's snapshot write is fire-and-forget,
         so under load it can land after a fixed sleep: wait for the halted write first. */
      await vi.waitFor(
        () =>
          expect(JSON.parse(readFileSync(analysisStateJsonPath(seed.bookDir), 'utf8'))).toMatchObject({
            state: 'halted',
          }),
        { timeout: 5_000, interval: 50 },
      );
      await new Promise((r) => setTimeout(r, 500));
      expect(existsSync(analysisStateJsonPath(seed.bookDir))).toBe(true);
      expect(JSON.parse(readFileSync(analysisStateJsonPath(seed.bookDir), 'utf8'))).toMatchObject({
        state: 'halted',
        haltCode: 'analyzer-reasoning-overflow',
      });
    } finally {
      markRunEnded();
      removeManuscript(seed.manuscriptId);
      await clearAnalysisCache(seed.manuscriptId);
    }
  }, 30_000);

  it('a direct stage-2 overflow on the subset (Retry) route names its chapter — no catch existed for this before (#3084 F7)', async () => {
    /* #3084 F7 — runSubsetAnalyzerJob's real signature at 80be2f1d
       (analysis.ts:6796-6802): (job, record, selection, phase1Selection,
       toRun, allowStage1ShrinkSubset). Unlike runMainAnalyzerJob, it takes
       phase1Selection as a direct parameter (phase1Analyzer =
       phase1Selection.analyzer at :6849), so the stub goes there — no
       __overflow_spend_test_phase1_selection global hook needed here; that
       hook exists only for the main-route tests above, whose
       runMainAnalyzerJob resolves phase 1's selection internally.
       This route only reaches Phase 1 on a book whose cache already carries a
       finished `stage1` — hence `fullCache` here (see seedBook). */
    const seed = await seedBook('subset-overflow', [1, 2], { fullCache: true });
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { runSubsetAnalyzerJob } = await import('./analysis.js');
    const record = getManuscript(seed.manuscriptId)!;
    const subsetJob = { ...seed.job, kind: 'subset' as const };
    const phase1Selection = buildSelection(
      stubAnalyzer({
        async runStage2Chapter(_m: string, chapterId: number, _p: string, _call: StageCall): Promise<Stage2ChapterOutput> {
          if (chapterId === 2) throw new AnalyzerReasoningOverflowError('gemini', MODEL, 8100);
          return stage2For(1);
        },
      }),
      MODEL,
    );
    const events = captureEvents(subsetJob, () => {});
    try {
      await runSubsetAnalyzerJob(
        subsetJob,
        record,
        seed.phase0Selection,
        phase1Selection,
        record.chapterHints, // toRun: both seeded chapters, matching seedBook('subset-overflow', [1, 2])
        false, // allowStage1ShrinkSubset
      );
      expect(events.filter((e) => e.kind === 'error').map((e) => e.code)).toEqual(['analyzer-reasoning-overflow']);
      // Before this task's fix, the subset route's Phase-1 loop had no catch
      // at all around attributeChapterStage2WithEval, so this throw reached
      // the terminal handler with reasoningOverflowChapter still unset.
      expect(subsetJob.reasoningOverflowChapter).toEqual({ id: 2, title: 'Chapter Two' });
      expect(events.find((e) => e.kind === 'error')!.message).toContain('chapter "Chapter Two"');
    } finally {
      removeManuscript(seed.manuscriptId);
    }
  }, 30_000);

  /* #3084 P20 — an escalation call that overflows is swallowed inside
     StageRunner.runSingleAttempt (it returns null), which first reports it
     through StageCall.onReasoningOverflow. These stubs honour that contract
     (stage-runner.test.ts and escalation.test.ts pin the runner half), so the
     cases below prove the ROUTE passes the hook and that the hook stops every
     later window. Pool width 1 runs the two chapters one after the other, so
     the first escalation call is the only one in flight when it overflows. */
  async function runEscalationCase(
    route: 'main' | 'subset',
    overflow: boolean,
  ): Promise<{
    escalate: ReturnType<typeof vi.fn>;
    stage2: ReturnType<typeof vi.fn>;
    job: AnalysisJob;
    events: CapturedEvent[];
    bookDir: string;
  }> {
    /* The subset route needs the finished-cache seed to reach Phase 1 at all
       (see seedBook's `fullCache`); the main route reaches it from an empty
       cache, so its cases keep the original fixture. */
    const seed = await seedBook(`esc-${route}-${overflow ? 'overflow' : 'control'}`, [1, 2], {
      fullCache: route === 'subset',
    });
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    const escalate = vi.fn(async (_m: string, _chapterId: number, _w: number, _p: string, call: StageCall) => {
      if (overflow) call.onReasoningOverflow?.(new AnalyzerReasoningOverflowError('gemini', MODEL, 8100));
      return null;
    });
    const stage2 = vi.fn(async (_m: string, chapterId: number): Promise<Stage2ChapterOutput> => stage2For(chapterId));
    const phase1Selection = buildSelection(stubAnalyzer({ runAttributionEscalation: escalate, runStage2Chapter: stage2 }), MODEL);
    const { runMainAnalyzerJob, runSubsetAnalyzerJob } = await import('./analysis.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { clearAnalysisCache } = await import('../store/analysis-cache.js');
    process.env.ANALYZER_OLLAMA_CONCURRENCY = '1';
    try {
      const record = getManuscript(seed.manuscriptId)!;
      if (route === 'main') {
        (globalThis as Record<string, unknown>).__overflow_spend_test_phase1_selection = phase1Selection;
        const events = captureEvents(seed.job);
        await runMainAnalyzerJob(seed.job, record as never, seed.phase0Selection, {
          requestedFresh: true,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });
        return { escalate, stage2, job: seed.job, events, bookDir: seed.bookDir };
      }
      /* The subset route runs Phase 0 over toRun itself, then attributes
         chapters 1 and 2 one at a time with its own inline Phase-1 StageCall
         (escalation at its default 'local' mode uses that same phase1Selection
         analyzer, attributeChapterStage2's `opts.analyzer`). */
      const job = { ...seed.job, kind: 'subset', subsetChapterIds: [1, 2] } as unknown as AnalysisJob;
      const events = captureEvents(job);
      await runSubsetAnalyzerJob(job, record as never, seed.phase0Selection, phase1Selection, record.chapterHints, false);
      return { escalate, stage2, job, events, bookDir: seed.bookDir };
    } finally {
      process.env.ANALYZER_OLLAMA_CONCURRENCY = '2';
      removeManuscript(seed.manuscriptId);
      await clearAnalysisCache(seed.manuscriptId);
    }
  }

  for (const route of ['main', 'subset'] as const) {
    it(`${route} route: after one escalation call overflows, no later chapter sends an escalation window (#3084 P20)`, async () => {
      /* Positive control: with no overflow, both chapters send at least one
         window, so "exactly one call" below cannot pass vacuously. */
      const control = await runEscalationCase(route, false);
      expect(new Set(control.escalate.mock.calls.map((c) => c[1]))).toEqual(new Set([1, 2]));
      expect(control.job.reasoningOverflowed).toBeUndefined();

      const { escalate, job } = await runEscalationCase(route, true);
      expect(escalate).toHaveBeenCalledTimes(1);
      expect(job.reasoningOverflowed).toBe(true);
      /* #3435 decision E — every ending aborts the job's controller (N4 no longer holds). */
      expect(job.controller.signal.aborted).toBe(true);
    }, 60_000);

    /* #3084 P20 — the dispatch check. An overflow that only escalation saw is swallowed by
       the runner, so no pool rethrow stops the run; the check before each chapter dispatch
       does. Pool width 1: chapter 1 (whose escalation call overflowed) has finished and
       cached before chapter 2 is due. */
    it(`${route} route: after one escalation overflow in chapter 1, chapter 2's stage-2 call is never sent and the run halts with analyzer-reasoning-overflow (#3084 P20)`, async () => {
      /* Positive control: with no overflow, chapter 2's stage-2 call is sent, so "never
         sent" below cannot pass vacuously. */
      const control = await runEscalationCase(route, false);
      expect(new Set(control.stage2.mock.calls.map((c) => c[1]))).toEqual(new Set([1, 2]));

      const { stage2, events, job, bookDir } = await runEscalationCase(route, true);
      const stage2Chapters = stage2.mock.calls.map((c) => c[1]);
      expect(stage2Chapters).toContain(1);
      expect(stage2Chapters).not.toContain(2);
      expect(events.filter((e) => e.kind === 'error').map((e) => e.code)).toEqual(['analyzer-reasoning-overflow']);
      expect(events.some((e) => e.kind === 'result')).toBe(false);
      /* #3435 decision E — every ending aborts the job's controller (N4 no longer holds). */
      expect(job.controller.signal.aborted).toBe(true);
      /* endJob's snapshot write is fire-and-forget. */
      const { analysisStateJsonPath } = await import('../workspace/paths.js');
      await vi.waitFor(
        () =>
          expect(JSON.parse(readFileSync(analysisStateJsonPath(bookDir), 'utf8'))).toMatchObject({
            state: 'halted',
            haltCode: 'analyzer-reasoning-overflow',
          }),
        { timeout: 5_000, interval: 50 },
      );
    }, 60_000);
  }

  /* #3084 P20 — the Phase-0 dispatch check, reachable only in pipelined mode, where Phase 1
     escalates while Phase 0 is still dispatching cast chapters. Lag 0 and pool width 1:
     Phase 1 chapter 1 starts once Phase 0 chapter 1 completes. Phase 0 chapter 2's cast call
     is held until chapter 1's escalation call has run, so the Phase-0 pool's next dispatch
     (chapter 3) comes after the job is marked. A fail-safe timer opens the hold, so a fixture
     that never reaches escalation fails the control's assertions instead of hanging. */
  async function runPipelinedCase(overflow: boolean): Promise<{
    castCalls: number[];
    escalate: ReturnType<typeof vi.fn>;
    events: CapturedEvent[];
    job: AnalysisJob;
  }> {
    const seed = await seedBook(`pipelined-${overflow ? 'overflow' : 'control'}`, [1, 2, 3]);
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    let openChapterTwoCast!: () => void;
    const chapterTwoCastHeld = new Promise<void>((resolve) => {
      openChapterTwoCast = resolve;
    });
    const failSafe = setTimeout(() => openChapterTwoCast(), 20_000);
    const castCalls: number[] = [];
    const phase0Analyzer = stubAnalyzer({
      async runStage1Chapter(_m: string, chapterId: number): Promise<Stage1ChapterOutput> {
        castCalls.push(chapterId);
        if (chapterId === 2) await chapterTwoCastHeld;
        return {
          characters: [
            { id: 'nova', name: 'Nova', role: 'character', color: '#abc', evidence: [{ quote: 'The plan is set.' }] },
          ],
        };
      },
      runStage2Chapter: () => Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
    });
    const escalate = vi.fn(async (_m: string, _chapterId: number, _w: number, _p: string, call: StageCall) => {
      if (overflow) call.onReasoningOverflow?.(new AnalyzerReasoningOverflowError('gemini', MODEL, 8100));
      openChapterTwoCast();
      return null;
    });
    const g = globalThis as Record<string, unknown>;
    g.__overflow_spend_test_phase1_selection = buildSelection(stubAnalyzer({ runAttributionEscalation: escalate }), MODEL);
    g.__overflow_spend_test_pipelined = true;
    const originalMinLag = process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS;
    process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS = '0';
    process.env.ANALYZER_OLLAMA_CONCURRENCY = '1';
    const events = captureEvents(seed.job);
    const { runMainAnalyzerJob } = await import('./analysis.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { clearAnalysisCache } = await import('../store/analysis-cache.js');
    try {
      await runMainAnalyzerJob(seed.job, getManuscript(seed.manuscriptId)! as never, buildSelection(phase0Analyzer, 'phase0-model'), {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });
      /* The run can end on Phase 1's own dispatch check while Phase 0 chapter 2 is still
         finishing. A Phase-0 dispatch the check failed to stop lands after that. */
      await new Promise((r) => setTimeout(r, 500));
      return { castCalls, escalate, events, job: seed.job };
    } finally {
      clearTimeout(failSafe);
      openChapterTwoCast();
      process.env.ANALYZER_OLLAMA_CONCURRENCY = '2';
      restoreEnv('ANALYZER_PHASE1_MIN_LAG_CHAPTERS', originalMinLag);
      delete g.__overflow_spend_test_pipelined;
      removeManuscript(seed.manuscriptId);
      await clearAnalysisCache(seed.manuscriptId);
    }
  }

  it('pipelined main route: after an escalation overflow, Phase 0 starts no further cast chapter and the run halts with analyzer-reasoning-overflow (#3084 P20)', async () => {
    /* Positive control: with no overflow, the fixture reaches escalation in pipelined mode
       and Phase 0 casts chapter 3, so "never cast" below cannot pass vacuously. */
    const control = await runPipelinedCase(false);
    expect(control.escalate).toHaveBeenCalled();
    expect(control.castCalls).toContain(3);

    const run = await runPipelinedCase(true);
    expect(run.escalate).toHaveBeenCalledTimes(1);
    expect(run.castCalls).not.toContain(3);
    expect(run.events.filter((e) => e.kind === 'error').map((e) => e.code)).toEqual(['analyzer-reasoning-overflow']);
    /* #3435 decision E — every ending aborts the job's controller (N4 no longer holds). */
    expect(run.job.controller.signal.aborted).toBe(true);
  }, 90_000);

  /* #3084 P20 — the check after the Phase-0 pool joins. Here the overflow lands while the LAST
     Phase-0 chapter (2) is still casting, so the per-chapter dispatch check (already passed for
     chapter 2) cannot catch it. Without the tail check the run still ends with the overflow
     code (via Phase 1's own checks), but Phase 0b runs anyway after chapter 2 finishes and
     persists `cache.stage1`; with it, Phase 0b is skipped. */
  it('pipelined main route: an overflow recorded while the last Phase-0 chapter casts skips Phase 0b (#3084 P20)', async () => {
    const seed = await seedBook('pipelined-phase0b-skip', [1, 2]);
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    let openChapterTwoCast!: () => void;
    const chapterTwoCastHeld = new Promise<void>((resolve) => {
      openChapterTwoCast = resolve;
    });
    const failSafe = setTimeout(() => openChapterTwoCast(), 20_000);
    const phase0Analyzer = stubAnalyzer({
      async runStage1Chapter(_m: string, chapterId: number): Promise<Stage1ChapterOutput> {
        if (chapterId === 2) await chapterTwoCastHeld;
        return { characters: [novaCharacter()] };
      },
      runStage2Chapter: () => Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
    });
    const escalate = vi.fn(async (_m: string, _chapterId: number, _w: number, _p: string, call: StageCall) => {
      /* Pool width 2 (below) dispatches both cast chapters up front, so chapter 2's cast call is
         already held in flight — every Phase-0 dispatch check has passed — before Phase 1 can
         start, and nothing here has to wait for it (a wait would deadlock a shared call slot). */
      call.onReasoningOverflow?.(new AnalyzerReasoningOverflowError('gemini', MODEL, 8100));
      openChapterTwoCast();
      return null;
    });
    const g = globalThis as Record<string, unknown>;
    g.__overflow_spend_test_phase1_selection = buildSelection(stubAnalyzer({ runAttributionEscalation: escalate }), MODEL);
    g.__overflow_spend_test_pipelined = true;
    const originalMinLag = process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS;
    process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS = '0';
    let stage1Saved = false;
    let onStage1Saved!: () => void;
    const stage1SavedP = new Promise<void>((resolve) => {
      onStage1Saved = resolve;
    });
    g.__overflow_spend_test_stage1_saved = () => {
      stage1Saved = true;
      onStage1Saved();
    };
    const events = captureEvents(seed.job);
    const { runMainAnalyzerJob } = await import('./analysis.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { clearAnalysisCache } = await import('../store/analysis-cache.js');
    try {
      await runMainAnalyzerJob(seed.job, getManuscript(seed.manuscriptId)! as never, buildSelection(phase0Analyzer, 'phase0-model'), {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });
      /* The run can end on Phase 1's own check while Phase 0 chapter 2 is still finishing. A
         Phase 0b the tail check failed to stop resolves the latch as soon as it saves; the bound
         only limits how long the absence case waits. */
      await Promise.race([stage1SavedP, new Promise((r) => setTimeout(r, 1_500))]);
      expect(escalate).toHaveBeenCalledTimes(1);
      expect(events.filter((e) => e.kind === 'error').map((e) => e.code)).toEqual(['analyzer-reasoning-overflow']);
      expect(stage1Saved).toBe(false);
    } finally {
      delete g.__overflow_spend_test_stage1_saved;
      clearTimeout(failSafe);
      openChapterTwoCast();
      process.env.ANALYZER_OLLAMA_CONCURRENCY = '2';
      restoreEnv('ANALYZER_PHASE1_MIN_LAG_CHAPTERS', originalMinLag);
      delete g.__overflow_spend_test_pipelined;
      removeManuscript(seed.manuscriptId);
      await clearAnalysisCache(seed.manuscriptId);
    }
  }, 60_000);

  /* #3084 P20 — Tail-call gap detection: escalation overflows that occur after
     the last chapter dispatch (or after all in-flight dispatches join) were not
     checked, so the job ended as SUCCESS even though reasoningOverflowed was true.
     These three cases exercise the three tail gaps:
     1. Main route: overflow in chapter 2 (last) at pool width 1 (after Phase 1 pool joins)
     2. Main route: overflow in chapter 1 while chapter 2 in flight (width 2) (after pool joins)
     3. Subset route: overflow in chapter 2 (last) at width 1 (after subset loop)
  */
  async function runTailCase(
    route: 'main' | 'subset',
    overflowOnChapter: number,
    poolWidth: string,
  ): Promise<{ escalate: ReturnType<typeof vi.fn>; stage2: ReturnType<typeof vi.fn>; job: AnalysisJob; events: CapturedEvent[]; bookDir: string }> {
    const seed = await seedBook(`tail-${route}-${overflowOnChapter}-${poolWidth}`, [1, 2], { fullCache: route === 'subset' });
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    const escalate = vi.fn(async (_m: string, chapterId: number, _w: number, _p: string, call: StageCall) => {
      if (chapterId === overflowOnChapter) call.onReasoningOverflow?.(new AnalyzerReasoningOverflowError('gemini', MODEL, 8100));
      return null;
    });
    const stage2 = vi.fn(async (_m: string, chapterId: number): Promise<Stage2ChapterOutput> => stage2For(chapterId));
    const phase1Selection = buildSelection(stubAnalyzer({ runAttributionEscalation: escalate, runStage2Chapter: stage2 }), MODEL);
    const { runMainAnalyzerJob, runSubsetAnalyzerJob } = await import('./analysis.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { clearAnalysisCache } = await import('../store/analysis-cache.js');
    process.env.ANALYZER_OLLAMA_CONCURRENCY = poolWidth;
    try {
      const record = getManuscript(seed.manuscriptId)!;
      if (route === 'main') {
        (globalThis as Record<string, unknown>).__overflow_spend_test_phase1_selection = phase1Selection;
        const events = captureEvents(seed.job);
        await runMainAnalyzerJob(seed.job, record as never, seed.phase0Selection, {
          requestedFresh: true,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });
        return { escalate, stage2, job: seed.job, events, bookDir: seed.bookDir };
      }
      const job = { ...seed.job, kind: 'subset', subsetChapterIds: [1, 2] } as unknown as AnalysisJob;
      const events = captureEvents(job);
      await runSubsetAnalyzerJob(job, record as never, seed.phase0Selection, phase1Selection, record.chapterHints, false);
      return { escalate, stage2, job, events, bookDir: seed.bookDir };
    } finally {
      process.env.ANALYZER_OLLAMA_CONCURRENCY = '2';
      removeManuscript(seed.manuscriptId);
      await clearAnalysisCache(seed.manuscriptId);
    }
  }

  describe('tail-call overflow gap (no dispatch check after the final chapter)', () => {
    for (const route of ['main', 'subset'] as const) {
      it(`${route}: overflow in the LAST chapter's escalation (pool width 1) — #3084 P20`, async () => {
        const r = await runTailCase(route, 2, '1');
        expect(r.job.reasoningOverflowed).toBe(true);
        expect(r.events.filter((e) => e.kind === 'error').map((e) => e.code)).toEqual(['analyzer-reasoning-overflow']);
        expect(r.events.some((e) => e.kind === 'result')).toBe(false);
      }, 60_000);
    }

    it('main: overflow in chapter 1 escalation while chapter 2 in flight (pool width 2) — #3084 P20', async () => {
      const r = await runTailCase('main', 1, '2');
      expect(r.job.reasoningOverflowed).toBe(true);
      expect(r.events.filter((e) => e.kind === 'error').map((e) => e.code)).toEqual(['analyzer-reasoning-overflow']);
      expect(r.events.some((e) => e.kind === 'result')).toBe(false);
    }, 60_000);
  });

  /* #3084 P20 — the Signal-2 non-story classifier runs AFTER both tail checks, so
     an overflow only it sees cannot halt the run (owner decision: warn, don't
     halt). The run completes and the client gets ONE non-fatal warning. Chapter 2
     attributed to the narrator leaves `nova` in a single (front) chapter, which
     is what makes the third-party guard consult the classifier at all. */
  async function runClassifierCase(
    route: 'main' | 'subset',
    opts: { classifierOverflows: boolean; escalationOverflowsOnChapter?: number },
  ): Promise<{ classify: ReturnType<typeof vi.fn>; job: AnalysisJob; events: CapturedEvent[] }> {
    const seed = await seedBook(
      `cls-${route}-${opts.classifierOverflows}-${opts.escalationOverflowsOnChapter ?? 'x'}`,
      [1, 2],
      { fullCache: route === 'subset' },
    );
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    const classify = vi.fn(async () => {
      if (opts.classifierOverflows) throw new AnalyzerReasoningOverflowError('gemini', MODEL, 8100);
      return { nonStory: false };
    });
    const escalate = vi.fn(async (_m: string, chapterId: number, _w: number, _p: string, call: StageCall) => {
      if (chapterId === opts.escalationOverflowsOnChapter) {
        call.onReasoningOverflow?.(new AnalyzerReasoningOverflowError('gemini', MODEL, 8100));
      }
      return null;
    });
    const stage2 = async (_m: string, chapterId: number): Promise<Stage2ChapterOutput> =>
      chapterId === 2
        ? { sentences: [{ id: 201, chapterId: 2, characterId: 'narrator', confidence: 0.9, text: BODIES[2] }] }
        : stage2For(chapterId);
    const phase1Selection = buildSelection(stubAnalyzer({ runAttributionEscalation: escalate, runStage2Chapter: stage2 }), MODEL);
    const phase0Selection = buildSelection(
      stubAnalyzer({
        async runStage1Chapter(): Promise<Stage1ChapterOutput> {
          return { characters: [novaCharacter()] };
        },
        runStage2Chapter: () => Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
        runNonStoryClassification: classify as never,
      } as Partial<Analyzer>),
      'phase0-model',
    );
    const { runMainAnalyzerJob, runSubsetAnalyzerJob } = await import('./analysis.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { clearAnalysisCache } = await import('../store/analysis-cache.js');
    process.env.ANALYZER_OLLAMA_CONCURRENCY = '1';
    try {
      const record = getManuscript(seed.manuscriptId)!;
      if (route === 'main') {
        (globalThis as Record<string, unknown>).__overflow_spend_test_phase1_selection = phase1Selection;
        const events = captureEvents(seed.job);
        await runMainAnalyzerJob(seed.job, record as never, phase0Selection, {
          requestedFresh: true,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });
        return { classify, job: seed.job, events };
      }
      const job = { ...seed.job, kind: 'subset', subsetChapterIds: [1, 2] } as unknown as AnalysisJob;
      const events = captureEvents(job);
      await runSubsetAnalyzerJob(job, record as never, phase0Selection, phase1Selection, record.chapterHints, false);
      return { classify, job, events };
    } finally {
      process.env.ANALYZER_OLLAMA_CONCURRENCY = '2';
      removeManuscript(seed.manuscriptId);
      await clearAnalysisCache(seed.manuscriptId);
    }
  }

  describe('a reasoning overflow only the non-story classifier saw (#3084 P20, owner: warn, do not halt)', () => {
    for (const route of ['main', 'subset'] as const) {
      it(`${route}: the run still sends its result with no error, and exactly one warning names the title-only fallback`, async () => {
        /* Positive control: the fixture consults the classifier, and a clean
           classifier run emits no warning, so "one warning" cannot pass vacuously. */
        const control = await runClassifierCase(route, { classifierOverflows: false });
        expect(control.classify).toHaveBeenCalled();
        expect(control.events.filter((e) => e.kind === 'warning')).toEqual([]);

        const r = await runClassifierCase(route, { classifierOverflows: true });
        expect(r.classify).toHaveBeenCalled();
        expect(r.job.reasoningOverflowed).toBe(true);
        expect(r.events.filter((e) => e.kind === 'error')).toEqual([]);
        expect(r.events.some((e) => e.kind === 'result')).toBe(true);
        const warnings = r.events.filter((e) => e.kind === 'warning');
        expect(warnings).toHaveLength(1);
        expect(warnings[0].code).toBe('analyzer-reasoning-overflow-nonstory');
        expect(warnings[0].message).toMatch(/front-matter/i);
        expect(warnings[0].message).toMatch(/chapter titles only/i);
        /* Gemini at Auto: the fixes list omits the output-cap entry (nothing to
           raise), so the warning must not advise it either (#3084 pass-3). */
        expect(warnings[0].message).not.toMatch(/num_predict|max output tokens/i);
        expect(warnings[0].message).toMatch(/different analyzer model/i);
      }, 60_000);

      it(`${route}: a run an earlier overflow already halted emits no non-story warning`, async () => {
        const r = await runClassifierCase(route, { classifierOverflows: true, escalationOverflowsOnChapter: 2 });
        expect(r.events.filter((e) => e.kind === 'error').map((e) => e.code)).toEqual(['analyzer-reasoning-overflow']);
        expect(r.events.some((e) => e.kind === 'result')).toBe(false);
        expect(r.events.filter((e) => e.kind === 'warning')).toEqual([]);
      }, 60_000);
    }
  });
});

/* #3084 pass-3 — the non-story warning's advice is built from the SAME source as
   the fixes list, so it cannot drift from it. */
describe('nonStoryOverflowWarningMessage — advice follows the fixes list (#3084 pass-3)', () => {
  afterEach(() => {
    delete process.env.ANALYZER_NUM_PREDICT;
    delete process.env.ANALYZER_MAX_OUTPUT_TOKENS;
  });

  it('Ollama at the default num_predict names num_ctx and not num_predict; a positive cap names num_predict', async () => {
    const { nonStoryOverflowWarningMessage } = await import('./analysis.js');
    const ctx = { transport: 'ollama' as const, model: 'qwen3.5:9b' };
    const dflt = nonStoryOverflowWarningMessage(ctx);
    expect(dflt).toMatch(/num_ctx/);
    expect(dflt).not.toMatch(/num_predict/);
    process.env.ANALYZER_NUM_PREDICT = '2048';
    expect(nonStoryOverflowWarningMessage(ctx)).toMatch(/num_predict/);
  });

  it('Gemini names the output cap only when the fixes list does (pinned below the known limit)', async () => {
    const { nonStoryOverflowWarningMessage } = await import('./analysis.js');
    const { _seedGeminiCatalogForTest, _resetGeminiCatalogForTest } = await import(
      '../analyzer/catalog/gemini-catalog.js'
    );
    const ctx = { transport: 'gemini' as const, model: 'gemini-3.6-flash' };
    _seedGeminiCatalogForTest('test-key', [{ id: 'gemini-3.6-flash', outputTokenLimit: 65_536 }]);
    try {
      process.env.ANALYZER_MAX_OUTPUT_TOKENS = '0';
      expect(nonStoryOverflowWarningMessage(ctx)).not.toMatch(/max output tokens/i);
      process.env.ANALYZER_MAX_OUTPUT_TOKENS = '4096';
      expect(nonStoryOverflowWarningMessage(ctx)).toMatch(/max output tokens/i);
    } finally {
      _resetGeminiCatalogForTest();
    }
  });
});

/* #3435 (plan 285 T2) — the main route's Phase-1 (attribution) failure
   bookkeeping, the dispatch split, the guarded failure-catch saves and the
   terminal label. Ported by name from #3439 (9a063ea6), adapted to the
   `phase` marker; `PA:` tests are not ported (decision D4). */
describe('main Phase-1 failure bookkeeping, dispatch split and terminal labels (#3435)', () => {
  const NOVA_2 = [{ id: 201, chapterId: 2, characterId: 'nova', confidence: 0.9, text: BODIES[2] }];
  const PHASE1_MODEL = 'phase1-only-model';

  interface SaveSnapshot {
    failedChapterIds?: number[];
    failedChapterErrors?: Record<string, unknown>;
    chapterCast?: Record<number, unknown[]>;
    chapters?: Record<number, unknown>;
  }
  interface MainOpts {
    chapterIds?: number[];
    fresh?: boolean;
    width?: string;
    pipelined?: boolean;
    phase1Model?: string;
    phase1?: Partial<Analyzer>;
    phase0?: Partial<Analyzer>;
    saveHook?: (c: SaveSnapshot, job: AnalysisJob) => void | Promise<void>;
  }

  /** Seeds an arbitrary cache and runs one main run against it. `failedSaves`
      lists every save that carried a non-empty failed-id list. */
  async function runMainOn(
    label: string,
    seedCache: Record<string, unknown>,
    stage2: Analyzer['runStage2Chapter'],
    opts: MainOpts = {},
  ) {
    const seed = await seedBook(label, opts.chapterIds ?? [1, 2]);
    const { saveAnalysisCache, loadAnalysisCache, clearAnalysisCache } = await import('../store/analysis-cache.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { runMainAnalyzerJob } = await import('./analysis.js');
    await saveAnalysisCache(seed.manuscriptId, seedCache as never);
    const castCalls: number[] = [];
    const stage2Calls: number[] = [];
    const failedSaves: number[][] = [];
    const g = globalThis as Record<string, unknown>;
    g.__overflow_spend_test_save_hook = async (c: SaveSnapshot) => {
      if (c.failedChapterIds?.length) failedSaves.push([...c.failedChapterIds]);
      await opts.saveHook?.(c, seed.job);
    };
    const phase0 = buildSelection(
      stubAnalyzer({
        async runStage1Chapter(_m, chapterId): Promise<Stage1ChapterOutput> {
          castCalls.push(chapterId);
          return { characters: [novaCharacter()] };
        },
        ...opts.phase0,
      }),
      'phase0-model',
    );
    g.__overflow_spend_test_phase1_selection = buildSelection(
      stubAnalyzer({
        runStage2Chapter: async (m, id, ...rest) => {
          stage2Calls.push(id);
          return stage2(m, id, ...rest);
        },
        ...opts.phase1,
      }),
      opts.phase1Model ?? MODEL,
    );
    const originalMinLag = process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS;
    if (opts.pipelined) {
      g.__overflow_spend_test_pipelined = true;
      process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS = '0';
    }
    if (opts.width) process.env.ANALYZER_OLLAMA_CONCURRENCY = opts.width;
    const events = captureEvents(seed.job);
    try {
      await runMainAnalyzerJob(seed.job, getManuscript(seed.manuscriptId)! as never, phase0, {
        requestedFresh: opts.fresh ?? false,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });
      await new Promise((r) => setTimeout(r, 100));
      const after = await loadAnalysisCache(seed.manuscriptId);
      return { castCalls, stage2Calls, events, after, failedSaves, job: seed.job, bookDir: seed.bookDir };
    } finally {
      process.env.ANALYZER_OLLAMA_CONCURRENCY = '2';
      restoreEnv('ANALYZER_PHASE1_MIN_LAG_CHAPTERS', originalMinLag);
      delete g.__overflow_spend_test_pipelined;
      removeManuscript(seed.manuscriptId);
      await clearAnalysisCache(seed.manuscriptId);
    }
  }

  const BOTH_CAST = { chapterCast: { 1: [novaCharacter()], 2: [novaCharacter()] } };

  /** Chapter `overflowOn`'s escalation call reports a reasoning overflow. */
  const escalationOverflow = async (overflowOn: number): Promise<Partial<Analyzer>> => {
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    return {
      runAttributionEscalation: async (_m: string, chapterId: number, _w: number, _p: string, call: StageCall) => {
        if (chapterId === overflowOn) call.onReasoningOverflow?.(new AnalyzerReasoningOverflowError('gemini', MODEL, 8100));
        return null;
      },
    };
  };

  it('P-zeta: pool width 1, ch1 escalation overflows — ch2 is stopped at its dispatch, with no chapter-failed and no record (control)', async () => {
    const r = await runMainOn('p-zeta', BOTH_CAST, async (_m, id) => stage2For(id), {
      width: '1',
      phase1: await escalationOverflow(1),
    });
    /* Control: ch1 really overflowed and ch2 was really stopped. */
    expect(r.job.reasoningOverflowed).toBe(true);
    expect(r.stage2Calls).toEqual([1]);
    expect(r.events.filter((e) => e.kind === 'error').map((e) => e.code)).toEqual(['analyzer-reasoning-overflow']);
    expect(r.events.filter((e) => e.kind === 'chapter-failed')).toEqual([]);
    expect(r.failedSaves).toEqual([]);
    expect(r.after.failedChapterIds ?? []).toEqual([]);
  }, 60_000);

  it('A9 pipelined: ch1 Phase-0 overflow rethrown at ch1 Phase-1 dispatch records nothing, and the terminal names the Phase-0 model (control)', async () => {
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    const r = await runMainOn('a9-pipelined', {}, async (_m, id) => stage2For(id), {
      pipelined: true,
      width: '1',
      fresh: true,
      phase1Model: PHASE1_MODEL,
      phase0: { runStage1Chapter: () => Promise.reject(new AnalyzerReasoningOverflowError('gemini', MODEL, 8100)) },
    });
    const terminal = r.events.find((e) => e.kind === 'error')!;
    expect(terminal.code).toBe('analyzer-reasoning-overflow');
    expect(String(terminal.message)).toContain('phase0-model');
    expect(String(terminal.message)).not.toContain(PHASE1_MODEL);
    expect(r.events.filter((e) => e.kind === 'chapter-failed')).toEqual([]);
    expect(r.failedSaves).toEqual([]);
    expect(r.after.failedChapterIds ?? []).toEqual([]);
  }, 60_000);

  it('P-gamma: a main-route Phase-1 failure on a re-attributed chapter is recorded (chapter-failed) and replaces the stale collapse record', async () => {
    const { events, after } = await runMainOn(
      'p-gamma',
      {
        /* Chapter 1's cached sentences are not seeded: dropping them for a flagged chapter is a later
           task's rule, and a cached chapter is replayed instead of attributed. */
        chapters: { 2: NOVA_2 },
        chapterCast: { 1: [novaCharacter()], 2: [novaCharacter()] },
        failedChapterIds: [1],
        failedChapterErrors: { '1': { code: 'attribution-collapse', message: 'seeded', remediation: 'seeded', phase: 'attribution' } },
      },
      async (_m, id) => {
        if (id === 1) throw new Error('Phase 1 fails for chapter 1');
        return stage2For(id);
      },
    );
    const failed = events.find((e) => e.kind === 'chapter-failed' && e.chapterId === 1);
    expect(failed).toBeDefined();
    expect(failed!.code).not.toBe('attribution-collapse');
    expect(failed!.phase).toBe('attribution');
    expect(after.failedChapterIds).toEqual([1]);
    expect(after.failedChapterErrors?.['1']?.code).toBe(failed!.code);
    expect(after.failedChapterErrors?.['1']?.phase).toBe('attribution');
  }, 60_000);

  it('a main resume that re-attributes an M10-recorded chapter clears its record and sends chapter-resolved', async () => {
    const { events, after, stage2Calls } = await runMainOn(
      'm8-clear',
      {
        ...BOTH_CAST,
        /* stage1 on disk: Phase 0 (and its own clear of a failed id) is skipped, so only the
           Phase-1 completion can clear this record. Chapter 1 has no cached sentences. */
        stage1: { characters: [novaCharacter()], chapters: [1, 2].map((id) => ({ id, title: CHAPTER_TITLES[id] })) },
        chapters: { 2: NOVA_2 },
        failedChapterIds: [1],
        failedChapterErrors: { '1': { code: 'analyzer-timeout', message: 'seeded', remediation: 'seeded', phase: 'attribution' } },
      },
      async (_m, id) => stage2For(id),
    );
    expect(stage2Calls).toContain(1);
    expect(events.filter((e) => e.kind === 'chapter-resolved').map((e) => e.chapterId)).toEqual([1]);
    expect(events.some((e) => e.kind === 'chapter-failed')).toBe(false);
    expect(after.failedChapterIds ?? []).toEqual([]);
    expect(after.failedChapterErrors?.['1']).toBeUndefined();
  }, 60_000);

  /* Ported from #3439 (9a063ea6) by name; seeds carry `phase` (plan 285 T5). */
  const COLLAPSED = [{ id: 101, chapterId: 1, characterId: 'narrator', confidence: 0.9, text: BODIES[1] }];
  /** No stage1: chapter 1 attribution-flagged (has its cast, cached collapsed
      sentences), chapter 2 cast-failed (empty-array failure marker). */
  const PE_SEED = {
    chapters: { 1: COLLAPSED },
    chapterCast: { 1: [novaCharacter()], 2: [] },
    failedChapterIds: [1, 2],
    failedChapterErrors: {
      '1': { code: 'attribution-collapse', message: 'seeded', remediation: 'seeded', phase: 'attribution' },
      '2': { code: 'analyzer-timeout', message: 'seeded', remediation: 'seeded', phase: 'cast' },
    },
  };

  it('PE: with no stage1, an attribution-flagged chapter with a cast is not re-queued into cast detection but IS re-attributed; its record clears once that Phase 1 succeeds (owner decision, #3435)', async () => {
    const { castCalls, stage2Calls, events, after } = await runMainOn('pe-resume', PE_SEED, async (_m, id) =>
      stage2For(id),
    );
    expect(castCalls).toEqual([2]);
    expect([...stage2Calls].sort()).toEqual([1, 2]);
    /* Chapter 1 is not replayed: its pending take puts it in the Phase-1 pool's
       task list (not only in the post-join M8d pass). */
    expect(events.some((e) => e.kind === 'log' && /^Running 2 chapters /.test(String(e.message)))).toBe(true);
    expect(events.filter((e) => e.kind === 'chapter-resolved').map((e) => e.chapterId as number).sort()).toEqual([1, 2]);
    expect(after.failedChapterIds ?? []).toEqual([]);
    expect(after.chapters?.[1]?.[0]?.characterId).toBe('nova');
    expect(after.pendingAttributionChapterIds ?? []).toEqual([]);
  }, 60_000);

  it('PE negative: if the re-attribution fails for the flagged chapter its record is kept and chapter-resolved is not sent for it', async () => {
    const { events, after, stage2Calls } = await runMainOn('pe-resume-fail', PE_SEED, async (_m, id) => {
      if (id === 1) throw new Error('Phase 1 fails for chapter 1');
      return stage2For(id);
    });
    /* Control: the flagged chapter really was re-attributed, not replayed. */
    expect(stage2Calls).toContain(1);
    expect(events.filter((e) => e.kind === 'chapter-resolved').map((e) => e.chapterId)).not.toContain(1);
    expect(after.failedChapterIds).toContain(1);
  }, 60_000);

  it("PD-main: a collapse-flagged chapter whose cast ALSO failed is re-cast; its cast record clears at Phase-0a success, it stays pending, and a Phase-1 throw re-records it as attribution", async () => {
    const { castCalls, stage2Calls, events, after } = await runMainOn(
      'pd-main',
      {
        chapters: { 1: COLLAPSED, 2: NOVA_2 },
        chapterCast: { 1: [], 2: [novaCharacter()] },
        failedChapterIds: [1],
        failedChapterErrors: { '1': { code: 'analyzer-timeout', message: 'seeded', remediation: 'seeded', phase: 'cast' } },
      },
      async (_m, id) => {
        if (id === 1) throw new Error('Phase 1 fails for chapter 1');
        return stage2For(id);
      },
    );
    /* Control: the chapter really was re-cast (Phase 0a succeeded) and attributed (and failed). */
    expect(castCalls).toEqual([1]);
    expect(stage2Calls).toContain(1);
    const forOne = events
      .filter((e) => (e.kind === 'chapter-resolved' || e.kind === 'chapter-failed') && e.chapterId === 1)
      .map((e) => (e.kind === 'chapter-failed' ? `failed:${String(e.phase)}` : 'resolved'));
    expect(forOne).toEqual(['resolved', 'failed:attribution']);
    expect(after.failedChapterIds).toContain(1);
    expect(after.failedChapterErrors?.['1']?.phase).toBe('attribution');
    expect(after.pendingAttributionChapterIds).toContain(1);
    /* A pending take is never deleted. */
    expect(after.chapters?.[1]).toEqual(COLLAPSED);
  }, 60_000);

  it('a FINISHED book (stage1 on disk): a main run replays a flagged chapter cached sentences instead of re-attributing it', async () => {
    const { stage2Calls, after } = await runMainOn(
      'finished-replay',
      {
        chapters: { 1: COLLAPSED, 2: NOVA_2 },
        chapterCast: { 1: [novaCharacter()], 2: [novaCharacter()] },
        stage1: {
          characters: [novaCharacter()],
          chapters: [1, 2].map((id) => ({ id, title: CHAPTER_TITLES[id] })),
        },
        failedChapterIds: [1],
        failedChapterErrors: {
          '1': { code: 'attribution-collapse', message: 'seeded', remediation: 'seeded', phase: 'attribution' },
        },
      },
      async (_m, id) => stage2For(id),
    );
    expect(stage2Calls).not.toContain(1);
    expect(after.chapters?.[1]?.[0]?.characterId).toBe('narrator');
    expect(after.failedChapterIds).toEqual([1]);
  }, 60_000);

  it('MD: a Pause during the main Phase 1 records nothing (control)', async () => {
    const { AnalysisAbortedError } = await import('../analyzer/errors.js');
    const r = await runMainOn('md-pause', BOTH_CAST, () => Promise.reject(new AnalysisAbortedError('paused')));
    expect(r.events.filter((e) => e.kind === 'error').map((e) => e.code)).toEqual(['aborted']);
    expect(r.events.filter((e) => e.kind === 'chapter-failed')).toEqual([]);
    expect(r.failedSaves).toEqual([]);
    expect(r.after.failedChapterIds ?? []).toEqual([]);
  }, 60_000);

  it('Pause between chapters ends aborted, no persist', async () => {
    const { readFileSync: read } = await import('node:fs');
    let stateBefore = '';
    const r = await runMainOn('pause-gap', BOTH_CAST, async (_m, id) => stage2For(id), {
      width: '1',
      /* The Pause lands in the dispatch gap: the first save that carries chapter 1's take
         runs after its model call returned and before chapter 2's dispatch, so nothing is
         in flight. */
      saveHook: (c, job) => {
        if (c.chapters?.[1] && !job.controller.signal.aborted) {
          stateBefore = read(join(job.bookDir!, '.audiobook', 'state.json'), 'utf8');
          job.controller.abort();
        }
      },
    });
    expect(r.stage2Calls).toEqual([1]);
    expect(r.events.filter((e) => e.kind === 'error').map((e) => e.code)).toEqual(['aborted']);
    expect(r.events.some((e) => e.kind === 'result')).toBe(false);
    expect(read(join(r.bookDir, '.audiobook', 'state.json'), 'utf8')).toBe(stateBefore);
    /* #3435 — no stitch: the stop rejects at the dispatch, so the run never reaches the
       Phase-2 window (the abort check before the persist would otherwise mask a dispatch
       that resolved). */
    expect(r.events.some((e) => e.kind === 'phase' && e.phaseId === 2)).toBe(false);
  }, 60_000);

  it('MG: with split phase models, a Phase-1 failure row AND its terminal error name the Phase-1 model, not the Phase-0 one', async () => {
    const { AnalyzerTruncatedError } = await import('../analyzer/errors.js');
    const r = await runMainOn(
      'mg-main',
      BOTH_CAST,
      async (_m, id) => {
        if (id === 1) throw new AnalyzerTruncatedError('gemini', 'MAX_TOKENS', 100);
        return stage2For(id);
      },
      { phase1Model: PHASE1_MODEL },
    );
    const terminal = r.events.find((e) => e.kind === 'error')!;
    expect(terminal.code).toBe('analyzer-truncated');
    expect(String(terminal.message)).toContain(PHASE1_MODEL);
    expect(String(terminal.message)).not.toContain('phase0-model');
    const row = r.events.find((e) => e.kind === 'chapter-failed' && e.chapterId === 1)!;
    expect(String(row.message)).toContain(PHASE1_MODEL);
    expect(String(row.message)).not.toContain('phase0-model');
  }, 60_000);

  for (const kind of ['overflow', 'truncated'] as const) {
  it(`MG (subset): with split phase models, a Phase-1 ${kind} terminal names the Phase-1 model`, async () => {
    const seed = await seedBook(`mg-subset-${kind}`, [1], { fullCache: true });
    const { AnalyzerReasoningOverflowError, AnalyzerTruncatedError } = await import('../analyzer/errors.js');
    const { clearAnalysisCache } = await import('../store/analysis-cache.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { runSubsetAnalyzerJob } = await import('./analysis.js');
    const record = getManuscript(seed.manuscriptId)!;
    const job = { ...seed.job, kind: 'subset' as const } as unknown as AnalysisJob;
    const events = captureEvents(job, () => {});
    try {
      await runSubsetAnalyzerJob(
        job,
        record,
        seed.phase0Selection,
        buildSelection(
          stubAnalyzer({
            runStage2Chapter: () =>
              Promise.reject(
                kind === 'overflow'
                  ? new AnalyzerReasoningOverflowError('gemini', MODEL, 8100)
                  : new AnalyzerTruncatedError('gemini', 'MAX_TOKENS', 100),
              ),
          }),
          PHASE1_MODEL,
        ),
        record.chapterHints,
        false,
      );
    } finally {
      removeManuscript(seed.manuscriptId);
      await clearAnalysisCache(seed.manuscriptId);
    }
    const terminal = events.find((e) => e.kind === 'error')!;
    expect(terminal.code).toBe(kind === 'overflow' ? 'analyzer-reasoning-overflow' : 'analyzer-truncated');
    expect(String(terminal.message)).toContain(PHASE1_MODEL);
    expect(String(terminal.message)).not.toContain('phase0-model');
  }, 60_000);
  }

  it('sequential last-chapter escalation overflow: the terminal names the Phase-1 model', async () => {
    const r = await runMainOn('seq-last-overflow', BOTH_CAST, async (_m, id) => stage2For(id), {
      width: '1',
      phase1Model: PHASE1_MODEL,
      phase1: await escalationOverflow(2),
    });
    const terminal = r.events.find((e) => e.kind === 'error')!;
    expect(terminal.code).toBe('analyzer-reasoning-overflow');
    expect(String(terminal.message)).toContain(PHASE1_MODEL);
    expect(String(terminal.message)).not.toContain('phase0-model');
  }, 60_000);

  it('the overflow terminal names its chapter', async () => {
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    const r = await runMainOn('overflow-names-chapter', BOTH_CAST, async (_m, id) => {
      if (id === 1) throw new AnalyzerReasoningOverflowError('gemini', MODEL, 8100);
      return stage2For(id);
    });
    const terminal = r.events.find((e) => e.kind === 'error')!;
    expect(terminal.code).toBe('analyzer-reasoning-overflow');
    expect(String(terminal.message)).toContain('chapter "Chapter One"');
    expect(String(terminal.message)).not.toContain('a chapter');
  }, 60_000);

  it('a save that throws while recording a Phase-1 failure does not replace the real error or swallow chapter-failed', async () => {
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    const r = await runMainOn(
      'save-throws-p1',
      BOTH_CAST,
      () => Promise.reject(new AnalyzerReasoningOverflowError('gemini', MODEL, 8100)),
      {
        saveHook: (c) => {
          if ((c.failedChapterErrors?.['1'] as { code?: string } | undefined)?.code === 'analyzer-reasoning-overflow') {
            throw new Error('ENOSPC: disk full');
          }
        },
      },
    );
    const terminal = r.events.find((e) => e.kind === 'error')!;
    expect(terminal.code).toBe('analyzer-reasoning-overflow');
    expect(String(terminal.message)).not.toMatch(/ENOSPC/);
    expect((terminal.fixes as unknown[]).length).toBeGreaterThan(0);
    expect(r.events.find((e) => e.kind === 'chapter-failed')).toMatchObject({ chapterId: 1, code: 'analyzer-reasoning-overflow' });
  }, 60_000);

  it('a save that throws in the Phase-0a failure catch keeps the original error and still sends chapter-failed', async () => {
    let thrown = false;
    const r = await runMainOn('save-throws-main', {}, async (_m, id) => stage2For(id), {
      fresh: true,
      phase0: { runStage1Chapter: () => Promise.reject(new Error('cast model exploded')) },
      saveHook: (c) => {
        /* Only the save inside the failure catch (the record is there, the cast is the empty marker). */
        if (!thrown && c.failedChapterErrors?.['1'] && c.chapterCast?.[1] && !c.chapterCast[1].length) {
          thrown = true;
          throw new Error('ENOSPC: disk full');
        }
      },
    });
    expect(thrown).toBe(true);
    expect(r.events.find((e) => e.kind === 'chapter-failed' && e.chapterId === 1)).toBeDefined();
    expect(r.events.filter((e) => e.kind === 'error' && /ENOSPC/.test(String(e.message)))).toEqual([]);
  }, 60_000);

  it('a save that throws while recording a Phase-0 failure on the subset route still reports chapter-failed and does not end the run on the fs error', async () => {
    const seed = await seedBook('save-throws-p0-subset', [1], { fullCache: true });
    const { clearAnalysisCache } = await import('../store/analysis-cache.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { runSubsetAnalyzerJob } = await import('./analysis.js');
    let thrown = false;
    (globalThis as Record<string, unknown>).__overflow_spend_test_save_hook = (c: SaveSnapshot) => {
      /* Only the save inside the failure catch: later saves are a different path. */
      if (!thrown && c.failedChapterErrors?.['1'] && !c.chapterCast?.[1]?.length) {
        thrown = true;
        throw new Error('ENOSPC: disk full');
      }
    };
    const record = getManuscript(seed.manuscriptId)!;
    const job = { ...seed.job, kind: 'subset' as const } as unknown as AnalysisJob;
    const events = captureEvents(job, () => {});
    try {
      await runSubsetAnalyzerJob(
        job,
        record,
        buildSelection(stubAnalyzer({ runStage1Chapter: () => Promise.reject(new Error('cast model exploded')) }), 'phase0-model'),
        buildSelection(stubAnalyzer({ runStage2Chapter: async (_m, id) => stage2For(id) }), MODEL),
        record.chapterHints,
        false,
      );
    } finally {
      removeManuscript(seed.manuscriptId);
      await clearAnalysisCache(seed.manuscriptId);
    }
    expect(thrown).toBe(true);
    expect(events.find((e) => e.kind === 'chapter-failed')).toMatchObject({ chapterId: 1 });
    expect(events.filter((e) => e.kind === 'error' && /ENOSPC/.test(String(e.message)))).toEqual([]);
  }, 60_000);
});

/* #3435 review pass 3 — pipelined mode. Chapter i's Phase 1 dispatches once the
   watermark (the highest Phase-0 index completed, NOT a contiguous prefix)
   reaches i + minLag, and `phase0FailedCount` is only set after the Phase-0 pool
   drains, so a chapter whose OWN Phase 0a failed is still attributed. Its Phase-1
   success must not clear its cast-phase record: only a Phase-0a success does,
   otherwise the resume never re-casts it and the book completes without that
   chapter's characters. Plan 285 T5 (M8c): that take was made against the
   rolling roster while the cast record stood, so it is pending, and the resume
   re-attributes it. Ported by name from #3439 (9a063ea6). */
describe('pipelined main route: a cast-phase failure record survives the same chapter\'s Phase 1 (#3435)', () => {
  async function runCastFailurePipelined(label: string, opts: { delayFailureSave?: boolean } = {}) {
    const seed = await seedBook(label, [1, 2, 3]);
    const { loadAnalysisCache, clearAnalysisCache } = await import('../store/analysis-cache.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { runMainAnalyzerJob } = await import('./analysis.js');
    const g = globalThis as Record<string, unknown>;
    const stage2Calls: number[] = [];
    let ch1Phase1Done = false;
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const failSafe = setTimeout(() => openGate(), 20_000);
    /* Opens once chapter 1's Phase 1 has returned, plus a beat for its post-call
       bookkeeping (the clear) to run. */
    const afterCh1Phase1 = async (): Promise<void> => {
      while (!ch1Phase1Done) await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 300));
    };
    let failChapterOne = true;
    const castCalls: number[] = [];
    const phase0 = buildSelection(
      stubAnalyzer({
        async runStage1Chapter(_m: string, chapterId: number): Promise<Stage1ChapterOutput> {
          castCalls.push(chapterId);
          if (chapterId === 1 && failChapterOne) throw new Error('cast model exploded');
          if (chapterId === 3 && failChapterOne) await gate;
          return { characters: [novaCharacter()] };
        },
      }),
      'phase0-model',
    );
    g.__overflow_spend_test_phase1_selection = buildSelection(
      stubAnalyzer({
        async runStage2Chapter(_m: string, chapterId: number): Promise<Stage2ChapterOutput> {
          stage2Calls.push(chapterId);
          if (chapterId === 1 && failChapterOne) {
            ch1Phase1Done = true;
            void afterCh1Phase1().then(openGate);
          }
          return stage2For(chapterId);
        },
      }),
      MODEL,
    );
    g.__overflow_spend_test_pipelined = true;
    if (opts.delayFailureSave) {
      /* Hold the Phase-0a catch's save for chapter 1 until its Phase 1 has finished,
         so the two bookkeeping paths interleave the other way round. */
      let held = false;
      g.__overflow_spend_test_save_hook = async (c: {
        failedChapterErrors?: Record<string, unknown>;
        chapterCast?: Record<number, unknown[]>;
      }) => {
        if (!held && c.failedChapterErrors?.['1'] && c.chapterCast?.[1] && !c.chapterCast[1].length) {
          held = true;
          await afterCh1Phase1();
        }
      };
    }
    const originalMinLag = process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS;
    process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS = '0';
    const events1 = captureEvents(seed.job);
    try {
      await runMainAnalyzerJob(seed.job, getManuscript(seed.manuscriptId)! as never, phase0, {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });
      const mid = await loadAnalysisCache(seed.manuscriptId);
      const stage2Run1 = [...stage2Calls];
      const castCallsRun1 = [...castCalls];

      /* The resume (what the view's cast_incomplete auto-resume POSTs). */
      failChapterOne = false;
      delete g.__overflow_spend_test_save_hook;
      castCalls.length = 0;
      stage2Calls.length = 0;
      /* A new job: run 1's endJob marked the seed job ended (#3435 decision E). */
      const resumeJob = {
        ...seed.job,
        controller: new AbortController(),
        subscribers: new Set(),
        ended: false,
        halting: false,
        left: false,
        liveWork: 0,
      } as unknown as AnalysisJob;
      const events2 = captureEvents(resumeJob);
      await runMainAnalyzerJob(resumeJob, getManuscript(seed.manuscriptId)! as never, phase0, {
        requestedFresh: false,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });
      const after = await loadAnalysisCache(seed.manuscriptId);
      return { events1, events2, mid, after, stage2Run1, castCallsRun1, castCallsRun2: [...castCalls], stage2Run2: [...stage2Calls] };
    } finally {
      clearTimeout(failSafe);
      openGate();
      restoreEnv('ANALYZER_PHASE1_MIN_LAG_CHAPTERS', originalMinLag);
      delete g.__overflow_spend_test_pipelined;
      delete g.__overflow_spend_test_save_hook;
      removeManuscript(seed.manuscriptId);
      await clearAnalysisCache(seed.manuscriptId);
    }
  }

  it('P-alpha: chapter 1\'s cast failure survives its own Phase 1; the resume re-casts and re-attributes it', async () => {
    const r = await runCastFailurePipelined('p-alpha');
    /* Control: chapter 1 really was attributed in run 1 while its cast had failed. */
    expect(r.stage2Run1).toContain(1);
    expect(r.events1.some((e) => e.kind === 'chapter-failed' && e.chapterId === 1)).toBe(true);
    expect(r.events1.filter((e) => e.kind === 'chapter-resolved').map((e) => e.chapterId)).not.toContain(1);
    expect(r.events1.filter((e) => e.kind === 'error').map((e) => e.code)).toEqual(['cast_incomplete']);
    expect(r.mid.failedChapterIds).toEqual([1]);
    expect(r.mid.failedChapterErrors?.['1']?.phase).toBe('cast');
    expect(r.mid.chapterCast?.[1]).toEqual([]);
    /* M8c: the take was made against the rolling roster while the cast record stood. */
    expect(r.mid.pendingAttributionChapterIds).toEqual([1]);

    expect(r.castCallsRun2).toEqual([1]);
    expect(r.stage2Run2).toContain(1);
    expect(r.events2.filter((e) => e.kind === 'chapter-resolved').map((e) => e.chapterId)).toEqual([1]);
    expect(r.after.failedChapterIds ?? []).toEqual([]);
    expect(r.after.chapterCast?.[1]?.length).toBeGreaterThan(0);
    expect(r.after.pendingAttributionChapterIds ?? []).toEqual([]);
  }, 90_000);

  it('the other interleaving: chapter 1\'s Phase 1 finishing while the Phase-0a catch\'s save is pending leaves record and events consistent', async () => {
    const r = await runCastFailurePipelined('p-alpha-delayed', { delayFailureSave: true });
    expect(r.stage2Run1).toContain(1);
    const kinds = r.events1
      .filter((e) => (e.kind === 'chapter-failed' || e.kind === 'chapter-resolved') && e.chapterId === 1)
      .map((e) => e.kind);
    expect(kinds).toEqual(['chapter-failed']);
    expect(r.mid.failedChapterIds).toEqual([1]);
    expect(r.mid.chapterCast?.[1]).toEqual([]);
    expect(r.mid.pendingAttributionChapterIds).toEqual([1]);
    expect(r.castCallsRun2).toEqual([1]);
    expect(r.stage2Run2).toContain(1);
    expect(r.after.failedChapterIds ?? []).toEqual([]);
  }, 90_000);
});

/* #3435 (plan 285 T4) — the subset route records a Phase-1 (attribution)
   failure, its Phase-1 gate counts only CAST failures, a soft stop ends via
   endJob (so the halted snapshot lands), and a cast failure fixed by Phase 0
   waits for its Phase 1 before it clears. Ported by name from #3439
   (9a063ea6), seeds adapted to `phase`. */
describe('a Retry whose Phase 1 fails keeps its failure on record and reports it (#3435)', () => {
  async function runRetry(
    label: string,
    runStage2Chapter: Analyzer['runStage2Chapter'],
    seedFailed: boolean,
  ): Promise<{ events: CapturedEvent[]; failedChapterIds: number[]; failedChapterErrors: Record<string, { code: string; phase?: string }> }> {
    const seed = await seedBook(label, [1], { fullCache: true });
    const { saveAnalysisCache, loadAnalysisCache, clearAnalysisCache } = await import('../store/analysis-cache.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { runSubsetAnalyzerJob } = await import('./analysis.js');
    if (seedFailed) {
      const cache = await loadAnalysisCache(seed.manuscriptId);
      /* An attribution-phase failure: the chapter already has its cast. */
      cache.chapterCast = { 1: [novaCharacter()] };
      cache.failedChapterIds = [1];
      cache.failedChapterErrors = {
        '1': { code: 'attribution-collapse', message: 'seeded', remediation: 'seeded', phase: 'attribution' },
      };
      await saveAnalysisCache(seed.manuscriptId, cache);
    }
    const record = getManuscript(seed.manuscriptId)!;
    const subsetJob = { ...seed.job, kind: 'subset' as const };
    const events = captureEvents(subsetJob, () => {});
    try {
      await runSubsetAnalyzerJob(
        subsetJob,
        record,
        seed.phase0Selection,
        buildSelection(stubAnalyzer({ runStage2Chapter }), MODEL),
        record.chapterHints,
        false,
      );
      const after = await loadAnalysisCache(seed.manuscriptId);
      return {
        events,
        failedChapterIds: after.failedChapterIds ?? [],
        failedChapterErrors: (after.failedChapterErrors ?? {}) as Record<string, { code: string; phase?: string }>,
      };
    } finally {
      removeManuscript(seed.manuscriptId);
      await clearAnalysisCache(seed.manuscriptId);
    }
  }

  it('control: a clean Retry clears the record and sends chapter-resolved only', async () => {
    const r = await runRetry('p1-clean', async (_m, id) => stage2For(id), true);
    expect(r.events.filter((e) => e.kind === 'chapter-resolved').map((e) => e.chapterId)).toEqual([1]);
    expect(r.events.some((e) => e.kind === 'chapter-failed')).toBe(false);
    expect(r.failedChapterIds).toEqual([]);
  }, 30_000);

  it('a Phase-1 timeout sends chapter-failed (no chapter-resolved), and the chapter stays in failedChapterIds', async () => {
    const { AnalyzerTimeoutError } = await import('../analyzer/errors.js');
    const { classifyAnalysisFailure } = await import('./failure-taxonomy.js');
    const err = new AnalyzerTimeoutError('gemini', MODEL, 90_000, 'thinking-idle');
    const r = await runRetry('p1-timeout', () => Promise.reject(err), true);
    const kinds = r.events.map((e) => e.kind).filter((k) => ['chapter-resolved', 'chapter-failed', 'error'].includes(k));
    expect(kinds).toEqual(['chapter-failed', 'error']);
    const classified = classifyAnalysisFailure(err, 'gemini');
    const failed = r.events.find((e) => e.kind === 'chapter-failed')!;
    expect(failed).toMatchObject({ chapterId: 1, code: classified.code, phase: 'attribution', message: expect.stringContaining('thinking window') });
    expect(r.failedChapterIds).toEqual([1]);
    expect(r.failedChapterErrors['1'].code).toBe(classified.code);
    expect(r.failedChapterErrors['1'].phase).toBe('attribution');
  }, 30_000);

  it('a Phase-1 unreachable analyzer is recorded and reported the same way', async () => {
    const { AnalyzerUnreachableError } = await import('../analyzer/errors.js');
    const { classifyAnalysisFailure } = await import('./failure-taxonomy.js');
    const err = new AnalyzerUnreachableError('connection refused', 'ollama');
    const r = await runRetry('p1-unreachable', () => Promise.reject(err), true);
    const classified = classifyAnalysisFailure(err, 'ollama');
    expect(r.events.find((e) => e.kind === 'chapter-failed')).toMatchObject({ chapterId: 1, code: classified.code });
    expect(r.failedChapterIds).toEqual([1]);
    expect(r.failedChapterErrors['1'].code).toBe(classified.code);
  }, 30_000);

  it('a Phase-1 reasoning overflow still ends the run with its code AND now survives a reload', async () => {
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    const r = await runRetry(
      'p1-overflow',
      () => Promise.reject(new AnalyzerReasoningOverflowError('gemini', MODEL, 8100)),
      true,
    );
    expect(r.events.filter((e) => e.kind === 'error').map((e) => e.code)).toEqual(['analyzer-reasoning-overflow']);
    expect(r.failedChapterIds).toEqual([1]);
    expect(r.failedChapterErrors['1'].code).toBe('analyzer-reasoning-overflow');
  }, 30_000);
});

describe('the subset route: failure records vs the Phase-1 gate, soft stops and cast fixes (#3435)', () => {
  /** Chapter 1's cached sentences are "collapsed" (narrator); a re-attribution
      writes nova, so a changed characterId proves the chapter was re-attributed. */
  const COLLAPSED_ID = 'narrator';
  const recFor = (code: string) => ({
    code,
    message: 'seeded',
    remediation: 'seeded',
    phase: code.startsWith('attribution-') ? ('attribution' as const) : ('cast' as const),
  });

  interface Step {
    toRun: number[];
    runStage2Chapter: Analyzer['runStage2Chapter'];
    runStage1Chapter?: Analyzer['runStage1Chapter'];
  }
  interface StepResult {
    events: CapturedEvent[];
    job: AnalysisJob;
  }
  interface CaseResult {
    steps: StepResult[];
    bookDir: string;
    failedChapterIds: number[];
    failedChapterErrors: Record<string, { code: string; phase?: string }>;
    chapters: Record<number, Array<{ characterId: string }>>;
    stage1: unknown;
  }

  async function runCase(
    label: string,
    seedFailed: Record<number, string>,
    steps: Step[],
    opts: { emptyCast?: number[]; noCast?: number[]; excluded?: number[]; noStage1?: boolean } = {},
  ): Promise<CaseResult> {
    const seed = await seedBook(label, [1, 2], { fullCache: true });
    const { saveAnalysisCache, loadAnalysisCache, clearAnalysisCache } = await import('../store/analysis-cache.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { runSubsetAnalyzerJob } = await import('./analysis.js');
    const cache = await loadAnalysisCache(seed.manuscriptId);
    cache.chapterCast = { 1: [novaCharacter()], 2: [novaCharacter()] };
    for (const id of opts.emptyCast ?? []) cache.chapterCast[id] = [];
    for (const id of opts.noCast ?? []) delete cache.chapterCast[id];
    if (opts.noStage1) delete cache.stage1;
    cache.chapters = {
      1: [{ id: 101, chapterId: 1, characterId: COLLAPSED_ID, confidence: 0.9, text: BODIES[1] }],
      2: [{ id: 201, chapterId: 2, characterId: 'nova', confidence: 0.9, text: BODIES[2] }],
    } as never;
    const ids = Object.keys(seedFailed).map(Number);
    if (ids.length) {
      cache.failedChapterIds = ids;
      cache.failedChapterErrors = Object.fromEntries(ids.map((id) => [String(id), recFor(seedFailed[id])]));
    }
    await saveAnalysisCache(seed.manuscriptId, cache);
    const record = getManuscript(seed.manuscriptId)!;
    for (const h of record.chapterHints) if (opts.excluded?.includes(h.id)) h.excluded = true;
    const results: StepResult[] = [];
    try {
      for (const step of steps) {
        const job = {
          ...seed.job,
          controller: new AbortController(),
          subscribers: new Set(),
          kind: 'subset' as const,
        } as unknown as AnalysisJob;
        const events = captureEvents(job, () => {});
        await runSubsetAnalyzerJob(
          job,
          record,
          step.runStage1Chapter
            ? buildSelection(stubAnalyzer({ runStage1Chapter: step.runStage1Chapter }), 'phase0-model')
            : seed.phase0Selection,
          buildSelection(stubAnalyzer({ runStage2Chapter: step.runStage2Chapter }), MODEL),
          record.chapterHints.filter((c) => step.toRun.includes(c.id)),
          false,
        );
        results.push({ events, job });
      }
      const after = await loadAnalysisCache(seed.manuscriptId);
      return {
        steps: results,
        bookDir: seed.bookDir,
        failedChapterIds: after.failedChapterIds ?? [],
        failedChapterErrors: (after.failedChapterErrors ?? {}) as CaseResult['failedChapterErrors'],
        chapters: (after.chapters ?? {}) as CaseResult['chapters'],
        stage1: after.stage1,
      };
    } finally {
      removeManuscript(seed.manuscriptId);
      await clearAnalysisCache(seed.manuscriptId);
    }
  }

  /** The halted snapshot a soft stop's endJob persists (a detached write: poll). */
  async function haltedSnapshot(bookDir: string): Promise<{ state: string; haltCode?: string; haltReason?: string } | null> {
    const { readAnalysisState } = await import('../store/analysis-state.js');
    for (let i = 0; i < 40; i++) {
      const s = await readAnalysisState(bookDir);
      if (s && s.state === 'halted') return s;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  it('P3: a Phase-1 failure recorded on chapter 1 does not block a later clean Re-analyse of chapter 2', async () => {
    const { AnalyzerTimeoutError } = await import('../analyzer/errors.js');
    const ch2Calls: number[] = [];
    const r = await runCase('p3-gate', {}, [
      { toRun: [1], runStage2Chapter: () => Promise.reject(new AnalyzerTimeoutError('gemini', MODEL, 90_000, 'thinking-idle')) },
      {
        toRun: [2],
        runStage2Chapter: async (_m, id) => {
          ch2Calls.push(id);
          return stage2For(id);
        },
      },
    ]);
    /* Chapter 1's record is the control: it survived, so the gate saw it. */
    expect(r.failedChapterIds).toEqual([1]);
    expect(r.failedChapterErrors['1'].phase).toBe('attribution');
    expect(ch2Calls).toEqual([2]);
    expect(r.steps[1].events.some((e) => e.kind === 'result')).toBe(true);
  }, 60_000);

  it('P2: with two attribution-flagged chapters, a Retry of chapter 1 attributes it and leaves chapter 2 flagged', async () => {
    const calls: number[] = [];
    const r = await runCase('p2-gate', { 1: 'attribution-collapse', 2: 'attribution-collapse' }, [
      {
        toRun: [1],
        runStage2Chapter: async (_m, id) => {
          calls.push(id);
          return stage2For(id);
        },
      },
    ]);
    expect(calls).toEqual([1]);
    expect(r.chapters[1][0].characterId).toBe('nova');
    expect(r.steps[0].events.some((e) => e.kind === 'result')).toBe(true);
    expect(r.failedChapterIds).toEqual([2]);
  }, 60_000);

  it('PB: an excluded chapter carrying a cast-phase record does not block a Re-analyse of another chapter', async () => {
    const calls: number[] = [];
    const r = await runCase(
      'pb-excluded',
      { 2: 'analyzer-timeout' },
      [
        {
          toRun: [1],
          runStage2Chapter: async (_m, id) => {
            calls.push(id);
            return stage2For(id);
          },
        },
      ],
      { emptyCast: [2], excluded: [2] },
    );
    expect(calls).toEqual([1]);
    expect(r.steps[0].events.some((e) => e.kind === 'result')).toBe(true);
    /* The excluded chapter's record is untouched. */
    expect(r.failedChapterIds).toEqual([2]);
  }, 60_000);

  for (const [name, seedFailed] of [
    ['Retry (the chapter carries an attribution record)', { 1: 'attribution-collapse' }],
    ['Re-analyse (no record anywhere)', {}],
  ] as const) {
    it(`P-theta: a ${name} on a book with a narration-only chapter (empty cast, no record) reaches Phase 1`, async () => {
      const calls: number[] = [];
      const r = await runCase(
        'ptheta-narration',
        seedFailed,
        [
          {
            toRun: [1],
            runStage2Chapter: async (_m, id) => {
              calls.push(id);
              return stage2For(id);
            },
          },
        ],
        { emptyCast: [2] },
      );
      expect(calls).toEqual([1]);
      expect(r.steps[0].events.some((e) => e.kind === 'result')).toBe(true);
      expect(r.chapters[1][0].characterId).toBe('nova');
    }, 60_000);
  }

  it('a cast-phase failure fixed by Phase 0 is NOT cleared or announced when its Phase 1 then fails (stage1 on disk)', async () => {
    const r = await runCase(
      'p1-castfix',
      { 1: 'analyzer-timeout' },
      [{ toRun: [1], runStage2Chapter: () => Promise.reject(new Error('Phase 1 fails after Phase 0 fixed the cast')) }],
      { emptyCast: [1] },
    );
    expect(r.steps[0].events.some((e) => e.kind === 'chapter-resolved')).toBe(false);
    expect(r.failedChapterIds).toEqual([1]);
  }, 60_000);

  it('a cast-phase failure fixed by Phase 0 is cleared and announced once its Phase 1 succeeds', async () => {
    const r = await runCase(
      'p1-castfix-clean',
      { 1: 'analyzer-timeout' },
      [{ toRun: [1], runStage2Chapter: async (_m, id) => stage2For(id) }],
      { emptyCast: [1] },
    );
    expect(r.steps[0].events.filter((e) => e.kind === 'chapter-resolved').map((e) => e.chapterId)).toEqual([1]);
    expect(r.steps[0].events.some((e) => e.kind === 'result')).toBe(true);
    expect(r.failedChapterIds).toEqual([]);
    expect(r.chapters[1][0].characterId).toBe('nova');
  }, 60_000);

  it('S4: with no stage1, a Phase-0 success clears the cast record and announces it (no Phase 1 follows)', async () => {
    const r = await runCase(
      's4-nostage1',
      { 1: 'analyzer-timeout' },
      [{ toRun: [1], runStage2Chapter: async (_m, id) => stage2For(id) }],
      { emptyCast: [1], noStage1: true },
    );
    expect(r.steps[0].events.filter((e) => e.kind === 'chapter-resolved').map((e) => e.chapterId)).toEqual([1]);
    expect(r.failedChapterIds).toEqual([]);
  }, 60_000);

  it('S5, stage1 absent: the gate exit ends cast_incomplete naming the chapters, and the halted snapshot lands', async () => {
    const r = await runCase(
      's5-absent',
      {},
      [
        {
          toRun: [1],
          runStage1Chapter: () => Promise.reject(new Error('cast model exploded')),
          runStage2Chapter: async (_m, id) => stage2For(id),
        },
      ],
      { noStage1: true },
    );
    const errors = r.steps[0].events.filter((e) => e.kind === 'error');
    expect(errors.map((e) => e.code)).toEqual(['cast_incomplete']);
    expect(String(errors[0].message)).toContain('Chapter One');
    expect(String(errors[0].message)).toMatch(/Retry to continue.$/);
    expect(String(errors[0].message)).not.toMatch(/retry below/i);
    expect(r.steps[0].events.some((e) => e.kind === 'result')).toBe(false);
    expect(r.stage1).toBeUndefined();
    const snap = await haltedSnapshot(r.bookDir);
    expect(snap).toMatchObject({ state: 'halted', haltCode: 'cast_incomplete' });
  }, 60_000);

  it("S5, stage1 existed: the target's cast failed again - a terminal error with its classified code", async () => {
    const { AnalyzerTimeoutError } = await import('../analyzer/errors.js');
    const { classifyAnalysisFailure } = await import('./failure-taxonomy.js');
    const err = new AnalyzerTimeoutError('gemini', MODEL, 90_000, 'thinking-idle');
    const classified = classifyAnalysisFailure(err, 'phase0-model');
    const r = await runCase('s5-existed', {}, [
      { toRun: [1], runStage1Chapter: () => Promise.reject(err), runStage2Chapter: async (_m, id) => stage2For(id) },
    ]);
    const errors = r.steps[0].events.filter((e) => e.kind === 'error');
    expect(errors.map((e) => e.code)).toEqual([classified.code]);
    expect(r.failedChapterErrors['1']).toMatchObject({ code: classified.code, phase: 'cast' });
    expect(r.steps[0].events.some((e) => e.kind === 'result')).toBe(false);
    const snap = await haltedSnapshot(r.bookDir);
    expect(snap).toMatchObject({ state: 'halted', haltCode: classified.code });
  }, 60_000);

  it('S5, stage1 existed, blocking cast failure on a NON-target chapter: ends cast_incomplete naming it, target not attributed', async () => {
    const calls: number[] = [];
    const r = await runCase('s5-nontarget', { 2: 'analyzer-timeout' }, [
      {
        toRun: [1],
        runStage2Chapter: async (_m, id) => {
          calls.push(id);
          return stage2For(id);
        },
      },
    ]);
    const errors = r.steps[0].events.filter((e) => e.kind === 'error');
    expect(errors.map((e) => e.code)).toEqual(['cast_incomplete']);
    expect(String(errors[0].message)).toContain('Chapter Two');
    expect(String(errors[0].message)).not.toMatch(/retry below/i);
    expect(calls).toEqual([]);
    expect(r.chapters[1][0].characterId).toBe(COLLAPSED_ID);
    expect(r.failedChapterErrors['2']).toMatchObject({ phase: 'cast' });
    expect(r.failedChapterErrors['1']).toBeUndefined();
    expect(r.steps[0].events.some((e) => e.kind === 'result')).toBe(false);
  }, 60_000);

  it('S4: with no stage1, a Phase-0 success never clears an ATTRIBUTION record and announces nothing for it', async () => {
    const r = await runCase(
      's4-attr-kept',
      { 1: 'attribution-collapse' },
      [{ toRun: [1], runStage2Chapter: async (_m, id) => stage2For(id) }],
      { emptyCast: [1], noStage1: true },
    );
    expect(r.steps[0].events.some((e) => e.kind === 'chapter-resolved')).toBe(false);
    expect(r.failedChapterIds).toEqual([1]);
    expect(r.failedChapterErrors['1']).toMatchObject({ phase: 'attribution' });
  }, 60_000);

  it("S6: incomplete coverage ends via endJob(error cast_incomplete) with today's message, and the halted snapshot lands", async () => {
    const r = await runCase(
      's6-coverage',
      {},
      [{ toRun: [1], runStage2Chapter: async (_m, id) => stage2For(id) }],
      { noCast: [2] },
    );
    const errors = r.steps[0].events.filter((e) => e.kind === 'error');
    expect(errors.map((e) => e.code)).toEqual(['cast_incomplete']);
    expect(String(errors[0].message)).toMatch(/Phase 0a covers 1 of 2 chapters/);
    expect(r.steps[0].events.some((e) => e.kind === 'result')).toBe(false);
    const snap = await haltedSnapshot(r.bookDir);
    expect(snap).toMatchObject({ state: 'halted', haltCode: 'cast_incomplete' });
    expect(String(snap!.haltReason)).toMatch(/Phase 0a covers 1 of 2 chapters/);
  }, 60_000);

  it('a save that throws while recording a Phase-1 failure does not replace the real error or swallow chapter-failed', async () => {
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    (globalThis as Record<string, unknown>).__overflow_spend_test_save_hook = (c: {
      failedChapterErrors?: Record<string, { code: string }>;
    }) => {
      if (c.failedChapterErrors?.['1']?.code === 'analyzer-reasoning-overflow') throw new Error('ENOSPC: disk full');
    };
    const r = await runCase('save-throws-p1', {}, [
      { toRun: [1], runStage2Chapter: () => Promise.reject(new AnalyzerReasoningOverflowError('gemini', MODEL, 8100)) },
    ]);
    const { events } = r.steps[0];
    const terminal = events.find((e) => e.kind === 'error')!;
    expect(terminal.code).toBe('analyzer-reasoning-overflow');
    expect(String(terminal.message)).not.toMatch(/ENOSPC/);
    expect((terminal.fixes as unknown[]).length).toBeGreaterThan(0);
    expect(events.find((e) => e.kind === 'chapter-failed')).toMatchObject({ chapterId: 1, code: 'analyzer-reasoning-overflow' });
  }, 60_000);
});

describe('castIncompleteMessage (#3435 S5 copy)', () => {
  it('agrees with a single title', async () => {
    const { castIncompleteMessage } = await import('./analysis.js');
    expect(castIncompleteMessage(['A'])).toBe(
      'Phase 0 paused — 1 chapter still needs cast detection (A). Retry to continue.',
    );
  });
  it('lists up to three titles, location-neutral', async () => {
    const { castIncompleteMessage } = await import('./analysis.js');
    expect(castIncompleteMessage(['A', 'B', 'C'])).toBe(
      'Phase 0 paused — 3 chapters still need cast detection (A, B, C). Retry to continue.',
    );
  });
  it('caps a long list at three titles then "and N more"', async () => {
    const { castIncompleteMessage } = await import('./analysis.js');
    expect(castIncompleteMessage(['A', 'B', 'C', 'D', 'E', 'F'])).toBe(
      'Phase 0 paused — 6 chapters still need cast detection (A, B, C and 3 more). Retry to continue.',
    );
  });
});

describe('the subset result gate: S8 and S14 end resume_required on an unfinished book (#3435)', () => {
  const takeOf = (id: number, characterId = 'nova') => [
    { id: id * 100 + 1, chapterId: id, characterId, confidence: 0.9, text: BODIES[id] },
  ];
  const rec = (code: string, phase: 'cast' | 'attribution') => ({ code, message: 'seeded', remediation: 'seeded', phase });
  const STAGE1 = {
    characters: [novaCharacter()],
    chapters: [1, 2, 3].map((id) => ({ id, title: CHAPTER_TITLES[id] })),
  };

  type GateStep = { subset: number[] } | { main: true };

  /** A three-chapter book that has NOT reached Confirm (castConfirmed false,
      no confirmReached), its seeded cache, then each step in turn: a subset
      Retry of `subset`, or a main resume. */
  async function runGate(label: string, seedCache: Record<string, unknown>, steps: GateStep[]) {
    const seed = await seedBook(label, [1, 2, 3], { unconfirmed: true });
    const { saveAnalysisCache, loadAnalysisCache, clearAnalysisCache } = await import('../store/analysis-cache.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { runSubsetAnalyzerJob, runMainAnalyzerJob } = await import('./analysis.js');
    const { castJsonPath, manuscriptEditsJsonPath, stateJsonPath } = await import('../workspace/paths.js');
    await saveAnalysisCache(seed.manuscriptId, seedCache as never);
    const record = getManuscript(seed.manuscriptId)!;
    const stage2Calls: number[][] = [];
    const phase1 = (calls: number[]) =>
      buildSelection(
        stubAnalyzer({
          runStage2Chapter: async (_m, id) => {
            calls.push(id);
            return stage2For(id);
          },
        }),
        MODEL,
      );
    const results: CapturedEvent[][] = [];
    const caches: Array<Awaited<ReturnType<typeof loadAnalysisCache>>> = [];
    try {
      for (const step of steps) {
        const calls: number[] = [];
        stage2Calls.push(calls);
        if ('subset' in step) {
          const job = {
            ...seed.job,
            controller: new AbortController(),
            subscribers: new Set(),
            kind: 'subset' as const,
          } as unknown as AnalysisJob;
          const events = captureEvents(job);
          await runSubsetAnalyzerJob(
            job,
            record,
            seed.phase0Selection,
            phase1(calls),
            record.chapterHints.filter((c) => step.subset.includes(c.id)),
            false,
          );
          results.push(events);
        } else {
          const job = {
            ...seed.job,
            controller: new AbortController(),
            subscribers: new Set(),
          } as unknown as AnalysisJob;
          (globalThis as Record<string, unknown>).__overflow_spend_test_phase1_selection = phase1(calls);
          const events = captureEvents(job);
          await runMainAnalyzerJob(job, record as never, seed.phase0Selection, {
            requestedFresh: false,
            allowStage1Shrink: true,
            requestedModel: undefined,
          });
          await new Promise((r) => setTimeout(r, 100));
          results.push(events);
        }
        caches.push(await loadAnalysisCache(seed.manuscriptId));
      }
      const readOr = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined);
      return {
        steps: results,
        caches,
        stage2Calls,
        bookDir: seed.bookDir,
        after: await loadAnalysisCache(seed.manuscriptId),
        state: readOr(stateJsonPath(seed.bookDir)) as Record<string, unknown>,
        cast: readOr(castJsonPath(seed.bookDir)) as { characters: Array<{ lines?: number }> } | undefined,
        edits: readOr(manuscriptEditsJsonPath(seed.bookDir)) as { sentences: Array<{ chapterId: number }> } | undefined,
      };
    } finally {
      removeManuscript(seed.manuscriptId);
      await clearAnalysisCache(seed.manuscriptId);
    }
  }

  const endings = (events: CapturedEvent[]) =>
    events
      .filter((e) => e.kind === 'result' || e.kind === 'error')
      .map((e) => (e.kind === 'error' ? `error:${e.code}` : 'result'));

  it('P-delta: a Retry of ch2 while ch3 has no take ends resume_required naming ch3; no state.json or authoritative cast.json write, the interim roll is present, and the takes are not marked persisted', async () => {
    const r = await runGate(
      'p-delta',
      {
        stage1: STAGE1,
        chapterCast: { 1: [novaCharacter()], 2: [novaCharacter()], 3: [novaCharacter()] },
        chapters: { 1: takeOf(1) },
      },
      [{ subset: [2] }],
    );
    expect(r.stage2Calls[0]).toEqual([2]);
    expect(endings(r.steps[0])).toEqual(['error:resume_required']);
    const terminal = r.steps[0].find((e) => e.kind === 'error')!;
    expect(String(terminal.message)).toBe(
      'Chapter Two re-analysed. Chapter Three still needs attribution — resume the analysis to finish the book.',
    );
    /* No authoritative persist: state.json carries no provenance, and cast.json
       (if the interim overlay wrote one) has no attributed line counts. */
    expect(r.state.analysisProvenance).toBeUndefined();
    for (const c of r.cast?.characters ?? []) expect(c.lines ?? 0).toBe(0);
    /* The per-chapter roll did land. */
    expect(r.edits?.sentences.some((s) => s.chapterId === 2)).toBe(true);
    /* Binding (T5 review): the flags are set only on S14's pass branch. */
    expect(r.after.takesPersisted).toBe(false);
    expect(r.after.confirmReached).toBeUndefined();
  }, 60_000);

  it('P-eta: a Retry of ch2 while ch1 is pending ends resume_required; a main resume then re-attributes ch1 and sends result', async () => {
    const r = await runGate(
      'p-eta',
      {
        chapterCast: { 1: [], 2: [novaCharacter()], 3: [novaCharacter()] },
        chapters: { 1: takeOf(1, 'narrator'), 2: takeOf(2, 'narrator'), 3: takeOf(3) },
        failedChapterIds: [1, 2],
        failedChapterErrors: { '1': rec('analyzer-timeout', 'cast'), '2': rec('attribution-collapse', 'attribution') },
      },
      [{ subset: [1] }, { subset: [2] }, { main: true }],
    );
    /* Step 1 is S8 (stage1 absent at load): no attribution. */
    expect(endings(r.steps[0])).toEqual(['error:resume_required']);
    expect(r.stage2Calls[0]).toEqual([]);
    /* Step 2 attributes ch2, but ch1 (S0 put it in P) is still pending. */
    expect(r.stage2Calls[1]).toEqual([2]);
    expect(endings(r.steps[1])).toEqual(['error:resume_required']);
    expect(String(r.steps[1].find((e) => e.kind === 'error')!.message)).toContain('Chapter One still needs attribution');
    expect(r.caches[1].takesPersisted).toBe(false);
    expect(r.caches[1].confirmReached).toBeUndefined();
    /* The main resume re-attributes the pending chapter and finishes the book. */
    expect(r.stage2Calls[2]).toEqual([1]);
    expect(endings(r.steps[2])).toEqual(['result']);
    expect(r.after.pendingAttributionChapterIds ?? []).toEqual([]);
    expect(r.after.takesPersisted).toBe(true);
  }, 60_000);

  it('S14 with two chapters missing: the message and the log line use the plural', async () => {
    const r = await runGate(
      's14-plural',
      {
        stage1: STAGE1,
        chapterCast: { 1: [novaCharacter()], 2: [novaCharacter()], 3: [novaCharacter()] },
        chapters: {},
      },
      [{ subset: [1] }],
    );
    expect(endings(r.steps[0])).toEqual(['error:resume_required']);
    expect(String(r.steps[0].find((e) => e.kind === 'error')!.message)).toBe(
      'Chapter One re-analysed. Chapter Two, Chapter Three still need attribution — resume the analysis to finish the book.',
    );
    expect(
      r.steps[0].some(
        (e) =>
          e.kind === 'log' &&
          e.message === '2 other chapters still need attribution — resume the analysis to finish the book.',
      ),
    ).toBe(true);
  }, 60_000);

  it('S14 with one chapter missing: the log line uses the singular', async () => {
    const r = await runGate(
      's14-singular-log',
      {
        stage1: STAGE1,
        chapterCast: { 1: [novaCharacter()], 2: [novaCharacter()], 3: [novaCharacter()] },
        chapters: { 1: takeOf(1) },
      },
      [{ subset: [2] }],
    );
    expect(
      r.steps[0].some(
        (e) =>
          e.kind === 'log' &&
          e.message === '1 other chapter still needs attribution — resume the analysis to finish the book.',
      ),
    ).toBe(true);
  }, 60_000);

  it('P-beta (server): with no stage1, a Retry whose cast detection completes the book ends resume_required (S8), not silently', async () => {
    const r = await runGate(
      'p-beta',
      {
        chapterCast: { 1: [], 2: [novaCharacter()], 3: [novaCharacter()] },
        chapters: {},
        failedChapterIds: [1],
        failedChapterErrors: { '1': rec('analyzer-timeout', 'cast') },
      },
      [{ subset: [1] }],
    );
    expect(endings(r.steps[0])).toEqual(['error:resume_required']);
    expect(String(r.steps[0].find((e) => e.kind === 'error')!.message)).toBe(
      'Cast detection for Chapter One is done. The rest of the book still needs attribution — resume the analysis to finish.',
    );
    expect(r.stage2Calls[0]).toEqual([]);
    expect(r.after.stage1).toBeDefined();
  }, 60_000);
});
