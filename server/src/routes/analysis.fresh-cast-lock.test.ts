/* #1981 Task 11 — races analysis.ts's "Start fresh" cast.json delete (inside
   runMainAnalyzerJob) against a concurrent cast-aliases write, and asserts
   the file stays deleted regardless of interleaving.

   Kept in its own file, not analysis.test.ts — mirrors book-state-preserve-
   voices.test.ts's precedent: a dedicated fast-tier file for one focused
   race, so this file's own heavy fixture/mock setup (a real Express app +
   workspace-backed book, on top of the stub-analyzer machinery
   analysis.test.ts's "fresh re-analysis" test already needs) doesn't compound
   analysis.test.ts's already-large hook-timeout budget.

   Named deliberately: cast-aliases' add-alias re-reads cast.json INSIDE its
   own lock and refuses with 409 when the cast is absent (see
   cast-aliases.ts) — it is rule-2-compliant, so once serialised against the
   delete it leaves cast.json deleted in BOTH orderings.

   #2015 update: analysis.ts's own readPriorCastForMerge is now LOCKED, and
   reads via readFile (cast-fingerprint.ts) rather than state-io's readJson,
   so it neither trips the readJson interceptor below nor races the delete.
   It queues behind add-alias's held lock instead, which adds two extra lock
   handoffs between `released()` and the delete actually landing — hence the
   widened settle window below.

   The analysis job's own stub Phase-0 analyzer hangs on a SEPARATE gate,
   released only after this test has already inspected disk state. Nothing
   between the "Start fresh" delete and Phase-0's own per-chapter cast.json
   mirror write (analysis.ts, `interim.length > 0` block) touches cast.json,
   so holding Phase 0 open guarantees the only write in play during the
   race window is analysis.ts's locked delete and add-alias's own write —
   never the job's own later, legitimate re-creation of cast.json. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import type { Analyzer, AnalyzerSelection } from '../analyzer/index.js';
import type { Stage1ChapterOutput, Stage2ChapterOutput } from '../handoff/schemas.js';
import type { AnalysisJob } from './analysis.js';

/* W2.6 mirror — same three mocks analysis.test.ts's own "fresh re-analysis"
   test needs, so runMainAnalyzerJob never touches a real Ollama/GPU boundary. */
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

/* #1981 Task 11 — hoisted `vi.mock` (NOT a runtime `vi.spyOn`) so the race
   test below can deterministically intercept cast-aliases.ts's OWN
   `readJson` call (bound at its own module-load time, before any runtime
   spy could attach to it). Defaults to a plain passthrough. */
vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return { ...actual, readJson: vi.fn(actual.readJson) };
});

const AUTHOR = 'Fresh Lock Author';
const SERIES = 'Standalones';
const TITLE = 'Fresh Lock Book';
const CHAPTER_BODY = 'Nova said the plan out loud.';

let workspaceRoot: string;
let app: Express;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-fresh-lock-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  /* Sequential, not `Promise.all` — this file carries a hoisted async-factory
     `vi.mock` (state-io.js above); a `Promise.all` of dynamic imports races
     the factory and a module can bind the real, unmocked export. Also all
     workspace-sensitive modules (paths.js/scan.js, transitively) are
     imported for the FIRST time here, after WORKSPACE_DIR is set — nothing
     earlier in this file imports them, so no `vi.resetModules()` dance is
     needed (contrast cast-lock.race.test.ts's cross-module describe, whose
     OWN static top-of-file `import './paths.js'` forces one). */
  const { castAliasesRouter } = await import('./cast-aliases.js');
  app = express();
  app.use(express.json());
  app.use('/api/books', castAliasesRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
  return { analyzer, engine: 'gemini', model, fallbackModel: null };
}

