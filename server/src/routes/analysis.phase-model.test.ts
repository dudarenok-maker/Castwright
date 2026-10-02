/* Phase-event model propagation — regression for "phase events carry the
   resolved analyzer model id."

   The route already emits `model` on throttle events (plan-88 precedent).
   This suite pins the matching contract for plain `phase` events: every
   phase-0 event must carry `model === phase0ModelId` and every phase-1
   event must carry `model === phase1ModelId`.

   Uses the same spy-analyzer + stub-manuscript harness as
   analysis-pipelining.test.ts so no network / Ollama calls are made. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { buildNonStoryClassifier, noteReasoningOverflow, runMainAnalyzerJob, runSubsetAnalyzerJob, type AnalysisJob } from './analysis.js';
import { clearAnalysisCache } from '../store/analysis-cache.js';
import type { Analyzer, AnalyzerSelection, StageCall } from '../analyzer/index.js';
import type { Stage1ChapterOutput, Stage1Output, Stage2ChapterOutput } from '../handoff/schemas.js';
import type { ChapterHint } from '../store/manuscripts.js';
import { putManuscript, removeManuscript } from '../store/manuscripts.js';
import { AnalysisAbortedError, AnalyzerReasoningOverflowError, GeminiContentBlockedError } from '../analyzer/errors.js';
import { LocalUnreachableError } from '../analyzer/ollama.js';
import { FallbackAnalyzer } from '../analyzer/index.js';
import { USER_SETTINGS_PATH } from '../workspace/user-settings.js';

/* ── spy analyzer / selection helpers (mirrors analysis-pipelining.test.ts) */

function buildSpyPhase0Analyzer(): Analyzer {
  return {
    async runStage1(): Promise<Stage1Output> {
      throw new Error('runStage1 not used in this suite');
    },
    async runStage1Chapter(_manuscriptId: string, chapterId: number): Promise<Stage1ChapterOutput> {
      return {
        characters: [
          {
            id: 'narrator',
            name: 'Narrator',
            role: 'narrator',
            color: 'narrator',
            evidence: [
              { quote: 'lorem ipsum dolor sit amet' },
              { quote: 'lorem ipsum dolor sit amet' },
              { quote: 'lorem ipsum dolor sit amet' },
            ],
          },
          {
            id: `ch${chapterId}-char`,
            name: `Character_ch${chapterId}`,
            role: 'character',
            color: 'unset',
            evidence: [
              { quote: 'lorem ipsum dolor sit amet' },
              { quote: 'lorem ipsum dolor sit amet' },
              { quote: 'lorem ipsum dolor sit amet' },
            ],
          },
        ],
      };
    },
    async runStage2Chapter(): Promise<Stage2ChapterOutput> {
      throw new Error('Phase-0 analyzer does not run Phase-1 calls');
    },
    async runEmotionChapter() {
      throw new Error('Phase-0 analyzer does not run emotion calls');
    },
    async runScriptReviewChapter() {
      throw new Error('Phase-0 analyzer does not run script review calls');
    },
    async runStage3Chapter() {
      throw new Error('Phase-0 analyzer does not run instruct-annotation calls');
    },
    async runAttributionEscalation() {
      throw new Error('Phase-0 analyzer does not run escalation calls');
    },
  };
}

function buildSpyPhase1Analyzer(): Analyzer {
  return {
    async runStage1(): Promise<Stage1Output> {
      throw new Error('runStage1 not used in this suite');
    },
    async runStage1Chapter(): Promise<Stage1ChapterOutput> {
      throw new Error('Phase-1 analyzer does not run Phase-0 calls');
    },
    async runStage2Chapter(
      _manuscriptId: string,
      chapterId: number,
      _prompt: string,
      _call: StageCall,
    ): Promise<Stage2ChapterOutput> {
      return {
        sentences: [
          {
            id: chapterId * 100 + 1,
            chapterId,
            characterId: 'narrator',
            text: 'lorem ipsum dolor sit amet.',
          },
        ],
      };
    },
    async runEmotionChapter() {
      throw new Error('Phase-1 analyzer does not run emotion calls');
    },
    async runScriptReviewChapter() {
      throw new Error('Phase-1 analyzer does not run script review calls');
    },
    async runStage3Chapter() {
      throw new Error('Phase-1 analyzer does not run instruct-annotation calls');
    },
    async runAttributionEscalation() {
      throw new Error('Phase-1 analyzer does not run escalation calls');
    },
  };
}

