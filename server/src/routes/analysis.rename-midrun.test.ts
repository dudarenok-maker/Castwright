/* #2165 — the DEFENCE-IN-DEPTH layer. book-state.ts now refuses a rename
   while an analysis is registered (see
   book-state.rename-analysis-busy.test.ts), so this file deliberately does
   NOT go through the route: it performs the rename the way book-state.ts
   would (renameWithRetry + `rec.bookDir = newDir`) directly against a live
   run, and asserts that even a rename that somehow reached a running job
   cannot resurrect the pre-rename directory.

   Shape borrowed wholesale from analysis.fresh-cast-lock.test.ts: a real
   workspace-backed book in a tmpdir, the three analyzer/GPU mocks that keep
   runMainAnalyzerJob off any real boundary, and a stub Phase-0 analyzer that
   hangs on a gate so the test owns a deterministic mid-run window. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Analyzer, AnalyzerSelection } from '../analyzer/index.js';
import type { Stage1ChapterOutput, Stage2ChapterOutput } from '../handoff/schemas.js';
import type { AnalysisJob } from './analysis.js';
import { renameWithRetry } from '../workspace/atomic-rename.js';

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

const AUTHOR = 'Rename Midrun Author';
const SERIES = 'Standalones';
const OLD_TITLE = 'Rename Midrun Book';
const NEW_TITLE = 'Rename Midrun Book Renamed';
/* Real quoted dialogue (not mere narration) so the stub character's evidence
   quote below verbatim-matches the source and survives
   verifyEvidenceAgainstSource / dropEvidencelessCast — without that, Nova is
   a legitimate zero-evidence drop by production code, unrelated to #2165,
   and the whole case would fail for the wrong reason. Deliberately carries
   NO `<Name> <verb>` dialogue tag (no "Nova said"): the roster-coverage
   guard (analyzer/roster-coverage.ts) auto-recovers a tagged speaker it
   doesn't find on the roster, which — with a name present — put `nova`
   into the final cast via a second, unrelated mechanism and made the
   placebo mutation (phase-0 stub returns no characters) a false pass. */
const CHAPTER_BODY = '"The plan is set." Silence followed.';

let workspaceRoot: string;

/* #2196 — two config pins this file's guard tests need to keep the run
   COMPLETING honestly with `nova` in the persisted final cast:

   1. STRUCTURE_ENGINE off. With the deterministic structure engine on (default),
      the single untagged test line flags a crossExamine window: escalation would
      call `analyzer.runAttributionEscalation` (which these Phase-1 stubs
      deliberately cannot satisfy), and crossExamine's own resolution demotes
      `nova` to the unknown-male bucket. off: these guard tests exercise the
      same pre-structure-engine path they were written against.

   2. minorCastMinLines = 1. `nova` speaks exactly once; the post-stage-2 fold
      (fold-minor-cast.ts) folds any character with line count strictly below
      `minorCastMinLines` (default 3) into the unknown buckets — so a 1-line
      character would be folded even with a fully completed run. We write a
      throwaway user-settings file (pointed at via USER_SETTINGS_FILE) whose
      extra pin flips only this knob. Set at module scope so it lands before the
      lazy `await import('./analysis.js')` inside each test forces
      user-settings.ts to resolve USER_SETTINGS_PATH; test-setup.ts already
      redirects user settings to a throwaway temp file, so this file's override
      stays out of the developer's real settings. */
const settingsTmpDir = mkdtempSync(join(tmpdir(), 'audiobook-rename-midrun-settings-'));
process.env.USER_SETTINGS_FILE = join(settingsTmpDir, 'user-settings.json');
writeFileSync(process.env.USER_SETTINGS_FILE, JSON.stringify({ minorCastMinLines: 1 }));

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-rename-midrun-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.STRUCTURE_ENGINE = '0';
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.STRUCTURE_ENGINE;
  rmSync(settingsTmpDir, { recursive: true, force: true });
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
});

function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
  return { analyzer, engine: 'gemini', model, fallbackModel: null };
}

