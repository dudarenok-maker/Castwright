/* Item 2 (cast-identity follow-up round) — pins the prohibition documented on
   `dropSupersededTargetsNoLongerLive` and at its two call sites in this file
   (search `dropSupersededTargetsNoLongerLive`): the prune runs ONLY at the
   two authoritative persist blocks, bound to `mergedFinal.characters`, and
   NEVER at any of the three mid-run "Cast so far" interim writes.

   The hazard (already fixed once as #2086): during an interim write,
   `buildInterimCast` has folded only the chapters analysed so far. A
   character who simply has not been reached yet is indistinguishable, at
   that moment, from one the analyzer actually dropped. Pruning a
   `supersededBy` entry against that partial roster would delete a valid
   alias for someone merely not yet on stage, silently orphaning their
   already-rendered audio onto the narrator the next time an old segment
   resolves through the (now-missing) alias.

   This is a BEHAVIOURAL test, not a structural one (no line-number/string
   scan) — chosen because a structural check only proves the two current
   call sites are the ones bound to `mergedFinal.characters`; it says
   nothing about a THIRD call added at an interim site tomorrow, which is
   exactly the regression this guards against. Driving the real
   `runMainAnalyzerJob` (the same job function `POST /analyze` invokes) is
   the only way to make the test's outcome depend on what the interim write
   block actually does, not on a description of what it's supposed to do.

   Scenario: a two-chapter book. Chapter 1 completes normally, triggering
   the real interim "Cast so far" write. Chapter 2 — which would introduce
   the CURRENTLY-live character a pre-existing `supersededBy` entry targets
   — fails outright (simulating a crash / disconnect / rate-limit death
   mid-run), so the run ends in Phase 0a with only chapter 1 folded in and
   the authoritative end-of-run write never reached. At the moment of the
   interim write, the target is simply not-yet-reached — indistinguishable
   from dropped. The test asserts the alias survives on disk.

   Mutation check performed by hand while writing this test (see the PR /
   commit message for the exact result): temporarily binding
   `dropSupersededTargetsNoLongerLive` to the interim roster's ids at the
   chapter-loop interim write (this file, the block that computes
   `mergedInterim`) turns this test red — the not-yet-reached target reads
   as dropped and the entry is pruned out from under it. Reverted before
   commit; production is untouched by this file. */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CharacterOutput,
  Stage1ChapterOutput,
  Stage2ChapterOutput,
} from '../handoff/schemas.js';
import type { Analyzer, AnalyzerSelection } from '../analyzer/index.js';
import type { AnalysisJob } from './analysis.js';
import type { ChapterHint } from '../store/manuscripts.js';

/* Same three environment mocks the #2110 dangling-target e2e test uses, to
   keep runMainAnalyzerJob off a real Ollama / real GPU-cost state and let
   the test inject the Phase-1 analyzer selection (never actually reached
   here, since the run dies in Phase 0a — kept for parity/safety in case a
   future edit makes Phase 0a advance further before failing). */
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
      if (opts.phase === 'phase1' && g.__interim_prune_test_phase1_selection) {
        return g.__interim_prune_test_phase1_selection;
      }
      return actual.selectAnalyzerForPhase(
        opts as Parameters<typeof actual.selectAnalyzerForPhase>[0],
      );
    },
    isPerPhaseModelSelectionActive: () => false,
  };
});

const AUTHOR = 'Interim Prune Author';
const SERIES = 'Standalones';
const TITLE = 'Interim Prune Book';

/* Chapter 1: narrator + Olga, same proven not-to-escalate dialogue tag shape
   ("X asked") the #2110 fixture uses, so Phase 0a never calls
   runAttributionEscalation (not implemented by the stub analyzer below). */
const CHAPTER1_BODY =
  '“Are you sure this will work,” Olga asked.\n\n“I think so,” Olga said.\n\n“Let us try, then,” Olga added.\n\nThe house had stood empty since the fire.';

/* Chapter 2's content is never actually analysed — the stub analyzer throws
   for this chapter regardless of body, simulating a mid-run crash. The text
   only needs to exist because a chapter hint requires a body. */
