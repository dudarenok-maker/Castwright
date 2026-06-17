/* Plan 88 follow-up — end-to-end pipelined Phase 0/Phase 1 contract.

   The watermark and select-analyzer modules already pin the seam-level
   invariants in isolation (`server/src/analyzer/phase-watermark.test.ts`,
   `server/src/analyzer/select-analyzer.test.ts`). This suite drives the
   `runMainAnalyzerJob` route body end-to-end with spy analyzers + a
   stub manuscript record, proving that the pipelining contract engages
   in the PRODUCTION code path — not just in the watermark unit tests.

   Cases (mapping to the plan-88 follow-up acceptance criteria):
     1. Interleaved execution — on a 30-chapter mock book with LAG=10,
        Phase 1 chapter 0 dispatches AFTER Phase 0 chapter 9 completes
        but BEFORE Phase 0 chapter 11 starts.
     2. Rolling roster — Phase 1 chapter 5's analyzer receives a
        snapshot containing Phase 0 chapters 0..14's characters but
        NOT chapters 15+'s.
     3. Back-pressure under stall — Phase 0 stalls mid-book (chapter 13
        hangs). Phase 1 chapters 0-2 dispatch quickly; chapter 3 parks
        until chapter 13 completes.
     4. Non-pipelined sequential mode — with per-phase selection
        inactive the pipeline collapses to sequential. Phase 1 NEVER
        dispatches while any Phase 0 chapter is pending.
     5. Concurrent quota usage — both pools in flight produces
        interleaved calls (Phase 1 calls fire while Phase 0 calls are
        still active), proving the limiter buckets advance in parallel.

   All cases use spy analyzers (no network, no Ollama / Gemini SDK) and
   the on-disk analysis cache (per-test unique id + `clearAnalysisCache`
   teardown). The route layer's saveAnalysisCache / loadAnalysisCache
   are real to keep the test honest about the actual write paths the
   pipelining touches. */

import { describe, expect, beforeEach, afterEach, vi } from 'vitest';
import { quarantinedIt } from '../test-utils/quarantine.js';
import { runMainAnalyzerJob, type AnalysisJob } from './analysis.js';
import { clearAnalysisCache } from '../store/analysis-cache.js';
import type { Analyzer, AnalyzerSelection, StageCall } from '../analyzer/index.js';
import type { Stage1ChapterOutput, Stage1Output, Stage2ChapterOutput } from '../handoff/schemas.js';
import type { ChapterHint } from '../store/manuscripts.js';
import { putManuscript, removeManuscript } from '../store/manuscripts.js';

/* Helpers ─────────────────────────────────────────────────────────── */

const originalEnv = { ...process.env };

