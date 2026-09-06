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
   race window is analysis.ts's own writer(s) and add-alias's own write —
   never the job's own later, legitimate re-creation of cast.json.

   #3022 retarget (2026-09-06, owner decision "option 2"): this test pins the
   OUTCOME — cast.json stays deleted after a "Start fresh" delete races a
   concurrent add-alias write — not any one lock site. An earlier version of
   this file asserted that outcome AND claimed it as proof the delete's own
   `withCastLock` (analysis.ts, inside the `requestedFresh` block) was what
   enforced it; that claim was false; replacing that wrapper with a
   passthrough of identical arity left the assertion below green, because
   `readPriorCastForMerge` (analysis.ts) takes the SAME cast lock earlier in
   the same job, unconditionally whenever `recordRef.bookDir` is set, strictly
   before the delete — so add-alias's write is already serialised against the
   job well before the delete is reached, regardless of the delete's own
   wrapper. The outcome is real and worth gating; which specific call site
   delivers it is not something this test can pin without also breaking on a
   configuration production never runs (removing the upstream lock, which
   nothing in production ever does).

   WHICH assertion gates this test: the `vi.waitFor` poll for the delete, not
   the `expect(castExistsAfterRace)` at the bottom. Under the mutations that
   break the invariant, add-alias's write lands before the poll ever observes
   an absent file, so the poll throws and the bottom assertion is never
   reached. An earlier version of this header sent the reader to the bottom
   assertion; that was wrong (PR #3060 review pass 1, finding 1), and naming
   the reddening assertion correctly is precisely what #3022's decision asked
   for. */

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

/* Shared synchronization-wait budget (finding 4, PR #3009 review pass 1) —
   one named constant so a raised timeout can't silently diverge from a
   hardcoded copy in an error message. */
const SYNC_WAIT_TIMEOUT_MS = 5_000;

/* How long to let a late resurrection write land before sampling disk (PR
   #3009 review pass 2, finding 1). NOT a synchronisation guess: the delete is
   polled for separately, and this window exists purely to give a wrong writer
   time to be wrong in. Longer is strictly safer here, so it is not tuned. */
const RESURRECTION_SETTLE_MS = 400;

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

describe('#1981 Task 11 — "Start fresh" cannot be resurrected by a racing cast writer', () => {
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
          /* Signalled AFTER the real read, not at interceptor entry (PR #3009
             review pass 1, finding 1). The SHAPE follows the sibling precedent
             in book-state-preserve-voices.test.ts (#2215/#2232); the finding
             that this file needed it is this PR's own, so credit both rather
             than copying the sibling's attribution wholesale (pass 2, finding
             4). The invariant this edge exists to establish is "add-alias's
             read genuinely happens-before the delete" — resolving on entry
             would release the delete while the read was still pending, which
             is harmless while the route holds withCastLock but gives strictly
             LESS slack than the 300ms sleep did. Deliberately NOT argued from
             a single named lock site, the way the sibling's comment is: this
             file pins the outcome across whichever lock enforces it (#3022
             retarget), not one call site, so citing a specific wrapper here
             would overstate what this interceptor's timing actually proves. */
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
        /* The deadline timer is captured, unref'd and cleared (PR #3009 review
           pass 2, finding 3). Left dangling it holds a live handle for the full
           SYNC_WAIT_TIMEOUT_MS past the normal path — the exact hazard
           workspace/file-lock.ts:239-247 names and defends against, in a repo
           that already fights "Worker exited unexpectedly" teardown noise. */
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            interceptedSignal,
            new Promise<never>((_, reject) => {
              deadlineTimer = setTimeout(
                () => reject(new Error(
                  `add-alias never reached its intercepted in-lock read within ${SYNC_WAIT_TIMEOUT_MS}ms`,
                )),
                SYNC_WAIT_TIMEOUT_MS,
              );
              deadlineTimer.unref?.();
            }),
          ]);
        } finally {
          if (deadlineTimer) clearTimeout(deadlineTimer);
        }
        expect(intercepted).toBe(true);

        const recordRef = getManuscript(manuscriptId)!;
        jobPromise = runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: true,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });
        jobPromise.catch(() => {}); // don't let a later stub-shape error surface here

        // Finding 3 (PR #3009 review pass 1) — a `clearAnalysisCache`-completion
        // signal was tried here as a replacement for this fixed sleep. It
        // deadlocks: `readPriorCastForMerge` (analysis.ts, unconditional
        // whenever bookDir exists, and unconditionally BEFORE this
        // `requestedFresh` block) takes the SAME cast lock add-alias is
        // holding open below, so the job cannot reach `clearAnalysisCache`
        // (further down in the same block) — let alone signal its
        // completion — until add-alias's lock is released. But `released()`
        // below is gated on that very signal, so nothing ever fires; observed
        // `LockAcquisitionTimeoutError` after 10s and the test's own 5s wait
        // timing out. No duration-free synchronization point is AVAILABLE for
        // this head start with the current interceptor shape: the job cannot
        // even attempt this lock until add-alias releases it, so there is no
        // earlier test-visible edge to poll or await. Stated as availability,
        // not non-existence (PR #3009 review pass 2) — a lock-queue-ENTRY
        // edge (workspace/file-lock.ts:232, synchronous, fires while add-alias
        // still holds) would not deadlock; it is simply not exposed to a test
        // today. Do not re-run this experiment: it was tried once already and
        // deadlocked for the reason above, which does not change with #3022's
        // retarget below.
        //
        // #3022 retarget: under the outcome-level invariant this file now
        // pins, this fixed sleep has exactly one job — give the job and
        // add-alias a chance to actually interleave, so a real regression has
        // a window to occur in. That is a legitimate use of a fixed delay
        // (it does not gate correctness of anything the test asserts; it only
        // widens the odds a wrong writer gets to run during the race), not a
        // synchronisation guess standing in for a signal that doesn't exist —
        // the sleep below is that window, not a timing assumption to defend.
        // Generous head start: the delete either completes immediately
        // (unlocked at every site — the bug window) or queues behind
        // add-alias's held lock (locked at any site that matters — the fix).
        // Not a tight window either way.
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
              /* Message names BOTH causes deliberately. Under the retargeted
                 invariant this is the assertion a real regression reddens, and
                 the two ways to get here are indistinguishable from inside the
                 poll: the delete may not have run yet (contention), or it ran
                 and a racing writer put the file back (the #1981 Task 11 bug).
                 A message naming only the first blames contention for the
                 second, which is exactly the misdiagnosis PR #3009 review pass
                 2 finding 1 caught in the previous wording. */
              throw new Error(
                `cast.json is still present after ${SYNC_WAIT_TIMEOUT_MS}ms ` +
                  '— either the "Start fresh" delete never completed, or it ' +
                  'completed and a concurrent writer resurrected the file. ' +
                  'Both are failures of this invariant; check the job log for ' +
                  'a cast_merge_base_stale advisory, which indicates the latter.',
              );
            }
          },
          { timeout: SYNC_WAIT_TIMEOUT_MS, interval: 10 },
        );

        /* Settle window, RESTORED (PR #3009 review pass 2, finding 1). The poll
           above returns at the first instant of absence, so sampling absence
           immediately after it would be tautological, so the sample is taken
           at a moment the poll did not choose.

           Be honest about what this currently buys: NOTHING on today's code
           path. Per the reasoning above, no writer exists between the poll
           seeing the file gone and this sample, so this window waits 400ms for
           something that cannot happen, and the assertion it feeds cannot fail
           (PR #3060 review pass 1, finding 2). It is retained as a FORWARD
           guard, not as the gate: the invariant is "must not be resurrected",
           and a writer added later between the delete and stage 1 would be
           caught here and NOT by the poll, which exits at the first instant of
           absence. If that ever stops being worth 400ms, delete the window and
           the assertion together rather than leaving an assertion that reads
           like a gate. The gate is the poll above. */
        await new Promise((r) => setTimeout(r, RESURRECTION_SETTLE_MS));

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
      /* The core assertion, and what this test pins after the #3022 retarget:
         an add-alias write cannot interleave with a "Start fresh" delete to
         leave cast.json resurrected — whichever lock in analysis.ts's
         "Start fresh" path is what actually enforces that. This test does
         NOT claim to pin any one call site: `readPriorCastForMerge`
         (analysis.ts) takes the cast lock unconditionally, before the delete
         block, whenever `recordRef.bookDir` is set, so add-alias's write is
         already serialised against the job well before the job reaches the
         delete — which is exactly why asserting this outcome does not, by
         itself, prove the delete's own `withCastLock` is doing anything (see
         the file header).

         This assertion is NOT what catches the mutation, despite reading like
         it (PR #3060 review pass 1, finding 1). Removing cast-lock protection
         from both `readPriorCastForMerge` and the delete block does redden the
         test — at the POLL above, because add-alias's write lands before the
         poll ever sees the file gone, so execution never reaches this line.
         Review pass 1 measured which single-site removals redden it too:
         add-alias's own wrapper (`cast-aliases.ts`) does; the delete's wrapper
         alone and `readPriorCastForMerge`'s alone do not — the latter being
         the #1981 Task 11 line this file is named for, and the disclosure
         #3022 signed up for when it chose to retarget. */
      expect(castExistsAfterRace).toBe(false);
    },
    /* Runaway backstop, not a synchronisation deadline. 60_000 is this suite's
       house norm for the class (51 uses vs 17 of 30_000).

       Corrected in PR #3009 review pass 2, finding 2. Pass 1 raised this citing
       a test BODY of "10.4s then 22.0s on an UNLOADED box". That box was NOT
       unloaded — three sibling worktrees were running node/python at the
       time — and the claim was never checked before it was written down.
       Five quiet isolation runs measure 3.56 / 4.85 / 4.74 / 6.28 / 4.54s, so
       the honest body is ~5s and the old 30_000 already had ~5x headroom, not
       the 1.4x pass 1 asserted. (#3007's own 25.23s figure for this shape came
       from a contended box too.) The raise still stands, but only on the half
       of the evidence that survives: two of six runs under
       `flake-repro.mjs --cpu-load` blew 30_000 outright.

       60_000 not 120_000: suite-wide `retry: 1` means a genuine wedge costs
       twice the budget in fast-lane wall clock, so the ceiling is not free.
       Raising it at all is still NOT the "wider constant" mistake this PR
       fixes elsewhere — that sleep gated an ASSERTION on a timing guess,
       while this only bounds a hang. The real detectors are the internal
       bounded waits (SYNC_WAIT_TIMEOUT_MS above, withKeyLock's 10s per #2260),
       which held across all six contended runs and fail naming what never
       happened; this catches only what they cannot see. */
    60_000,
  );
});