function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
  return { analyzer, engine: 'gemini', model, fallbackModel: null };
}

function buildStubJob(manuscriptId: string): AnalysisJob {
  return {
    controller: new AbortController(),
    subscribers: new Set(),
    manuscriptId,
    kind: 'main',
    bookDir: null,
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
  };
}

function buildStubChapters(count: number): ChapterHint[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    title: `Chapter ${i + 1}`,
    body: `Chapter ${i + 1} body. ` + 'lorem ipsum dolor sit amet '.repeat(50),
  }));
}

function registerStubManuscript(id: string, count: number): void {
  const chapterHints = buildStubChapters(count);
  putManuscript({
    manuscriptId: id,
    format: 'plaintext',
    title: `Stub ${id}`,
    wordCount: chapterHints.length * 100,
    byteSize: 100_000,
    uploadedAt: new Date().toISOString(),
    sourceText: chapterHints.map((c) => c.body).join('\n\n'),
    chapterHints,
  });
}

/* ── vi.mock for select-analyzer so the route picks our spy analyzers. ── */

/* #3141 step 4 — the route-level suite below also needs a Phase 0 override
   (so the POST route never constructs a real Ollama/Gemini analyzer) and a
   record of every call's opts, so a test can assert what the route parsed
   out of req.body without re-implementing the parsing itself. */
vi.mock('../analyzer/select-analyzer.js', async () => {
  const actual = await vi.importActual<typeof import('../analyzer/select-analyzer.js')>(
    '../analyzer/select-analyzer.js',
  );
  return {
    ...actual,
    selectAnalyzerForPhase: (opts: { phase: 'phase0' | 'phase1'; phaseModel?: string; model?: string }) => {
      const g = globalThis as Record<string, unknown>;
      (g.__phase_model_test_calls as unknown[] | undefined)?.push({ ...opts });
      if (opts.phase === 'phase1' && g.__phase_model_test_phase1_selection) {
        return g.__phase_model_test_phase1_selection;
      }
      if (opts.phase === 'phase0' && g.__phase_model_test_phase0_selection) {
        return g.__phase_model_test_phase0_selection;
      }
      return actual.selectAnalyzerForPhase(
        opts as Parameters<typeof actual.selectAnalyzerForPhase>[0],
      );
    },
    isPerPhaseModelSelectionActive: (_hasPerRunPhasePick?: boolean) => {
      /* Always return false (sequential mode) — keeps Phase 1 simple and
         deterministic without needing to fiddle with lag semaphores. */
      return false;
    },
  };
});

function setPhase1Selection(sel: AnalyzerSelection): void {
  (globalThis as Record<string, unknown>).__phase_model_test_phase1_selection = sel;
}

function clearPhase1Selection(): void {
  delete (globalThis as Record<string, unknown>).__phase_model_test_phase1_selection;
}

function setPhase0Selection(sel: AnalyzerSelection): void {
  (globalThis as Record<string, unknown>).__phase_model_test_phase0_selection = sel;
}

function clearPhase0Selection(): void {
  delete (globalThis as Record<string, unknown>).__phase_model_test_phase0_selection;
}

interface CapturedSelectorCall {
  phase: 'phase0' | 'phase1';
  phaseModel?: string;
  model?: string;
}

function startCapturingSelectorCalls(): CapturedSelectorCall[] {
  const calls: CapturedSelectorCall[] = [];
  (globalThis as Record<string, unknown>).__phase_model_test_calls = calls;
  return calls;
}

function stopCapturingSelectorCalls(): void {
  delete (globalThis as Record<string, unknown>).__phase_model_test_calls;
}

afterEach(() => {
  clearPhase1Selection();
  clearPhase0Selection();
  stopCapturingSelectorCalls();
});