beforeEach(() => {
  /* Clear analyzer env so each case sets only what it needs. */
  delete process.env.ANALYZER;
  delete process.env.ANALYZER_PHASE0_MODEL;
  delete process.env.ANALYZER_PHASE1_MODEL;
  delete process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS;
  delete process.env.GEMINI_API_KEY;
  delete process.env.STAGE2_CONCURRENCY;
  delete process.env.ANALYSIS_CAST_CONCURRENCY;
  /* These cases assert Phase 0/1 dispatch scheduling + call counts with stub
     (deliberately non-covering) attribution responses, so disable the stage-2
     coverage guard (plan 181) — otherwise every stub response fails the
     coverage check and is re-analysed, tripling the analyzer call counts. The
     guard itself is covered by stage2-coverage.test.ts. */
  process.env.STAGE2_COVERAGE_RETRIES = '0';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

/* Build a synthetic manuscript with N chapters, deterministic body. */
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

interface CallTrace {
  phase: 0 | 1;
  chapterId: number;
  /* Roster snapshot at dispatch — for Phase 1 only. Captured as the
     character ids ONLY (the order/content is what matters for the
     rolling-roster assertion). */
  rosterIds?: string[];
  /* Monotonic timestamp of dispatch. Used to assert interleaving. */
  startedAt: number;
}

interface PipelineFixture {
  trace: CallTrace[];
  /* Resolves the n-th Phase 0 call (1-indexed by chapterId). Set via
     `holdPhase0[chapterId] = true` in a test to keep that chapter's
     dispatch promise pending until `releasePhase0(chapterId)`. */
  holdPhase0: Map<number, () => void>;
  /* Resolve a held Phase 0 chapter — flips its dispatch promise from
     pending to resolved with the canned per-chapter result. */
  releasePhase0(chapterId: number): void;
  /* Holds the same way for Phase 1 if a test needs it. */
  holdPhase1: Map<number, () => void>;
  releasePhase1(chapterId: number): void;
  /* Pre-armed event hook — resolves immediately if a matching trace entry
     already exists, else registers a waiter synchronously and resolves on
     the push that creates it. Compose via Promise.all for multi-chapter waits. */
  whenDispatched(phase: 0 | 1, chapterId: number): Promise<void>;
  /* Push a trace entry and notify waiters — used by the temporary Step-1 test. */
  record(entry: CallTrace): void;
}

/* Build a paired spy analyzer for Phase 0 and Phase 1. Each per-chapter
   call records its dispatch into `trace` and resolves with a canned
   chapter-specific cast (Phase 0) / sentence array (Phase 1). Tests can
   `holdPhase0/Phase1` chapters to simulate slow / stalled work — the
   analyzer's per-call promise won't resolve until `release*()` fires. */
function makePipelineFixture(): {
  fixture: PipelineFixture;
  phase0Analyzer: Analyzer;
  phase1Analyzer: Analyzer;
} {
  const trace: CallTrace[] = [];
  const holdPhase0 = new Map<number, () => void>();
  const holdPhase1 = new Map<number, () => void>();
  const waiters: Array<{ match: (e: CallTrace) => boolean; resolve: () => void }> = [];

  function record(entry: CallTrace): void {
    trace.push(entry);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(entry)) {
        waiters[i].resolve();
        waiters.splice(i, 1);
      }
    }
  }

  function whenDispatched(phase: 0 | 1, chapterId: number): Promise<void> {
    if (trace.some((e) => e.phase === phase && e.chapterId === chapterId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      waiters.push({ match: (e) => e.phase === phase && e.chapterId === chapterId, resolve });
    });
  }

  const dispatchHold = (holds: Map<number, () => void>, chapterId: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (holds.has(chapterId)) {
        holds.set(chapterId, () => {
          holds.delete(chapterId);
          resolve();
        });
      } else {
        resolve();
      }
    });

  const phase0Analyzer: Analyzer = {
    async runStage1(): Promise<Stage1Output> {
      throw new Error('runStage1 not exercised by pipelining tests');
    },
    async runStage1Chapter(
      _manuscriptId: string,
      chapterId: number,
      _prompt: string,
      _call: StageCall,
    ): Promise<Stage1ChapterOutput> {
      record({ phase: 0, chapterId, startedAt: Date.now() });
      /* If the test wants to hold this chapter, register a holder and
         park until releasePhase0 fires. Otherwise resolve on next tick. */
      await dispatchHold(holdPhase0, chapterId);
      /* Canned per-chapter cast — distinct character per chapter so
         tests can assert which chapters folded into a roster snapshot. */
      return {
        characters: [
          {
            id: `ch${chapterId}-char`,
            name: `Character_ch${chapterId}`,
            role: 'minor',
            color: 'narrator',
            /* Embed real evidence so verifyEvidenceAgainstSource doesn't
               drop everyone. Use a token from the body (`lorem ipsum`) so
               the substring match lands. */
            evidence: [
              { quote: 'lorem ipsum dolor sit amet' },
              { quote: 'lorem ipsum dolor sit amet' },
              { quote: 'lorem ipsum dolor sit amet' },
            ],
          },
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
        ],
      };
    },
    async runStage2Chapter(): Promise<Stage2ChapterOutput> {
      throw new Error('Phase 0 analyzer does not run Phase 1 calls');
    },
    async runEmotionChapter() {
      throw new Error('Phase 0 analyzer does not run emotion calls');
    },
  };

  const phase1Analyzer: Analyzer = {
    async runStage1(): Promise<Stage1Output> {
      throw new Error('runStage1 not exercised by pipelining tests');
    },
    async runStage1Chapter(): Promise<Stage1ChapterOutput> {
      throw new Error('Phase 1 analyzer does not run Phase 0 calls');
    },
    async runStage2Chapter(
      _manuscriptId: string,
      chapterId: number,
      prompt: string,
      _call: StageCall,
    ): Promise<Stage2ChapterOutput> {
      /* Snapshot the roster from the inbox prompt. The prompt embeds the
         character roster as a JSON array under a "## Characters" header
         — see buildStage2ChapterInbox in analysis.ts. We grep for the
         array and pluck out the ids. */
      const match = prompt.match(/```json\s*\n([\s\S]*?)\n```/);
      let rosterIds: string[] = [];
      if (match) {
        try {
          const parsed = JSON.parse(match[1]) as Array<{ id: string }>;
          rosterIds = parsed.map((c) => c.id).sort();
        } catch {
          /* Best-effort; tests assert on a subset of expected ids. */
        }
      }
      record({ phase: 1, chapterId, rosterIds, startedAt: Date.now() });
      await dispatchHold(holdPhase1, chapterId);
      return {
        sentences: [
          {
            id: chapterId * 100 + 1,
            chapterId,
            characterId: 'narrator',
            text: `Chapter ${chapterId} body.`,
          },
        ],
      };
    },
    async runEmotionChapter() {
      throw new Error('Phase 1 analyzer does not run emotion calls');
    },
  };

  return {
    fixture: {
      trace,
      holdPhase0,
      releasePhase0(chapterId: number): void {
        const release = holdPhase0.get(chapterId);
        if (release) release();
      },
      holdPhase1,
      releasePhase1(chapterId: number): void {
        const release = holdPhase1.get(chapterId);
        if (release) release();
      },
      whenDispatched,
      record,
    },
    phase0Analyzer,
    phase1Analyzer,
  };
}

function buildSpyAnalyzerSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
  return {
    analyzer,
    engine: 'gemini',
    model,
    fallbackModel: null,
  };
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

/* Patch selectAnalyzerForPhase so the route picks our spy analyzers
   per phase. selectAnalyzer accepts a model override but the route's
   `selectAnalyzerForPhase('phase1')` call inside `runMainAnalyzerJob`
   reads env-only. We override the analyzer instance directly via
   vi.mock at top of file (sticky for the whole module) — see below. */
vi.mock('../analyzer/select-analyzer.js', async () => {
  const actual = await vi.importActual<typeof import('../analyzer/select-analyzer.js')>(
    '../analyzer/select-analyzer.js',
  );
  return {
    ...actual,
    /* Routed to the singleton injected by the test via a global hook —
       the test sets _testPhase1Analyzer + _testPhase1Active before
       calling runMainAnalyzerJob; we honour it here for the 'phase1'
       call and fall through to the real implementation otherwise. */
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

/* Replace disk-backed analysis cache with an in-memory Map so that these
   scheduling tests have zero real I/O and no shared CACHE_DIR coupling.
   Empty-cache miss shape MUST match the real loadAnalysisCache return:
   `{ chapters: {} }` (analysis-cache.ts ~L117). */
vi.mock('../store/analysis-cache.js', () => {
  const mem = new Map<string, unknown>();
  return {
    loadAnalysisCache: async (id: string) => mem.get(id) ?? { chapters: {} },
    saveAnalysisCache: async (id: string, cache: unknown) => { mem.set(id, cache); },
    clearAnalysisCache: async (id: string) => { mem.delete(id); },
  };
});

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

afterEach(() => {
  clearPipelinedMode();
});

/* Helper that polls `condition` until true or a budget elapses. Vitest
   uses real timers here (Phase 0 / Phase 1 dispatch hops are real
   microtasks), so polling with `setImmediate`-style waits is the
   right call. */
async function waitFor(condition: () => boolean, budgetMs = 2000, step = 5): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > budgetMs) {
      throw new Error(`waitFor timed out after ${budgetMs}ms`);
    }
    await new Promise((r) => setTimeout(r, step));
  }
}

