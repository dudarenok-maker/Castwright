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
import { clearAnalysisCache, saveAnalysisCache } from '../store/analysis-cache.js';
import type { Analyzer, AnalyzerSelection, StageCall } from '../analyzer/index.js';
import type { Stage1ChapterOutput, Stage1Output, Stage2ChapterOutput } from '../handoff/schemas.js';
import type { ChapterHint } from '../store/manuscripts.js';
import { putManuscript, removeManuscript } from '../store/manuscripts.js';
import { AnalysisAbortedError, AnalyzerReasoningOverflowError, GeminiContentBlockedError, AnalyzerUnreachableError } from '../analyzer/errors.js';
import { LocalUnreachableError } from '../analyzer/ollama.js';
import { FallbackAnalyzer, RunFallbackSwitch, fallbackSwitchKey, targetInputGuard } from '../analyzer/index.js';
import { USER_SETTINGS_PATH, _setUserSettingsCacheForTest, _resetUserSettingsCache } from '../workspace/user-settings.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';
import { estimateInputTokens } from '../analyzer/runner/prompt.js';
import { resolveCapacity } from '../analyzer/capacity.js';
import { resolveStage1ChunkCharBudget } from '../analyzer/stage1-chunk.js';

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
    ended: false,
    halting: false,
    left: false,
    liveWork: 0,
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

/* #3084 wave 3d — the end-of-run Ollama evict is observed through this mock; detectOllamaDevice is
   called by any job whose selection is local. */
const { unloadResidentOllamaMock } = vi.hoisted(() => ({ unloadResidentOllamaMock: vi.fn(async () => {}) }));
vi.mock('./ollama-health.js', () => ({ detectOllamaDevice: vi.fn(async () => 'unknown'), unloadResidentOllama: unloadResidentOllamaMock }));
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
    selectAnalyzerForPhase: (opts: { phase: 'phase0' | 'phase1'; phaseModel?: string; model?: string; fallbackSwitch?: unknown }) => {
      const g = globalThis as Record<string, unknown>;
      (g.__phase_model_test_calls as unknown[] | undefined)?.push({ ...opts });
      /* #3084 wave 3d — builds the phase-1 selection from what the job passed, like the real selector. */
      if (opts.phase === 'phase1' && g.__phase_model_test_phase1_factory) {
        return (g.__phase_model_test_phase1_factory as (o: unknown) => unknown)(opts);
      }
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
  delete (globalThis as Record<string, unknown>).__phase_model_test_phase1_factory;
}

