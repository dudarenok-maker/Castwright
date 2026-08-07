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

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-rename-midrun-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
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
    runAttributionEscalation: () => Promise.reject(new Error('not used')),
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
    runAttributionEscalation: () => Promise.reject(new Error('not used')),
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
        process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
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
        process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }

      expect(existsSync(analysisStateJsonPath(seed.newDir))).toBe(true);
      expect(existsSync(analysisStateJsonPath(seed.oldDir))).toBe(false);
      expect(existsSync(seed.oldDir)).toBe(false);
    },
    30_000,
  );
});
