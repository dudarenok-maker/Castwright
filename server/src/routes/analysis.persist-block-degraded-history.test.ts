/* #2228 — neither analyzer persist block (`runMainAnalyzerJob`'s
   `recordRetirements` / `dropSuperseded*` / `reconcileRejectEdgesOnDisk` /
   `catch (historyErr)` sequence, nor `runSubsetAnalyzerJob`'s mirror of it)
   was stood up end to end by any test in the repo — every fact about how
   that block is WIRED lived only in source-scan tests ([C7]/[C11] in
   analysis-reject-edge-reconcile.test.ts), which cannot fail for the reason
   the behaviour is wrong. #2214/#2201 was exactly that: two individually
   correct changes that were jointly broken, and every unit test stayed
   green because none of them drove the real block, in the real order,
   against a real degraded file.

   This test drives `runMainAnalyzerJob` for real (same stub-analyzer
   machinery analysis.live-id-retire-filter.test.ts / analysis.fresh-cast-
   lock.test.ts use to keep it off a real Ollama/GPU boundary) against a
   book whose cast-id-history.json is already damaged, and checks the
   OUTCOME the ordering exists to guarantee: the degraded read is taken
   before anything rewrites the file, the always-throwing step is reached
   and its throw is caught, the shared user-facing log line fires exactly
   because of that catch, and the damaged file is never laundered — it
   reaches disk afterwards byte-identical to how it was seeded. cast.json's
   own authoritative write (which happens BEFORE the try block) still lands,
   proving the persist wasn't skipped wholesale.

   Kept in its own file — same rationale as the other dedicated
   runMainAnalyzerJob fixture files: this fixture/mock setup shouldn't
   compound analysis.test.ts's already-large hook-timeout budget. */

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
import { clearAnalysisCache } from '../store/analysis-cache.js';
import {
  putManuscript,
  removeManuscript,
  getManuscript,
  type ChapterHint,
} from '../store/manuscripts.js';
import {
  runMainAnalyzerJob,
  DEGRADED_CAST_ID_HISTORY_LOG_MESSAGE,
  type AnalysisJob,
} from './analysis.js';

/* Same three environment mocks analysis.live-id-retire-filter.test.ts /
   analysis.fresh-cast-lock.test.ts use to keep runMainAnalyzerJob off a
   real Ollama / real GPU-cost state and to let the test inject the
   Phase-1 analyzer selection. */
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

const CHAPTER_BODY = '“Are you sure this will work,” Nova asked.\n\nOlga nodded and looked away.';

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

describe('runMainAnalyzerJob persist block — degraded cast-id-history.json (#2228)', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
  });

  it(
    'exercises recordRetirements -> dropSuperseded* -> throw -> catch end to end: emits the shared log line and leaves the damaged file byte-identical',
    async () => {
      const manuscriptId = `test-persist-block-degraded-history-${Date.now()}-${Math.random()}`;
      const bookDir = mkdtempSync(join(tmpdir(), 'audiobook-persist-block-degraded-history-test-'));
      mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';

      writeFileSync(
        join(bookDir, '.audiobook', 'state.json'),
        JSON.stringify({
          bookId: 'b_persist_block_degraded_history_test',
          manuscriptId,
          title: 'Persist Block Degraded History Test Book',
          author: 'Test Author',
          series: 'Standalones',
          seriesPosition: null,
          isStandalone: true,
          manuscriptFile: 'manuscript.md',
          castConfirmed: false,
          chapters: [
            { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
            { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
            { id: 3, title: 'Chapter Three', slug: '03-chapter-three' },
          ],
          coverGradient: ['#000', '#fff'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );

      // No prior cast.json — this is a first-time analysis, so no
      // retirement has anything real to retire. That is deliberate: the
      // ordering under test (recordRetirements -> dropSuperseded* ->
      // reconcileRejectEdgesOnDisk -> catch) runs regardless, because
      // dropSupersededIdsReclaimedByLiveCast reads cast-id-history.json
      // UNCONDITIONALLY once the final cast.json write has happened, not
      // only when there is a retirement to act on.

      const historyPath = join(bookDir, '.audiobook', 'cast-id-history.json');
      // Present but unparseable — same degraded shape
      // analysis-reject-edge-reconcile.test.ts's [C8] uses. The file must
      // exist (an ABSENT file is a legitimate, non-degraded "no history
      // yet" case) but fail to parse.
      const rawHistory = '{invalid json';
      writeFileSync(historyPath, rawHistory);

      const chapterHints: ChapterHint[] = [
        { id: 1, title: 'Chapter One', body: CHAPTER_BODY },
        { id: 2, title: 'Chapter Two', body: CHAPTER_BODY },
        { id: 3, title: 'Chapter Three', body: CHAPTER_BODY },
      ];
      putManuscript({
        manuscriptId,
        format: 'plaintext',
        title: 'Persist Block Degraded History Test Book',
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

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runMainAnalyzerJob(
          job,
          recordRef as never,
          buildSelection(buildPhase0Analyzer(), 'phase0-model'),
          { requestedFresh: false, allowStage1Shrink: true, requestedModel: undefined },
        );

        // The authoritative cast.json write (which happens BEFORE the
        // history try block, in the same persist) still landed — proof the
        // damaged history file didn't abort the persist wholesale, only the
        // history-specific steps inside their own try/catch.
        const castAfter = JSON.parse(
          readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'),
        ) as { characters: Array<{ id: string }> };
        expect(castAfter.characters.map((c) => c.id)).toContain('nova');

        // The damaged file was never laundered — byte-identical to what was
        // seeded. Before #2214 an always-writing step in this same block
        // would have replaced it with a valid, empty file by this point.
        expect(readFileSync(historyPath, 'utf8')).toBe(rawHistory);

        // The shared user-facing log line fired — proof the throw was
        // actually caught by THIS persist block's own catch handler, not
        // swallowed or routed elsewhere.
        const logs = (job.replay as unknown as { logs: Array<{ message?: string }> }).logs;
        const degradedLine = logs.filter((l) => l.message === DEGRADED_CAST_ID_HISTORY_LOG_MESSAGE);
        expect(degradedLine).toHaveLength(1);
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );
});
