/* D1 (#3169) — a throw in a detached job's setup span must end the job
   terminally, exactly like a throw inside the historic main try, instead of
   leaking an `unhandledRejection` that leaves the job registered, its SSE
   stream open, and nothing logged under `[analysis]`.

   The throw point used here is common to BOTH job bodies: `requireBookStateLanguage`
   (called from `resolveBookLanguageForManuscript`, itself the very first setup
   step) is mocked to throw a non-`BookLanguageUnsetError` for a chosen
   manuscript id. That is exactly the "non-BookLanguageUnsetError rethrow after
   resolveBookLanguageForManuscript" case #3169's audit names as one of the
   setup-span throw sites — and, unlike `selectAnalyzerForPhase({phase:'phase1'})`
   (main-job-only) or `buildCloudEscalationAnalyzer` (config-gated), it is
   reachable identically from `runMainAnalyzerJob` and `runSubsetAnalyzerJob`
   with no extra scaffolding, so one mock covers both job bodies.

   Uses the same spy-analyzer + stub-manuscript harness as
   analysis-pipelining.test.ts / analysis.phase-model.test.ts so no network /
   Ollama calls are made — the analyzers here are never actually invoked,
   since the forced throw happens before either phase runs. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runMainAnalyzerJob,
  runSubsetAnalyzerJob,
  isAnalysisJobRunning,
  __testRegisterJobForTest,
  type AnalysisJob,
} from './analysis.js';
import { clearAnalysisCache } from '../store/analysis-cache.js';
import type { Analyzer, AnalyzerSelection, StageCall } from '../analyzer/index.js';
import type { Stage1ChapterOutput, Stage1Output, Stage2ChapterOutput } from '../handoff/schemas.js';
import type { ChapterHint } from '../store/manuscripts.js';
import { putManuscript, removeManuscript, getManuscript } from '../store/manuscripts.js';
import { AnalysisAbortedError } from '../analyzer/ollama.js';
import { LockAcquisitionTimeoutError, LOCK_CONTENTION_REQUEST_ERROR } from '../workspace/file-lock.js';

/* ── setup-throw mock: `requireBookStateLanguage` throws whatever the test
   stashed on globalThis, for whichever manuscript id the test flagged.
   `findBookByManuscriptId` is also mocked (just for that one manuscript id)
   so `resolveBookLanguageForManuscript` reaches `requireBookStateLanguage`
   at all — its own real implementation would return `null` for an
   unregistered book and short-circuit to 'en' before ever calling it. ── */

vi.mock('../workspace/scan.js', async () => {
  const actual = await vi.importActual<typeof import('../workspace/scan.js')>('../workspace/scan.js');
  return {
    ...actual,
    findBookByManuscriptId: async (manuscriptId: string) => {
      const g = globalThis as Record<string, unknown>;
      if (g.__setup_throw_manuscript_id === manuscriptId) {
        return {
          bookDir: '/fake/setup-throw-dir',
          author: '',
          series: '',
          title: '',
          state: {} as never,
        };
      }
      return actual.findBookByManuscriptId(manuscriptId);
    },
    requireBookStateLanguage: (state: never) => {
      const g = globalThis as Record<string, unknown>;
      if (g.__setup_throw_error) {
        throw g.__setup_throw_error;
      }
      return actual.requireBookStateLanguage(state);
    },
  };
});

function setSetupThrow(manuscriptId: string, error: unknown): void {
  const g = globalThis as Record<string, unknown>;
  g.__setup_throw_manuscript_id = manuscriptId;
  g.__setup_throw_error = error;
}

function clearSetupThrow(): void {
  const g = globalThis as Record<string, unknown>;
  delete g.__setup_throw_manuscript_id;
  delete g.__setup_throw_error;
}

afterEach(() => {
  clearSetupThrow();
});

/* ── stub analyzer / manuscript / job helpers (mirrors analysis.phase-model.test.ts) ── */

function buildInertAnalyzer(): Analyzer {
  return {
    async runStage1(): Promise<Stage1Output> {
      throw new Error('must not be called — the setup-span throw ends the job first');
    },
    async runStage1Chapter(): Promise<Stage1ChapterOutput> {
      throw new Error('must not be called — the setup-span throw ends the job first');
    },
    async runStage2Chapter(
      _manuscriptId: string,
      _chapterId: number,
      _prompt: string,
      _call: StageCall,
    ): Promise<Stage2ChapterOutput> {
      throw new Error('must not be called — the setup-span throw ends the job first');
    },
    async runEmotionChapter() {
      throw new Error('must not be called — the setup-span throw ends the job first');
    },
    async runScriptReviewChapter() {
      throw new Error('must not be called — the setup-span throw ends the job first');
    },
    async runStage3Chapter() {
      throw new Error('must not be called — the setup-span throw ends the job first');
    },
    async runAttributionEscalation() {
      throw new Error('must not be called — the setup-span throw ends the job first');
    },
  };
}

