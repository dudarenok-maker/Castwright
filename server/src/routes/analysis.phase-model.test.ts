/* Phase-event model propagation — regression for "phase events carry the
   resolved analyzer model id."

   The route already emits `model` on throttle events (plan-88 precedent).
   This suite pins the matching contract for plain `phase` events: every
   phase-0 event must carry `model === phase0ModelId` and every phase-1
   event must carry `model === phase1ModelId`.

   Uses the same spy-analyzer + stub-manuscript harness as
   analysis-pipelining.test.ts so no network / Ollama calls are made. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runMainAnalyzerJob, type AnalysisJob } from './analysis.js';
import { clearAnalysisCache } from '../store/analysis-cache.js';
import type { Analyzer, AnalyzerSelection, StageCall } from '../analyzer/index.js';
import type { Stage1ChapterOutput, Stage1Output, Stage2ChapterOutput } from '../handoff/schemas.js';
import type { ChapterHint } from '../store/manuscripts.js';
import { putManuscript, removeManuscript } from '../store/manuscripts.js';

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

vi.mock('../analyzer/select-analyzer.js', async () => {
  const actual = await vi.importActual<typeof import('../analyzer/select-analyzer.js')>(
    '../analyzer/select-analyzer.js',
  );
  return {
    ...actual,
    selectAnalyzerForPhase: (opts: { phase: 'phase0' | 'phase1' }) => {
      const g = globalThis as Record<string, unknown>;
      if (opts.phase === 'phase1' && g.__phase_model_test_phase1_selection) {
        return g.__phase_model_test_phase1_selection;
      }
      return actual.selectAnalyzerForPhase(
        opts as Parameters<typeof actual.selectAnalyzerForPhase>[0],
      );
    },
    isPerPhaseModelSelectionActive: () => {
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

afterEach(() => {
  clearPhase1Selection();
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
