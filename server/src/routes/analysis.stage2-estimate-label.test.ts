/* Issue #2354 / #2365 C2 — the stage-2 time estimate logged at the top of
   Phase 1 is always the pre-flight constant (sourceChars / baseline rate),
   never the stage-1-observed rate. The refinement computed from
   stage1ActualMs happens inside runPhase0Pool(), which is launched
   UN-awaited; nothing awaits it before this log line fires, in EVERY mode
   (sequential mode parks Phase 1's *workers* on the watermark, not this
   setup code, so it is not exempt either). A prior version of this fix
   conditioned the label on a `stage2EstRefined` flag that could never be
   true at the log site — that flag, its setter, and the
   selectStage2EstimateLabel helper are gone; the log line now states the
   honest constant unconditionally. This test drives the real route (no
   pipelined-mode forcing — the whole point is that the wording no longer
   depends on that) and pins the log line's actual text. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runMainAnalyzerJob, type AnalysisJob } from './analysis.js';
import { clearAnalysisCache } from '../store/analysis-cache.js';
import type { Analyzer, AnalyzerSelection } from '../analyzer/index.js';
import type { ChapterHint } from '../store/manuscripts.js';
import { putManuscript, removeManuscript, getManuscript } from '../store/manuscripts.js';

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
  phase1SpySelection = null;
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

/* Spy analyzer that responds with minimal data. Adds delay to ensure
   stage1ActualMs > 0 so the refinement block executes (it still refines
   stage2EstMs's VALUE — only the label is no longer conditioned on it). */
function makeSpyAnalyzer(): Analyzer {
  const slowDown = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  return {
    async runStage1Chapter() {
      await slowDown();
      return {
        characters: [{ id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' }],
      };
    },
    async runStage2Chapter() {
      await slowDown();
      return {
        sentences: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'A sentence.' }],
      };
    },
    async runStage1() {
      throw new Error('Legacy whole-book stage 1 not used in test');
    },
    async runNonStoryClassification() {
      throw new Error('Non-story classification not used in test');
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

/* runMainAnalyzerJob resolves Phase 1's analyzer ITSELF via
   selectAnalyzerForPhase({ phase: 'phase1', ... }) — the `selection` argument
   the test passes in only covers Phase 0. Without this mock, Phase 1 would
   resolve to whatever the real default analyzer is (local/Ollama) and try to
   reach it over the network, which is what timed out here before this mock
   was restored. This does NOT force pipelined mode — isPerPhaseModelSelectionActive
   is left as the real implementation, which reads false from the cleared env,
   giving genuine default (sequential) behaviour. */
let phase1SpySelection: AnalyzerSelection | null = null;
vi.mock('../analyzer/select-analyzer.js', async () => {
  const actual = await vi.importActual<typeof import('../analyzer/select-analyzer.js')>(
    '../analyzer/select-analyzer.js',
  );
  return {
    ...actual,
    selectAnalyzerForPhase: (opts: { phase: 'phase0' | 'phase1' }) => {
      if (opts.phase === 'phase1' && phase1SpySelection) return phase1SpySelection;
      return actual.selectAnalyzerForPhase(opts);
    },
  };
});

vi.mock('../store/analysis-cache.js', () => {
  const mem = new Map<string, unknown>();
  return {
    loadAnalysisCache: async (id: string) => mem.get(id) ?? { chapters: {} },
    saveAnalysisCache: async (id: string, cache: unknown) => {
      mem.set(id, cache);
    },
    clearAnalysisCache: async (id: string) => {
      mem.delete(id);
    },
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

describe('stage-2 estimate label (#2354, #2365 C2)', () => {
  /* The title says only what this test asserts. It runs with the per-phase env
     cleared, so `isPerPhaseModelSelectionActive()` reads false and the route
     takes its default path — but the test does not ASSERT the mode, and naming
     a mode it never checks would be the same overstatement the fix removed. */
  it('logs the pre-flight wording, with no pipelined-mode forcing', async () => {
    const manuscriptId = `test-estimate-default-${Date.now()}`;
    registerStubManuscript(manuscriptId, 5);

    const phase0Analyzer = makeSpyAnalyzer();
    const phase1Analyzer = makeSpyAnalyzer();
    const phase0Selection = buildSpyAnalyzerSelection(phase0Analyzer, 'test-phase0');
    phase1SpySelection = buildSpyAnalyzerSelection(phase1Analyzer, 'test-phase1');

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

      const estimateLogs = job.replay.logs.filter((log) =>
        log.message.includes('Estimated stage time'),
      );
      expect(estimateLogs.length).toBeGreaterThan(0);

      /* This is the honest constant: in default (sequential) mode there is
         no per-phase model selection, so Phase 1's WORKERS park on the
         watermark until Phase 0 finishes -- but this log line fires from
         Phase 1's SETUP code, which runs unconditionally right after Phase 0
         is launched (un-awaited) and before anything awaits it. A version of
         this test that asserted the OLD 'based on stage 1 rate' wording here
         would have failed before the fix and must pass after it. */
      const estimateLog = estimateLogs[0];
      expect(estimateLog.message).toContain('pre-flight estimate, refined after stage 1');
      expect(estimateLog.message).not.toContain('based on stage 1 rate');
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
    }
  });
});