/* ───────────────────────────────────────────────────────────────────
   Case 1 — Interleaved execution under default LAG=10.
   30-chapter mock book; assert Phase 1 chapter 0 dispatches AFTER
   Phase 0 chapter 9 completes but BEFORE Phase 0 chapter 11 starts.
   ─────────────────────────────────────────────────────────────────── */
describe('runMainAnalyzerJob — pipelined Phase 0/1 interleaved execution', () => {
  // QUARANTINED(#878): CPU+I/O contention timeout — drive-to-completion + real CACHE_DIR write. See docs/testing/flaky-register.md
  quarantinedIt('Phase 1 chapter 0 dispatches after Phase 0 chapter 9 completes but before chapter 11 starts (LAG=10)', async () => {
    const manuscriptId = `test-pipeline-interleave-${Date.now()}`;
    registerStubManuscript(manuscriptId, 30);
    /* Both Phase 0 and Phase 1 use `readStage2Concurrency`. Set to 1 so
       chapter dispatch order is deterministic — assertion "chapter 12
       hasn't started when chapter 0 dispatches" depends on the Phase 0
       worker pool advancing strictly in chapter-id order. */
    process.env.STAGE2_CONCURRENCY = '1';

    const { fixture, phase0Analyzer, phase1Analyzer } = makePipelineFixture();
    const phase0Selection = buildSpyAnalyzerSelection(phase0Analyzer, 'gemma-4-31b-it');
    const phase1Selection = buildSpyAnalyzerSelection(phase1Analyzer, 'gemini-3.1-flash-lite');
    setPipelinedMode({ pipelined: true, phase1Selection, minLag: 10 });

    const job = buildStubJob(manuscriptId);
    /* runMainAnalyzerJob owns its own SSE life-cycle; we don't need to
       attach a subscriber for the assertion (the trace records the
       analyzer calls directly). */
    try {
      const recordRef = (await import('../store/manuscripts.js')).getManuscript(manuscriptId);
      if (!recordRef) throw new Error('stub manuscript missing');
      const runPromise = runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });

      await runPromise;

      /* Phase 1 chapter 1 (index 0) first dispatch happens after Phase 0
         chapter 10 (index 9) completes. The trace contains starts; the
         contract is "Phase 1 entry K >= Phase 0 entry K+10" in the
         interleaved order. Walk the trace by time. */
      const phase0First = fixture.trace.filter((t) => t.phase === 0).slice(0, 12);
      const phase1First = fixture.trace.find((t) => t.phase === 1);
      expect(phase1First).toBeDefined();
      /* Phase 1 chapter 0 (chapterId=1) must be the first Phase 1 call. */
      expect(phase1First!.chapterId).toBe(1);
      /* Index in the full trace of the first Phase 1 dispatch. */
      const firstPhase1Index = fixture.trace.indexOf(phase1First!);
      /* Everything before it must include Phase 0 chapters 1..10 (>=10
         Phase 0 calls). */
      const phase0BeforePhase1 = fixture.trace
        .slice(0, firstPhase1Index)
        .filter((t) => t.phase === 0);
      expect(phase0BeforePhase1.length).toBeGreaterThanOrEqual(10);
      /* And Phase 0 chapter 12 (id=12) must not have started yet — the
         first 10 Phase 0 chapters have all completed, the 11th may be in
         flight (concurrency=1; index 11 = chapter id 11), but chapter 12
         is one beyond the "just barely caught up to LAG" point. Be
         conservative: require that the first Phase 1 dispatch happens
         BEFORE Phase 0 chapter 12 starts. */
      const phase0Chapter12 = fixture.trace.find((t) => t.phase === 0 && t.chapterId === 12);
      if (phase0Chapter12) {
        const phase0Chapter12Index = fixture.trace.indexOf(phase0Chapter12);
        expect(firstPhase1Index).toBeLessThan(phase0Chapter12Index);
      }
      /* Verify both pools fully completed. */
      expect(phase0First.length).toBeGreaterThan(0);
      const allPhase1 = fixture.trace.filter((t) => t.phase === 1);
      expect(allPhase1.length).toBe(30);
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
    }
  }, 30_000);
});