/* ── captured-events helper ── */

interface CapturedEvent {
  kind: string;
  [k: string]: unknown;
}

function attachEventCapture(job: AnalysisJob): CapturedEvent[] {
  const events: CapturedEvent[] = [];
  const sub = {
    send: (payload: unknown) => {
      if (payload && typeof payload === 'object') {
        events.push(payload as CapturedEvent);
      }
    },
    res: { end: () => {} } as unknown as import('express').Response,
    keepAlive: setInterval(() => {}, 100_000) as NodeJS.Timeout,
  };
  /* Clear the keepAlive so the test process doesn't hang. */
  clearInterval(sub.keepAlive);
  job.subscribers.add(sub);
  return events;
}

/* ── Suite: phase events carry the resolved model id ─────────────────── */

describe('phase events carry the resolved model id', () => {
  it('phase-0 events have model===phase0ModelId; phase-1 events have model===phase1ModelId', async () => {
    const PHASE0_MODEL = 'gemma-phase0-test-model';
    const PHASE1_MODEL = 'gemini-phase1-test-model';

    const manuscriptId = `test-phase-model-${Date.now()}`;
    registerStubManuscript(manuscriptId, 2);

    /* Disable the stage-2 coverage guard (plan 181): stub responses are
         intentionally minimal and would fail coverage, tripling call counts.
         This is the same pattern as analysis-pipelining.test.ts. */
    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';

    const phase0Analyzer = buildSpyPhase0Analyzer();
    const phase1Analyzer = buildSpyPhase1Analyzer();
    const phase0Selection = buildSelection(phase0Analyzer, PHASE0_MODEL);
    const phase1Selection = buildSelection(phase1Analyzer, PHASE1_MODEL);
    setPhase1Selection(phase1Selection);

    const job = buildStubJob(manuscriptId);
    const events = attachEventCapture(job);

    try {
      const { getManuscript } = await import('../store/manuscripts.js');
      const recordRef = getManuscript(manuscriptId);
      if (!recordRef) throw new Error('stub manuscript not found');

      await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });

      const phaseEvents = events.filter((e) => e.kind === 'phase') as Array<
        CapturedEvent & { phaseId: number; model?: string }
      >;

      /* Must have emitted at least one phase-0 and one phase-1 event. */
      const phase0Events = phaseEvents.filter((e) => e.phaseId === 0);
      const phase1Events = phaseEvents.filter((e) => e.phaseId === 1);
      expect(phase0Events.length).toBeGreaterThan(0);
      expect(phase1Events.length).toBeGreaterThan(0);

      /* Every phase-0 event must carry the resolved phase-0 model id. */
      for (const ev of phase0Events) {
        expect(ev.model, `phase-0 event missing model: ${JSON.stringify(ev)}`).toBe(PHASE0_MODEL);
      }

      /* Every phase-1 event must carry the resolved phase-1 model id. */
      for (const ev of phase1Events) {
        expect(ev.model, `phase-1 event missing model: ${JSON.stringify(ev)}`).toBe(PHASE1_MODEL);
      }
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
      process.env.STAGE2_COVERAGE_RETRIES = origCovRetries;
    }
  }, 60_000);
});

/* ── Suite: a Gemini content-block fails fast with a terminal error ────── */

function buildContentBlockedPhase0Analyzer(model: string): Analyzer {
  return {
    ...buildSpyPhase0Analyzer(),
    async runStage1Chapter(): Promise<Stage1ChapterOutput> {
      /* Deterministic, whole-book-fatal filter block — must NOT be swallowed
         into a per-chapter chapter-failed + empty roster (the "0%, no error"
         symptom). It must reach the route's terminal error handler. */
      throw new GeminiContentBlockedError(model, 'RECITATION');
    },
  };
}

