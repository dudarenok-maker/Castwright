/* #3084 wave 2b, P20 — "stop new spend" after a reasoning overflow, driven
   through runMainAnalyzerJob against a real workspace book (the harness of
   analysis.rename-midrun.test.ts: a tmpdir workspace, the analyzer/GPU mocks,
   lazy imports). A stage-2 overflow in chapter 2 ends the run while chapter 1
   is still calling the model. Chapter 1 must still finish and cache for resume
   (the pools' design, analysis.ts:5672-5675), must start no escalation window,
   and its late completion must not overwrite the job's terminal `halted`
   snapshot or its code (N4).

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
vi.mock('./ollama-health.js', () => ({ detectOllamaDevice: detectOllamaDeviceMock }));
vi.mock('../gpu/analyzer-device-state.js', () => ({
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
      (globalThis as Record<string, unknown> & { __overflow_spend_test_save_hook?: (c: typeof args[1]) => void }).__overflow_spend_test_save_hook?.(args[1]);
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

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-overflow-spend-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Both pools size from analyzerPoolWidth() (analysis.ts:1277-1280): 2 puts
     both chapters in flight at once. */
  process.env.ANALYZER_OLLAMA_CONCURRENCY = '2';
  process.env.STAGE2_COVERAGE_RETRIES = '0';
  /* The first dynamic import of ./analysis.js costs 14 s+ cold (the whole
     analyzer/TTS graph); inside the first test's 30 s budget it times out at
     --retry=0 and only the repo's default retry hid it. Pay it here. */
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
  opts: { fullCache?: boolean } = {},
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
      castConfirmed: true,
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