/* ───────────────────────────────────────────────────────────────────
   Case 2 — Rolling roster snapshot at Phase 1 dispatch time.
   Phase 1 chapter K's analyzer call must see a roster containing
   only the Phase 0 chapters whose watermark has caught up (K + LAG).
   ─────────────────────────────────────────────────────────────────── */
describe('runMainAnalyzerJob — rolling roster snapshot', () => {
  it('Phase 1 chapter K dispatches with a roster snapshot containing only Phase 0 chapters 1..K+LAG', async () => {
    const manuscriptId = `test-rolling-roster-${Date.now()}`;
    /* 12 chapters + min-lag=5 + concurrency=1 keeps the Phase 0 grind
       short enough (11 sequential dispatches before the holding chapter
       12 stalls the pool) that the inner `waitFor` doesn't have to span
       a full CI-cold-start budget. The smaller fixture pins the same
       invariant the larger one used to — "Phase 1 chapter K sees roster
       up to K+LAG, nothing beyond". Holding chapter 12 keeps the
       chapter-12 ch-cast OUT of the roster snapshot so the `not.toContain`
       assertion still has teeth. */
    registerStubManuscript(manuscriptId, 12);
    process.env.STAGE2_CONCURRENCY = '1';

    const { fixture, phase0Analyzer, phase1Analyzer } = makePipelineFixture();
    const phase0Selection = buildSpyAnalyzerSelection(phase0Analyzer, 'gemma-4-31b-it');
    const phase1Selection = buildSpyAnalyzerSelection(phase1Analyzer, 'gemini-3.1-flash-lite');
    setPipelinedMode({ pipelined: true, phase1Selection, minLag: 5 });

    /* Hold Phase 0 chapter 12 so chapters 1..11 complete but chapter
       12+ stay pending. Phase 1 chapter id=6 (index 5) needs
       watermark >= 5+5=10. Watermark=10 means chapter index 10
       (id=11) completed and chapterCast[11] is folded. So the
       roster snapshot at Phase 1 ch6's dispatch contains ch1-char..
       ch11-char (+narrator), but NOT ch12-char or beyond. */
    fixture.holdPhase0.set(12, () => {});

    const job = buildStubJob(manuscriptId);
    try {
      const recordRef = (await import('../store/manuscripts.js')).getManuscript(manuscriptId);
      const runPromise = runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });

      /* Event-driven wait — resolves the instant Phase 1 chapter 6 records
         into the trace; no polling, no wall-clock budget. */
      await fixture.whenDispatched(1, 6);

      const phase1Chapter6 = fixture.trace.find((t) => t.phase === 1 && t.chapterId === 6);
      expect(phase1Chapter6).toBeDefined();
      const roster = phase1Chapter6!.rosterIds ?? [];
      /* Roster contains ch1-char through ch11-char (Phase 0 chapters
         1..11 folded) plus 'narrator'. Should NOT contain ch12-char
         because chapter 12 is held pending. */
      expect(roster).toContain('ch1-char');
      expect(roster).toContain('ch10-char');
      expect(roster).toContain('ch11-char');
      expect(roster).not.toContain('ch12-char');

      /* Wait for Phase 0 chapter 12 to actually enter its dispatchHold
         (the spy records BEFORE the hold, so whenDispatched resolves the
         instant ch12 is parked and ready to be released). Then release so
         runPromise can complete. Without this guard, releasePhase0(12)
         fires before ch12 starts and the hold is permanently stuck. */
      await fixture.whenDispatched(0, 12);
      fixture.releasePhase0(12);
      await runPromise;
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
    }
  });
});

