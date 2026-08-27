/* #2015 Task 9 — route-level controls proving analysis.ts actually WIRED the
   cast-merge-base detector into runMainAnalyzerJob / runSubsetAnalyzerJob.

   cast-merge-base.test.ts (Task 2) proves the createCastMergeBase primitive
   is correct in ISOLATION. It cannot prove analysis.ts wired it: that
   markDeleted() is really called in the Start-fresh block, that all five
   cast.json write sites really go through writeChecked, or that the subset
   route got its own reporter/send binding. That wiring is exactly where a
   detector with a ~100%-false-positive rate would still hide — a false
   positive on every run passes every POSITIVE-only test ever written.

   Controls 1-5 drive runMainAnalyzerJob (three of the five write sites:
   interim, stage1, final). Controls 6-7 were added by the independent
   review of Task 5 — the plan as first written drove runMainAnalyzerJob
   only, leaving runSubsetAnalyzerJob's other two write sites (subset-interim,
   subset-final), its OWN reportCastConflict closure, and its OWN `send`
   binding pinned by nothing but a by-hand read. "Verified by review is not
   coverage." */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runMainAnalyzerJob,
  runSubsetAnalyzerJob,
  type AnalysisJob,
  type AnalysisSubscriber,
} from './analysis.js';
import type { Analyzer, AnalyzerSelection, StageCall } from '../analyzer/index.js';
import type {
  CharacterOutput,
  SentenceOutput,
  Stage1ChapterOutput,
  Stage1Output,
  Stage2ChapterOutput,
} from '../handoff/schemas.js';
import { clearAnalysisCache, saveAnalysisCache } from '../store/analysis-cache.js';
import { putManuscript, removeManuscript, getManuscript, type ChapterHint } from '../store/manuscripts.js';
import { castJsonPath, castReuseCarryoverJsonPath } from '../workspace/paths.js';
import { rejectOrphanedPair, castIdHistoryPath } from '../store/cast-id-history.js';

/* Same three hoisted mocks analysis.test.ts / analysis.fresh-cast-lock.test.ts
   need — runMainAnalyzerJob/runSubsetAnalyzerJob must never touch a real
   Ollama/GPU boundary under test. */
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