describe('a reasoning overflow stops new spend, not work already in flight (#3084 P20, N4)', () => {
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

  it('after a stage-2 overflow in chapter 2, chapter 1 (already calling the model) finishes and caches, starts no escalation window, and the halted snapshot keeps its code (P20, N4)', async () => {
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
    (globalThis as Record<string, unknown>).__overflow_spend_test_phase1_selection = buildSelection(
      stubAnalyzer({
        runAttributionEscalation: escalate,
        async runStage2Chapter(_m: string, chapterId: number, _p: string, _call: StageCall): Promise<Stage2ChapterOutput> {
          if (chapterId === 2) {
            await chapterOneInFlight;
            throw new AnalyzerReasoningOverflowError('gemini', MODEL, 8100);
          }
          markChapterOneInFlight();
          /* Chapter 1's model call returns only after the run has ended on chapter 2's overflow. */
          await runEnded;
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

      /* P20 — chapter 1 still finishes and caches for resume. */
      await vi.waitFor(
        async () => expect((await loadAnalysisCache(seed.manuscriptId)).chapters[1]).toBeDefined(),
        { timeout: 10_000, interval: 50 },
      );
      /* P20 — but it started no escalation window, and nothing aborted the job. */
      expect(escalate).not.toHaveBeenCalled();
      expect(seed.job.controller.signal.aborted).toBe(false);
      expect(events.some((e) => e.kind === 'result')).toBe(false);

      /* N4 — read the persisted snapshot, not only the first event: chapter 1's
         late completion must not overwrite the terminal state or its code.
         endJob's snapshot write is fire-and-forget. */
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
      expect(job.controller.signal.aborted).toBe(false);
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
      expect(job.controller.signal.aborted).toBe(false);
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
    expect(run.job.controller.signal.aborted).toBe(false);
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

/* #3435 — a Retry (subset route) whose Phase 1 (attribution) fails. Phase 0
   used to clear the chapter's failure record and send chapter-resolved BEFORE
   attribution ran, so a Phase-1 failure left the chapter looking retried-clean:
   nothing re-recorded it and the terminal handler sent only `error`. The
   record is now kept until Phase 1 completes, and the Phase-1 catch records it
   (for a chapter with no prior record) and sends chapter-failed, the same way
   the route's Phase-0 failure path does. */
describe('a Retry whose Phase 1 fails keeps its failure on record and reports it (#3435)', () => {
  /* The first dynamic import of ./analysis.js costs ~14 s cold (it pulls the whole
     analyzer/TTS graph). Left inside the first test's 30 s budget it times out
     under load — the control, being first, hung at --retry=0 and was only
     rescued by the repo's default retry. Pay it here, with its own budget. */
  beforeAll(async () => {
    await import('./analysis.js');
  }, 120_000);

  async function runRetry(
    label: string,
    runStage2Chapter: Analyzer['runStage2Chapter'],
    seedFailed: boolean,
  ): Promise<{ events: CapturedEvent[]; failedChapterIds: number[]; failedChapterErrors: Record<string, { code: string }> }> {
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
        '1': { code: 'attribution-collapse', message: 'seeded', remediation: 'seeded' },
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
        failedChapterErrors: (after.failedChapterErrors ?? {}) as Record<string, { code: string }>,
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
    expect(failed).toMatchObject({ chapterId: 1, code: classified.code, message: expect.stringContaining('thinking window') });
    expect(r.failedChapterIds).toEqual([1]);
    expect(r.failedChapterErrors['1'].code).toBe(classified.code);
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

/* #3435 review pass 1 — the failure record is read back by the NEXT subset run's
   Phase-1 gate, and a Retry that never reaches the end of Phase 1 must not lose
   the record it erased in Phase 0. A two-chapter FINISHED book (both chapters
   cast + attributed, stage1 on disk), driven through successive subset runs. */
describe('the subset route: failure records vs the Phase-1 gate and an unfinished Retry (#3435)', () => {
  beforeAll(async () => {
    await import('./analysis.js');
  }, 120_000);

  /** Chapter 1's cached sentences are "collapsed" (narrator); a re-attribution
      writes nova, so a changed characterId proves the chapter was re-attributed. */
  const COLLAPSED_ID = 'narrator';

  interface Step {
    toRun: number[];
    runStage2Chapter: Analyzer['runStage2Chapter'];
    /** Overrides the Phase-1 selection model id (split-model case). */
    phase1Model?: string;
    /** Replaces the Phase-0 (cast) analyzer's per-chapter call. */
    runStage1Chapter?: Analyzer['runStage1Chapter'];
  }
  interface StepResult {
    events: CapturedEvent[];
    job: AnalysisJob;
  }
  interface CaseResult {
    steps: StepResult[];
    failedChapterIds: number[];
    failedChapterErrors: Record<string, { code: string }>;
    chapters: Record<number, Array<{ characterId: string }>>;
  }

  async function runCase(
    label: string,
    seedFailed: Record<number, string>,
    steps: Step[],
    opts: { prevStage1Size?: number; emptyCast?: number[]; excluded?: number[] } = {},
  ): Promise<CaseResult> {
    const seed = await seedBook(label, [1, 2], { fullCache: true });
    const { saveAnalysisCache, loadAnalysisCache, clearAnalysisCache } = await import('../store/analysis-cache.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { runSubsetAnalyzerJob } = await import('./analysis.js');
    const cache = await loadAnalysisCache(seed.manuscriptId);
    cache.chapterCast = { 1: [novaCharacter()], 2: [novaCharacter()] };
    for (const id of opts.emptyCast ?? []) cache.chapterCast[id] = [];
    if (opts.prevStage1Size) {
      /* A larger roster on disk than Phase 0 will rebuild (nova only) trips the
         stage-1 shrink guard once it is 3+ and the rebuild is under half. */
      cache.stage1 = {
        characters: Array.from({ length: opts.prevStage1Size }, (_, i) => ({
          ...novaCharacter(),
          id: `extra-${i}`,
          name: `Extra ${i}`,
        })),
        chapters: [1, 2].map((id) => ({ id, title: CHAPTER_TITLES[id] })),
      };
    }
    cache.chapters = {
      1: [{ id: 101, chapterId: 1, characterId: COLLAPSED_ID, confidence: 0.9, text: BODIES[1] }],
      2: [{ id: 201, chapterId: 2, characterId: 'nova', confidence: 0.9, text: BODIES[2] }],
    } as never;
    const ids = Object.keys(seedFailed).map(Number);
    if (ids.length) {
      cache.failedChapterIds = ids;
      cache.failedChapterErrors = Object.fromEntries(
        ids.map((id) => [String(id), { code: seedFailed[id], message: 'seeded', remediation: 'seeded' }]),
      );
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
          buildSelection(stubAnalyzer({ runStage2Chapter: step.runStage2Chapter }), step.phase1Model ?? MODEL),
          record.chapterHints.filter((c) => step.toRun.includes(c.id)),
          false,
        );
        results.push({ events, job });
      }
      const after = await loadAnalysisCache(seed.manuscriptId);
      return {
        steps: results,
        failedChapterIds: after.failedChapterIds ?? [],
        failedChapterErrors: (after.failedChapterErrors ?? {}) as Record<string, { code: string }>,
        chapters: (after.chapters ?? {}) as CaseResult['chapters'],
      };
    } finally {
      removeManuscript(seed.manuscriptId);
      await clearAnalysisCache(seed.manuscriptId);
    }
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

  it('P1: pausing during a Retry\'s Phase 1 keeps the chapter\'s prior failure record and its collapsed sentences', async () => {
    const { AnalysisAbortedError } = await import('../analyzer/errors.js');
    const r = await runCase('p1-abort', { 1: 'attribution-collapse' }, [
      { toRun: [1], runStage2Chapter: () => Promise.reject(new AnalysisAbortedError('paused')) },
    ]);
    const { events } = r.steps[0];
    expect(events.filter((e) => e.kind === 'error').map((e) => e.code)).toEqual(['aborted']);
    /* The view drops its row on chapter-resolved, so none may be sent for a
       chapter whose Phase 1 never ran. */
    expect(events.some((e) => e.kind === 'chapter-resolved')).toBe(false);
    expect(r.failedChapterIds).toEqual([1]);
    expect(r.failedChapterErrors['1'].code).toBe('attribution-collapse');
    expect(r.chapters[1][0].characterId).toBe(COLLAPSED_ID);
  }, 60_000);

  it('a Retry that ends in stage1_shrink_refused keeps the chapter\'s prior failure record', async () => {
    const calls: number[] = [];
    const r = await runCase(
      'p1-shrink',
      { 1: 'attribution-collapse' },
      [
        {
          toRun: [1],
          runStage2Chapter: async (_m, id) => {
            calls.push(id);
            return stage2For(id);
          },
        },
      ],
      { prevStage1Size: 6 },
    );
    const { events } = r.steps[0];
    expect(events.filter((e) => e.kind === 'error').map((e) => e.code)).toEqual(['stage1_shrink_refused']);
    expect(calls).toEqual([]);
    expect(events.some((e) => e.kind === 'chapter-resolved')).toBe(false);
    expect(r.failedChapterIds).toEqual([1]);
    expect(r.chapters[1][0].characterId).toBe(COLLAPSED_ID);
  }, 60_000);

  it('control: a Retry that completes Phase 1 clears the record and sends chapter-resolved once', async () => {
    const r = await runCase('p1-clean', { 1: 'attribution-collapse' }, [
      { toRun: [1], runStage2Chapter: async (_m, id) => stage2For(id) },
    ]);
    const { events } = r.steps[0];
    expect(events.filter((e) => e.kind === 'chapter-resolved').map((e) => e.chapterId)).toEqual([1]);
    expect(events.some((e) => e.kind === 'result')).toBe(true);
    expect(r.failedChapterIds).toEqual([]);
    expect(r.chapters[1][0].characterId).toBe('nova');
  }, 60_000);

  it('with split phase models, a Phase-1 failure\'s terminal error names the Phase-1 model, not the Phase-0 one', async () => {
    const { AnalyzerTruncatedError } = await import('../analyzer/errors.js');
    const r = await runCase('label', {}, [
      {
        toRun: [1],
        phase1Model: 'phase1-only-model',
        runStage2Chapter: () => Promise.reject(new AnalyzerTruncatedError('gemini', 'MAX_TOKENS', 100)),
      },
    ]);
    const terminal = r.steps[0].events.find((e) => e.kind === 'error')!;
    expect(terminal.code).toBe('analyzer-truncated');
    expect(String(terminal.message)).toContain('phase1-only-model');
    expect(String(terminal.message)).not.toContain('phase0-model');
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

  it('a save that throws while recording a Phase-0 failure still reports chapter-failed and does not end the run on the fs error', async () => {
    let thrown = false;
    (globalThis as Record<string, unknown>).__overflow_spend_test_save_hook = (c: {
      failedChapterErrors?: Record<string, unknown>;
      chapterCast?: Record<number, unknown[]>;
    }) => {
      /* Only the save inside the failure catch: later saves are a different path. */
      if (!thrown && c.failedChapterErrors?.['1'] && !c.chapterCast?.[1]?.length) {
        thrown = true;
        throw new Error('ENOSPC: disk full');
      }
    };
    const r = await runCase('save-throws-p0', {}, [
      {
        toRun: [1],
        runStage1Chapter: () => Promise.reject(new Error('cast model exploded')),
        runStage2Chapter: async (_m, id) => stage2For(id),
      },
    ]);
    const { events } = r.steps[0];
    expect(events.find((e) => e.kind === 'chapter-failed')).toMatchObject({ chapterId: 1 });
    expect(events.filter((e) => e.kind === 'error' && /ENOSPC/.test(String(e.message)))).toEqual([]);
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

  it('PD: a collapse-flagged chapter whose cast failed (empty cast, collapsed sentences) keeps its record when a Retry is paused in Phase 1', async () => {
    const { AnalysisAbortedError } = await import('../analyzer/errors.js');
    const r = await runCase(
      'pd-abort',
      { 1: 'analyzer-timeout' },
      [{ toRun: [1], runStage2Chapter: () => Promise.reject(new AnalysisAbortedError('paused')) }],
      { emptyCast: [1] },
    );
    const { events } = r.steps[0];
    expect(events.filter((e) => e.kind === 'error').map((e) => e.code)).toEqual(['aborted']);
    expect(events.some((e) => e.kind === 'chapter-resolved')).toBe(false);
    expect(r.failedChapterIds).toEqual([1]);
    expect(r.chapters[1][0].characterId).toBe(COLLAPSED_ID);
  }, 60_000);
});

describe('main-route resume: which failed chapters re-enter cast detection (#3435)', () => {
  beforeAll(async () => {
    await import('./analysis.js');
  }, 120_000);

  /** A book with NO stage1: chapter 1 attribution-flagged (has its cast, cached
      collapsed sentences), chapter 2 cast-failed (empty-array failure marker). */
  async function runResume(label: string) {
    const seed = await seedBook(label, [1, 2]);
    const { saveAnalysisCache, loadAnalysisCache, clearAnalysisCache } = await import('../store/analysis-cache.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { runMainAnalyzerJob } = await import('./analysis.js');
    await saveAnalysisCache(seed.manuscriptId, {
      chapters: {
        1: [{ id: 101, chapterId: 1, characterId: 'narrator', confidence: 0.9, text: BODIES[1] }],
      } as never,
      chapterCast: { 1: [novaCharacter()], 2: [] },
      failedChapterIds: [1, 2],
      failedChapterErrors: {
        '1': { code: 'attribution-collapse', message: 'seeded', remediation: 'seeded' },
        '2': { code: 'analyzer-timeout', message: 'seeded', remediation: 'seeded' },
      },
    } as never);
    const castCalls: number[] = [];
    const phase0 = buildSelection(
      stubAnalyzer({
        async runStage1Chapter(_m, chapterId): Promise<Stage1ChapterOutput> {
          castCalls.push(chapterId);
          return { characters: [novaCharacter()] };
        },
      }),
      'phase0-model',
    );
    (globalThis as Record<string, unknown>).__overflow_spend_test_phase1_selection = buildSelection(
      stubAnalyzer({ runStage2Chapter: async (_m, id) => stage2For(id) }),
      MODEL,
    );
    const events = captureEvents(seed.job);
    try {
      await runMainAnalyzerJob(seed.job, getManuscript(seed.manuscriptId)! as never, phase0, {
        requestedFresh: false,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });
      const after = await loadAnalysisCache(seed.manuscriptId);
      return { castCalls, events, after };
    } finally {
      removeManuscript(seed.manuscriptId);
      await clearAnalysisCache(seed.manuscriptId);
    }
  }

  it('PE: an attribution-flagged chapter with a cast is not re-queued into cast detection and not cleared by the resume; the cast-failed one is', async () => {
    const { castCalls, events, after } = await runResume('pe-resume');
    expect(castCalls).toEqual([2]);
    expect(events.filter((e) => e.kind === 'chapter-resolved').map((e) => e.chapterId)).toEqual([2]);
    expect(after.failedChapterIds).toEqual([1]);
    expect(after.failedChapterErrors?.['1']?.code).toBe('attribution-collapse');
  }, 60_000);

  it('a save that throws in the Phase-0a failure catch keeps the original error and still sends chapter-failed', async () => {
    const seed = await seedBook('save-throws-main', [1, 2]);
    const { clearAnalysisCache } = await import('../store/analysis-cache.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { runMainAnalyzerJob } = await import('./analysis.js');
    let thrown = false;
    (globalThis as Record<string, unknown>).__overflow_spend_test_save_hook = (c: {
      failedChapterErrors?: Record<string, unknown>;
      chapterCast?: Record<number, unknown[]>;
    }) => {
      /* Only the save inside the failure catch (the record is there, the cast is the empty marker). */
      if (!thrown && c.failedChapterErrors?.['1'] && c.chapterCast?.[1] && !c.chapterCast[1].length) {
        thrown = true;
        throw new Error('ENOSPC: disk full');
      }
    };
    const phase0 = buildSelection(
      stubAnalyzer({ runStage1Chapter: () => Promise.reject(new Error('cast model exploded')) }),
      'phase0-model',
    );
    const events = captureEvents(seed.job);
    try {
      await runMainAnalyzerJob(seed.job, getManuscript(seed.manuscriptId)! as never, phase0, {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });
    } finally {
      removeManuscript(seed.manuscriptId);
      await clearAnalysisCache(seed.manuscriptId);
    }
    expect(thrown).toBe(true);
    expect(events.find((e) => e.kind === 'chapter-failed' && e.chapterId === 1)).toBeDefined();
    expect(events.filter((e) => e.kind === 'error' && /ENOSPC/.test(String(e.message)))).toEqual([]);
  }, 60_000);
});