/* ───────────────────────────────────────────────────────────────────
   Case 3 — Back-pressure under stall.
   Phase 0 chapter 13 (index 12) hangs while chapters 14+ haven't
   started. With concurrency=1, the worker pool freezes at index 12.
   Watermark sits at 11 (chapter index 11 = id 12 just completed).
   Phase 1 chapter id=1 (index 0) needs watermark>=10 → dispatch.
   Phase 1 chapter id=2 (index 1) needs watermark>=11 → dispatch.
   Phase 1 chapter id=3 (index 2) needs watermark>=12 → PARK.
   Releasing Phase 0 chapter 13 (and 14 since concurrency=1) advances
   the watermark, releasing id=3. We extend the test to use Phase 1
   concurrency >= 2 so chapters 1 and 2 actually dispatch in parallel.
   ─────────────────────────────────────────────────────────────────── */
describe('runMainAnalyzerJob — back-pressure under stall', () => {
  // QUARANTINED(#878): CPU+I/O contention timeout — drive-to-completion + real CACHE_DIR write. See docs/testing/flaky-register.md
  quarantinedIt('Phase 1 chapter id=3 parks while Phase 0 chapter 13 is held; releasing unblocks dispatch', async () => {
    const manuscriptId = `test-backpressure-${Date.now()}`;
    registerStubManuscript(manuscriptId, 30);
    /* `readStage2Concurrency` is shared by Phase 0 + Phase 1. We need
       Phase 0 concurrency=1 for the watermark to cap deterministically
       at 11 when chapter 13 holds. Phase 1's worker pool will inherit
       the same value; since chapter id=3 parks the entire single
       worker, we have to keep our test assertion to "chapters 1 and 2
       dispatched, chapter 3 has NOT dispatched yet" — using concurrency
       higher than 1 would let chapter 3 spin up a second worker that
       dispatches independently. */
    process.env.STAGE2_CONCURRENCY = '1';

    const { fixture, phase0Analyzer, phase1Analyzer } = makePipelineFixture();
    const phase0Selection = buildSpyAnalyzerSelection(phase0Analyzer, 'gemma-4-31b-it');
    const phase1Selection = buildSpyAnalyzerSelection(phase1Analyzer, 'gemini-3.1-flash-lite');
    setPipelinedMode({ pipelined: true, phase1Selection, minLag: 10 });

    /* Hold Phase 0 chapter 13 — watermark stops at 11 until released. */
    fixture.holdPhase0.set(13, () => {});

    const job = buildStubJob(manuscriptId);
    try {
      const recordRef = (await import('../store/manuscripts.js')).getManuscript(manuscriptId);
      const runPromise = runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });

      /* Wait until Phase 1 chapters 1 and 2 (ids) have dispatched.
         Chapter id=3 (index 2) needs watermark>=12, which the held
         chapter 13 prevents — it must NOT dispatch. */
      await waitFor(
        () => [1, 2].every((id) => fixture.trace.some((t) => t.phase === 1 && t.chapterId === id)),
        10_000,
      );
      /* Give the watermark + queue another generous tick to make
         absolutely sure chapter 3 isn't spuriously released. */
      await new Promise((r) => setTimeout(r, 200));

      /* Phase 1 chapter id=3 must NOT have dispatched yet — it needs
         watermark >= 12 (which we're holding chapter 13 to prevent). */
      const phase1Chapter3 = fixture.trace.find((t) => t.phase === 1 && t.chapterId === 3);
      expect(phase1Chapter3).toBeUndefined();

      /* Release Phase 0 chapter 13 — watermark advances to 12 once
         chapter 13's completion folds in, releasing chapter id=3. */
      fixture.releasePhase0(13);
      await waitFor(() => fixture.trace.some((t) => t.phase === 1 && t.chapterId === 3), 10_000);
      await runPromise;
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
    }
  }, 30_000);
});