const CHAPTER2_BODY =
  '“Boris, is that you,” Olga called into the dark.\n\nNo one answered.';

function chapter1Roster(): CharacterOutput[] {
  return [
    { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
    {
      id: 'olga',
      name: 'Olga',
      role: 'lead',
      color: '#222222',
      gender: 'female',
      evidence: [{ quote: 'Olga asked' }, { quote: 'Olga said' }, { quote: 'Olga added' }],
    },
  ];
}

function buildPhase0Analyzer(): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    async runStage1Chapter(
      _manuscriptId: string,
      chapterId: number,
    ): Promise<Stage1ChapterOutput> {
      if (chapterId === 2) {
        // Simulated mid-run death: a crash / disconnect / rate-limit kill
        // that ends the job partway through Phase 0a, after chapter 1's
        // interim write already landed.
        throw new Error('simulated mid-run analyzer failure (chapter 2)');
      }
      return { characters: chapter1Roster() };
    },
    runStage2Chapter: () => Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.reject(new Error('not used')),
  };
}

/* Never reached (the run dies in Phase 0a before Phase 1 starts) — present
   only so buildSelection has something type-correct to hand runMainAnalyzerJob. */
function buildPhase1Analyzer(): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () => Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
    runStage2Chapter: (): Promise<Stage2ChapterOutput> =>
      Promise.reject(new Error('should never be reached — Phase 0a died first')),
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.reject(new Error('not used')),
  };
}

function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
  return { analyzer, engine: 'gemini', model, fallbackModel: null };
}

let workspaceRoot: string;
let bookDir: string;