function setPhase1Factory(factory: (opts: { fallbackSwitch?: RunFallbackSwitch }) => AnalyzerSelection): void {
  (globalThis as Record<string, unknown>).__phase_model_test_phase1_factory = factory;
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

  async function getManuscriptForTest(id: string) {
    return (await import('../store/manuscripts.js')).getManuscript(id) as never;
  }

  it('#3084 P30 — after a switch to a local target, phase-0 events name the Ollama model with engine local, not gemini', async () => {
    const lab = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'cuda:0', contextTokens: 32768 });
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab] }); // resolveCapacity({engine:'openai',...}) needs the endpoint saved
    const manuscriptId = `test-fallback-local-${Date.now()}`;
    registerStubManuscript(manuscriptId, 2);
    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    const primary: Analyzer = {
      ...buildSpyPhase0Analyzer(),
      async runStage1Chapter(): Promise<Stage1ChapterOutput> {
        throw new AnalyzerUnreachableError('connect ECONNREFUSED', 'openai');
      },
    };
    const selection: AnalyzerSelection = {
      analyzer: new FallbackAnalyzer(primary, buildSpyPhase0Analyzer()),
      engine: 'openai',
      model: 'openai:lab::qwen3-30b',
      fallbackModel: 'qwen3.5:4b',
    };
    setPhase1Selection(buildSelection(buildSpyPhase1Analyzer(), 'phase1-test-model'));
    const job = buildStubJob(manuscriptId);
    const events = attachEventCapture(job);
    try {
      const { getManuscript } = await import('../store/manuscripts.js');
      await runMainAnalyzerJob(job, getManuscript(manuscriptId) as never, selection, { requestedFresh: true, allowStage1Shrink: true, requestedModel: undefined });
      const switched = (events as Array<CapturedEvent & { model?: string; engine?: string }>).filter((e) => e.kind === 'phase' && e.phaseId === 0 && e.model === 'qwen3.5:4b');
      expect(switched.length).toBeGreaterThan(0);
      expect(switched.every((e) => e.engine === undefined || e.engine === 'local')).toBe(true);
      expect(switched.some((e) => e.engine === 'local')).toBe(true);
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
      process.env.STAGE2_COVERAGE_RETRIES = origCovRetries;
      _resetUserSettingsCache();
    }
  }, 60_000);

  it('#3084 P30 — two chapters sized for a large-context endpoint, dispatched together (analyzer.ollama.concurrency 2), reach the Ollama target split to its stage-1 budget, and none above it', async () => {
    const big = analyzerEndpointSchema.parse({ id: 'big', name: 'Big', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 262144 });
    /* Explicit values, so the preconditions hold on any box: `analyzer.stage1.chunkCharBudget` has no registry `max`. */
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [big],
      configOverrides: { 'analyzer.stage1.chunkCharBudget': 200_000, 'analyzer.ollama.numCtx': 32_768, 'analyzer.ollama.concurrency': 2 },
    });
    const tokens = (text: string) => estimateInputTokens('', [{ role: 'user', parts: [{ text }] }]);
    const localCapacity = resolveCapacity({ engine: 'local', model: 'qwen3.5:4b' });
    const localContext = localCapacity.contextTokens;
    const targetBudget = resolveStage1ChunkCharBudget(localCapacity, 'x', []); // 45,875 chars: 32,768 × 0.7 × 2, under the 200,000 ceiling
    const sentence = 'The lamp guttered and the room went quiet. ';
    /* About 1.6× the target's stage-1 budget: over that budget, under Ollama's raw context. */
    const body = sentence.repeat(2 * Math.floor((0.8 * targetBudget) / sentence.length));
    const endpointBudget = resolveStage1ChunkCharBudget(resolveCapacity({ engine: 'openai', model: 'openai:big::qwen3-30b' }), body, []);
    /* Preconditions: the endpoint sizes each chapter as one chunk; that chunk is over the target's stage-1
       budget, but a raw-context check (estimateInputTokens ≤ contextTokens) would let it through unsplit. */
    expect(endpointBudget).toBeGreaterThanOrEqual(body.length);
    expect(body.length).toBeGreaterThan(targetBudget);
    expect(tokens(body)).toBeLessThan(localContext);

    const manuscriptId = `test-fallback-capacity-${Date.now()}`;
    putManuscript({
      manuscriptId, format: 'plaintext', title: 'Capacity', wordCount: 1, byteSize: body.length * 2, uploadedAt: new Date().toISOString(),
      sourceText: body + body,
      chapterHints: [{ id: 1, title: 'One', body }, { id: 2, title: 'Two', body }] as unknown as ChapterHint[],
    });
    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    const primaryCalls: number[] = [];
    const targetCalls: Array<{ chapterId: number; bodyChars: number | undefined }> = [];
    /* Hold every primary call until both chapters have reached the primary, so both were sized for
       the endpoint before any switch lands (what two workers do in production). */
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const spy = buildSpyPhase0Analyzer();
    const primary: Analyzer = {
      ...spy,
      async runStage1Chapter(_m: string, chapterId: number): Promise<Stage1ChapterOutput> {
        primaryCalls.push(chapterId);
        if (new Set(primaryCalls).size === 2) openGate();
        await gate;
        throw new AnalyzerUnreachableError('connect ECONNREFUSED', 'openai');
      },
    };
    const target: Analyzer = {
      ...spy,
      async runStage1Chapter(m: string, chapterId: number, p: string, call: StageCall): Promise<Stage1ChapterOutput> {
        targetCalls.push({ chapterId, bodyChars: call.inputBody?.length });
        return spy.runStage1Chapter(m, chapterId, p, call);
      },
    };
    const selection: AnalyzerSelection = {
      analyzer: new FallbackAnalyzer(primary, target, undefined, targetInputGuard({ engine: 'local', model: 'qwen3.5:4b' })),
      engine: 'openai',
      model: 'openai:big::qwen3-30b',
      fallbackModel: 'qwen3.5:4b',
    };
    setPhase1Selection(buildSelection(buildSpyPhase1Analyzer(), 'phase1-test-model'));
    const job = buildStubJob(manuscriptId);
    try {
      await runMainAnalyzerJob(job, await getManuscriptForTest(manuscriptId), selection, { requestedFresh: true, allowStage1Shrink: true, requestedModel: undefined });
      /* Both chapters reached the primary, sized for the endpoint, before the switch. */
      expect(new Set(primaryCalls.slice(0, 2))).toEqual(new Set([1, 2]));
      /* Every chunk that reached the target carried its body (the main job's stage-1 call site sets
         StageCall.inputBody), and none was above the target's stage-1 budget. */
      expect(targetCalls.length).toBeGreaterThan(0);
      expect(targetCalls.every((c) => c.bodyChars !== undefined && c.bodyChars <= targetBudget)).toBe(true);
      /* Both in-flight chapters were split for the target. */
      expect(targetCalls.filter((c) => c.chapterId === 1).length).toBeGreaterThanOrEqual(2);
      expect(targetCalls.filter((c) => c.chapterId === 2).length).toBeGreaterThanOrEqual(2);
      expect(job.engine).toBe('local');
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
      process.env.STAGE2_COVERAGE_RETRIES = origCovRetries;
      _resetUserSettingsCache();
    }
  }, 60_000);

  it('#3084 P30 — a chapter started after the switch is sized for the target by its chunk budget, with no pre-send check (concurrency 1)', async () => {
    const big = analyzerEndpointSchema.parse({ id: 'big', name: 'Big', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 262144 });
    /* Explicit values, so the preconditions hold on any box: `analyzer.stage1.chunkCharBudget` has no registry `max`. */
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [big],
      configOverrides: { 'analyzer.stage1.chunkCharBudget': 200_000, 'analyzer.ollama.numCtx': 32_768, 'analyzer.ollama.concurrency': 1 },
    });
    const tokens = (text: string) => estimateInputTokens('', [{ role: 'user', parts: [{ text }] }]);
    const localContext = resolveCapacity({ engine: 'local', model: 'qwen3.5:4b' }).contextTokens;
    const sentence = 'The lamp guttered and the room went quiet. ';
    const paragraph = sentence.repeat(20);
    /* Paragraph-separated (unlike a single run-on string) so splitBodyIntoChunks — which only
       cuts on blank-line boundaries — can actually divide this body once it is over budget. */
    const body = Array.from({ length: Math.ceil(((localContext - 1_000) * 1.2 * 4) / paragraph.length) }, () => paragraph).join('\n\n');
    expect(resolveStage1ChunkCharBudget(resolveCapacity({ engine: 'openai', model: 'openai:big::qwen3-30b' }), body, [])).toBeGreaterThanOrEqual(body.length);
    expect(tokens(body)).toBeGreaterThan(localContext);

    const manuscriptId = `test-fallback-capacity-later-${Date.now()}`;
    putManuscript({
      manuscriptId, format: 'plaintext', title: 'Capacity later', wordCount: 1, byteSize: body.length * 2, uploadedAt: new Date().toISOString(),
      sourceText: body + body,
      chapterHints: [{ id: 1, title: 'One', body }, { id: 2, title: 'Two', body }] as unknown as ChapterHint[],
    });
    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    const targetCalls: Array<{ chapterId: number; tokens: number }> = [];
    const spy = buildSpyPhase0Analyzer();
    const primary: Analyzer = {
      ...spy,
      async runStage1Chapter(): Promise<Stage1ChapterOutput> {
        throw new AnalyzerUnreachableError('connect ECONNREFUSED', 'openai');
      },
    };
    const target: Analyzer = {
      ...spy,
      async runStage1Chapter(m: string, chapterId: number, p: string, call: StageCall): Promise<Stage1ChapterOutput> {
        targetCalls.push({ chapterId, tokens: tokens(p) });
        return spy.runStage1Chapter(m, chapterId, p, call);
      },
    };
    /* No guard: chapter 1 reaches the target oversized (it was sized before the switch); chapter 2,
       started after it, must be sized for Ollama by the chunk budget alone. */
    const selection: AnalyzerSelection = { analyzer: new FallbackAnalyzer(primary, target), engine: 'openai', model: 'openai:big::qwen3-30b', fallbackModel: 'qwen3.5:4b' };
    setPhase1Selection(buildSelection(buildSpyPhase1Analyzer(), 'phase1-test-model'));
    const job = buildStubJob(manuscriptId);
    try {
      await runMainAnalyzerJob(job, await getManuscriptForTest(manuscriptId), selection, { requestedFresh: true, allowStage1Shrink: true, requestedModel: undefined });
      const chapter2 = targetCalls.filter((c) => c.chapterId === 2);
      expect(chapter2.length).toBeGreaterThanOrEqual(2);
      expect(chapter2.every((c) => c.tokens <= localContext)).toBe(true);
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
      process.env.STAGE2_COVERAGE_RETRIES = origCovRetries;
      _resetUserSettingsCache();
    }
  }, 60_000);

  it('#3084 wave 3d — a primary that recovers after the switch never receives a later chapter: it goes, sized for the target, to the target', async () => {
    const small = analyzerEndpointSchema.parse({ id: 'small', name: 'Small', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 8192 });
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [small],
      configOverrides: { 'analyzer.stage1.chunkCharBudget': 200_000, 'analyzer.ollama.numCtx': 32_768, 'analyzer.ollama.concurrency': 1 },
    });
    const primaryBudget = resolveStage1ChunkCharBudget(resolveCapacity({ engine: 'openai', model: 'openai:small::m' }), 'x', []);
    const targetBudget = resolveStage1ChunkCharBudget(resolveCapacity({ engine: 'local', model: 'qwen3.5:4b' }), 'x', []);
    expect(targetBudget).toBeGreaterThan(primaryBudget);
    const paragraph = 'The lamp guttered and the room went quiet. '.repeat(20);
    /* Paragraph-separated so a chunker can divide it; over the primary's budget, under the target's. */
    const body = Array.from({ length: Math.ceil((1.6 * primaryBudget) / paragraph.length) }, () => paragraph).join('\n\n');
    expect(body.length).toBeGreaterThan(primaryBudget);
    expect(body.length).toBeLessThan(targetBudget);

    const manuscriptId = `test-fallback-sticky-${Date.now()}`;
    putManuscript({
      manuscriptId, format: 'plaintext', title: 'Sticky', wordCount: 1, byteSize: body.length * 2, uploadedAt: new Date().toISOString(),
      sourceText: body + body,
      chapterHints: [{ id: 1, title: 'One', body }, { id: 2, title: 'Two', body }] as unknown as ChapterHint[],
    });
    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    const primaryCalls: Array<{ chapterId: number; bodyChars: number | undefined }> = [];
    const targetCalls: Array<{ chapterId: number; bodyChars: number | undefined }> = [];
    const spy = buildSpyPhase0Analyzer();
    /* A blip: the first call is unreachable, every later one would succeed (the primary recovered). */
    const primary: Analyzer = {
      ...spy,
      async runStage1Chapter(m: string, chapterId: number, p: string, call: StageCall): Promise<Stage1ChapterOutput> {
        primaryCalls.push({ chapterId, bodyChars: call.inputBody?.length });
        if (primaryCalls.length === 1) throw new AnalyzerUnreachableError('connect ETIMEDOUT', 'openai');
        return spy.runStage1Chapter(m, chapterId, p, call);
      },
    };
    const target: Analyzer = {
      ...spy,
      async runStage1Chapter(m: string, chapterId: number, p: string, call: StageCall): Promise<Stage1ChapterOutput> {
        targetCalls.push({ chapterId, bodyChars: call.inputBody?.length });
        return spy.runStage1Chapter(m, chapterId, p, call);
      },
    };
    const selection: AnalyzerSelection = { analyzer: new FallbackAnalyzer(primary, target), engine: 'openai', model: 'openai:small::m', fallbackModel: 'qwen3.5:4b' };
    setPhase1Selection(buildSelection(buildSpyPhase1Analyzer(), 'phase1-test-model'));
    const job = buildStubJob(manuscriptId);
    try {
      await runMainAnalyzerJob(job, await getManuscriptForTest(manuscriptId), selection, { requestedFresh: true, allowStage1Shrink: true, requestedModel: undefined });
      /* Only the chunk that blipped ever went to the primary, and it fit the primary. */
      expect(primaryCalls.length).toBe(1);
      expect(primaryCalls[0].bodyChars!).toBeLessThanOrEqual(primaryBudget);
      /* Chapter 2 went whole (over the primary's budget) to the target, never to the primary. */
      expect(primaryCalls.some((c) => c.chapterId === 2)).toBe(false);
      expect(targetCalls.some((c) => c.chapterId === 2 && c.bodyChars! > primaryBudget && c.bodyChars! <= targetBudget)).toBe(true);
      expect(job.engine).toBe('local');
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
      process.env.STAGE2_COVERAGE_RETRIES = origCovRetries;
      _resetUserSettingsCache();
    }
  }, 60_000);

  it('#3084 wave 3d review pass 2 — a phase-0 switch is the switch of the whole run: phase-1 calls go to the target, the recovered primary gets none, and the job names the engine serving', async () => {
    const manuscriptId = `test-fallback-run-sticky-${Date.now()}`;
    registerStubManuscript(manuscriptId, 3);
    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    const phase0Primary: Analyzer = {
      ...buildSpyPhase0Analyzer(),
      async runStage1Chapter(): Promise<Stage1ChapterOutput> {
        throw new LocalUnreachableError('connect ECONNREFUSED');
      },
    };
    const phase1PrimaryCalls: number[] = [];
    const phase1TargetCalls: number[] = [];
    const p1 = buildSpyPhase1Analyzer();
    const phase1Primary: Analyzer = {
      ...p1,
      async runStage2Chapter(m: string, chapterId: number, p: string, call: StageCall): Promise<Stage2ChapterOutput> {
        phase1PrimaryCalls.push(chapterId);
        return p1.runStage2Chapter(m, chapterId, p, call);
      },
    };
    const phase1Target: Analyzer = {
      ...p1,
      async runStage2Chapter(m: string, chapterId: number, p: string, call: StageCall): Promise<Stage2ChapterOutput> {
        phase1TargetCalls.push(chapterId);
        return p1.runStage2Chapter(m, chapterId, p, call);
      },
    };
    const job = buildStubJob(manuscriptId);
    job.engine = 'local';
    job.fallbackSwitch = new RunFallbackSwitch();
    const phase0: AnalyzerSelection = {
      analyzer: new FallbackAnalyzer(phase0Primary, buildSpyPhase0Analyzer(), undefined, undefined, { switch: job.fallbackSwitch, key: fallbackSwitchKey({ engine: 'local', model: 'qwen3.5:4b' }) }),
      engine: 'local',
      model: 'qwen3.5:4b',
      fallbackModel: 'gemini-3.6-flash',
    };
    /* What the real selector does with the switch the job hands it. */
    setPhase1Factory((o) => ({
      analyzer: new FallbackAnalyzer(phase1Primary, phase1Target, undefined, undefined, { switch: o.fallbackSwitch ?? new RunFallbackSwitch(), key: fallbackSwitchKey({ engine: 'local', model: 'qwen3.5:9b' }) }),
      engine: 'local',
      model: 'qwen3.5:9b',
      fallbackModel: 'gemini-3.6-flash',
    }));
    const events = attachEventCapture(job);
    try {
      await runMainAnalyzerJob(job, await getManuscriptForTest(manuscriptId), phase0, { requestedFresh: true, allowStage1Shrink: true, requestedModel: undefined });
      expect(phase1PrimaryCalls).toEqual([]);
      expect(phase1TargetCalls.length).toBeGreaterThan(0);
      /* The cold-boot snapshot reads job.engine: it names who is serving. */
      expect(job.engine).toBe('gemini');
      const phase1Events = (events as Array<CapturedEvent & { model?: string; engine?: string }>).filter((e) => e.kind === 'phase' && e.phaseId === 1 && e.model);
      expect(phase1Events.some((e) => e.model === 'gemini-3.6-flash' && e.engine === 'gemini')).toBe(true);
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
      process.env.STAGE2_COVERAGE_RETRIES = origCovRetries;
      _resetUserSettingsCache();
    }
  }, 60_000);

  it('#3084 wave 3d — an Ollama primary that fell back to Gemini is still evicted when the run ends (job.engine no longer reads local)', async () => {
    const manuscriptId = `test-fallback-evict-${Date.now()}`;
    registerStubManuscript(manuscriptId, 2);
    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    unloadResidentOllamaMock.mockClear();
    const spy = buildSpyPhase0Analyzer();
    const primary: Analyzer = {
      ...spy,
      async runStage1Chapter(): Promise<Stage1ChapterOutput> {
        throw new LocalUnreachableError('connect ECONNREFUSED');
      },
    };
    const selection: AnalyzerSelection = { analyzer: new FallbackAnalyzer(primary, spy), engine: 'local', model: 'qwen3.5:4b', fallbackModel: 'gemini-3.6-flash' };
    setPhase1Selection(buildSelection(buildSpyPhase1Analyzer(), 'phase1-test-model'));
    const job = buildStubJob(manuscriptId);
    job.engine = 'local';
    try {
      await runMainAnalyzerJob(job, await getManuscriptForTest(manuscriptId), selection, { requestedFresh: true, allowStage1Shrink: true, requestedModel: undefined });
      expect(job.engine).toBe('gemini');
      await vi.waitFor(() => expect(unloadResidentOllamaMock).toHaveBeenCalledTimes(1));
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
      process.env.STAGE2_COVERAGE_RETRIES = origCovRetries;
      _resetUserSettingsCache();
    }
  }, 60_000);
  it('#3084 P30 — after a phase-1 switch, phase-1 events carry the target engine', async () => {
    const lab = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'cuda:0', contextTokens: 32768 });
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab] }); // resolveCapacity({engine:'openai',...}) needs the endpoint saved
    const manuscriptId = `test-fallback-phase1-${Date.now()}`;
    registerStubManuscript(manuscriptId, 2);
    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    const phase1Primary: Analyzer = {
      ...buildSpyPhase1Analyzer(),
      async runStage2Chapter(): Promise<Stage2ChapterOutput> {
        throw new AnalyzerUnreachableError('connect ECONNREFUSED', 'openai');
      },
    };
    setPhase1Selection({ analyzer: new FallbackAnalyzer(phase1Primary, buildSpyPhase1Analyzer()), engine: 'openai', model: 'openai:lab::qwen3-30b', fallbackModel: 'qwen3.5:4b' });
    const job = buildStubJob(manuscriptId);
    const events = attachEventCapture(job);
    try {
      await runMainAnalyzerJob(job, await getManuscriptForTest(manuscriptId), buildSelection(buildSpyPhase0Analyzer(), 'phase0-test-model'), { requestedFresh: true, allowStage1Shrink: true, requestedModel: undefined });
      const switched = (events as Array<CapturedEvent & { model?: string; engine?: string }>).filter((e) => e.kind === 'phase' && e.phaseId === 1 && e.model === 'qwen3.5:4b');
      expect(switched.length).toBeGreaterThan(0);
      expect(switched.every((e) => e.engine === 'local')).toBe(true);
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
      process.env.STAGE2_COVERAGE_RETRIES = origCovRetries;
      _resetUserSettingsCache();
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
      /* #3084 wave 3d — both of the run's selections get the SAME switch, so a phase-0 fallback is the run's. */
      const switchOf = (c: unknown) => (c as { fallbackSwitch?: unknown }).fallbackSwitch;
      expect(switchOf(phase0Call)).toBeInstanceOf(RunFallbackSwitch);
      expect(switchOf(phase1Call)).toBe(switchOf(phase0Call));

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

/* ── Suite: the subset route shares one fallback switch across its two selections
   (#3084 wave 3d) ─────────────────────────────────────────────────────────── */

describe('POST /:id/analysis/chapters shares one fallback switch per run (#3084 wave 3d)', () => {
  it('hands phase 0 and phase 1 the same RunFallbackSwitch, and a second request a different one', async () => {
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const { analysisRouter } = await import('./analysis.js');
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);

    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';

    setPhase0Selection(buildSelection(buildSpyPhase0Analyzer(), 'phase0-subset-route-model'));
    setPhase1Selection(buildSelection(buildSpyPhase1Analyzer(), 'phase1-subset-route-model'));
    const calls = startCapturingSelectorCalls();
    const switchOf = (c: unknown) => (c as { fallbackSwitch?: unknown }).fallbackSwitch;

    const ids = [1, 2].map((n) => `test-subset-route-switch-${n}-${Date.now()}-${Math.random()}`);
    for (const id of ids) registerStubManuscript(id, 1);

    try {
      for (const id of ids) {
        const res = await supertest(app).post(`/api/manuscripts/${id}/analysis/chapters`).send({ chapterIds: [1] }).buffer(true);
        expect(res.status).toBe(200);
      }

      const phase0Calls = calls.filter((c) => c.phase === 'phase0');
      const phase1Calls = calls.filter((c) => c.phase === 'phase1');
      expect(phase0Calls).toHaveLength(2);
      expect(phase1Calls).toHaveLength(2);
      for (let i = 0; i < 2; i++) {
        expect(switchOf(phase0Calls[i])).toBeInstanceOf(RunFallbackSwitch);
        expect(switchOf(phase1Calls[i])).toBe(switchOf(phase0Calls[i]));
      }
      expect(switchOf(phase0Calls[1])).not.toBe(switchOf(phase0Calls[0]));
    } finally {
      for (const id of ids) {
        removeManuscript(id);
        await clearAnalysisCache(id);
      }
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
      expect(job.controller.signal.aborted).toBe(true); // #3435 decision E: every ending aborts the job (N4 superseded)
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
      expect(job.controller.signal.aborted).toBe(true); // #3435 decision E: every ending aborts the job (N4 superseded)
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
      expect(job.controller.signal.aborted).toBe(true); // #3435 decision E: every ending aborts the job (N4 superseded)
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
    expect(noteReasoningOverflow(job, budget, new Error('503'), undefined, 0)).toBe(false);
    expect(job.reasoningOverflowed).toBeUndefined();
    expect(budget.remainingWindows).toBe(600);
    expect(noteReasoningOverflow(job, budget, new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100), undefined, 0)).toBe(true);
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
      0,
    );
    expect(job.reasoningOverflowChapter).toEqual({ id: 4, title: 'The Long Night' });
  });

  it('records the phase it was told about, and keeps the FIRST overflow phase (#3435)', () => {
    const job = buildStubJob('m-note-overflow-phase');
    const budget = { remainingWindows: 600 };
    noteReasoningOverflow(job, budget, new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100), undefined, 1);
    noteReasoningOverflow(job, budget, new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 4200), undefined, 0);
    expect(job.reasoningOverflowPhase).toBe(1);
  });

  it('keeps the FIRST overflow chapter, like reasoningOverflowError, even when a later call names a different one', () => {
    const job = buildStubJob('m-note-overflow-first-wins');
    const budget = { remainingWindows: 600 };
    noteReasoningOverflow(
      job,
      budget,
      new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100),
      { id: 4, title: 'The Long Night' },
      0,
    );
    noteReasoningOverflow(
      job,
      budget,
      new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 4200),
      { id: 5, title: 'The Fen' },
      0,
    );
    expect(job.reasoningOverflowChapter).toEqual({ id: 4, title: 'The Long Night' });
  });

  it('leaves reasoningOverflowChapter undefined when no chapter is passed', () => {
    const job = buildStubJob('m-note-overflow-no-chapter');
    const budget = { remainingWindows: 600 };
    noteReasoningOverflow(job, budget, new AnalyzerReasoningOverflowError('ollama', 'qwen3.5:4b', undefined), undefined, 0);
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

  it('#3084 wave 3d — the classification call announces a fallback switch through the caller\'s onFallback, so it is never silent', async () => {
    const onFallback = vi.fn();
    const run = vi.fn(async (_m: string, _c: number, _p: string, call: StageCall) => {
      call.onFallback?.({ reason: 'Ollama unreachable (qwen3.5:4b) — switched to Gemini (gemini-3.6-flash)' });
      return { nonStory: false };
    });
    const job = buildStubJob('m-nonstory-fallback');
    const classify = buildNonStoryClassifier({
      job,
      structureBudget: { remainingWindows: 600 },
      analyzer: { ...buildSpyPhase1Analyzer(), runNonStoryClassification: run as unknown as NonNullable<Analyzer['runNonStoryClassification']> },
      manuscriptId: job.manuscriptId,
      bookTitle: null,
      bookLanguage: 'en',
      onFallback,
    })!;
    await classify(chapter(1));
    expect(onFallback).toHaveBeenCalledWith({ reason: 'Ollama unreachable (qwen3.5:4b) — switched to Gemini (gemini-3.6-flash)' });
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

/* #3084 wave 3d review pass 2 (D) — the JOBS' wiring of the fixes above: removing `onFallback` from a job's
   buildNonStoryClassifier call, or the subset job's `job.ollamaServed = true`, left the suite green. These drive
   the real jobs (not buildNonStoryClassifier with a handler of the test's own). */
describe('the main and subset jobs wire the sticky-fallback fixes (#3084 wave 3d)', () => {
  /* The stage-1 spy names `ch1-char` / `ch2-char`; one line from `ch1-char` in chapter 1 (a front-region
     chapter whose body never names it) makes it a Signal-2 candidate, so the job consults the classifier. */
  const phase1WithOneLine: Analyzer = {
    ...buildSpyPhase1Analyzer(),
    async runStage2Chapter(_m: string, chapterId: number): Promise<Stage2ChapterOutput> {
      return {
        sentences: [{ id: chapterId * 100 + 1, chapterId, characterId: chapterId === 1 ? 'ch1-char' : 'narrator', text: chapterId === 1 ? '"Lorem ipsum dolor sit amet," he said.' : 'lorem ipsum dolor sit amet.' }],
      };
    },
  };

  /* The subset route reaches the third-party guard only for a book whose stage 1 is already cached
     (without it, it ends at resume_required after Phase 0). */
  async function seedCachedStage1(manuscriptId: string): Promise<void> {
    await saveAnalysisCache(manuscriptId, {
      chapters: {},
      stage1: {
        characters: [
          { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
          { id: 'ch1-char', name: 'Character_ch1', role: 'character', color: 'unset', evidence: [{ quote: 'lorem ipsum dolor sit amet' }, { quote: 'lorem ipsum dolor sit amet' }, { quote: 'lorem ipsum dolor sit amet' }] },
        ],
        chapters: [{ id: 1, title: 'Chapter 1' }, { id: 2, title: 'Chapter 2' }],
      },
    } as never);
  }

  /* Stage 1 and the rest work on the primary; only the non-story check finds it unreachable. */
  function nonStoryBlip(): { selection: AnalyzerSelection; primaryNonStoryCalls: () => number } {
    let primaryCalls = 0;
    const primary: Analyzer = {
      ...buildSpyPhase0Analyzer(),
      async runNonStoryClassification() {
        primaryCalls += 1;
        throw new LocalUnreachableError('connect ECONNREFUSED');
      },
    };
    const target: Analyzer = { ...buildSpyPhase0Analyzer(), async runNonStoryClassification() { return { nonStory: false }; } };
    return {
      selection: { analyzer: new FallbackAnalyzer(primary, target), engine: 'local', model: 'qwen3.5:4b', fallbackModel: 'gemini-3.6-flash' },
      primaryNonStoryCalls: () => primaryCalls,
    };
  }

  it('main: a switch made by the non-story check relabels the job (job.engine) and marks the target', async () => {
    const manuscriptId = `test-nonstory-fallback-main-${Date.now()}`;
    registerStubManuscript(manuscriptId, 2);
    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    const { selection, primaryNonStoryCalls } = nonStoryBlip();
    setPhase1Selection(buildSelection(phase1WithOneLine, 'phase1-test-model'));
    const job = buildStubJob(manuscriptId);
    job.engine = 'local';
    try {
      const { getManuscript } = await import('../store/manuscripts.js');
      await runMainAnalyzerJob(job, getManuscript(manuscriptId) as never, selection, { requestedFresh: true, allowStage1Shrink: true, requestedModel: undefined });
      expect(primaryNonStoryCalls(), 'precondition: the job consulted the non-story classifier').toBe(1);
      expect(job.engine).toBe('gemini');
      expect(job.fallbackMarked?.has('gemini-3.6-flash')).toBe(true);
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
      process.env.STAGE2_COVERAGE_RETRIES = origCovRetries;
      _resetUserSettingsCache();
    }
  }, 60_000);

  it('subset: a switch made by the non-story check relabels the job (job.engine) and marks the target', async () => {
    const manuscriptId = `test-nonstory-fallback-subset-${Date.now()}`;
    registerStubManuscript(manuscriptId, 2);
    await seedCachedStage1(manuscriptId);
    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    const { selection, primaryNonStoryCalls } = nonStoryBlip();
    const job = { ...buildStubJob(manuscriptId), kind: 'subset', subsetChapterIds: [1, 2] } as unknown as AnalysisJob;
    job.engine = 'local';
    try {
      const { getManuscript } = await import('../store/manuscripts.js');
      const recordRef = getManuscript(manuscriptId) as never as { chapterHints: ChapterHint[] };
      await runSubsetAnalyzerJob(job, recordRef as never, selection, buildSelection(phase1WithOneLine, 'phase1-test-model'), recordRef.chapterHints as never, true);
      expect(primaryNonStoryCalls(), 'precondition: the job consulted the non-story classifier').toBe(1);
      expect(job.engine).toBe('gemini');
      expect(job.fallbackMarked?.has('gemini-3.6-flash')).toBe(true);
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
      process.env.STAGE2_COVERAGE_RETRIES = origCovRetries;
      _resetUserSettingsCache();
    }
  }, 60_000);

  it('subset: an Ollama primary that fell back to Gemini is still evicted when the run ends (job.ollamaServed)', async () => {
    const manuscriptId = `test-subset-evict-${Date.now()}`;
    registerStubManuscript(manuscriptId, 2);
    await seedCachedStage1(manuscriptId);
    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    unloadResidentOllamaMock.mockClear();
    const p1 = buildSpyPhase1Analyzer();
    const phase1Primary: Analyzer = {
      ...p1,
      async runStage2Chapter(): Promise<Stage2ChapterOutput> {
        throw new LocalUnreachableError('connect ECONNREFUSED');
      },
    };
    const phase1Selection: AnalyzerSelection = { analyzer: new FallbackAnalyzer(phase1Primary, p1), engine: 'local', model: 'qwen3.5:4b', fallbackModel: 'gemini-3.6-flash' };
    const job = { ...buildStubJob(manuscriptId), kind: 'subset', subsetChapterIds: [1, 2] } as unknown as AnalysisJob;
    job.engine = 'local';
    try {
      const { getManuscript } = await import('../store/manuscripts.js');
      const recordRef = getManuscript(manuscriptId) as never as { chapterHints: ChapterHint[] };
      await runSubsetAnalyzerJob(job, recordRef as never, buildSelection(buildSpyPhase0Analyzer(), 'phase0-test-model'), phase1Selection, recordRef.chapterHints as never, true);
      expect(job.engine, 'precondition: the job relabelled to the target').toBe('gemini');
      await vi.waitFor(() => expect(unloadResidentOllamaMock).toHaveBeenCalledTimes(1));
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
      process.env.STAGE2_COVERAGE_RETRIES = origCovRetries;
      _resetUserSettingsCache();
    }
  }, 60_000);
});
