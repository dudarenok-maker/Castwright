/* #2260 review round 3, C1 — WHERE the analysis persist block's lock-timeout
 * rethrow happens, driven end to end against a real `runMainAnalyzerJob`.
 *
 * Round 2 made the persist's `catch (historyErr)` rethrow a
 * `LockAcquisitionTimeoutError` instead of swallowing it. That was the right
 * error class in the wrong place. Thrown from inside the persist's own `try`
 * it skipped `logCarriedForwardCharacters` and the ENTIRE state.json
 * read+write, and then landed in the enclosing `catch (persistErr)` — which
 * logs "Non-fatal — the analysis result still streams back to the client" and
 * falls straight through to `send({kind:'result'})` + `endJob(job)`. So the
 * fold delivered none of its intended loudness (the job still reported
 * SUCCESS) AND added a fresh divergence the swallow never had: state.json
 * keeping the PREVIOUS run's chapter list, durations, `analysisProvenance`
 * and `updatedAt`.
 *
 * Both facts are asserted here, and BOTH are load-bearing — the fix is only
 * correct if the timeout reaches an `error` terminal AND every write in the
 * persist still landed. A test that checked one without the other would pass
 * against either half of the bug.
 *
 * And, as with `store/not-linked-edges.lock-timeout.test.ts` (the pattern this
 * file copies), the disk-fault direction is pinned alongside it: an EPERM out
 * of the same step is still swallowed, still warns, and still ends the job via
 * `result`. A handler that failed everything loudly would be a regression, not
 * a fix, and only the two-directional pair can tell those apart.
 *
 * The timeout is injected by mocking `dropSupersededIdsReclaimedByLiveCast`
 * (the first step in the block that runs UNCONDITIONALLY once the final
 * cast.json write has happened — see analysis.persist-block-degraded-history
 * .test.ts's fixture 1, which relies on the same property) rather than by
 * genuinely contending a lock: the real budget is 10s, which races vitest's
 * 15s testTimeout. The mock throws the REAL error class; that the real mutex
 * throws it on expiry is pinned separately in `workspace/file-lock.test.ts`.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CharacterOutput,
  SentenceOutput,
  Stage1ChapterOutput,
  Stage2ChapterOutput,
} from '../handoff/schemas.js';
import type { Analyzer, AnalyzerSelection, StageCall } from '../analyzer/index.js';
import { clearAnalysisCache, saveAnalysisCache } from '../store/analysis-cache.js';
import { putManuscript, removeManuscript, getManuscript, type ChapterHint } from '../store/manuscripts.js';
import type { Response } from '../http.js';

/* The seams the fixtures below drive. Each defaults to a passthrough to the
   real implementation; every test installs its own thrower.

   `toThrow` fires from `dropSupersededIdsReclaimedByLiveCast` — a step INSIDE
   the persist's `catch (historyErr)`, i.e. one of the six sites that rethrow.

   `reconcileThrow` fires from inside `reconcileRejectEdgesOnDisk` — the ONE
   site that does not (round 4, owner decision). There is no way to mock that
   function itself (it lives in the module under test), so the throw is aimed
   at `loadCastIdHistoryWithStatus`, which it calls inside its own
   `withCastLock`. That function is ALSO called once at the top of the persist,
   which is why the throw is armed rather than unconditional: the arming
   happens in `dropSupersededTargetsNoLongerLive`, the step immediately before
   the reconcile call, so only the reconcile's own read can ever hit it. */
const historyStep = vi.hoisted(() => ({
  toThrow: null as unknown,
  reconcileThrow: null as unknown,
  armed: false,
}));