function buildPhase1Analyzer(): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () => Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
    async runStage2Chapter(_manuscriptId: string, chapterId: number): Promise<Stage2ChapterOutput> {
      return {
        sentences: [
          { id: chapterId * 100 + 1, chapterId, characterId: 'nova', confidence: 0.9, text: CHAPTER_BODY },
        ],
      };
    },
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    /* Escalation no-op (matches analysis.rename-midrun's status quo across
       the suite): degree-zero escalation stub resolution. `attributeChapterStage2`
       calls runAttributionEscalation whenever the structure cross-examination
       flags a window, so a REJECTING stub here crashes the run mid-Phase-1 with
       the stub's own `Error: not used` — pre-empting the book-dir guard's
       STALE_BOOK_DIR terminal halt that these #2196 tests exist to observe. */
    runAttributionEscalation: () => Promise.resolve(null),
  };
}

/* #2165 — a Phase-1 analyzer that FAILS stage-2 attribution, ending the run in
   a real terminal error (state `'halted'`). The #2165 analysis-state test
   asserts the cold-boot snapshot FOLLOWS the rename; that `halted` snapshot is
   only written for a genuine run error. Before srv-59 the run naturally ended
   on a Phase-1 error; once structure+escalation landed, a REJECTING
   runAttributionEscalation stub supplied that error implicitly (and also broke
   the #2196 halt-path tests by crashing before the persist gate). With the
   escalation stub now a no-op, tests that want a halted terminal supply it
   explicitly via this analyzer instead of leaning on the crash. */
function buildFailingPhase1Analyzer(): Analyzer {
  return {
    ...buildPhase1Analyzer(),
    runStage2Chapter: () => Promise.reject(new Error('simulated stage-2 attribution failure')),
  };
}

/* Seeds a workspace book + its in-memory ManuscriptRecord and returns the
   pieces each case needs. Fresh manuscriptId per case so the module-level
   job maps and the manuscript store can't leak between them. */