function buildSelection(): AnalyzerSelection {
  return { analyzer: buildInertAnalyzer(), engine: 'gemini', model: 'setup-throw-test-model', fallbackModel: null };
}

function buildStubJob(manuscriptId: string, kind: 'main' | 'subset'): AnalysisJob {
  const job = {
    controller: new AbortController(),
    subscribers: new Set(),
    manuscriptId,
    kind,
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
  } as unknown as AnalysisJob;
  /* Registered into the module's in-flight map so endJob's deregistration
     (the staleness guard `targetMap.get(manuscriptId) === job`) has a real
     entry to remove — the route always registers before dispatching a job;
     calling the job function directly (as this suite does) skips that, so
     the test does it itself via the same test-only hook
     analysis.rejoin-miss.test.ts already uses. */
  __testRegisterJobForTest(job);
  return job;
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

interface CapturedEvent {
  kind: string;
  [k: string]: unknown;
}

function attachEventCapture(job: AnalysisJob): CapturedEvent[] {
  const events: CapturedEvent[] = [];
  const keepAlive = setInterval(() => {}, 100_000) as NodeJS.Timeout;
  clearInterval(keepAlive);
  job.subscribers.add({
    send: (payload: unknown) => {
      if (payload && typeof payload === 'object') events.push(payload as CapturedEvent);
    },
    res: { end: () => {} } as unknown as import('express').Response,
    keepAlive,
  });
  return events;
}

/* ── Suite: runMainAnalyzerJob ─────────────────────────────────────────── */

describe('D1 (#3169) — runMainAnalyzerJob ends terminally on a setup-span throw', () => {
  it('a non-BookLanguageUnsetError thrown during setup resolves the job promise, emits a curated terminal error (not the raw lock-timeout message), deregisters the job, and logs under [analysis]', async () => {
    const manuscriptId = `test-setup-throw-main-${Date.now()}-${Math.random()}`;
    registerStubManuscript(manuscriptId, 1);
    const job = buildStubJob(manuscriptId, 'main');
    const events = attachEventCapture(job);
    const rawError = new LockAcquisitionTimeoutError(
      'cast:C:\\Users\\real-name\\books\\Some Author\\Some Series\\Some Title\\.audiobook\\cast.json',
      10_000,
    );
    setSetupThrow(manuscriptId, rawError);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const recordRef = getManuscript(manuscriptId);
      if (!recordRef) throw new Error('stub manuscript not found');

      // 1. The returned promise resolves rather than rejects.
      await expect(
        runMainAnalyzerJob(job, recordRef as never, buildSelection(), {
          requestedFresh: true,
          allowStage1Shrink: true,
          requestedModel: undefined,
        }),
      ).resolves.toBeUndefined();

      // 2. A subscriber receives a terminal { kind: 'error' } event with a
      //    curated message — never the raw lock-timeout text, which embeds
      //    an absolute workspace path (CLAUDE.md's LAN-HTTPS rule).
      const errorEvent = events.find((e) => e.kind === 'error') as
        | (CapturedEvent & { code?: string; message?: string })
        | undefined;
      expect(errorEvent, 'a terminal error event must be emitted').toBeDefined();
      expect(errorEvent?.message).toBe(LOCK_CONTENTION_REQUEST_ERROR);
      expect(errorEvent?.message).not.toContain('withKeyLock');
      expect(errorEvent?.message).not.toContain('cast:C:\\Users\\real-name');

      // 3. The job is deregistered — a subsequent lookup finds nothing live.
      expect(isAnalysisJobRunning(manuscriptId)).toBe(false);

      // 4. The error is logged with an [analysis] prefix, naming the manuscript.
      const loggedFailure = consoleErrorSpy.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].startsWith('[analysis] failed'),
      );
      expect(loggedFailure, 'expected a console.error("[analysis] failed", …) call').toBeDefined();
      const loggedDetail = loggedFailure?.[1] as { manuscriptId?: string } | undefined;
      expect(loggedDetail?.manuscriptId).toBe(manuscriptId);
    } finally {
      consoleErrorSpy.mockRestore();
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
    }
  }, 30_000);

  it('an AnalysisAbortedError thrown during setup ends the job with code "aborted"', async () => {
    const manuscriptId = `test-setup-throw-main-aborted-${Date.now()}-${Math.random()}`;
    registerStubManuscript(manuscriptId, 1);
    const job = buildStubJob(manuscriptId, 'main');
    const events = attachEventCapture(job);
    setSetupThrow(manuscriptId, new AnalysisAbortedError('paused during setup'));

    try {
      const recordRef = getManuscript(manuscriptId);
      if (!recordRef) throw new Error('stub manuscript not found');

      await expect(
        runMainAnalyzerJob(job, recordRef as never, buildSelection(), {
          requestedFresh: true,
          allowStage1Shrink: true,
          requestedModel: undefined,
        }),
      ).resolves.toBeUndefined();

      const errorEvent = events.find((e) => e.kind === 'error') as
        | (CapturedEvent & { code?: string })
        | undefined;
      expect(errorEvent?.code).toBe('aborted');
      expect(isAnalysisJobRunning(manuscriptId)).toBe(false);
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
    }
  }, 30_000);
});