describe('a Gemini content-block surfaces a terminal error', () => {
  it('phase-0 per-chapter content-block → terminal analyzer-content-blocked error, not a silent empty roster', async () => {
    const MODEL = 'gemini-3.1-flash-lite';
    const manuscriptId = `test-content-blocked-${Date.now()}`;
    registerStubManuscript(manuscriptId, 2);
    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';

    const phase0Selection = buildSelection(buildContentBlockedPhase0Analyzer(MODEL), MODEL);
    const job = buildStubJob(manuscriptId);
    const events = attachEventCapture(job);

    try {
      const { getManuscript } = await import('../store/manuscripts.js');
      const recordRef = getManuscript(manuscriptId);
      if (!recordRef) throw new Error('stub manuscript not found');

      await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });

      const errorEvent = events.find((e) => e.kind === 'error') as
        | (CapturedEvent & { code?: string; message?: string })
        | undefined;
      expect(errorEvent, 'a terminal error event must be emitted, not a silent all-chapters-failed run').toBeDefined();
      expect(errorEvent?.code).toBe('analyzer-content-blocked');
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
      process.env.STAGE2_COVERAGE_RETRIES = origCovRetries;
    }
  }, 60_000);
});

/* ── Suite: the pill shows the EFFECTIVE model after a local→gemini fallback ── */

describe('phase events name the effective model after a silent local→gemini fallback (Bug 2)', () => {
  it('phase-0 events switch from the dead local primary to the Gemini fallback model', async () => {
    const LOCAL_MODEL = 'qwen-local-test';
    const FALLBACK_MODEL = 'gemini-3.1-flash-lite';
    const manuscriptId = `test-fallback-model-${Date.now()}`;
    registerStubManuscript(manuscriptId, 2);
    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';

    /* Primary (local) is unreachable on every chapter; the Gemini fallback works.
       The FallbackAnalyzer must ANNOUNCE the switch (call.onFallback) so the route
       re-labels the pill — otherwise it keeps naming the local model that isn't
       running (the "wrong model in the pill" bug). */
    const primary: Analyzer = {
      ...buildSpyPhase0Analyzer(),
      async runStage1Chapter(): Promise<Stage1ChapterOutput> {
        throw new LocalUnreachableError('Ollama down');
      },
    };
    const selection: AnalyzerSelection = {
      analyzer: new FallbackAnalyzer(primary, buildSpyPhase0Analyzer()),
      engine: 'local',
      model: LOCAL_MODEL,
      fallbackModel: FALLBACK_MODEL,
    };
    /* phase-1 uses a plain working spy so the test never touches a real backend. */
    setPhase1Selection(buildSelection(buildSpyPhase1Analyzer(), 'phase1-test-model'));

    const job = buildStubJob(manuscriptId);
    const events = attachEventCapture(job);
    try {
      const { getManuscript } = await import('../store/manuscripts.js');
      const recordRef = getManuscript(manuscriptId);
      if (!recordRef) throw new Error('stub manuscript not found');

      await runMainAnalyzerJob(job, recordRef as never, selection, {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });

      const phase0Models = (
        events.filter((e) => e.kind === 'phase' && e.phaseId === 0) as Array<
          CapturedEvent & { model?: string }
        >
      ).map((e) => e.model);
      expect(phase0Models, 'phase-0 events must name the effective Gemini fallback model').toContain(
        FALLBACK_MODEL,
      );
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
      process.env.STAGE2_COVERAGE_RETRIES = origCovRetries;
    }
  }, 60_000);
});

/* ── Suite: the route honours a per-run phase1Model from the request body
   (#3141 step 4) ──────────────────────────────────────────────────────── */