describe('#2015 Task 9 — route-level cast_merge_base_stale controls', () => {
  /* English tag-anchored dialogue fixture — same shape analysis.test.ts's
     srv-59 Task 11 describe block already uses. The mock Phase-1 analyzer
     misattributes the speech line (proven wrong by the "Anton asked" tag)
     and correctly calls the narration line 'narrator'; low confidences
     (0.42 / 0.33) exercise the real merge/fold path without tripping
     escalation (STAGE2_COVERAGE_RETRIES=0 below keeps it fast). */
  const CHAPTER_BODY = '“Are you sure this will work,” Anton asked.\n\nOlga nodded and looked away.';

  function stage1Roster(): CharacterOutput[] {
    return [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
      {
        id: 'anton',
        name: 'Anton',
        role: 'lead',
        color: '#111111',
        gender: 'male',
        evidence: [{ quote: 'Anton asked' }],
      },
      {
        id: 'olga',
        name: 'Olga',
        role: 'lead',
        color: '#222222',
        gender: 'female',
        evidence: [{ quote: 'Olga nodded' }],
      },
    ];
  }

  function mockAttributionSentences(chapterId: number): SentenceOutput[] {
    return [
      {
        id: chapterId * 100 + 1,
        chapterId,
        characterId: 'olga', // wrong — the tag proves 'anton'; irrelevant to this file
        confidence: 0.42,
        text: 'Are you sure this will work',
      },
      {
        id: chapterId * 100 + 2,
        chapterId,
        characterId: 'narrator',
        confidence: 0.33,
        text: 'Olga nodded and looked away',
      },
    ];
  }

  /* `onChapter` fires synchronously before the stub resolves — the hook
     positive controls use to land a foreign writeFileSync at a precise
     point in the run without racing async fs calls. */
  function buildPhase0Analyzer(onChapter?: (chapterId: number) => void): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      async runStage1Chapter(
        _manuscriptId: string,
        chapterId: number,
      ): Promise<Stage1ChapterOutput> {
        onChapter?.(chapterId);
        return { characters: stage1Roster() };
      },
      runStage2Chapter: () =>
        Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () => Promise.reject(new Error('not used')),
    };
  }

  function buildPhase1Analyzer(onChapter?: (chapterId: number) => void): Analyzer {
    return {
      runStage1: () => Promise.reject(new Error('not used')),
      runStage1Chapter: () =>
        Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
      async runStage2Chapter(
        _manuscriptId: string,
        chapterId: number,
        _prompt: string,
        _call: StageCall,
      ): Promise<Stage2ChapterOutput> {
        onChapter?.(chapterId);
        return { sentences: mockAttributionSentences(chapterId) };
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

  function setPhase1Selection(sel: AnalyzerSelection): void {
    (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection = sel;
  }
  function clearPhase1Selection(): void {
    delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
  }
  afterEach(() => {
    clearPhase1Selection();
  });

  function makeBookDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'audiobook-merge-base-detect-test-'));
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    return dir;
  }

  function seedStateJson(
    bookDir: string,
    manuscriptId: string,
    extra: Record<string, unknown> = {},
  ): void {
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'b_merge_base_detect_test',
        manuscriptId,
        title: 'Merge Base Detect Test Book',
        author: 'Test Author',
        series: 'Standalones',
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.md',
        castConfirmed: false,
        // Three chapters — mandatory for the multi-chapter negative controls:
        // two of the five write sites (interim, subset-interim) sit inside
        // per-chapter loops, so a single-chapter run executes each site once
        // and cannot observe a stale-baseline false positive at all.
        chapters: [
          { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
          { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
          { id: 3, title: 'Chapter Three', slug: '03-chapter-three' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...extra,
      }),
    );
  }

  function buildStubChapters(): ChapterHint[] {
    return [
      { id: 1, title: 'Chapter One', body: CHAPTER_BODY },
      { id: 2, title: 'Chapter Two', body: CHAPTER_BODY },
      { id: 3, title: 'Chapter Three', body: CHAPTER_BODY },
    ];
  }

  function registerManuscript(manuscriptId: string, bookDir: string, bookId?: string): ChapterHint[] {
    const chapterHints = buildStubChapters();
    putManuscript({
      manuscriptId,
      format: 'plaintext',
      title: 'Merge Base Detect Test Book',
      wordCount: 100,
      byteSize: 1000,
      uploadedAt: new Date().toISOString(),
      sourceText: chapterHints.map((c) => c.body).join('\n\n'),
      chapterHints,
      bookDir,
      ...(bookId ? { bookId } : {}),
    });
    return chapterHints;
  }

  function readCast(bookDir: string): {
    characters: Array<{ id: string } & Record<string, unknown>>;
  } {
    return JSON.parse(readFileSync(castJsonPath(bookDir), 'utf8'));
  }

  function seedCastJson(bookDir: string, characters: Array<Record<string, unknown>>): void {
    writeFileSync(castJsonPath(bookDir), JSON.stringify({ characters }, null, 2));
  }

  /* A subscriber-backed job. Deliberately does NOT read job.replay.warnings
     after the run — that Map dedupes by code (proven in the "warning
     replay" describe block in analysis.test.ts: five conflicting sites
     replay as ONE advisory), which is exactly the blind spot the "exactly
     one" controls below need to avoid. A raw subscriber sees every LIVE
     broadcastToJob call, undeduped. */
  function makeJob(
    onEvent: (ev: unknown) => void,
    opts: {
      manuscriptId: string;
      bookDir: string;
      kind?: 'main' | 'subset';
      subsetChapterIds?: number[];
    },
  ): AnalysisJob {
    const job = {
      controller: new AbortController(),
      subscribers: new Set(),
      manuscriptId: opts.manuscriptId,
      kind: opts.kind ?? 'main',
      subsetChapterIds: opts.subsetChapterIds,
      bookDir: opts.bookDir,
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
    job.subscribers.add({ send: onEvent } as unknown as AnalysisSubscriber);
    return job;
  }

  /* Fix round 1 (independent review, Important finding 1) — a zero-warnings
     assertion is VACUOUS unless the run actually reached a merge-base write.
     runMainAnalyzerJob swallows every top-level failure into
     endJob(job, {kind:'error'}) (analysis.ts ~5123-5161), and both interim
     write sites additionally swallow their own throws (:3739, :5743) — none
     of that surfaces as a 'warning' event, so warningCodes(events).toEqual([])
     would pass just as trivially for a run that died before any write as for
     one where the detector correctly found nothing to report. This helper is
     what stops that: cast.json on disk afterwards must carry THIS run's own
     detected roster. 'narrator' never appears in any of THIS helper's callers'
     seed fixtures (they seed 'stale' / 'foreign' / 'carried') — control 5
     below does seed a 'narrator' row, but it never calls this helper and has
     its own bookDir, so the two never collide — and narrator always speaks
     in CHAPTER_BODY's second sentence (survives the non-speaker-drop pass
     unlike 'olga'), so its presence is a positive, run-specific signal that a
     write actually landed — not proof merely that the job returned. */
  function assertRunWroteRoster(bookDir: string): void {
    const ids = readCast(bookDir).characters.map((c) => c.id);
    expect(ids).toContain('narrator');
  }

  function warningCodes(events: unknown[]): Array<string | undefined> {
    return events
      .filter((ev) => (ev as { kind?: string }).kind === 'warning')
      .map((ev) => (ev as { code?: string }).code);
  }

  async function teardown(
    manuscriptId: string,
    bookDir: string,
    originalRetries: string | undefined,
  ): Promise<void> {
    removeManuscript(manuscriptId);
    await clearAnalysisCache(manuscriptId);
    rmSync(bookDir, { recursive: true, force: true });
    if (originalRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
    else process.env.STAGE2_COVERAGE_RETRIES = originalRetries;
  }

  it(
    /* #2015 — the most important test in the change. A detector with a
       ~100% false-positive rate passes every positive-only test ever
       written: asserting only that a real conflict is caught cannot
       distinguish a working detector from one that fires unconditionally.
       Fresh is mandatory too — it is the shape that killed design 3 (a
       baseline pinned at capture would be invalidated by the Start-fresh
       delete's own markDeleted() reset if that reset were missing or wrong,
       reporting a conflict on every single fresh run with zero concurrent
       writers). A pre-existing cast.json is seeded so the delete + reset
       actually has a real sha256 to transition away from — an empty book
       captures fingerprint:null from the start (source: 'none'), which
       would make markDeleted() a no-op and prove nothing. */
    'control 1 — an uncontended multi-chapter Start-fresh run emits ZERO stale warnings (route-level, main)',
    async () => {
      const manuscriptId = `test-merge-base-fresh-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalRetries = process.env.STAGE2_COVERAGE_RETRIES;
      // Fix round 1 (Minor) — setup that can throw (registerManuscript,
      // saveAnalysisCache, etc.) now lives INSIDE the try, alongside the env
      // var mutation. Previously both ran before the try: a throw there would
      // skip `finally` entirely, leaking the env var override and the tmpdir
      // into whichever sibling test runs next in the same fork.
      try {
        process.env.STAGE2_COVERAGE_RETRIES = '0';
        seedStateJson(bookDir, manuscriptId);
        seedCastJson(bookDir, [{ id: 'stale', name: 'Stale', role: 'minor', color: '#999999' }]);
        registerManuscript(manuscriptId, bookDir);

        const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
        const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model');
        setPhase1Selection(phase1Selection);

        const events: unknown[] = [];
        const job = makeJob((ev) => events.push(ev), { manuscriptId, bookDir });

        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: true,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        expect(warningCodes(events)).toEqual([]);
        assertRunWroteRoster(bookDir);
      } finally {
        await teardown(manuscriptId, bookDir, originalRetries);
      }
    },
    30_000,
  );

  it(
    /* Covers the `sha256` baseline path (control 1 covers the ABSENT path):
       a real prior cast.json, requestedFresh:false, no Start-fresh delete —
       the baseline never touches markDeleted() at all on this run. */
    'control 2 — an uncontended multi-chapter NON-fresh run emits ZERO stale warnings (route-level, main)',
    async () => {
      const manuscriptId = `test-merge-base-nonfresh-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalRetries = process.env.STAGE2_COVERAGE_RETRIES;
      try {
        process.env.STAGE2_COVERAGE_RETRIES = '0';
        seedStateJson(bookDir, manuscriptId);
        seedCastJson(bookDir, [{ id: 'stale', name: 'Stale', role: 'minor', color: '#999999' }]);
        registerManuscript(manuscriptId, bookDir);

        const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
        const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model');
        setPhase1Selection(phase1Selection);

        const events: unknown[] = [];
        const job = makeJob((ev) => events.push(ev), { manuscriptId, bookDir });

        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: false,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        expect(warningCodes(events)).toEqual([]);
        assertRunWroteRoster(bookDir);
      } finally {
        await teardown(manuscriptId, bookDir, originalRetries);
      }
    },
    30_000,
  );

  it(
    /* The positive control: a foreign writer lands between two of this
       run's OWN writes. Asserts EXACTLY one warning, not "at least one" —
       "at least one" cannot fail for a detector that fires on every
       remaining write site, which is precisely the regression the
       baseline-advance rule (cast-merge-base.ts) exists to prevent. A run
       that reports a conflict has, by definition, reached a write — no
       separate disk assertion is needed here the way it is for the
       zero-warnings controls above. */
    "control 3 — a foreign write between two of this run's own writes reports EXACTLY one stale warning (route-level, main)",
    async () => {
      const manuscriptId = `test-merge-base-positive-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalRetries = process.env.STAGE2_COVERAGE_RETRIES;
      try {
        process.env.STAGE2_COVERAGE_RETRIES = '0';
        seedStateJson(bookDir, manuscriptId);
        seedCastJson(bookDir, [{ id: 'stale', name: 'Stale', role: 'minor', color: '#999999' }]);
        registerManuscript(manuscriptId, bookDir);

        const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
        /* The foreign write is injected inside the Phase-1 (attribution)
           analyzer's FIRST call. The sequential-stub watermark
           (pipelinedPerPhase is forced false by the select-analyzer mock
           above) gates every Phase-1 chapter dispatch behind
           watermark.markPhase0AllDone(), which analysis.ts only calls AFTER
           the 'stage1' write (analysis.ts ~3948) has already landed — so
           this always lands strictly between the run's own 'stage1' write
           and its 'final' write, regardless of Phase-1's own internal
           dispatch order. */
        let injected = false;
        const phase1Selection = buildSelection(
          buildPhase1Analyzer(() => {
            if (!injected) {
              injected = true;
              seedCastJson(bookDir, [{ id: 'foreign' }]);
            }
          }),
          'phase1-model',
        );
        setPhase1Selection(phase1Selection);

        const events: unknown[] = [];
        const job = makeJob((ev) => events.push(ev), { manuscriptId, bookDir });

        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: false,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        expect(warningCodes(events)).toEqual(['cast_merge_base_stale']);
      } finally {
        await teardown(manuscriptId, bookDir, originalRetries);
      }
    },
    30_000,
  );

  it(
    /* fingerprint: null disables detection rather than reporting a false
       conflict. A carryover-sourced run (no cast.json, only a
       cast-reuse-carryover.json — srv-13) captures fingerprint: null from
       readPriorCastForMerge's 'carryover' branch, so castBase.enabled is
       false for the WHOLE run — a foreign write mid-run must produce zero
       warnings, not a false conflict. */
    'control 4 — a carryover-sourced run emits ZERO warnings even against a foreign write mid-run (detection disabled)',
    async () => {
      const manuscriptId = `test-merge-base-carryover-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalRetries = process.env.STAGE2_COVERAGE_RETRIES;
      try {
        process.env.STAGE2_COVERAGE_RETRIES = '0';
        seedStateJson(bookDir, manuscriptId);
        // No cast.json — only the reuse-carryover snapshot.
        writeFileSync(
          castReuseCarryoverJsonPath(bookDir),
          JSON.stringify(
            { characters: [{ id: 'carried', name: 'Carried', role: 'minor', color: '#abcabc' }] },
            null,
            2,
          ),
        );
        registerManuscript(manuscriptId, bookDir);

        const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
        let injected = false;
        const phase1Selection = buildSelection(
          buildPhase1Analyzer(() => {
            if (!injected) {
              injected = true;
              seedCastJson(bookDir, [{ id: 'foreign' }]);
            }
          }),
          'phase1-model',
        );
        setPhase1Selection(phase1Selection);

        const events: unknown[] = [];
        const job = makeJob((ev) => events.push(ev), { manuscriptId, bookDir });

        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: false,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        expect(warningCodes(events)).toEqual([]);
        /* Fix round 1 (Important finding 2) — this control previously had
           ZERO execution evidence of its own: it stays green under both
           mutations by design, asserts only an empty array, and never
           touched disk. As written it could not distinguish "detection
           correctly disabled" from "the run errored", "the foreign write
           never landed", or "no write site was reached". This is the
           route-level's only pin on the fingerprint:null third state, so it
           needs its own proof the run actually reached a write — not just
           that the (vacuous) zero-warnings assertion above happened to
           hold. */
        assertRunWroteRoster(bookDir);
      } finally {
        await teardown(manuscriptId, bookDir, originalRetries);
      }
    },
    30_000,
  );

  it(
    /* srv-13 carry-forward, unchanged by this branch — the 2026-07-14
       Coalfall voice-strip invariant. Mirrors analysis.test.ts's
       "fresh re-analysis PRESERVES designed voices…" assertions rather than
       inventing new ones. */
    'control 5 — fresh re-analysis PRESERVES designed voices while dropping reuse continuity (route-level)',
    async () => {
      const manuscriptId = `test-merge-base-voice-preserve-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalRetries = process.env.STAGE2_COVERAGE_RETRIES;
      try {
        process.env.STAGE2_COVERAGE_RETRIES = '0';
        seedStateJson(bookDir, manuscriptId, { castConfirmed: true });
        seedCastJson(bookDir, [
          {
            id: 'narrator',
            name: 'Narrator',
            voiceUuid: 'U-narr',
            ttsEngine: 'qwen',
            overrideTtsVoices: {
              qwen: {
                name: 'qwen-U-narr',
                variants: { excited: { name: 'qwen-U-narr__excited' } },
              },
            },
            voiceId: 'some-library-voice',
            voiceState: 'reused',
            matchedFrom: { bookId: 'prior', characterId: 'narrator', confidence: 0.9 },
          },
        ]);
        registerManuscript(manuscriptId, bookDir);

        const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
        const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model');
        setPhase1Selection(phase1Selection);

        const events: unknown[] = [];
        const job = makeJob((ev) => events.push(ev), { manuscriptId, bookDir });

        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: true,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        const narr = readCast(bookDir).characters.find((c) => c.id === 'narrator') as
          | (Record<string, unknown> & { id: string })
          | undefined;
        expect(narr).toBeDefined();
        expect(narr!.overrideTtsVoices).toEqual({
          qwen: {
            name: 'qwen-U-narr',
            variants: { excited: { name: 'qwen-U-narr__excited' } },
          },
        });
        expect(narr!.voiceUuid).toBe('U-narr');
        expect(narr!.ttsEngine).toBe('qwen');
        expect(narr!.matchedFrom).toBeUndefined();
        expect(narr!.voiceId).toBeUndefined();
      } finally {
        await teardown(manuscriptId, bookDir, originalRetries);
      }
    },
    30_000,
  );

  it(
    /* #2015 addendum (Task 5 review) — runSubsetAnalyzerJob carries its own
       two write sites (subset-interim, subset-final), its own
       reportCastConflict, and its own `send` binding. Nothing above drives
       it; this is the subset negative control. */
    'control 6 — an uncontended subset run emits ZERO stale warnings (route-level, subset)',
    async () => {
      const manuscriptId = `test-merge-base-subset-negative-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalRetries = process.env.STAGE2_COVERAGE_RETRIES;
      try {
        process.env.STAGE2_COVERAGE_RETRIES = '0';
        seedStateJson(bookDir, manuscriptId);
        seedCastJson(bookDir, [{ id: 'stale', name: 'Stale', role: 'minor', color: '#999999' }]);
        const chapterHints = registerManuscript(manuscriptId, bookDir);

        // Pre-seed cache.stage1 so the subset route takes the "book already
        // fully analysed" branch (stage1Existed === true) — the only branch
        // that reaches the subset-final write site at all.
        const stage1: Stage1Output = {
          characters: stage1Roster(),
          chapters: chapterHints.map((c) => ({ id: c.id, title: c.title })),
        };
        await saveAnalysisCache(manuscriptId, { chapters: {}, stage1 });

        const selection = buildSelection(buildPhase0Analyzer(), 'phase0-model-subset');
        const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model-subset');

        const events: unknown[] = [];
        const job = makeJob((ev) => events.push(ev), {
          manuscriptId,
          bookDir,
          kind: 'subset',
          subsetChapterIds: chapterHints.map((c) => c.id),
        });

        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runSubsetAnalyzerJob(
          job,
          recordRef as never,
          selection,
          phase1Selection,
          recordRef.chapterHints,
          false,
        );

        expect(warningCodes(events)).toEqual([]);
        assertRunWroteRoster(bookDir);
      } finally {
        await teardown(manuscriptId, bookDir, originalRetries);
      }
    },
    30_000,
  );

  it(
    /* The subset positive control — and the one that would catch a reporter
       closing over the wrong `send` binding (a silent misdelivery nothing
       else in this branch tests): asserts the warning arrives via THIS
       job's own captured `events`, not merely that some warning fired
       somewhere.

       The subset Phase-0a loop is a plain sequential `for` (no pool), so
       the first chapter's subset-interim write always lands strictly before
       the second chapter's own analyzer call — injecting on the SECOND call
       deterministically lands the foreign write between two of this run's
       own writes. A run that reports a conflict has, by definition, reached
       a write — no separate disk assertion is needed here the way it is for
       the zero-warnings controls above. */
    "control 7 — a foreign write mid-run reports EXACTLY one warning on the subset job's own send (route-level, subset)",
    async () => {
      const manuscriptId = `test-merge-base-subset-positive-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const originalRetries = process.env.STAGE2_COVERAGE_RETRIES;
      try {
        process.env.STAGE2_COVERAGE_RETRIES = '0';
        seedStateJson(bookDir, manuscriptId);
        seedCastJson(bookDir, [{ id: 'stale', name: 'Stale', role: 'minor', color: '#999999' }]);
        const chapterHints = registerManuscript(manuscriptId, bookDir);

        const stage1: Stage1Output = {
          characters: stage1Roster(),
          chapters: chapterHints.map((c) => ({ id: c.id, title: c.title })),
        };
        await saveAnalysisCache(manuscriptId, { chapters: {}, stage1 });

        let calls = 0;
        const selection = buildSelection(
          buildPhase0Analyzer(() => {
            calls += 1;
            if (calls === 2) {
              seedCastJson(bookDir, [{ id: 'foreign' }]);
            }
          }),
          'phase0-model-subset',
        );
        const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model-subset');

        const events: unknown[] = [];
        const job = makeJob((ev) => events.push(ev), {
          manuscriptId,
          bookDir,
          kind: 'subset',
          subsetChapterIds: chapterHints.map((c) => c.id),
        });

        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runSubsetAnalyzerJob(
          job,
          recordRef as never,
          selection,
          phase1Selection,
          recordRef.chapterHints,
          false,
        );

        expect(warningCodes(events)).toEqual(['cast_merge_base_stale']);
      } finally {
        await teardown(manuscriptId, bookDir, originalRetries);
      }
    },
    30_000,
  );

  /* #2694 — the run's OWN out-of-band writers (`clearNotLinkedEdgesForDroppedRejections`
     via `recordRetirements`, `reconcileRejectEdgesOnDisk`) desynchronise the
     baseline when they write cast.json without advancing it, and the NEXT
     `writeChecked` then reports a foreign conflict that never happened.
     #2185's existing negative controls above (1/2/4/6) pass VACUOUSLY against
     this bug — none of their fixtures ever drives a dropped-self-loop
     rejection, so none of them ever reaches `clearNotLinkedEdgesForDroppedRejections`'s
     write at all. This fixture is built specifically to reach it:

       - 'anton' and 'anton_dup' share a name, so `dedupePriorCastByName`
         folds 'anton_dup' into 'anton' and reports retirement
         {from:'anton_dup', to:'anton'} — recorded by the INTERIM
         `recordRetirements` call, well before any `writeChecked` runs.
       - cast-id-history.json is pre-seeded (via `rejectOrphanedPair`) with
         rejectedPair {from:'anton', to:'anton_dup'} — a prior "anton is not
         anton_dup" decision. Repointing THAT pair through the retirement
         above collides `to` back onto `from` ('anton' -> 'anton'), a dropped
         self-loop (mirrors cast-id-history.test.ts's M2 test).
       - 'olga' carries a `notLinkedTo` edge naming 'anton' for this book, so
         `clearNotLinkedEdgesForDroppedRejections` has a real edge to clear —
         a genuine read-modify-write of cast.json, entirely this run's own,
         through a path that (pre-fix) never told the baseline about it. */
  function seedSelfLoopDropFixture(bookDir: string, bookId: string): void {
    seedCastJson(bookDir, [
      { id: 'anton', name: 'Anton', role: 'lead', color: '#111111' },
      { id: 'anton_dup', name: 'Anton', role: 'lead', color: '#222222' },
      {
        id: 'olga',
        name: 'Olga',
        role: 'lead',
        color: '#333333',
        notLinkedTo: [{ bookId, characterId: 'anton' }],
      },
    ]);
  }

  function readCastIdHistoryRejectedPairs(
    bookDir: string,
  ): Array<{ from: string; to: string }> {
    const history = JSON.parse(readFileSync(castIdHistoryPath(bookDir), 'utf8')) as {
      rejectedPairs?: Array<{ from: string; to: string }>;
    };
    return history.rejectedPairs ?? [];
  }

  it(
    /* The regression test proper. Red before tasks 1-4 (recorded verbatim in
       the PR body): the interim `recordRetirements` call folds 'anton_dup'
       into 'anton', drops the self-loop rejectedPair, and
       `clearNotLinkedEdgesForDroppedRejections` clears olga's stale edge —
       a real write the pre-fix baseline never learns about, so the next
       `writeChecked` (the 'stage1' write) reports a phantom
       `cast_merge_base_stale`. Green after: `noteExternalWrite` advances the
       baseline to match, so nothing downstream reports a conflict. */
    "control 8 — an uncontended run whose OWN dropped-self-loop cleanup emits ZERO stale warnings (route-level, main)",
    async () => {
      const manuscriptId = `test-merge-base-selfloop-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const bookId = 'b_merge_base_detect_test';
      const originalRetries = process.env.STAGE2_COVERAGE_RETRIES;
      try {
        process.env.STAGE2_COVERAGE_RETRIES = '0';
        seedStateJson(bookDir, manuscriptId);
        seedSelfLoopDropFixture(bookDir, bookId);
        await rejectOrphanedPair(bookDir, 'anton', 'anton_dup');
        registerManuscript(manuscriptId, bookDir, bookId);

        const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
        const phase1Selection = buildSelection(buildPhase1Analyzer(), 'phase1-model');
        setPhase1Selection(phase1Selection);

        const events: unknown[] = [];
        const job = makeJob((ev) => events.push(ev), { manuscriptId, bookDir });

        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: false,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        /* Fix round 1 reasoning applied here too — a zero-warnings assertion
           is vacuous unless the fixture actually reached the dropped-
           self-loop write. Confirm the self-loop rejectedPair really was
           dropped (proves `recordRetirements` -> `retireCharacterId` ->
           `clearNotLinkedEdgesForDroppedRejections` all fired), THEN assert
           on the outcome that matters. */
        expect(readCastIdHistoryRejectedPairs(bookDir)).toEqual([]);
        /* Further anti-vacuity: the notLinkedTo edge must have actually been
           cleared from disk. If the write never happened, olga's notLinkedTo
           would still contain the rejected edge. This pins that
           `clearNotLinkedEdgesForDroppedRejections` was wired and executed. */
        const cast = readCast(bookDir);
        const olga = cast.characters.find((c) => c.id === 'olga');
        expect(olga?.notLinkedTo ?? []).toEqual([]);
        expect(warningCodes(events)).toEqual([]);
        assertRunWroteRoster(bookDir);
      } finally {
        await teardown(manuscriptId, bookDir, originalRetries);
      }
    },
    30_000,
  );

  it(
    /* The symmetric positive control the brief requires: without it, "zero
       advisories" from control 8 would be equally satisfiable by a fix that
       broke detection outright (e.g. `noteExternalWrite` unconditionally
       swallowing every write regardless of provenance). A GENUINE foreign
       write, injected the same way control 3 does, must still be reported —
       exactly once — even in a run that ALSO takes the self-loop-drop path
       above. */
    "control 9 — a genuine foreign write alongside a self-loop-drop cleanup still reports EXACTLY one stale warning (route-level, main)",
    async () => {
      const manuscriptId = `test-merge-base-selfloop-foreign-${Date.now()}-${Math.random()}`;
      const bookDir = makeBookDir();
      const bookId = 'b_merge_base_detect_test';
      const originalRetries = process.env.STAGE2_COVERAGE_RETRIES;
      try {
        process.env.STAGE2_COVERAGE_RETRIES = '0';
        seedStateJson(bookDir, manuscriptId);
        seedSelfLoopDropFixture(bookDir, bookId);
        await rejectOrphanedPair(bookDir, 'anton', 'anton_dup');
        registerManuscript(manuscriptId, bookDir, bookId);

        const phase0Selection = buildSelection(buildPhase0Analyzer(), 'phase0-model');
        // Same injection point + reasoning as control 3: lands strictly
        // between this run's own 'stage1' write and its 'final' write.
        let injected = false;
        const phase1Selection = buildSelection(
          buildPhase1Analyzer(() => {
            if (!injected) {
              injected = true;
              seedCastJson(bookDir, [{ id: 'foreign' }]);
            }
          }),
          'phase1-model',
        );
        setPhase1Selection(phase1Selection);

        const events: unknown[] = [];
        const job = makeJob((ev) => events.push(ev), { manuscriptId, bookDir });

        const recordRef = getManuscript(manuscriptId);
        if (!recordRef) throw new Error('stub manuscript not found');

        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: false,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        expect(readCastIdHistoryRejectedPairs(bookDir)).toEqual([]);
        /* Same anti-vacuity check as control 8: the notLinkedTo edge must have
           been cleared despite the genuine foreign write. This proves the run
           wired the write despite the injection injection. */
        const cast = readCast(bookDir);
        const olga = cast.characters.find((c) => c.id === 'olga');
        expect(olga?.notLinkedTo ?? []).toEqual([]);
        expect(warningCodes(events)).toEqual(['cast_merge_base_stale']);
      } finally {
        await teardown(manuscriptId, bookDir, originalRetries);
      }
    },
    30_000,
  );
});