function setPhase1Selection(sel: AnalyzerSelection): void {
  (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection = sel;
}
function clearPhase1Selection(): void {
  delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
}
afterEach(() => {
  clearPhase1Selection();
});

function buildPhase1Analyzer(): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () =>
      Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
    async runStage2Chapter(
      _manuscriptId: string,
      chapterId: number,
    ): Promise<Stage2ChapterOutput> {
      return {
        sentences: [
          {
            id: chapterId * 100 + 1,
            chapterId,
            characterId: 'nova',
            confidence: 0.9,
            text: CHAPTER_BODY,
          },
        ],
      };
    },
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () =>
      Promise.reject(new Error('no flagged windows — escalation should never be called')),
  };
}

describe('#1981 Task 11 — "Start fresh" cast.json delete races a concurrent cast writer', () => {
  it(
    'an add-alias write does not resurrect cast.json after a concurrent "Start fresh" delete',
    async () => {
      const manuscriptId = `test-fresh-lock-${Date.now()}-${Math.random()}`;
      const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
      mkdirSync(join(bookDir, '.audiobook'), { recursive: true });

      const { makeBookId, castJsonPath } = await import('../workspace/paths.js');
      const bookId = makeBookId(AUTHOR, SERIES, TITLE);
      writeFileSync(
        join(bookDir, '.audiobook', 'state.json'),
        JSON.stringify({
          bookId,
          manuscriptId,
          title: TITLE,
          author: AUTHOR,
          series: SERIES,
          seriesPosition: null,
          isStandalone: true,
          manuscriptFile: 'manuscript.md',
          castConfirmed: true,
      language: 'en',

          chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
          coverGradient: ['#000', '#fff'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );
      const castPath = join(bookDir, '.audiobook', 'cast.json');
      writeFileSync(
        castPath,
        JSON.stringify({
          characters: [{ id: 'nova', name: 'Nova', role: 'character', color: '#abc', aliases: [] }],
        }),
      );

      const { putManuscript, getManuscript, removeManuscript } = await import(
        '../store/manuscripts.js'
      );
      putManuscript({
        manuscriptId,
        format: 'plaintext',
        title: TITLE,
        wordCount: 10,
        byteSize: 100,
        uploadedAt: new Date().toISOString(),
        sourceText: CHAPTER_BODY,
        chapterHints: [{ id: 1, title: 'Chapter One', body: CHAPTER_BODY }],
        bookDir,
      });

      const { runMainAnalyzerJob } = await import('./analysis.js');
      const stateIo = await import('../workspace/state-io.js');
      const actual = await vi.importActual<typeof import('../workspace/state-io.js')>(
        '../workspace/state-io.js',
      );

      /* Phase-0's own controllable hang — see file header. Released only
         after this test has already captured disk state. */
      let releasePhase0!: () => void;
      const phase0Gate = new Promise<void>((resolve) => {
        releasePhase0 = resolve;
      });
      function buildHangingPhase0Analyzer(): Analyzer {
        return {
          runStage1: () => Promise.reject(new Error('not used')),
          async runStage1Chapter(): Promise<Stage1ChapterOutput> {
            await phase0Gate;
            return { characters: [{ id: 'nova', name: 'Nova', role: 'character', color: '#abc' }] };
          },
          runStage2Chapter: () =>
            Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
          runEmotionChapter: () => Promise.reject(new Error('not used')),
          runScriptReviewChapter: () => Promise.reject(new Error('not used')),
          runStage3Chapter: () => Promise.reject(new Error('not used')),
          runAttributionEscalation: () => Promise.reject(new Error('not used')),
        };
      }

      const phase0Selection = buildSelection(buildHangingPhase0Analyzer(), 'phase0-model');
      const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model');
      setPhase1Selection(phase1Selection);

      const job: AnalysisJob = {
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

      /* Race machinery: gate add-alias's in-lock readJson(cast.json) call. */
      const raceCastPath = castJsonPath(bookDir);
      let released!: () => void;
      const gate = new Promise<void>((resolve) => {
        released = resolve;
      });
      let intercepted = false;
      let signalIntercepted!: () => void;
      const interceptedSignal = new Promise<void>((resolve) => {
        signalIntercepted = resolve;
      });
      const spy = vi.mocked(stateIo.readJson).mockImplementation(async (path: string) => {
        if (!intercepted && path === raceCastPath) {
          intercepted = true;
          const value = await actual.readJson(path); // real bytes, now — happens-before the delete
          /* Signalled AFTER the real read, not at interceptor entry (PR #2232
             review, finding 1). The invariant this edge exists to establish is
             "add-alias's read genuinely happens-before the delete" — resolving on
             entry would release the delete while the read was still pending, which
             is harmless while the route holds withCastLock but gives the
             lock-removed mutation strictly LESS slack than the 300ms sleep did.
             Signal what the comment actually claims. */
          signalIntercepted();
          await gate; // hold the RESOLUTION open until released below
          return value;
        }
        return actual.readJson(path);
      });

      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';

      let resAlias: request.Response;
      let castExistsAfterRace = true;
      let jobPromise: Promise<void> | undefined;
      try {
        const aliasPromise = request(app)
          .post(`/api/books/${bookId}/cast/add-alias`)
          .send({ characterId: 'nova', aliasName: 'Supernova' });
        aliasPromise.catch(() => {}); // supertest is lazy — force real dispatch now
        // Let add-alias acquire the cast lock and reach (and get stuck
        // behind) its intercepted in-lock read. Wait for the interceptedSignal,
        // which resolves only AFTER the real read completes (not at entry) — this
        // is the genuine happens-before edge, deterministic regardless of machine
        // load. A poll on a boolean at entry (the old pattern) gave a shorter
        // critical window than even the 300ms fixed sleep it replaced.
        await Promise.race([
          interceptedSignal,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(
                'add-alias never reached its intercepted in-lock read within 5000ms',
              )),
              5_000,
            ),
          ),
        ]);
        expect(intercepted).toBe(true);

        const recordRef = getManuscript(manuscriptId)!;
        jobPromise = runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: true,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });
        jobPromise.catch(() => {}); // don't let a later stub-shape error surface here

        // Generous head start: the delete either completes immediately
        // (unlocked — the bug window) or queues behind add-alias's held
        // lock (locked — the fix). Not a tight window either way.
        await new Promise((r) => setTimeout(r, 100));

        released();
        resAlias = await aliasPromise;
        /* #2015 — three handoffs now, not one: add-alias releases, the job's
           locked capture acquires+releases, then the delete acquires. Poll for
           the delete to complete (file removal) rather than sleeping a fixed
           duration, which can fail under lock-contention delays. No
           resurrection write is possible after resAlias resolves, since the
           add-alias write has already landed on disk (writeJsonAtomic happens
           before the HTTP response) and Phase 0 is still gated. */
        await vi.waitFor(
          () => {
            if (existsSync(castPath)) {
              throw new Error('cast.json still exists; delete has not completed');
            }
          },
          { timeout: 5_000, interval: 10 },
        );

        // Capture disk state NOW, before Phase 0 (still gated) is allowed to
        // proceed to the job's own later, legitimate cast.json write.
        castExistsAfterRace = existsSync(castPath);
      } finally {
        // Not `mockRestore()` — this is a `vi.fn()` wrapper (from the
        // hoisted `vi.mock` factory above), not a `vi.spyOn` spy, so restore
        // its default passthrough behaviour explicitly.
        spy.mockImplementation(actual.readJson);
        releasePhase0();
        if (jobPromise) await jobPromise.catch(() => {});
        removeManuscript(manuscriptId);
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }

      expect(resAlias!.status).toBe(200);
      /* The core assertion: whichever side acquired the lock first,
         cast.json ends up deleted, never resurrected with add-alias's stale
         snapshot. */
      expect(castExistsAfterRace).toBe(false);
    },
    30_000,
  );
});
