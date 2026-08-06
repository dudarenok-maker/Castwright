/* #2040 Wave 2 final review, finding 1(b) — proves the recording boundary's
   live-id filter is WIRED, not merely present.

   Finding 1(a) closed the one producer that could emit a retirement naming a
   live cast id (`remapFreshToPriorIds`). That is exactly what makes 1(b) hard
   to pin: with 1(a) in place there is no production input that reaches the
   filter, so a unit test on `refuseRetirementsOfLiveIds` proves the function
   works and nothing about whether `recordRetirements` ever consults it, or
   whether it is handed the right roster. Eleven tests on this branch have
   looked like they pinned something while a different path produced the same
   observable result; a filter with no driving test would be the twelfth.

   So this file SIMULATES a future 1(a)-shaped regression: `remapFreshToPriorIds`
   is mocked to return precisely the rewrite the real guard now refuses — the
   reviewer's Brann fixture, where 'brann' is still held by a live prior row —
   and asserts the recording boundary refuses it anyway. That is what "defence
   in depth" has to mean operationally: the second layer holds when the first
   one is removed.

   Kept in its own file because the mock is module-scoped: analysis.test.ts's
   remap suites need the real implementation. */

import { describe, it, expect, vi, afterEach } from 'vitest';
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
import { loadCastIdHistory, retireCharacterId } from '../store/cast-id-history.js';
import { runMainAnalyzerJob, type AnalysisJob } from './analysis.js';

/* Same three environment mocks analysis.test.ts uses to keep runMainAnalyzerJob
   off a real Ollama / real GPU-cost state and to let the test inject the
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

/* THE injection. Stands in for a regression that reopens finding 1(a): emit
   `brann -> brann-weir` even though a different, live prior row still holds
   'brann'. Only fires for this file's fixture (a fresh row with id 'brann');
   anything else delegates to the real implementation, so the mock can't
   accidentally become the thing under test. */
vi.mock('../store/remap-fresh-to-prior.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/remap-fresh-to-prior.js')>();
  return {
    ...actual,
    remapFreshToPriorIds: <C extends { id: string }, S extends { characterId: string }>(
      fresh: C[],
      sentences: S[],
      priorCast: ReadonlyArray<{ id: string } & Record<string, unknown>>,
      priorRewrites?: Readonly<Record<string, string>>,
    ) => {
      if (!fresh.some((f) => f.id === 'brann')) {
        return actual.remapFreshToPriorIds(fresh, sentences, priorCast, priorRewrites);
      }
      return {
        characters: fresh.map((c) => (c.id === 'brann' ? { ...c, id: 'brann-weir' } : c)),
        sentences: sentences.map((s) =>
          s.characterId === 'brann' ? { ...s, characterId: 'brann-weir' } : s,
        ),
        rewrites: { brann: 'brann-weir' },
      };
    },
  };
});

const CHAPTER_BODY = '“Are you sure this will work,” Brann asked.\n\nOlga nodded and looked away.';

function stage1Roster(): CharacterOutput[] {
  return [
    { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
    {
      id: 'brann',
      name: 'Brann Weir',
      role: 'lead',
      color: '#111111',
      gender: 'male',
      evidence: [{ quote: 'Brann asked' }],
    },
  ];
}

function attributionForChapter(chapterId: number): SentenceOutput[] {
  return [
    {
      id: chapterId * 100 + 1,
      chapterId,
      characterId: 'brann',
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

describe('runMainAnalyzerJob — the recording boundary refuses a retirement naming a live cast id (#2040 Wave 2 final review, finding 1(b))', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
  });

  it('a bogus remap rewrite reaches recordRetirements and is refused + logged, leaving the unrelated chain intact', async () => {
    const manuscriptId = `test-live-id-filter-${Date.now()}-${Math.random()}`;
    const bookDir = mkdtempSync(join(tmpdir(), 'audiobook-live-id-filter-test-'));
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
    const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';

    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'b_live_id_filter_test',
        manuscriptId,
        title: 'Live Id Filter Test Book',
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
          { id: 'brann', name: 'Brann', voiceState: 'locked', voiceUuid: 'U-brann-1' },
          { id: 'brann-weir', name: 'Brann Weir', voiceState: 'locked', voiceUuid: 'U-brann-weir-2' },
        ],
      }),
    );

    const chapterHints: ChapterHint[] = [
      { id: 1, title: 'Chapter One', body: CHAPTER_BODY },
      { id: 2, title: 'Chapter Two', body: CHAPTER_BODY },
      { id: 3, title: 'Chapter Three', body: CHAPTER_BODY },
    ];
    putManuscript({
      manuscriptId,
      format: 'plaintext',
      title: 'Live Id Filter Test Book',
      wordCount: 100,
      byteSize: 1000,
      uploadedAt: new Date().toISOString(),
      sourceText: chapterHints.map((c) => c.body).join('\n\n'),
      chapterHints,
      bookDir,
    });

    // The unrelated, WORKING chain the collateral repoint would have dragged
    // onto the wrong character.
    await retireCharacterId(bookDir, 'brann-w', 'brann');

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

      /* The injected rewrite DID take effect on the roster — proof the mock
         actually ran and the filter was handed a real bogus retirement,
         rather than this test passing because nothing happened at all. The
         fresh row is persisted under 'brann-weir', and the prior 'brann' row
         is carried forward (voiced), so 'brann' is live in the very roster
         `recordRetirements` filters against. */
      const castAfter = JSON.parse(
        readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'),
      ) as { characters: Array<{ id: string; name: string; lines?: number }> };
      const idsAfter = castAfter.characters.map((c) => c.id);
      expect(idsAfter).toContain('brann');
      expect(idsAfter).toContain('brann-weir');
      expect(castAfter.characters.find((c) => c.id === 'brann-weir')?.lines).toBe(3);

      const history = await loadCastIdHistory(bookDir);
      // The property: the bogus retirement never reached retireCharacterId,
      // so its repoint loop never ran and 'brann-w' still resolves to Brann.
      expect(history.supersededBy).toHaveProperty('brann-w', 'brann');
      expect(history.supersededBy).not.toHaveProperty('brann');

      // …and the refusal was surfaced, not swallowed.
      const logs = (job.replay as unknown as { logs: Array<{ message?: string }> }).logs;
      const refusalLine = logs.find((l) => l.message?.includes('still-live cast id'));
      expect(refusalLine?.message).toContain('brann -> brann-weir');
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
      rmSync(bookDir, { recursive: true, force: true });
      process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
    }
  }, 60_000);
});