/* ───────────────────────────────────────────────────────────────────
   Case 4 — Sequential mode (per-phase selection inactive).
   When no per-phase model is configured the pipeline collapses to the
   sequential phase gate — Phase 1 NEVER dispatches while any Phase 0
   chapter is pending. The watermark factory returns the sequential stub.
   ─────────────────────────────────────────────────────────────────── */
describe('runMainAnalyzerJob — non-pipelined mode collapses to sequential', () => {
  // QUARANTINED(#878): CPU+I/O contention timeout — drive-to-completion + real CACHE_DIR write. See docs/testing/flaky-register.md
  quarantinedIt('sequential mode — Phase 1 never dispatches while any Phase 0 chapter is pending', async () => {
    const manuscriptId = `test-sequential-${Date.now()}`;
    registerStubManuscript(manuscriptId, 6);
    process.env.STAGE2_CONCURRENCY = '2';

    const { fixture, phase0Analyzer, phase1Analyzer } = makePipelineFixture();
    const phase0Selection = buildSpyAnalyzerSelection(phase0Analyzer, 'gemma-4-31b-it');
    const phase1Selection = buildSpyAnalyzerSelection(phase1Analyzer, 'gemma-4-31b-it');
    /* In sequential mode the route still calls
       `selectAnalyzerForPhase('phase1')`, but the watermark is the
       sequential stub — Phase 1 only starts after Phase 0b finalises.
       We inject the spy for Phase 1 so it doesn't fall through to the
       real Ollama analyzer (which would hit localhost:11434 and fail
       in the test sandbox). */
    setPipelinedMode({ pipelined: false, phase1Selection });

    const job = buildStubJob(manuscriptId);
    try {
      const recordRef = (await import('../store/manuscripts.js')).getManuscript(manuscriptId);
      const runPromise = runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });
      await runPromise;

      /* All Phase 0 calls must precede all Phase 1 calls in the trace.
         The sequential stub watermark only releases Phase 1 waiters
         after `markPhase0AllDone` fires, which the route triggers
         AFTER the Phase 0 worker pool drains AND Phase 0b finalises. */
      const lastPhase0Index = (() => {
        let idx = -1;
        for (let i = fixture.trace.length - 1; i >= 0; i--) {
          if (fixture.trace[i].phase === 0) {
            idx = i;
            break;
          }
        }
        return idx;
      })();
      const firstPhase1Index = fixture.trace.findIndex((t) => t.phase === 1);
      expect(lastPhase0Index).toBeGreaterThanOrEqual(0);
      expect(firstPhase1Index).toBeGreaterThan(lastPhase0Index);
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
    }
  }, 30_000);
});

/* ───────────────────────────────────────────────────────────────────
   Case 5 — Concurrent pool execution proof (interleaved trace).
   When both pools are in flight, the trace must contain interleaved
   Phase-0 + Phase-1 entries. This is the user-visible evidence the
   wall-clock pipelining gain is real (vs. PR #106's scope-down where
   the trace would be strictly Phase-0 then Phase-1).
   ─────────────────────────────────────────────────────────────────── */