async function seedRunnableBook(): Promise<{
  manuscriptId: string;
  oldDir: string;
  newDir: string;
  seededCast: string;
  job: AnalysisJob;
  releasePhase0: () => void;
  phase0Selection: AnalyzerSelection;
}> {
  const manuscriptId = `test-rename-midrun-${Date.now()}-${Math.random()}`;
  const oldDir = join(workspaceRoot, 'books', AUTHOR, SERIES, OLD_TITLE);
  const newDir = join(workspaceRoot, 'books', AUTHOR, SERIES, NEW_TITLE);
  /* AUTHOR/SERIES/OLD_TITLE/NEW_TITLE are shared module-level constants, so
     both `it` cases in this file resolve to the same oldDir/newDir paths.
     Without this, the second case's renameWithRetry target already exists (the
     first case's completed run left its book at newDir) and Windows refuses
     a rename onto an existing directory (EPERM) — clean slate per case. */
  rmSync(oldDir, { recursive: true, force: true });
  rmSync(newDir, { recursive: true, force: true });
  mkdirSync(join(oldDir, '.audiobook'), { recursive: true });

  const { makeBookId } = await import('../workspace/paths.js');
  const bookId = makeBookId(AUTHOR, SERIES, OLD_TITLE);
  writeFileSync(
    join(oldDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId,
      title: OLD_TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(oldDir, 'manuscript.md'), `# Chapter One\n\n${CHAPTER_BODY}\n`);
  /* The seed roster deliberately does NOT contain `nova`. `renameWithRetry` below
     carries this file to newDir intact, so "cast.json exists at newDir" is
     true before the run writes anything — a seed containing the analyzer's
     own character would make the whole case a placebo. `seed-marker` is the
     control: only a real merge-base write can put `nova` in this file. */
  const { castJsonPath } = await import('../workspace/paths.js');
  const seededCast = JSON.stringify({
    characters: [
      { id: 'seed-marker', name: 'Seed Marker', role: 'character', color: '#abc', aliases: [] },
    ],
  });
  writeFileSync(castJsonPath(oldDir), seededCast);

  const { putManuscript } = await import('../store/manuscripts.js');
  putManuscript({
    manuscriptId,
    format: 'plaintext',
    title: OLD_TITLE,
    wordCount: 10,
    byteSize: 100,
    uploadedAt: new Date().toISOString(),
    sourceText: CHAPTER_BODY,
    chapterHints: [{ id: 1, title: 'Chapter One', body: CHAPTER_BODY }],
    bookDir: oldDir,
  });

  let releasePhase0!: () => void;
  const phase0Gate = new Promise<void>((resolve) => {
    releasePhase0 = resolve;
  });
  const phase0Analyzer: Analyzer = {
    runStage1: () => Promise.reject(new Error('not used')),
    async runStage1Chapter(): Promise<Stage1ChapterOutput> {
      await phase0Gate;
      /* The evidence quote is required, not decorative: Phase 0b's
         dropEvidencelessCast (analysis.ts) drops any non-narrator character
         with zero surviving evidence, and this run completes past that pass
         before the case reads the final cast.json. The quote must verbatim-
         match CHAPTER_BODY so verifyEvidenceAgainstSource keeps it. */
      return {
        characters: [
          {
            id: 'nova',
            name: 'Nova',
            role: 'character',
            color: '#abc',
            evidence: [{ quote: 'The plan is set.' }],
          },
        ],
      };
    },
    runStage2Chapter: () => Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.resolve(null),
  };

  const job = {
    controller: new AbortController(),
    subscribers: new Set(),
    manuscriptId,
    kind: 'main',
    bookDir: oldDir,
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

  (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection =
    buildSelection(buildPhase1Analyzer(), 'phase1-model');

  return {
    manuscriptId,
    oldDir,
    newDir,
    seededCast,
    job,
    releasePhase0,
    phase0Selection: buildSelection(phase0Analyzer, 'phase0-model'),
  };
}

/* Exactly what book-state.ts:846-858 does: move the folder (with the same
   OneDrive/cloud-sync-friendly retry — a raw sync rename was observed
   flaking with EPERM here under full-suite load, exactly the class of
   transient failure renameWithRetry exists to absorb), then point the
   in-memory record at the new path. */
async function renameLikeBookState(manuscriptId: string, oldDir: string, newDir: string) {
  const { getManuscript, putManuscript } = await import('../store/manuscripts.js');
  await renameWithRetry(oldDir, newDir);
  const rec = getManuscript(manuscriptId)!;
  rec.bookDir = newDir;
  putManuscript(rec);
}

describe('#2165 — a rename that reaches a live analysis run does not resurrect the old directory', () => {
  it(
    "the run's cast.json write follows the rename",
    async () => {
      const seed = await seedRunnableBook();
      const { runMainAnalyzerJob } = await import('./analysis.js');
      const { castJsonPath } = await import('../workspace/paths.js');
      const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';

      let jobPromise: Promise<void> | undefined;
      try {
        jobPromise = runMainAnalyzerJob(
          seed.job,
          getManuscript(seed.manuscriptId)! as never,
          seed.phase0Selection,
          { requestedFresh: false, allowStage1Shrink: true, requestedModel: undefined },
        );
        jobPromise.catch(() => {});

        /* Let the run reach (and hang in) Phase 0. */
        await new Promise((r) => setTimeout(r, 300));
        await renameLikeBookState(seed.manuscriptId, seed.oldDir, seed.newDir);

        seed.releasePhase0();
        await jobPromise.catch(() => {});
      } finally {
        seed.releasePhase0();
        if (jobPromise) await jobPromise.catch(() => {});
        removeManuscript(seed.manuscriptId);
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }

      /* POSITIVE CONTROL FIRST. `renameWithRetry` carried the seeded cast.json to
         newDir, so mere existence there proves nothing — a run that died
         immediately after the rename would satisfy it. These two assertions
         are what prove a merge-base write actually landed at the new path: */
      const after = readFileSync(castJsonPath(seed.newDir), 'utf8');
      expect(after).not.toBe(seed.seededCast);
      expect(
        (JSON.parse(after).characters as Array<{ id: string }>).map((c) => c.id),
      ).toContain('nova');

      /* Per-mechanism assertion — the write did NOT also go to the old path. */
      expect(existsSync(castJsonPath(seed.oldDir))).toBe(false);
      /* Whole-outcome assertion: NOTHING recreated the pre-rename folder. */
      expect(existsSync(seed.oldDir)).toBe(false);
    },
    30_000,
  );

  it(
    "the run's analysis-state.json snapshot follows the rename",
    async () => {
      const seed = await seedRunnableBook();
      const { runMainAnalyzerJob } = await import('./analysis.js');
      const { analysisStateJsonPath } = await import('../workspace/paths.js');
      const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';

      /* This case wants the terminal SNAPSHOT to follow the rename, and a
         `halted` snapshot exists only for a run that ends in a genuine error.
         Give it a Phase-1 analyzer that fails stage-2 attribution (rather than
         leaning on the escalation-stub crash that used to supply the error) so
         the run halts and its `halted` cold-boot snapshot lands at newDir. */
      (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection =
        buildSelection(buildFailingPhase1Analyzer(), 'phase1-model');


      let jobPromise: Promise<void> | undefined;
      try {
        jobPromise = runMainAnalyzerJob(
          seed.job,
          getManuscript(seed.manuscriptId)! as never,
          seed.phase0Selection,
          { requestedFresh: false, allowStage1Shrink: true, requestedModel: undefined },
        );
        jobPromise.catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
        await renameLikeBookState(seed.manuscriptId, seed.oldDir, seed.newDir);

        /* Abort rather than complete: the paused terminal snapshot IGNORES
           the ~5s throttle, so it lands deterministically inside a short
           test — and unlike terminal success it is not immediately deleted. */
        seed.job.controller.abort();
        seed.releasePhase0();
        await jobPromise.catch(() => {});
        /* endJob's snapshot write is fire-and-forget (`void`). */
        await new Promise((r) => setTimeout(r, 400));
      } finally {
        seed.releasePhase0();
        if (jobPromise) await jobPromise.catch(() => {});
        removeManuscript(seed.manuscriptId);
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }

      expect(existsSync(analysisStateJsonPath(seed.newDir))).toBe(true);
      /* POSITIVE CONTROL, and it has to be the STATE, not mere existence.
         `persistRunningSnapshot` fires unthrottled on the first markPhase
         (lastDiskWriteAt starts at 0), so a running snapshot lands at oldDir
         BEFORE the rename and renameWithRetry carries it across — existence
         at newDir is therefore satisfied even with persistTerminalSnapshot
         deleted outright. The running snapshot writes state:'running'; only
         the TERMINAL one writes 'halted' (this run ends on a Phase-1 error,
         not an abort, so it halts rather than pausing). Asserting 'halted' is
         what separates "the terminal snapshot followed the rename" from "some
         earlier file rode along with it". */
      const after = readFileSync(analysisStateJsonPath(seed.newDir), 'utf8');
      expect(JSON.parse(after).state).toBe('halted');

      /* Per-mechanism assertion — the write did NOT also go to the old path. */
      expect(existsSync(analysisStateJsonPath(seed.oldDir))).toBe(false);
      /* Whole-outcome assertion: NOTHING recreated the pre-rename folder. */
      expect(existsSync(seed.oldDir)).toBe(false);
    },
    30_000,
  );
  /* ── #2196 — out-of-process move (the folder moves while the in-memory
        record is left pointing at the dead path). The next book write would
        otherwise `mkdir` the moved-away folder back into existence. ── */

  it(
    '#2196 out-of-tree move: the moved-away folder is never recreated and the run halts (detached fail-loud)',
    async () => {
      const seed = await seedRunnableBook();
      const { runMainAnalyzerJob } = await import('./analysis.js');
      const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';

      /* The #2196 out-of-process move: the folder goes OUTSIDE the workspace
         `books/` root, and the in-memory ManuscriptRecord is left pointing at
         the old (now dead) path — untouched. */
      const escapedParent = join(workspaceRoot, 'escaped');
      mkdirSync(escapedParent, { recursive: true });
      const escapedDir = join(escapedParent, seed.manuscriptId);

      const errorLogs: string[] = [];
      const errorSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
        errorLogs.push(a.map(String).join(' '));
      });

      let jobPromise: Promise<void> | undefined;
      try {
        jobPromise = runMainAnalyzerJob(
          seed.job,
          getManuscript(seed.manuscriptId)! as never,
          seed.phase0Selection,
          { requestedFresh: false, allowStage1Shrink: true, requestedModel: undefined },
        );
        jobPromise.catch(() => {});

        /* Let the run reach (and hang in) Phase 0, then move the folder out. */
        await new Promise((r) => setTimeout(r, 300));
        await renameWithRetry(seed.oldDir, escapedDir);

        seed.releasePhase0();
        await jobPromise.catch(() => {});
      } finally {
        seed.releasePhase0();
        if (jobPromise) await jobPromise.catch(() => {});
        removeManuscript(seed.manuscriptId);
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
        errorSpy.mockRestore();
      }

      /* CORE: nothing recreated the old (moved-away) folder — not the persist
         block, not the running/terminal snapshots, not the rolling
         manuscript-edits / dropped-quotes (C1 + C4). */
      expect(existsSync(seed.oldDir)).toBe(false);
      expect(existsSync(join(seed.oldDir, '.audiobook'))).toBe(false);

      /* V7·1 — the durable detached-run fail-loud: an always-on server error
         naming manuscriptId + STALE_BOOK_DIR. */
      expect(errorLogs.some((l) => l.includes('STALE_BOOK_DIR'))).toBe(true);
      expect(
        errorLogs.some((l) => l.includes('STALE_BOOK_DIR') && l.includes(seed.manuscriptId)),
      ).toBe(true);
    },
    30_000,
  );

  it(
    '#2196 pathless halt DROP: attached terminal SSE is a STALE_BOOK_DIR error (not result) and no halted snapshot is written',
    async () => {
      const seed = await seedRunnableBook();
      const { runMainAnalyzerJob } = await import('./analysis.js');
      const { analysisStateJsonPath } = await import('../workspace/paths.js');
      const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';

      /* An attached subscriber so the run's terminal broadcast is observable. */
      const events: Array<Record<string, unknown>> = [];
      seed.job.subscribers.add({
        keepAlive: { unref() {} } as unknown as ReturnType<typeof setInterval>,
        res: { end() {} } as never,
        send: (p: unknown) => events.push(p as Record<string, unknown>),
      } as never);

      const escapedParent = join(workspaceRoot, 'escaped2');
      mkdirSync(escapedParent, { recursive: true });
      const escapedDir = join(escapedParent, seed.manuscriptId);

      let jobPromise: Promise<void> | undefined;
      try {
        jobPromise = runMainAnalyzerJob(
          seed.job,
          getManuscript(seed.manuscriptId)! as never,
          seed.phase0Selection,
          { requestedFresh: false, allowStage1Shrink: true, requestedModel: undefined },
        );
        jobPromise.catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
        await renameWithRetry(seed.oldDir, escapedDir);

        seed.releasePhase0();
        await jobPromise.catch(() => {});
      } finally {
        seed.releasePhase0();
        if (jobPromise) await jobPromise.catch(() => {});
        removeManuscript(seed.manuscriptId);
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }

      /* The run terminal is the halt, NOT a result broadcast. */
      expect(events.some((e) => e.kind === 'result')).toBe(false);
      expect(events.some((e) => e.kind === 'error' && e.code === 'STALE_BOOK_DIR')).toBe(true);

      /* C1/C4 — the halted snapshot was DROPPED (no valid path), never written
         into the moved-away folder (and that folder not recreated). */
      expect(existsSync(seed.oldDir)).toBe(false);
      expect(existsSync(analysisStateJsonPath(seed.oldDir))).toBe(false);
    },
    30_000,
  );

  it(
    '#2196 in-tree move with a stale record re-hydrates and writes to the new path',
    async () => {
      const seed = await seedRunnableBook();
      const { runMainAnalyzerJob } = await import('./analysis.js');
      const { castJsonPath } = await import('../workspace/paths.js');
      const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';

      let rehydratedBookDir: string | undefined;
      let jobPromise: Promise<void> | undefined;
      try {
        jobPromise = runMainAnalyzerJob(
          seed.job,
          getManuscript(seed.manuscriptId)! as never,
          seed.phase0Selection,
          { requestedFresh: false, allowStage1Shrink: true, requestedModel: undefined },
        );
        jobPromise.catch(() => {});
        await new Promise((r) => setTimeout(r, 300));

        /* Move IN-TREE (still under books/), but do NOT update the in-memory
           record — the guard's slow path must re-hydrate it to the new path
           (C2), and every write must land there. */
        await renameWithRetry(seed.oldDir, seed.newDir);

        seed.releasePhase0();
        await jobPromise.catch(() => {});
        rehydratedBookDir = getManuscript(seed.manuscriptId)?.bookDir;
      } finally {
        seed.releasePhase0();
        if (jobPromise) await jobPromise.catch(() => {});
        removeManuscript(seed.manuscriptId);
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }

      /* The run completed and wrote the authoritative cast to the NEW path. */
      const after = readFileSync(castJsonPath(seed.newDir), 'utf8');
      expect(after).not.toBe(seed.seededCast);
      expect((JSON.parse(after).characters as Array<{ id: string }>).map((c) => c.id)).toContain(
        'nova',
      );

      /* The old path was never recreated. */
      expect(existsSync(seed.oldDir)).toBe(false);

      /* The store record was re-hydrated to the new path (C2). */
      expect(rehydratedBookDir).toBe(seed.newDir);
    },
    30_000,
  );

  it(
    "#2196 cross-book contamination: a stale A-dir holding book B's identity is refused and the run halts",
    async () => {
      const seed = await seedRunnableBook();
      const { runMainAnalyzerJob } = await import('./analysis.js');
      const { castJsonPath, makeBookId } = await import('../workspace/paths.js');
      const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';

      /* Plant a DIFFERENT book's identity in the stale A-dir: the folder still
         exists in-tree at A's path, but its .audiobook/state.json belongs to
         book B. The guard's full identity check must refuse it (R2) and the
         run must halt — no A data can reach it. */
      const foreignManuscriptId = `${seed.manuscriptId}-foreign`;
      const foreignBookId = makeBookId(AUTHOR, SERIES, 'Foreign Book');
      writeFileSync(
        join(seed.oldDir, '.audiobook', 'state.json'),
        JSON.stringify({
          bookId: foreignBookId,
          manuscriptId: foreignManuscriptId,
          title: 'Foreign Book',
          author: AUTHOR,
          series: SERIES,
          seriesPosition: null,
          isStandalone: true,
          manuscriptFile: 'manuscript.md',
          castConfirmed: true,
          chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
          coverGradient: ['#000', '#fff'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );

      const errorLogs: string[] = [];
      const errorSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
        errorLogs.push(a.map(String).join(' '));
      });

      let jobPromise: Promise<void> | undefined;
      try {
        jobPromise = runMainAnalyzerJob(
          seed.job,
          getManuscript(seed.manuscriptId)! as never,
          seed.phase0Selection,
          { requestedFresh: false, allowStage1Shrink: true, requestedModel: undefined },
        );
        jobPromise.catch(() => {});
        await new Promise((r) => setTimeout(r, 300));

        seed.releasePhase0();
        await jobPromise.catch(() => {});
      } finally {
        seed.releasePhase0();
        if (jobPromise) await jobPromise.catch(() => {});
        removeManuscript(seed.manuscriptId);
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
        errorSpy.mockRestore();
      }

      /* No book-A data was written into the foreign-identity dir (R2): the
         seeded cast is untouched and contains no A character. */
      const castAtA = readFileSync(castJsonPath(seed.oldDir), 'utf8');
      expect(castAtA).toBe(seed.seededCast);
      expect(
        (JSON.parse(castAtA).characters as Array<{ id: string }>).map((c) => c.id),
      ).not.toContain('nova');

      /* The full identity check refused it -> run halted (STALE_BOOK_DIR). */
      expect(errorLogs.some((l) => l.includes('STALE_BOOK_DIR'))).toBe(true);
      /* The planted B-dir still exists in-tree (it is not deleted). */
      expect(existsSync(seed.oldDir)).toBe(true);
    },
    30_000,
  );

  it(
    '#2196 TOCTOU (review pass 2): a mid-persist in-tree move that re-resolves to a DIFFERENT dir refuses the terminal state write (halt)',
    async () => {
      const seed = await seedRunnableBook();
      const { assertWriteTargetStable } = await import('./analysis.js');
      const { BookDirUnresolvedError } = await import('../workspace/book-dir-guard.js');
      const { getManuscript, putManuscript, removeManuscript } = await import('../store/manuscripts.js');

      try {
        /* The persist captured `oldDir` as its writeDir (the block-top resolve).
           A mid-persist in-tree move then relocates the book and updates the
           record, so a FRESH identity-gated re-resolve lands on `newDir` — a
           DIFFERENT dir than this persist already wrote to. That must refuse
           the terminal state write (halt), never landing a completed-looking
           state record in a half-migrated pair. */
        const writeDir = seed.oldDir;
        putManuscript({ ...getManuscript(seed.manuscriptId)!, bookDir: seed.newDir });
        await renameWithRetry(seed.oldDir, seed.newDir);

        await expect(assertWriteTargetStable(seed.job, writeDir)).rejects.toBeInstanceOf(
          BookDirUnresolvedError,
        );
      } finally {
        removeManuscript(seed.manuscriptId);
      }
    },
    30_000,
  );

});