describe('POST /:id/analysis honours a per-run phase1Model (#3141 step 4)', () => {
  it('routes req.body.phase1Model into the Phase 1 selector as phaseModel, and never touches user-settings.json', async () => {
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const { analysisRouter } = await import('./analysis.js');
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);

    const manuscriptId = `test-route-phase1model-${Date.now()}-${Math.random()}`;
    registerStubManuscript(manuscriptId, 1);

    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';

    setPhase0Selection(buildSelection(buildSpyPhase0Analyzer(), 'phase0-route-test-model'));
    setPhase1Selection(buildSelection(buildSpyPhase1Analyzer(), 'phase1-route-test-model'));
    const calls = startCapturingSelectorCalls();

    const settingsBefore = existsSync(USER_SETTINGS_PATH) ? readFileSync(USER_SETTINGS_PATH) : null;

    try {
      const res = await supertest(app)
        .post(`/api/manuscripts/${manuscriptId}/analysis`)
        .send({ fresh: true, phase1Model: 'route-test-phase1-override' })
        .buffer(true);
      expect(res.status).toBe(200);

      const phase0Call = calls.find((c) => c.phase === 'phase0');
      const phase1Call = calls.find((c) => c.phase === 'phase1');
      expect(phase0Call, 'route must call selectAnalyzerForPhase for phase0').toBeDefined();
      expect(phase0Call?.phaseModel, 'no phase0Model was sent, so opts.phaseModel must be undefined').toBeUndefined();
      expect(phase1Call, 'route must call selectAnalyzerForPhase for phase1').toBeDefined();
      expect(phase1Call?.phaseModel).toBe('route-test-phase1-override');

      const settingsAfter = existsSync(USER_SETTINGS_PATH) ? readFileSync(USER_SETTINGS_PATH) : null;
      expect(
        settingsAfter,
        'a per-run phase1Model must never be written to user-settings.json',
      ).toEqual(settingsBefore);
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
      process.env.STAGE2_COVERAGE_RETRIES = origCovRetries;
    }
  }, 60_000);
});

/* ── Suite: a reasoning overflow ends the run (#3084 P20) ─────────────── */

