/* Issue #2354 — Stage-2 time estimate is labelled "based on stage 1 rate"
   while still holding the pre-flight constant in pipelined mode.

   The estimate label must reflect the actual basis: in pipelined mode,
   Phase 1 setup runs BEFORE Phase 0 refinement completes, so the logged
   number is still the pre-flight constant from the baseline. The label
   must say "(pre-flight estimate, refined after stage 1)" in that case.
   When refinement has run, the label says "(based on stage 1 rate)". */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runMainAnalyzerJob, selectStage2EstimateLabel, type AnalysisJob } from './analysis.js';
import { clearAnalysisCache } from '../store/analysis-cache.js';
import type { Analyzer, AnalyzerSelection } from '../analyzer/index.js';
import type { Stage1ChapterOutput, Stage1Output, Stage2ChapterOutput } from '../handoff/schemas.js';
import type { ChapterHint } from '../store/manuscripts.js';
import { putManuscript, removeManuscript, getManuscript } from '../store/manuscripts.js';

/* ═══════════════════════════════════════════════════════════════════════════
   Unit tests for selectStage2EstimateLabel pure helper
   ═════════════════════════════════════════════════════════════════════════ */

describe('selectStage2EstimateLabel', () => {
  it('returns pre-flight message when isRefined is false', () => {
    const label = selectStage2EstimateLabel(false);
    expect(label).toContain('pre-flight estimate, refined after stage 1');
    expect(label).not.toContain('based on stage 1 rate');
  });

  it('returns refined message when isRefined is true', () => {
    const label = selectStage2EstimateLabel(true);
    expect(label).toContain('based on stage 1 rate');
    expect(label).not.toContain('pre-flight estimate');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Integration test for pipelined mode
   ═════════════════════════════════════════════════════════════════════════ */

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.ANALYZER;
  delete process.env.ANALYZER_PHASE0_MODEL;
  delete process.env.ANALYZER_PHASE1_MODEL;
  delete process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS;
  delete process.env.GEMINI_API_KEY;
  delete process.env.ANALYZER_OLLAMA_CONCURRENCY;
  delete process.env.ANALYSIS_CAST_CONCURRENCY;
  process.env.STAGE2_COVERAGE_RETRIES = '0';
});

afterEach(() => {
  process.env = { ...originalEnv };
  clearPipelinedMode();
  testAnalyzers.phase0 = undefined;
  testAnalyzers.phase1 = undefined;
});

/* Build a synthetic manuscript with N chapters. */
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

function buildSpyAnalyzerSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
  return {
    analyzer,
    engine: 'gemini',
    model,
    fallbackModel: null,
  };
}

function setPipelinedMode(opts: {
  pipelined: boolean;
  phase1Selection?: AnalyzerSelection;
  minLag?: number;
}): void {
  const g = globalThis as any;
  g.__test_force_pipelined = opts.pipelined;
  g.__test_phase1_selection = opts.phase1Selection ?? null;
  if (opts.minLag !== undefined) {
    process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS = String(opts.minLag);
  }
}

function clearPipelinedMode(): void {
  const g = globalThis as any;
  delete g.__test_force_pipelined;
  delete g.__test_phase1_selection;
}

/* Spy analyzer that responds with minimal data. Adds delay to ensure
   stage1ActualMs > 0 so the refinement block executes. */
function makeSpyAnalyzer(): Analyzer {
  const slowDown = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  return {
    async runStage1Chapter() {
      await slowDown();
      return {
        characters: [{ id: 'narrator', name: 'Narrator', role: 'narrator' }],
      };
    },
    async runStructureChapter() {
      return {
        characters: [{ id: 'narrator', name: 'Narrator', role: 'narrator' }],
        sentences: [],
        tags: [],
        turns: [],
        engagedTurns: 0,
      };
    },
    async runStage2Chapter() {
      await slowDown();
      return {
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narrator', text: 'A sentence.' },
        ],
      };
    },
    async runAttributionChapter() {
      await slowDown();
      return {
        characters: [{ id: 'narrator', name: 'Narrator', role: 'narrator' }],
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narrator', text: 'A sentence.' },
        ],
      };
    },
    async runEmotionChapter() {
      throw new Error('Emotion analyzer not used in test');
    },
    async runScriptReviewChapter() {
      throw new Error('Script review analyzer not used in test');
    },
    async runStage3Chapter() {
      throw new Error('Stage 3 analyzer not used in test');
    },
    async runAttributionEscalation() {
      throw new Error('Escalation not used in test');
    },
  };
}