vi.mock('../store/cast-id-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/cast-id-history.js')>();
  return {
    ...actual,
    dropSupersededIdsReclaimedByLiveCast: async (bookDir: string, liveIds: string[]) => {
      if (historyStep.toThrow) throw historyStep.toThrow;
      return actual.dropSupersededIdsReclaimedByLiveCast(bookDir, liveIds);
    },
    dropSupersededTargetsNoLongerLive: async (bookDir: string, liveIds: string[]) => {
      const result = await actual.dropSupersededTargetsNoLongerLive(bookDir, liveIds);
      if (historyStep.reconcileThrow) historyStep.armed = true;
      return result;
    },
    loadCastIdHistoryWithStatus: async (bookDir: string) => {
      if (historyStep.armed) throw historyStep.reconcileThrow;
      return actual.loadCastIdHistoryWithStatus(bookDir);
    },
  };
});

/* Same three environment mocks the sibling runMainAnalyzerJob fixture files
   use to keep the job off a real Ollama / real GPU-cost state and to let the
   test inject the Phase-1 analyzer selection. */
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
      if (opts.phase === 'phase1' && g.__analyzer_device_test_phase1_selection) {
        return g.__analyzer_device_test_phase1_selection;
      }
      return actual.selectAnalyzerForPhase(
        opts as Parameters<typeof actual.selectAnalyzerForPhase>[0],
      );
    },
    isPerPhaseModelSelectionActive: () => false,
  };
});

const { LockAcquisitionTimeoutError } = await import('../workspace/file-lock.js');
const { runMainAnalyzerJob, runSubsetAnalyzerJob } = await import('./analysis.js');
type AnalysisJob = import('./analysis.js').AnalysisJob;

const CHAPTER_BODY = '“Are you sure this will work,” Nova asked.\n\nOlga nodded and looked away.';

/* A deliberately WRONG prior state.json: stale chapter titles, no
   analysisProvenance at all, and a fixed old timestamp. Every one of those is
   something the persist's state.json write replaces — which is exactly what
   the early throw skipped. */
const STALE_UPDATED_AT = '2020-01-01T00:00:00.000Z';
const STALE_CHAPTER_TITLE = 'STALE — previous run';

function stage1Roster(): CharacterOutput[] {
  return [
    { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
    {
      id: 'nova',
      name: 'Nova',
      role: 'lead',
      color: '#111111',
      gender: 'female',
      evidence: [{ quote: 'Nova asked' }],
    },
  ];
}

function attributionForChapter(chapterId: number): SentenceOutput[] {
  return [
    {
      id: chapterId * 100 + 1,
      chapterId,
      characterId: 'nova',
      confidence: 0.9,
      text: 'Are you sure this will work',
    },
  ];
}

function buildPhase0Analyzer(): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    async runStage1Chapter(): Promise<Stage1ChapterOutput> {
      return { characters: stage1Roster() };
    },
    runStage2Chapter: () => Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.reject(new Error('not used')),
  };
}

function buildPhase1Analyzer(): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () => Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
    async runStage2Chapter(
      _manuscriptId: string,
      chapterId: number,
      _prompt: string,
      _call: StageCall,
    ): Promise<Stage2ChapterOutput> {
      return { sentences: attributionForChapter(chapterId) };
    },
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () =>
      Promise.reject(new Error('no flagged windows — escalation should never be called')),
  };
}

function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
  return { analyzer, engine: 'gemini', model, fallbackModel: null };
}

interface StateJsonOnDisk {
  chapters: Array<{ id: number; title: string; duration?: number }>;
  analysisProvenance?: { engine?: string; model?: string; at?: string };
  updatedAt?: string;
}

/** Drives one full `runMainAnalyzerJob` against a throwaway book, with a
 *  subscriber attached so the job's TERMINAL SSE event is observable — that
 *  event is the only thing that distinguishes "ended via endJob with an
 *  error" from "ended via send({kind:'result'})". */
