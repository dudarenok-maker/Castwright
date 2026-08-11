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

   This file drives `runMainAnalyzerJob` for real twice (same stub-analyzer
   machinery analysis.live-id-retire-filter.test.ts / analysis.fresh-cast-
   lock.test.ts use to keep it off a real Ollama/GPU boundary), against two
   fixtures that each exercise a different slice of the ordering:

   1. A DEGRADED cast-id-history.json, checking the throw/catch half: the
      degraded read is taken before anything rewrites the file, the
      always-throwing step is reached and its throw is caught, the shared
      user-facing log line fires exactly because of that catch, and the
      damaged file is never laundered — it reaches disk afterwards
      byte-identical to how it was seeded. `recordRetirements` is inert in
      this fixture (no prior cast.json, so it returns at its own first line
      — see its own comment); the throw comes from the first step that
      always runs regardless, `dropSupersededIdsReclaimedByLiveCast`.
      cast.json's own authoritative write (which happens BEFORE the try
      block) still lands, proving the persist wasn't skipped wholesale.
   2. A HEALTHY cast-id-history.json plus a stranded `notLinkedTo` edge,
      checking the reconcile half `[C7]`/`[C11]` (analysis-reject-edge-
      reconcile.test.ts) can only source-scan: the block actually reaches
      `reconcileRejectEdgesOnDisk`, which reads the *just-captured*
      pre-persist verdict and the edge is genuinely cleared and reported —
      the one path where that captured verdict is actually consumed.
   3. A TRANSIENT one-shot read failure on cast-id-history.json's very
      first physical read this run, with a genuinely well-formed file
      underneath it (the real-world case the module doc comment names: "a
      transient EPERM/EBUSY from an AV scanner or a cloud-sync client").
      Under the real capture position, the capture eats the blip
      (`historyStatusBeforePersist` = 'degraded') while every read after
      it — including `dropSupersededIdsReclaimedByLiveCast`'s own, which
      would otherwise throw and never reach reconcile at all — sees the
      real, healthy file. This is the ONLY fixture in this file that
      forces apart the two independent defences (#2214's throw and
      #2202/#2214's `historyStatusBeforePersist` ternary): fixtures 1 and 2
      each engage exactly one of them, so moving the capture is invisible
      to both — case 1 never reaches the ternary (the throw fires first
      regardless of capture position) and case 2's file is healthy
      throughout (the ternary is consulted but never disagrees with the
      local read, so a reordering that leaves it consulted at all stays
      green). Case 3 is built so ONLY the capture's own position decides
      which of the two defences — the throw or the ternary — is the one
      that actually saves the edge, which `console.warn`'s wording
      (case-specific: 'reject-edge reconciliation skipped' vs 'failed to
      record character-id retirement(s)') can tell apart even though both
      paths converge on the SAME shared `job.replay.logs` line.

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
import { castIdHistoryPath } from '../store/cast-id-history.js';

/* #2228 fix round 1, F2 — hoisted so case 3 can intercept the SINGLE first
   physical read of cast-id-history.json regardless of which internal caller
   issues it (analysis.ts's own capture, or one of cast-id-history.ts's
   internal mutating helpers) — a real filesystem blip does not know or care
   which logical step asked for the read. Defaults to a pure passthrough;
   case 3 installs a one-shot failing implementation and restores the
   passthrough in its own `finally`. */
vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return { ...actual, readJson: vi.fn(actual.readJson) };
});

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
    'a degraded cast-id-history.json reaching dropSupersededIdsReclaimedByLiveCast throws, is caught, and emits the shared log line, leaving the damaged file byte-identical',
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
        // #2228 fix round 1, F5 — an unset var restored via bare assignment
        // writes the STRING 'undefined' into the worker's env, leaking into
        // every later test in this fork. Guarded shape matches the existing
        // precedent at analysis.merge-base-detect.test.ts's teardown().
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );

  /* #2228 fix round 1, F1/F2 — the degraded fixture above never reaches
     `reconcileRejectEdgesOnDisk` at all: `dropSupersededIdsReclaimedByLiveCast`
     (the always-run step immediately before it) throws first, by construction,
     so [C7]'s "wired into both persists" fact and [C11]'s "captured before the
     rewrites" fact stay unexercised — deleting the `reconcileRejectEdgesOnDisk`
     call, or moving the `historyStatusBeforePersist` capture, leaves the
     degraded case above green either way.

     This fixture reaches reconcile instead: a HEALTHY cast-id-history.json
     (so nothing throws) plus a stranded `notLinkedTo` edge on the prior
     cast.json that survives, unbacked by any `rejectedPairs` entry, onto the
     freshly-persisted roster. `reconcileRejectEdgesOnDisk` is the only step
     in the block that consumes `historyStatusBeforePersist` — this is the one
     path where that capture is actually read, not merely taken. */
  it(
    'a healthy cast-id-history.json with a stranded notLinkedTo edge reaches reconcileRejectEdgesOnDisk and clears it',
    async () => {
      const manuscriptId = `test-persist-block-healthy-history-${Date.now()}-${Math.random()}`;
      const bookDir = mkdtempSync(join(tmpdir(), 'audiobook-persist-block-healthy-history-test-'));
      mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';

      const HEALTHY_BOOK_ID = 'book-nova-healthy-history-test';

      writeFileSync(
        join(bookDir, '.audiobook', 'state.json'),
        JSON.stringify({
          bookId: HEALTHY_BOOK_ID,
          manuscriptId,
          title: 'Persist Block Healthy History Test Book',
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

      // A PRIOR cast.json — 'nova' already exists with a same-book
      // notLinkedTo edge to 'ghost', UNBACKED by any rejectedPairs entry.
      // seedReuseGuardsFromPriorCast (merge-analysis-cast.ts) copies this
      // onto the fresh 'nova' row by id before the final merge write, so it
      // survives onto mergedFinal.characters — the exact shape [C1]
      // (analysis-reject-edge-reconcile.test.ts) removes when reconcile
      // actually runs.
      writeFileSync(
        join(bookDir, '.audiobook', 'cast.json'),
        JSON.stringify({
          characters: [
            {
              id: 'nova',
              name: 'Nova',
              role: 'lead',
              color: '#111111',
              notLinkedTo: [{ bookId: HEALTHY_BOOK_ID, characterId: 'ghost' }],
            },
          ],
        }),
      );

      const historyPath = join(bookDir, '.audiobook', 'cast-id-history.json');
      // Healthy and well-formed, with NO rejectedPairs entry backing the
      // nova/ghost edge above — an unbacked edge, reconcile's [C1] shape.
      writeFileSync(
        historyPath,
        JSON.stringify({ schema: 1, supersededBy: {}, rejectedPairs: [] }),
      );

      const chapterHints: ChapterHint[] = [
        { id: 1, title: 'Chapter One', body: CHAPTER_BODY },
        { id: 2, title: 'Chapter Two', body: CHAPTER_BODY },
        { id: 3, title: 'Chapter Three', body: CHAPTER_BODY },
      ];
      putManuscript({
        manuscriptId,
        format: 'plaintext',
        title: 'Persist Block Healthy History Test Book',
        wordCount: 60,
        byteSize: 600,
        uploadedAt: new Date().toISOString(),
        sourceText: chapterHints.map((c) => c.body).join('\n\n'),
        chapterHints,
        bookDir,
        bookId: HEALTHY_BOOK_ID,
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

        const castAfter = JSON.parse(
          readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'),
        ) as { characters: Array<{ id: string; notLinkedTo?: Array<{ characterId: string }> }> };
        const nova = castAfter.characters.find((c) => c.id === 'nova');
        expect(nova).toBeDefined();
        // The stranded edge is gone — reconcile actually ran and removed it,
        // not merely "was called" in the abstract.
        expect((nova!.notLinkedTo ?? []).some((e) => e.characterId === 'ghost')).toBe(false);

        const logs = (job.replay as unknown as { logs: Array<{ message?: string }> }).logs;
        // The healthy-path "Cleared N stranded..." line reached the run log —
        // proof reconcileRejectEdgesOnDisk was actually called from the
        // persist block ([F1]'s fact) and that its local read plus the
        // captured historyStatusBeforePersist both resolved to non-degraded,
        // letting it proceed past the ternary to the real removal branch
        // ([F2]'s fact — the capture is on the path that is exercised here).
        const clearedLine = logs.filter((l) => l.message?.includes('Cleared') && l.message.includes('ghost'));
        expect(clearedLine).toHaveLength(1);
        // Sanity: the degraded-skip line must NOT fire on a healthy run.
        expect(logs.some((l) => l.message === DEGRADED_CAST_ID_HISTORY_LOG_MESSAGE)).toBe(false);
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );

  /* #2228 fix round 1, F2 — see the file header's case 3 for why cases 1/2
     above cannot discriminate the capture's POSITION: case 1 never reaches
     the ternary at all (the throw fires first, at any capture position) and
     case 2's file is healthy throughout (the ternary is consulted but never
     disagrees with the local read, whatever order it runs in). This fixture
     forces the two independent defences — #2214's throw and the
     `historyStatusBeforePersist` ternary — apart, by injecting a ONE-SHOT
     failure on cast-id-history.json's first physical read, with a
     genuinely well-formed file underneath. At the real capture position that
     read IS the capture, so only the ternary can save the edge — exactly
     [C14]'s point, driven here end to end instead of through a direct call. */
  it(
    'a one-shot transient read failure at the capture is honoured by the ternary even though every later read on the same run succeeds',
    async () => {
      const manuscriptId = `test-persist-block-transient-blip-${Date.now()}-${Math.random()}`;
      const bookDir = mkdtempSync(join(tmpdir(), 'audiobook-persist-block-transient-blip-test-'));
      mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';

      const BLIP_BOOK_ID = 'book-nova-transient-blip-test';

      writeFileSync(
        join(bookDir, '.audiobook', 'state.json'),
        JSON.stringify({
          bookId: BLIP_BOOK_ID,
          manuscriptId,
          title: 'Persist Block Transient Blip Test Book',
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

      writeFileSync(
        join(bookDir, '.audiobook', 'cast.json'),
        JSON.stringify({
          characters: [
            {
              id: 'nova',
              name: 'Nova',
              role: 'lead',
              color: '#111111',
              notLinkedTo: [{ bookId: BLIP_BOOK_ID, characterId: 'ghost' }],
            },
          ],
        }),
      );

      const historyPath = castIdHistoryPath(bookDir);
      // Genuinely well-formed — the blip below is injected at the read
      // layer, not by damaging this file.
      writeFileSync(historyPath, JSON.stringify({ schema: 1, supersededBy: {}, rejectedPairs: [] }));

      const chapterHints: ChapterHint[] = [
        { id: 1, title: 'Chapter One', body: CHAPTER_BODY },
        { id: 2, title: 'Chapter Two', body: CHAPTER_BODY },
        { id: 3, title: 'Chapter Three', body: CHAPTER_BODY },
      ];
      putManuscript({
        manuscriptId,
        format: 'plaintext',
        title: 'Persist Block Transient Blip Test Book',
        wordCount: 60,
        byteSize: 600,
        uploadedAt: new Date().toISOString(),
        sourceText: chapterHints.map((c) => c.body).join('\n\n'),
        chapterHints,
        bookDir,
        bookId: BLIP_BOOK_ID,
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

      const stateIo = await import('../workspace/state-io.js');
      const actualStateIo = await vi.importActual<typeof import('../workspace/state-io.js')>(
        '../workspace/state-io.js',
      );
      let historyReadCount = 0;
      const spy = vi.mocked(stateIo.readJson).mockImplementation(async (path: string) => {
        if (path === historyPath) {
          historyReadCount += 1;
          if (historyReadCount === 1) {
            // The one-shot blip — a transient EBUSY/EPERM, not a damaged
            // file. loadCastIdHistoryWithStatus's own try/catch turns this
            // into a 'degraded' verdict exactly as it would a real one.
            throw new Error('EBUSY: resource busy or locked (simulated transient read blip)');
          }
        }
        return actualStateIo.readJson(path);
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runMainAnalyzerJob(
          job,
          recordRef as never,
          buildSelection(buildPhase0Analyzer(), 'phase0-model'),
          { requestedFresh: false, allowStage1Shrink: true, requestedModel: undefined },
        );

        expect(historyReadCount).toBeGreaterThan(1); // sanity: later reads did happen and succeeded

        const castAfter = JSON.parse(
          readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'),
        ) as { characters: Array<{ id: string; notLinkedTo?: Array<{ characterId: string }> }> };
        const nova = castAfter.characters.find((c) => c.id === 'nova');
        expect(nova).toBeDefined();
        // The ternary honoured the STALE pre-persist verdict, not the
        // now-healthy local read reconcile's own read would otherwise see —
        // the edge survives.
        expect((nova!.notLinkedTo ?? []).some((e) => e.characterId === 'ghost')).toBe(true);

        const logs = (job.replay as unknown as { logs: Array<{ message?: string }> }).logs;
        expect(logs.some((l) => l.message === DEGRADED_CAST_ID_HISTORY_LOG_MESSAGE)).toBe(true);
        expect(logs.some((l) => l.message?.includes('Cleared'))).toBe(false);

        // Which of the two defences actually fired — the wording only
        // reconcile's OWN degraded branch uses (not the catch handler's).
        const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
        expect(warnings.some((w) => w.includes('reject-edge reconciliation skipped'))).toBe(true);
        expect(warnings.some((w) => w.includes('failed to record character-id retirement(s)'))).toBe(
          false,
        );
      } finally {
        warnSpy.mockRestore();
        spy.mockImplementation(actualStateIo.readJson);
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        rmSync(bookDir, { recursive: true, force: true });
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );
});