describe('a reasoning overflow ends the analysis run (#3084 P20)', () => {
  const MODEL = 'gemini-3.6-flash';
  const overflow = () => new AnalyzerReasoningOverflowError('gemini', MODEL, 8100);

  function overflowingPhase0Analyzer(): Analyzer {
    return {
      ...buildSpyPhase0Analyzer(),
      async runStage1Chapter(): Promise<Stage1ChapterOutput> {
        /* Same engine settings, same overflow on every chapter — must reach the
           terminal handler, not a per-chapter chapter-failed. */
        throw overflow();
      },
    };
  }

  function terminalError(events: CapturedEvent[]) {
    return events.find((e) => e.kind === 'error') as (CapturedEvent & { code?: string; message?: string }) | undefined;
  }

  it('stage 1 (Phase 0 cast detection, main route) → terminal analyzer-reasoning-overflow, not a per-chapter grind', async () => {
    const manuscriptId = `test-overflow-stage1-${Date.now()}`;
    registerStubManuscript(manuscriptId, 2);
    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    const job = buildStubJob(manuscriptId);
    const events = attachEventCapture(job);

    try {
      const { getManuscript } = await import('../store/manuscripts.js');
      const recordRef = getManuscript(manuscriptId);
      if (!recordRef) throw new Error('stub manuscript not found');

      await runMainAnalyzerJob(job, recordRef as never, buildSelection(overflowingPhase0Analyzer(), MODEL), {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });

      const errorEvent = terminalError(events);
      expect(errorEvent?.code).toBe('analyzer-reasoning-overflow');
      /* The plan's own copies of these two cases (2026-09-11-…-w2.md
         P3765/P3807) assert the message names 'Gemini max output tokens', but
         the plan's userMessage copy (P4969) does not, and its taxonomy tests
         are explicit that the setting name lives in the remediation, not the
         userMessage (P3661 `expect(r.userMessage).not.toContain(…)`, P3663
         `expect(r.remediation).toContain(…)`). Assert the branch-only prose
         instead ("reasoning on <chapter>"): the static signature-row copy in
         failure-remediations.ts also says "spent its whole output budget
         reasoning" (without "on"), so only this phrase proves the classifier
         matched AnalyzerReasoningOverflowError rather than falling through to
         the signature row (mutation row 10). */
      expect(errorEvent?.message).toContain('spent its whole output budget reasoning on');
      expect(job.reasoningOverflowed).toBe(true); // P20: the first rethrow marks the job
      expect(job.controller.signal.aborted).toBe(false); // P20: new spend stops; the job is not aborted
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
      process.env.STAGE2_COVERAGE_RETRIES = origCovRetries;
    }
  }, 60_000);

  it('stage 2 (Phase 1 attribution) → terminal analyzer-reasoning-overflow', async () => {
    const manuscriptId = `test-overflow-stage2-${Date.now()}`;
    registerStubManuscript(manuscriptId, 2);
    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    setPhase1Selection(
      buildSelection(
        {
          ...buildSpyPhase1Analyzer(),
          async runStage2Chapter(): Promise<Stage2ChapterOutput> {
            throw overflow();
          },
        },
        MODEL,
      ),
    );
    const job = buildStubJob(manuscriptId);
    const events = attachEventCapture(job);

    try {
      const { getManuscript } = await import('../store/manuscripts.js');
      const recordRef = getManuscript(manuscriptId);
      if (!recordRef) throw new Error('stub manuscript not found');

      await runMainAnalyzerJob(job, recordRef as never, buildSelection(buildSpyPhase0Analyzer(), 'gemma-phase0-test-model'), {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });

      const errorEvent = terminalError(events);
      expect(errorEvent?.code).toBe('analyzer-reasoning-overflow');
      /* Same deviation, same reason as the stage-1 case above. */
      expect(errorEvent?.message).toContain('spent its whole output budget reasoning on');
      expect(job.reasoningOverflowed).toBe(true); // P20: the first rethrow marks the job
      expect(job.controller.signal.aborted).toBe(false); // P20: new spend stops; the job is not aborted
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
      process.env.STAGE2_COVERAGE_RETRIES = origCovRetries;
    }
  }, 60_000);

  it('stage 1 on the subset (Retry) route → terminal analyzer-reasoning-overflow', async () => {
    const manuscriptId = `test-overflow-subset-${Date.now()}`;
    registerStubManuscript(manuscriptId, 2);
    /* No cached stage 1, so the subset route runs Phase 0 (cast detection)
       through its own per-chapter catch (routes/analysis.ts:7194-7205). */
    await clearAnalysisCache(manuscriptId);
    const job = { ...buildStubJob(manuscriptId), kind: 'subset', subsetChapterIds: [1, 2] } as unknown as AnalysisJob;
    const events = attachEventCapture(job);

    try {
      const { getManuscript } = await import('../store/manuscripts.js');
      const recordRef = getManuscript(manuscriptId);
      if (!recordRef) throw new Error('stub manuscript not found');

      await runSubsetAnalyzerJob(
        job,
        recordRef as never,
        buildSelection(overflowingPhase0Analyzer(), MODEL),
        buildSelection(buildSpyPhase1Analyzer(), 'gemini-phase1-test-model'),
        recordRef.chapterHints,
        false,
      );

      expect(terminalError(events)?.code).toBe('analyzer-reasoning-overflow');
      expect(job.reasoningOverflowed).toBe(true); // P20: the subset Phase-0 catch marks the job
      expect(job.controller.signal.aborted).toBe(false);
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
    }
  }, 60_000);
});

/* ── Suite: "stop new spend" helpers (#3084 P20) ─────────────────────── */

describe('noteReasoningOverflow (#3084 P20)', () => {
  it('marks the job and empties the book escalation budget for a reasoning overflow only', () => {
    const job = buildStubJob('m-note-overflow');
    const budget = { remainingWindows: 600 };
    expect(noteReasoningOverflow(job, budget, new Error('503'))).toBe(false);
    expect(job.reasoningOverflowed).toBeUndefined();
    expect(budget.remainingWindows).toBe(600);
    expect(noteReasoningOverflow(job, budget, new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100))).toBe(true);
    expect(job.reasoningOverflowed).toBe(true);
    expect(budget.remainingWindows).toBe(0);
  });

  it('records the chapter it was told about (#3084 F7)', () => {
    const job = buildStubJob('m-note-overflow-chapter');
    const budget = { remainingWindows: 600 };
    noteReasoningOverflow(
      job,
      budget,
      new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100),
      { id: 4, title: 'The Long Night' },
    );
    expect(job.reasoningOverflowChapter).toEqual({ id: 4, title: 'The Long Night' });
  });

  it('keeps the FIRST overflow chapter, like reasoningOverflowError, even when a later call names a different one', () => {
    const job = buildStubJob('m-note-overflow-first-wins');
    const budget = { remainingWindows: 600 };
    noteReasoningOverflow(
      job,
      budget,
      new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100),
      { id: 4, title: 'The Long Night' },
    );
    noteReasoningOverflow(
      job,
      budget,
      new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 4200),
      { id: 5, title: 'The Fen' },
    );
    expect(job.reasoningOverflowChapter).toEqual({ id: 4, title: 'The Long Night' });
  });

  it('leaves reasoningOverflowChapter undefined when no chapter is passed', () => {
    const job = buildStubJob('m-note-overflow-no-chapter');
    const budget = { remainingWindows: 600 };
    noteReasoningOverflow(job, budget, new AnalyzerReasoningOverflowError('ollama', 'qwen3.5:4b', undefined));
    expect(job.reasoningOverflowChapter).toBeUndefined();
  });
});