async function runJob(
  label: string,
  kind: 'main' | 'subset' = 'main',
): Promise<{
  events: Array<{ kind?: string; code?: string; message?: string }>;
  state: StateJsonOnDisk;
  cast: { characters: Array<{ id: string }> };
  warnings: string[];
  cleanup: () => Promise<void>;
}> {
  const manuscriptId = `test-persist-lock-timeout-${label}-${Date.now()}-${Math.random()}`;
  const bookIdForRun = `b_persist_lock_timeout_${label}`;
  const bookDir = mkdtempSync(join(tmpdir(), `audiobook-persist-lock-timeout-${label}-`));
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
  process.env.STAGE2_COVERAGE_RETRIES = '0';

  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: bookIdForRun,
      manuscriptId,
      title: 'Persist Lock Timeout Test Book',
      author: 'Test Author',
      series: 'Standalones',
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.md',
      castConfirmed: false,
      chapters: [
        { id: 1, title: STALE_CHAPTER_TITLE, slug: '01-stale' },
        { id: 2, title: STALE_CHAPTER_TITLE, slug: '02-stale' },
        { id: 3, title: STALE_CHAPTER_TITLE, slug: '03-stale' },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: STALE_UPDATED_AT,
      updatedAt: STALE_UPDATED_AT,
    }),
  );

  const chapterHints: ChapterHint[] = [
    { id: 1, title: 'Chapter One', body: CHAPTER_BODY },
    { id: 2, title: 'Chapter Two', body: CHAPTER_BODY },
    { id: 3, title: 'Chapter Three', body: CHAPTER_BODY },
  ];
  putManuscript({
    manuscriptId,
    /* Required for the reconcile fixture: `bookIdForRetirementCleanup` returns
       undefined without it and `reconcileRejectEdgesOnDisk` then returns at its
       very first line, so the seam below would never be reached and the test
       would pass vacuously. */
    bookId: bookIdForRun,
    format: 'plaintext',
    title: 'Persist Lock Timeout Test Book',
    wordCount: 60,
    byteSize: 600,
    uploadedAt: new Date().toISOString(),
    sourceText: chapterHints.map((c) => c.body).join('\n\n'),
    chapterHints,
    bookDir,
  });

  (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection = buildSelection(
    buildPhase1Analyzer(),
    'phase1-model',
  );

  const events: Array<{ kind?: string; code?: string; message?: string }> = [];
  const keepAlive = setInterval(() => {}, 60_000);
  keepAlive.unref();
  /* The subset job only reaches its persist block on flow (a) — "cache.stage1
     existed BEFORE this batch". Seeding it is the whole difference between the
     two fixtures; everything else below is shared, deliberately, so the two
     jobs' persist blocks are exercised against the same book. */
  if (kind === 'subset') {
    await saveAnalysisCache(manuscriptId, {
      stage1: { characters: stage1Roster(), chapters: chapterHints.map((c) => ({ id: c.id, title: c.title })) },
      chapters: {},
    });
  }

  const job: AnalysisJob = {
    controller: new AbortController(),
    subscribers: new Set([
      {
        send: (payload: unknown) => {
          events.push(payload as { kind?: string });
        },
        res: { end: () => {} } as unknown as Response,
        keepAlive,
      },
    ]),
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

  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  const recordRef = getManuscript(manuscriptId);
  if (!recordRef) throw new Error('stub manuscript not found');

  /* Neither job EVER rejects — each owns its own top-level catch, which is the
     whole point: the terminal event, not a thrown error, is what the user
     sees. */
  if (kind === 'subset') {
    await runSubsetAnalyzerJob(
      job,
      recordRef as never,
      buildSelection(buildPhase0Analyzer(), 'phase0-model'),
      buildSelection(buildPhase1Analyzer(), 'phase1-model'),
      recordRef.chapterHints,
      true,
    );
  } else {
    await runMainAnalyzerJob(
      job,
      recordRef as never,
      buildSelection(buildPhase0Analyzer(), 'phase0-model'),
      { requestedFresh: false, allowStage1Shrink: true, requestedModel: undefined },
    );
  }

  const state = JSON.parse(
    readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'),
  ) as StateJsonOnDisk;
  const cast = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8')) as {
    characters: Array<{ id: string }>;
  };
  const warnings = warnSpy.mock.calls.map((c) => String(c[0]));

  warnSpy.mockRestore();
  errorSpy.mockRestore();
  clearInterval(keepAlive);

  return {
    events,
    state,
    cast,
    warnings,
    cleanup: async () => {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
      /* `maxRetries` is not decoration: this teardown was observed failing the
         TEST with `ENOTEMPTY` while the whole battery ran, because the persist
         finishes with a `writeJsonAtomic` rename and Windows can still be
         holding the directory a beat later. Node retries exactly this class
         (EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM) natively. */
      rmSync(bookDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
      else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
    },
  };
}

describe('runMainAnalyzerJob persist block — lock timeout vs disk fault (#2260 C1)', () => {
  afterEach(() => {
    historyStep.toThrow = null;
    historyStep.reconcileThrow = null;
    historyStep.armed = false;
    delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
  });

  it(
    'a lock timeout in the identity block still writes state.json AND ends the job with an error, not a result',
    async () => {
      historyStep.toThrow = new LockAcquisitionTimeoutError('cast-id-history:/w/book', 10_000);

      const run = await runJob('timeout');
      try {
        /* (1) THE WRITES SURVIVED. Under the round-2 placement the throw
           escaped before any of this ran, so state.json still held the stale
           seed — a divergence the plain swallow never produced. */
        expect(run.state.chapters.map((c) => c.title)).toEqual([
          'Chapter One',
          'Chapter Two',
          'Chapter Three',
        ]);
        expect(run.state.analysisProvenance?.model).toBe('phase1-model');
        expect(run.state.updatedAt).not.toBe(STALE_UPDATED_AT);
        // The authoritative cast.json write (before the identity block) too.
        expect(run.cast.characters.map((c) => c.id)).toContain('nova');

        /* (2) AND THE JOB FAILED LOUDLY. Under the round-2 placement the
           throw was caught by `catch (persistErr)`, which is best-effort, so
           the job went on to emit `result` and reported success. */
        const terminal = run.events[run.events.length - 1];
        expect(terminal?.kind).toBe('error');
        expect(run.events.some((e) => e.kind === 'result')).toBe(false);
        // The message that names the lock key and both cast-lock rules rides
        // through the classifier intact — that is what makes it diagnosable.
        expect(terminal?.message).toContain('cast-id-history:/w/book');
        expect(terminal?.message).toContain('rule 4');
      } finally {
        await run.cleanup();
      }
    },
    60_000,
  );

  it(
    'an EPERM-shaped disk fault in the same step is STILL swallowed — state.json written and the job ends with a result',
    async () => {
      historyStep.toThrow = Object.assign(
        new Error("EPERM: operation not permitted, open 'cast-id-history.json'"),
        { code: 'EPERM' },
      );

      const run = await runJob('eperm');
      try {
        // Same writes — this half was never broken and must stay that way.
        expect(run.state.chapters.map((c) => c.title)).toEqual([
          'Chapter One',
          'Chapter Two',
          'Chapter Three',
        ]);
        expect(run.state.analysisProvenance?.model).toBe('phase1-model');

        /* The terminal event is a RESULT: a side-table write failing must not
           fail the user's analysis. This is the assertion that reddens if the
           fix is over-applied into "rethrow everything". */
        const terminal = run.events[run.events.length - 1];
        expect(terminal?.kind).toBe('result');
        expect(run.events.some((e) => e.kind === 'error')).toBe(false);

        // ...and it was treated as best-effort, out loud, exactly as before.
        expect(
          run.warnings.some((w) => w.includes('failed to record character-id retirement(s)')),
        ).toBe(true);
      } finally {
        await run.cleanup();
      }
    },
    60_000,
  );

  /* #2260 round 4, owner decision — `reconcileRejectEdgesOnDisk` is the ONE
     handler that keeps swallowing a lock timeout, so it needs a test that
     reddens if someone "restores consistency" by adding the rethrow back.
     Round 2 DID add it there, on a rationale copy-pasted from the six identity
     sites ("the identity record never updated"), which does not describe this
     site: it runs last in the persist, after every retirement is already
     recorded, and writes only cosmetic `notLinkedTo` edges. */
  it(
    'a lock timeout in the reject-edge reconciliation is SWALLOWED — the run completes with a result',
    async () => {
      historyStep.reconcileThrow = new LockAcquisitionTimeoutError(
        'cast:/w/book-reconcile',
        10_000,
      );

      const run = await runJob('reconcile');
      try {
        /* The terminal event is a RESULT. This is the assertion the round-2
           rethrow reddened: a completed analysis was failed outright over a
           stale cosmetic edge the very next persist heals by itself. */
        const terminal = run.events[run.events.length - 1];
        expect(terminal?.kind).toBe('result');
        expect(run.events.some((e) => e.kind === 'error')).toBe(false);

        // The writes all landed too — same book state as a clean run.
        expect(run.state.chapters.map((c) => c.title)).toEqual([
          'Chapter One',
          'Chapter Two',
          'Chapter Three',
        ]);
        expect(run.cast.characters.map((c) => c.id)).toContain('nova');

        /* Swallowed is not the same as unnoticed — the operator line must
           still be there, or "best-effort" becomes "silent". */
        expect(run.warnings.some((w) => w.includes('failed to reconcile reject edges'))).toBe(true);
      } finally {
        await run.cleanup();
      }
    },
    60_000,
  );
});

/* #2260 round 4 (N2) — the subset job's persist block is a line-by-line mirror
 * of the main job's, down to the parked-then-rethrown local, and the commit
 * message, CLAUDE.md and the release notes all say "both blocks" — but only the
 * main one was driven. Reviewed line by line and found sound, so this is
 * coverage, not a bug hunt: it exists so the two blocks cannot silently drift
 * apart, which a mirrored-by-hand pair eventually does.
 *
 * Two-directional for the same reason the main pair is: a handler that failed
 * everything loudly would pass a timeout-only test.
 */
describe('runSubsetAnalyzerJob persist block — the same two directions (#2260 N2)', () => {
  afterEach(() => {
    historyStep.toThrow = null;
    historyStep.reconcileThrow = null;
    historyStep.armed = false;
    delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
  });

  it(
    'a lock timeout in the identity block still writes state.json AND ends the job with an error',
    async () => {
      historyStep.toThrow = new LockAcquisitionTimeoutError('cast-id-history:/w/subset', 10_000);

      const run = await runJob('subset-timeout', 'subset');
      try {
        // (1) The writes survived the parked throw.
        expect(run.state.chapters.map((c) => c.title)).toEqual([
          'Chapter One',
          'Chapter Two',
          'Chapter Three',
        ]);
        expect(run.state.analysisProvenance?.model).toBe('phase1-model');
        expect(run.state.updatedAt).not.toBe(STALE_UPDATED_AT);
        expect(run.cast.characters.map((c) => c.id)).toContain('nova');

        // (2) And the job failed loudly, with the diagnosable message intact.
        const terminal = run.events[run.events.length - 1];
        expect(terminal?.kind).toBe('error');
        expect(run.events.some((e) => e.kind === 'result')).toBe(false);
        expect(terminal?.message).toContain('cast-id-history:/w/subset');
        expect(terminal?.message).toContain('rule 4');
      } finally {
        await run.cleanup();
      }
    },
    60_000,
  );

  it(
    'an EPERM-shaped disk fault in the same step is STILL swallowed — the job ends with a result',
    async () => {
      historyStep.toThrow = Object.assign(
        new Error("EPERM: operation not permitted, open 'cast-id-history.json'"),
        { code: 'EPERM' },
      );

      const run = await runJob('subset-eperm', 'subset');
      try {
        expect(run.state.chapters.map((c) => c.title)).toEqual([
          'Chapter One',
          'Chapter Two',
          'Chapter Three',
        ]);
        expect(run.state.analysisProvenance?.model).toBe('phase1-model');

        const terminal = run.events[run.events.length - 1];
        expect(terminal?.kind).toBe('result');
        expect(run.events.some((e) => e.kind === 'error')).toBe(false);
        expect(
          run.warnings.some((w) => w.includes('failed to record character-id retirement(s)')),
        ).toBe(true);
      } finally {
        await run.cleanup();
      }
    },
    60_000,
  );
});
