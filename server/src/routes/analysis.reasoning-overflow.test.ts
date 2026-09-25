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

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  restoreEnv('ANALYZER_OLLAMA_CONCURRENCY', originalConcurrency);
  restoreEnv('STAGE2_COVERAGE_RETRIES', originalCoverageRetries);
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__overflow_spend_test_phase1_selection;
  delete (globalThis as Record<string, unknown>).__overflow_spend_test_pipelined;
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
});