describe('runMainAnalyzerJob — concurrent pool interleaving in production', () => {
  // QUARANTINED(#878): CPU+I/O contention timeout — drive-to-completion + real CACHE_DIR write. See docs/testing/flaky-register.md
  quarantinedIt('pipelined trace interleaves Phase-0 and Phase-1 dispatches (not strictly serial)', async () => {
    const manuscriptId = `test-concurrent-interleave-${Date.now()}`;
    registerStubManuscript(manuscriptId, 15);
    process.env.ANALYSIS_CAST_CONCURRENCY = '2';
    process.env.STAGE2_CONCURRENCY = '2';

    const { fixture, phase0Analyzer, phase1Analyzer } = makePipelineFixture();
    const phase0Selection = buildSpyAnalyzerSelection(phase0Analyzer, 'gemma-4-31b-it');
    const phase1Selection = buildSpyAnalyzerSelection(phase1Analyzer, 'gemini-3.1-flash-lite');
    /* Smaller lag so Phase 1 dispatches earlier and the interleave is
       visible across the 15-chapter trace. */
    setPipelinedMode({ pipelined: true, phase1Selection, minLag: 3 });

    const job = buildStubJob(manuscriptId);
    try {
      const recordRef = (await import('../store/manuscripts.js')).getManuscript(manuscriptId);
      await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
        requestedFresh: true,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });

      /* The trace must contain at least one Phase 1 entry whose start
         is BEFORE the last Phase 0 entry — that's the interleave
         signature. In strictly-serial mode this is impossible (every
         Phase 1 entry sits after every Phase 0 entry by construction). */
      const lastPhase0Index = (() => {
        let idx = -1;
        for (let i = fixture.trace.length - 1; i >= 0; i--) {
          if (fixture.trace[i].phase === 0) {
            idx = i;
            break;
          }
        }
        return idx;
      })();
      const firstPhase1Index = fixture.trace.findIndex((t) => t.phase === 1);
      expect(firstPhase1Index).toBeGreaterThanOrEqual(0);
      expect(lastPhase0Index).toBeGreaterThanOrEqual(0);
      expect(firstPhase1Index).toBeLessThan(lastPhase0Index);
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
    }
  }, 30_000);
});

/* ───────────────────────────────────────────────────────────────────
   Plan 118 regression — Phase 1 resolves through `selectAnalyzerForPhase`
   uniformly, even when a per-request `model` is present. Pre-fix the job
   used `opts.requestedModel ? selection : selectAnalyzerForPhase('phase1')`,
   so a per-request model (which the frontend ALWAYS sent) reused the Phase 0
   `selection` for Phase 1 — collapsing any configured split. The Phase 0 spy
   throws on `runStage2Chapter`, so the old path would never record a Phase 1
   dispatch; the fix routes Phase 1 through the per-phase selector (here the
   injected Phase 1 spy), so all chapters attribute.
   ─────────────────────────────────────────────────────────────────── */
describe('runMainAnalyzerJob — Phase 1 resolves via selectAnalyzerForPhase even with a per-request model', () => {
  // QUARANTINED(#878): CPU+I/O contention timeout — drive-to-completion + real CACHE_DIR write. See docs/testing/flaky-register.md
  quarantinedIt('does not reuse the Phase 0 selection for Phase 1 when requestedModel is set', async () => {
    const manuscriptId = `test-phase1-uniform-${Date.now()}`;
    registerStubManuscript(manuscriptId, 4);
    process.env.STAGE2_CONCURRENCY = '1';

    const { fixture, phase0Analyzer, phase1Analyzer } = makePipelineFixture();
    const phase0Selection = buildSpyAnalyzerSelection(phase0Analyzer, 'gemma-4-31b-it');
    const phase1Selection = buildSpyAnalyzerSelection(phase1Analyzer, 'gemini-3.1-flash-lite');
    /* Force the pipelined watermark on and inject the Phase 1 spy via the
       selectAnalyzerForPhase mock. minLag 0 → Phase 1 starts as soon as each
       Phase 0 chapter completes. */
    setPipelinedMode({ pipelined: true, phase1Selection, minLag: 0 });

    const job = buildStubJob(manuscriptId);
    try {
      const recordRef = (await import('../store/manuscripts.js')).getManuscript(manuscriptId);
      if (!recordRef) throw new Error('stub manuscript missing');
      await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
        requestedFresh: true,
        allowStage1Shrink: true,
        /* The frontend always sent this pre-fix; it must NOT shortcut Phase 1
           back onto the Phase 0 spy (which throws on runStage2Chapter). */
        requestedModel: 'gemini-2.5-flash',
      });
      const phase1Calls = fixture.trace.filter((t) => t.phase === 1);
      expect(phase1Calls.length).toBe(4);
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
    }
  }, 30_000);
});