/* ── Suite: runSubsetAnalyzerJob ───────────────────────────────────────── */

describe('D1 (#3169) — runSubsetAnalyzerJob ends terminally on a setup-span throw', () => {
  it('a non-BookLanguageUnsetError thrown during setup resolves the job promise, emits a curated terminal error (not the raw lock-timeout message), deregisters the job, and logs under [analysis-subset]', async () => {
    const manuscriptId = `test-setup-throw-subset-${Date.now()}-${Math.random()}`;
    registerStubManuscript(manuscriptId, 1);
    const job = buildStubJob(manuscriptId, 'subset');
    const events = attachEventCapture(job);
    const rawError = new LockAcquisitionTimeoutError(
      'cast:C:\\Users\\real-name\\books\\Some Author\\Some Series\\Some Title\\.audiobook\\cast.json',
      10_000,
    );
    setSetupThrow(manuscriptId, rawError);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const recordRef = getManuscript(manuscriptId);
      if (!recordRef) throw new Error('stub manuscript not found');
      const toRun = recordRef.chapterHints;

      await expect(
        runSubsetAnalyzerJob(job, recordRef as never, buildSelection(), buildSelection(), toRun, false),
      ).resolves.toBeUndefined();

      const errorEvent = events.find((e) => e.kind === 'error') as
        | (CapturedEvent & { code?: string; message?: string })
        | undefined;
      expect(errorEvent, 'a terminal error event must be emitted').toBeDefined();
      expect(errorEvent?.message).toBe(LOCK_CONTENTION_REQUEST_ERROR);
      expect(errorEvent?.message).not.toContain('withKeyLock');
      expect(errorEvent?.message).not.toContain('cast:C:\\Users\\real-name');

      expect(isAnalysisJobRunning(manuscriptId)).toBe(false);

      const loggedFailure = consoleErrorSpy.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].startsWith('[analysis-subset] failed'),
      );
      expect(loggedFailure, 'expected a console.error("[analysis-subset] failed", …) call').toBeDefined();
      const loggedDetail = loggedFailure?.[1] as { manuscriptId?: string } | undefined;
      expect(loggedDetail?.manuscriptId).toBe(manuscriptId);
    } finally {
      consoleErrorSpy.mockRestore();
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
    }
  }, 30_000);

  it('an AnalysisAbortedError thrown during setup ends the job with code "aborted"', async () => {
    const manuscriptId = `test-setup-throw-subset-aborted-${Date.now()}-${Math.random()}`;
    registerStubManuscript(manuscriptId, 1);
    const job = buildStubJob(manuscriptId, 'subset');
    const events = attachEventCapture(job);
    setSetupThrow(manuscriptId, new AnalysisAbortedError('paused during setup'));

    try {
      const recordRef = getManuscript(manuscriptId);
      if (!recordRef) throw new Error('stub manuscript not found');
      const toRun = recordRef.chapterHints;

      await expect(
        runSubsetAnalyzerJob(job, recordRef as never, buildSelection(), buildSelection(), toRun, false),
      ).resolves.toBeUndefined();

      const errorEvent = events.find((e) => e.kind === 'error') as
        | (CapturedEvent & { code?: string })
        | undefined;
      expect(errorEvent?.code).toBe('aborted');
      expect(isAnalysisJobRunning(manuscriptId)).toBe(false);
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
    }
  }, 30_000);
});