describe('buildNonStoryClassifier — no non-story call after a reasoning overflow (#3084 P20)', () => {
  const chapter = (id: number) => ({ id, title: `Chapter ${id}`, body: 'An essay on the author.' });
  type NonStoryFn = NonNullable<Analyzer['runNonStoryClassification']>;
  const build = (job: AnalysisJob, budget: { remainingWindows: number }, run: ReturnType<typeof vi.fn>) =>
    buildNonStoryClassifier({
      job,
      structureBudget: budget,
      analyzer: { ...buildSpyPhase1Analyzer(), runNonStoryClassification: run as unknown as NonStoryFn },
      manuscriptId: job.manuscriptId,
      bookTitle: null,
      bookLanguage: 'en',
    })!;

  it('a classification call that overflows marks the job, reads as story, and no later chapter is classified', async () => {
    const run = vi.fn(async () => {
      throw new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100);
    });
    const job = buildStubJob('m-nonstory-overflow');
    const budget = { remainingWindows: 600 };
    const classify = build(job, budget, run);
    await expect(classify(chapter(1))).resolves.toBe(false);
    await expect(classify(chapter(2))).resolves.toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(job.reasoningOverflowed).toBe(true);
    expect(budget.remainingWindows).toBe(0);
    // #3084 F7 — the classifier knows which chapter it was calling for (chapter 1's run).
    expect(job.reasoningOverflowChapter).toEqual({ id: 1, title: 'Chapter 1' });
  });

  it('a job already marked by an overflow elsewhere makes no classification call', async () => {
    const run = vi.fn(async () => ({ nonStory: true }));
    const job: AnalysisJob = { ...buildStubJob('m-nonstory-marked'), reasoningOverflowed: true };
    await expect(build(job, { remainingWindows: 0 }, run)(chapter(1))).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('with no overflow it classifies each chapter, and any other failure still reads as story (unchanged behaviour)', async () => {
    const run = vi.fn().mockResolvedValueOnce({ nonStory: true }).mockRejectedValueOnce(new Error('503'));
    const job = buildStubJob('m-nonstory-plain');
    const classify = build(job, { remainingWindows: 600 }, run);
    await expect(classify(chapter(1))).resolves.toBe(true);
    await expect(classify(chapter(2))).resolves.toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
    expect(job.reasoningOverflowed).toBeUndefined();
  });

  it('an abort still propagates', async () => {
    const run = vi.fn(async () => {
      throw new AnalysisAbortedError('paused');
    });
    await expect(build(buildStubJob('m-nonstory-abort'), { remainingWindows: 600 }, run)(chapter(1))).rejects.toBeInstanceOf(
      AnalysisAbortedError,
    );
  });

  it('is undefined for an analyzer with no non-story classification', () => {
    expect(
      buildNonStoryClassifier({
        job: buildStubJob('m-nonstory-none'),
        structureBudget: { remainingWindows: 600 },
        analyzer: buildSpyPhase1Analyzer(),
        manuscriptId: 'm-nonstory-none',
        bookTitle: null,
        bookLanguage: 'en',
      }),
    ).toBeUndefined();
  });
});