/* Mock global selectAnalyzerForPhase so we can inject spy analyzers. */
const testAnalyzers: { phase0?: Analyzer; phase1?: Analyzer } = {};
vi.mock('../analyzer/select-analyzer.js', async () => {
  const actual = await vi.importActual<typeof import('../analyzer/select-analyzer.js')>(
    '../analyzer/select-analyzer.js',
  );
  return {
    ...actual,
    selectAnalyzerForPhase: (opts: { phase: 'phase0' | 'phase1' }) => {
      const g = globalThis as any;
      if (opts.phase === 'phase1' && g.__test_phase1_selection) {
        return g.__test_phase1_selection;
      }
      return actual.selectAnalyzerForPhase(opts);
    },
    isPerPhaseModelSelectionActive: () => {
      const g = globalThis as any;
      if (g.__test_force_pipelined !== undefined) return g.__test_force_pipelined;
      return actual.isPerPhaseModelSelectionActive();
    },
  };
});

vi.mock('../store/analysis-cache.js', () => {
  const mem = new Map<string, unknown>();
  return {
    loadAnalysisCache: async (id: string) => mem.get(id) ?? { chapters: {} },
    saveAnalysisCache: async (id: string, cache: unknown) => { mem.set(id, cache); },
    clearAnalysisCache: async (id: string) => { mem.delete(id); },
  };
});

vi.mock('./ollama-health.js', () => ({
  detectOllamaDevice: async () => 'cuda',
}));

vi.mock('../gpu/analyzer-device-state.js', () => ({
  setLastKnownAnalyzerDevice: () => {},
  getLastKnownAnalyzerDevice: () => undefined,
}));

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

describe('stage-2 estimate label integration (#2354)', () => {
  it('pipelined mode logs "(pre-flight estimate, refined after stage 1)" because Phase 1 setup runs before Phase 0 refinement', async () => {
    const manuscriptId = `test-estimate-pipelined-${Date.now()}`;
    registerStubManuscript(manuscriptId, 5);

    const phase0Analyzer = makeSpyAnalyzer();
    const phase1Analyzer = makeSpyAnalyzer();
    const phase0Selection = buildSpyAnalyzerSelection(phase0Analyzer, 'test-phase0');
    const phase1Selection = buildSpyAnalyzerSelection(phase1Analyzer, 'test-phase1');

    // Enable pipelined mode: Phase 1 setup starts concurrently with Phase 0,
    // so the estimate log fires before Phase 0 completion refinement runs.
    setPipelinedMode({ pipelined: true, phase1Selection, minLag: 1 });
    process.env.ANALYZER_OLLAMA_CONCURRENCY = '1';

    const job = buildStubJob(manuscriptId);

    try {
      const recordRef = getManuscript(manuscriptId);
      if (!recordRef) throw new Error('manuscript not found');

      await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });

      // Extract the estimated stage time log
      const estimateLogs = job.replay.logs.filter((log) => log.message.includes('Estimated stage time'));
      expect(estimateLogs.length).toBeGreaterThan(0);

      const estimateLog = estimateLogs[0];
      // In pipelined mode, phase1 setup runs before phase0 refinement,
      // so the estimate should show the pre-flight label
      expect(estimateLog.message).toContain('pre-flight estimate, refined after stage 1');
      expect(estimateLog.message).not.toContain('based on stage 1 rate');
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
    }
  });
});