let runMainAnalyzerJob: typeof import('./analysis.js').runMainAnalyzerJob;
let putManuscript: typeof import('../store/manuscripts.js').putManuscript;
let getManuscript: typeof import('../store/manuscripts.js').getManuscript;
let removeManuscript: typeof import('../store/manuscripts.js').removeManuscript;
let clearAnalysisCache: typeof import('../store/analysis-cache.js').clearAnalysisCache;
let loadCastIdHistory: typeof import('../store/cast-id-history.js').loadCastIdHistory;
let retireCharacterId: typeof import('../store/cast-id-history.js').retireCharacterId;
let castJsonPath: typeof import('../workspace/paths.js').castJsonPath;
let makeBookId: typeof import('../workspace/paths.js').makeBookId;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-interim-prune-e2e-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  /* #2083 — sequential awaits, not Promise.all: a Promise.all of dynamic
     imports here races the async vi.mock factory above (module-under-test
     can receive the real binding instead of the mock). See the sibling
     files carrying this same comment (e.g. cast-id-history-wiring.test.ts)
     for the measured background. */
  const analysisMod = await import('./analysis.js');
  const manuscriptsMod = await import('../store/manuscripts.js');
  const cacheMod = await import('../store/analysis-cache.js');
  const historyMod = await import('../store/cast-id-history.js');
  const pathsMod = await import('../workspace/paths.js');

  runMainAnalyzerJob = analysisMod.runMainAnalyzerJob;
  putManuscript = manuscriptsMod.putManuscript;
  getManuscript = manuscriptsMod.getManuscript;
  removeManuscript = manuscriptsMod.removeManuscript;
  clearAnalysisCache = cacheMod.clearAnalysisCache;
  loadCastIdHistory = historyMod.loadCastIdHistory;
  retireCharacterId = historyMod.retireCharacterId;
  castJsonPath = pathsMod.castJsonPath;
  makeBookId = pathsMod.makeBookId;

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function seedStateJson(bookId: string, manuscriptId: string): void {
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
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      language: 'en',

      chapters: [
        { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
        { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
}

function registerManuscript(manuscriptId: string): ChapterHint[] {
  const chapterHints: ChapterHint[] = [
    { id: 1, title: 'Chapter One', body: CHAPTER1_BODY },
    { id: 2, title: 'Chapter Two', body: CHAPTER2_BODY },
  ];
  putManuscript({
    manuscriptId,
    format: 'plaintext',
    title: TITLE,
    wordCount: 100,
    byteSize: 1000,
    uploadedAt: new Date().toISOString(),
    sourceText: chapterHints.map((c) => c.body).join('\n\n'),
    chapterHints,
    bookDir,
  });
  return chapterHints;
}

function setPhase1Selection(sel: AnalyzerSelection): void {
  (globalThis as Record<string, unknown>).__interim_prune_test_phase1_selection = sel;
}
function clearPhase1Selection(): void {
  delete (globalThis as Record<string, unknown>).__interim_prune_test_phase1_selection;
}

describe('interim-write prune prohibition — a not-yet-reached target must not be pruned mid-run', () => {
  it(
    'survives a mid-run death after the chapter-1 interim write, with chapter 2 (the alias target) never reached',
    async () => {
      const manuscriptId = `test-interim-prune-e2e-${Date.now()}-${Math.random()}`;
      const bookId = makeBookId(AUTHOR, SERIES, TITLE);
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      const originalConcurrency = process.env.ANALYZER_OLLAMA_CONCURRENCY;
      process.env.STAGE2_COVERAGE_RETRIES = '0';
      // Force strictly-sequential chapter processing so chapter 1's interim
      // write is guaranteed to land (and be observable) before chapter 2
      // starts and dies — with the default pool width (2) both chapters
      // would be dispatched concurrently and the ordering this scenario
      // depends on would not be guaranteed.
      process.env.ANALYZER_OLLAMA_CONCURRENCY = '1';

      seedStateJson(bookId, manuscriptId);
      // The pre-existing alias: an earlier run/repair recorded 'old-boris'
      // as superseded by 'boris'. 'boris' is not live in cast.json at all
      // right now (no prior cast.json exists yet) — the book is mid-story,
      // and this run's chapter 2 is where 'boris' would first be detected.
      await retireCharacterId(bookDir, 'old-boris', 'boris');
      registerManuscript(manuscriptId);

      const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
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
        },
        lastDiskWriteAt: 0,
      } as unknown as AnalysisJob;

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        // The real job runner — same function POST /analyze invokes. It
        // does NOT reject: chapter 2's thrown error is caught by
        // runMainAnalyzerJob's own top-level try/catch and turned into a
        // terminal `error` event (endJob), so this resolves normally even
        // though the run failed partway through.
        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: false,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        // Sanity check on the fixture: the run really did die mid-Phase-0a,
        // not complete normally or die before chapter 1. If this fails the
        // scenario never fired and everything below would be vacuous.
        const logMessages = job.replay.logs.map((l) => l.message);
        expect(logMessages.some((m) => m.includes('Chapter 1/2 cast done'))).toBe(true);
        expect(logMessages.some((m) => m.includes('Chapter 2/2 cast done'))).toBe(false);

        // Sanity check: chapter 1's interim write really did land, and
        // 'boris' (chapter 2's character) is genuinely absent from it — the
        // exact "not yet reached, indistinguishable from dropped" state the
        // interim write must never prune against.
        const castAfterInterimWrite = JSON.parse(readFileSync(castJsonPath(bookDir), 'utf8')) as {
          characters: Array<{ id: string }>;
        };
        const idsAfterInterimWrite = castAfterInterimWrite.characters.map((c) => c.id);
        expect(idsAfterInterimWrite).toContain('narrator');
        expect(idsAfterInterimWrite).toContain('olga');
        expect(idsAfterInterimWrite).not.toContain('boris');

        // The assertion under test: the interim write must not have pruned
        // the 'old-boris' -> 'boris' alias just because 'boris' wasn't in
        // the roster it wrote. It is only genuinely dead once an
        // AUTHORITATIVE write (never reached in this run) says so.
        const historyAfterDeath = await loadCastIdHistory(bookDir);
        expect(historyAfterDeath.supersededBy).toHaveProperty('old-boris', 'boris');
        expect(historyAfterDeath.displaced ?? {}).not.toHaveProperty('old-boris');
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        clearPhase1Selection();
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
        if (originalConcurrency === undefined) delete process.env.ANALYZER_OLLAMA_CONCURRENCY;
        else process.env.ANALYZER_OLLAMA_CONCURRENCY = originalConcurrency;
      }
    },
    60_000,
  );
});
