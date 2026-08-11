/* #2110 — full-chain regression: retirement -> target dropped by a
   re-analysis -> re-create by name, driven through the REAL production
   pieces (runMainAnalyzerJob, the same job function POST /analyze invokes,
   and the real POST /:bookId/cast/create route via supertest), not a
   hand-rolled helper.

   The hazard: `cast-id-history.json` holds `{anton: 'антон'}` from an
   earlier retirement — 'антон' is live but unvoiced. A later re-analysis's
   carry-forward only re-adds voiced/reused survivors and the id-drift
   name-fallback only fires when a same-name fresh row exists to retire
   onto — with neither, 'антон' vanishes with NO retirement ever recorded,
   and the alias dangles. Nothing looks wrong (`buildCastResolver` already
   skips a history entry whose target isn't live) until a LATER character is
   created named "Антон" and mints the exact dead target id again — at which
   point the dangling raw key 'anton' would silently resolve (tier 2) onto
   the brand-new, unrelated row, hijacking every segment the original alias
   covered, with no orphan report at all.

   This file needs BOTH `runMainAnalyzerJob` (bookDir-only, no workspace
   scan) AND the real `castCreateRouter`, which resolves its book via
   `findBookByBookId` — a `workspace/paths.js`-BOOKS_ROOT-based scan whose
   root is a module-load-time constant. So (mirroring cast-create.test.ts)
   `process.env.WORKSPACE_DIR` is set BEFORE anything that could touch
   `workspace/paths.js` is imported — every value import that transitively
   reaches it is therefore a DYNAMIC import inside `beforeAll`, after the env
   var is set; only `import type` (erased at compile time, never touches the
   module graph) and node/express/vitest/supertest builtins are static. */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import type {
  CharacterOutput,
  SentenceOutput,
  Stage1ChapterOutput,
  Stage2ChapterOutput,
} from '../handoff/schemas.js';
import type { Analyzer, AnalyzerSelection, StageCall } from '../analyzer/index.js';
import type { AnalysisJob } from './analysis.js';
import type { ChapterHint } from '../store/manuscripts.js';
import type { CastResolution } from '../store/cast-resolve.js';

/* Same three environment mocks analysis.test.ts / analysis.live-id-retire-
   filter.test.ts use to keep runMainAnalyzerJob off a real Ollama / real
   GPU-cost state, and to let the test inject the Phase-1 analyzer
   selection. `vi.mock` is hoisted above every import (static or dynamic) by
   the vitest transform, so this applies to `analysis.js` even though it is
   loaded dynamically below. */
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

const AUTHOR = 'Dangling Target Author';
const SERIES = 'Standalones';
const TITLE = 'Dangling Target Book';

/* Same proven-not-to-escalate dialogue-tag shape the Task 8/10/14 fixtures
   in analysis.test.ts use ("X asked" — a named tag the dialogue-structure
   engine can cross-examine against, so it never calls
   `runAttributionEscalation`, which the phase-1 stub below doesn't
   implement). Two characters this run: the narrator and 'olga', a normal
   speaking character with no connection to the dying alias — given THREE
   quoted lines (`foldMinorCast`'s `MIN_LINES_DEFAULT`) so she clears the
   background-fold threshold and survives under her own id, letting the
   fixture exercise a real multi-character merge rather than a
   single-row edge case. */
const CHAPTER_BODY =
  '“Are you sure this will work,” Olga asked.\n\n“I think so,” Olga said.\n\n“Let us try, then,” Olga added.\n\nThe house had stood empty since the fire.';

function stage1RosterForChapter(): CharacterOutput[] {
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

function mockAttributionSentencesForChapter(chapterId: number): SentenceOutput[] {
  return [
    {
      id: chapterId * 100 + 1,
      chapterId,
      characterId: 'olga',
      confidence: 0.9,
      text: 'Are you sure this will work',
    },
    {
      id: chapterId * 100 + 2,
      chapterId,
      characterId: 'olga',
      confidence: 0.9,
      text: 'I think so',
    },
    {
      id: chapterId * 100 + 3,
      chapterId,
      characterId: 'olga',
      confidence: 0.9,
      text: 'Let us try, then',
    },
    {
      id: chapterId * 100 + 4,
      chapterId,
      characterId: 'narrator',
      confidence: 0.9,
      text: 'The house had stood empty since the fire',
    },
  ];
}

function buildPhase0Analyzer(): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    async runStage1Chapter(): Promise<Stage1ChapterOutput> {
      return { characters: stage1RosterForChapter() };
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
      return { sentences: mockAttributionSentencesForChapter(chapterId) };
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

let workspaceRoot: string;
let bookDir: string;
let bookId: string;
let app: Express;

let runMainAnalyzerJob: typeof import('./analysis.js').runMainAnalyzerJob;
let putManuscript: typeof import('../store/manuscripts.js').putManuscript;
let getManuscript: typeof import('../store/manuscripts.js').getManuscript;
let removeManuscript: typeof import('../store/manuscripts.js').removeManuscript;
let clearAnalysisCache: typeof import('../store/analysis-cache.js').clearAnalysisCache;
let loadCastIdHistory: typeof import('../store/cast-id-history.js').loadCastIdHistory;
let retireCharacterId: typeof import('../store/cast-id-history.js').retireCharacterId;
let buildCastResolver: typeof import('../store/cast-resolve.js').buildCastResolver;
let castJsonPath: typeof import('../workspace/paths.js').castJsonPath;
let makeBookId: typeof import('../workspace/paths.js').makeBookId;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-dangling-target-e2e-'));
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
  const resolveMod = await import('../store/cast-resolve.js');
  const pathsMod = await import('../workspace/paths.js');
  const createMod = await import('./cast-create.js');

  runMainAnalyzerJob = analysisMod.runMainAnalyzerJob;
  putManuscript = manuscriptsMod.putManuscript;
  getManuscript = manuscriptsMod.getManuscript;
  removeManuscript = manuscriptsMod.removeManuscript;
  clearAnalysisCache = cacheMod.clearAnalysisCache;
  loadCastIdHistory = historyMod.loadCastIdHistory;
  retireCharacterId = historyMod.retireCharacterId;
  buildCastResolver = resolveMod.buildCastResolver;
  castJsonPath = pathsMod.castJsonPath;
  makeBookId = pathsMod.makeBookId;

  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });

  app = express();
  app.use(express.json());
  app.use('/api/books', createMod.castCreateRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function seedStateJson(): void {
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'placeholder', // overwritten per-test before use
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
}

function seedPriorCastWithDyingAnton(): void {
  writeFileSync(
    castJsonPath(bookDir),
    JSON.stringify({
      characters: [
        { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
        {
          id: 'антон',
          name: 'Антон',
          role: 'character',
          color: 'unset',
          voiceState: 'generated',
        },
      ],
    }),
  );
}

function registerManuscript(manuscriptId: string): ChapterHint[] {
  const chapterHints: ChapterHint[] = [{ id: 1, title: 'Chapter One', body: CHAPTER_BODY }];
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
  (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection = sel;
}
function clearPhase1Selection(): void {
  delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
}

describe('#2110 — dangling supersededBy target: retirement -> re-analysis drops the target -> re-create by name', () => {
  it(
    'prunes the dangling alias at the authoritative write, so re-creating the dead target by name does not silently hijack the old alias',
    async () => {
      const manuscriptId = `test-dangling-target-e2e-${Date.now()}-${Math.random()}`;
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';

      seedStateJson();
      seedPriorCastWithDyingAnton();
      // The pre-existing retirement: an earlier run/repair recorded 'anton'
      // as superseded by 'антон'. 'антон' is still live but unvoiced.
      await retireCharacterId(bookDir, 'anton', 'антон');
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

        // Step 1: re-analysis (the REAL job runner, same one POST /analyze
        // invokes) — the fresh roster never mentions 'антон', and it is
        // unvoiced, so the carry-forward loop drops it with NO retirement
        // ever recorded for the drop itself.
        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: false,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        // Sanity check on the fixture: 'антон' really did vanish from the
        // persisted roster (if this fails, the scenario never fired and
        // everything below would be vacuous).
        const castAfterAnalysis = JSON.parse(readFileSync(castJsonPath(bookDir), 'utf8')) as {
          characters: Array<{ id: string }>;
        };
        const idsAfterAnalysis = castAfterAnalysis.characters.map((c) => c.id);
        expect(idsAfterAnalysis).not.toContain('антон');
        expect(idsAfterAnalysis).toContain('narrator');
        expect(idsAfterAnalysis).toContain('olga');

        // Step 2 (the fix under test): the dangling 'anton' -> 'антон' entry
        // is pruned at this exact authoritative write, not left to rot.
        const historyAfterAnalysis = await loadCastIdHistory(bookDir);
        expect(historyAfterAnalysis.supersededBy).not.toHaveProperty('anton');
        expect(historyAfterAnalysis.displaced).toEqual({ anton: 'антон' });
        expect(
          job.replay.logs.some(
            (l) =>
              l.message.includes('Dropped 1 history alias') &&
              l.message.includes('anton -> антон') &&
              l.message.includes('target no longer exists'),
          ),
        ).toBe(true);

        // Step 3: re-create by name, through the REAL cast/create route —
        // mints exactly 'антон' again (Unicode-preserving kebab, no
        // collision suffix since neither existingIds nor historyKeys
        // contain it after the prune).
        const createRes = await request(app)
          .post(`/api/books/${bookId}/cast/create`)
          .set('Content-Type', 'application/json')
          .send({ name: 'Антон' });
        expect(createRes.status).toBe(200);
        expect(createRes.body.character.id).toBe('антон');

        // Step 4 (the actual hazard #2110 describes): build the resolver
        // against the final on-disk state and confirm the legacy 'anton'
        // id does NOT silently resolve onto the brand-new, unrelated
        // 'антон' row. Without the prune, 'anton' -> 'антон' would still be
        // in supersededBy, and tier 2 (raw history) would match it straight
        // onto the new row.
        const finalCast = JSON.parse(readFileSync(castJsonPath(bookDir), 'utf8')) as {
          characters: Array<{ id: string }>;
        };
        const finalHistory = await loadCastIdHistory(bookDir);
        const resolver = buildCastResolver(finalCast.characters, finalHistory);
        const resolved: CastResolution | undefined = resolver.resolve('anton');
        expect(resolved).toBeUndefined();
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        clearPhase1Selection();
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );

  /* C1 (fix round, #2163) — the hazard the review found one tier up from
     #2110's own fix: pruning `anton -> антон` out of `supersededBy` frees
     the raw KEY 'anton' unless something else keeps it reserved.
     `dropSupersededTargetsNoLongerLive` moves it into `displaced`
     specifically so `POST /cast/create`'s taken-set can still see it — but
     only if that route actually reads `displaced`. Before the C1 fix it
     didn't, so re-creating by the id's OWN spelling ("Anton", not the safe
     "Антон" direction the test above covers) minted the bare 'anton' id
     again, and `buildCastResolver` then resolved 'anton' via the 'exact'
     tier — the one tier `segments-io.ts` treats as "rendered bytes are
     fine, nothing to report" (#2107), so the hijack this whole prune exists
     to prevent would have produced no orphan row, no chip, and no
     `repair-cast-id-drift.mjs` listing at all. */
  it(
    'a later re-create spelled like the pruned id itself must not mint the bare id and hijack the original alias (C1)',
    async () => {
      const manuscriptId = `test-dangling-target-e2e-c1-${Date.now()}-${Math.random()}`;
      const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
      process.env.STAGE2_COVERAGE_RETRIES = '0';

      seedStateJson();
      seedPriorCastWithDyingAnton();
      // Same pre-existing retirement as the test above: 'anton' -> 'антон',
      // 'антон' live but unvoiced.
      await retireCharacterId(bookDir, 'anton', 'антон');
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

        // Step 1: same re-analysis as the safe-direction test — drops the
        // dangling 'антон' row and prunes 'anton' -> 'антон' into
        // `displaced`.
        await runMainAnalyzerJob(job, recordRef as never, phase0Selection, {
          requestedFresh: false,
          allowStage1Shrink: true,
          requestedModel: undefined,
        });

        const historyAfterAnalysis = await loadCastIdHistory(bookDir);
        expect(historyAfterAnalysis.supersededBy).not.toHaveProperty('anton');
        expect(historyAfterAnalysis.displaced).toEqual({ anton: 'антон' });

        // Step 2 (the actual C1 hazard): re-create by the ORIGINAL id's own
        // spelling ("Anton", not "Антон") — must NOT mint the bare 'anton'
        // id. That key is still what every segment rendered under the old
        // alias carries; `displaced` exists precisely to keep it reserved.
        const createRes = await request(app)
          .post(`/api/books/${bookId}/cast/create`)
          .set('Content-Type', 'application/json')
          .send({ name: 'Anton' });
        expect(createRes.status).toBe(200);
        expect(createRes.body.character.id).not.toBe('anton');

        // Step 3: the legacy 'anton' id must not resolve onto the new row
        // via the 'exact' tier — the one tier segments-io.ts treats as
        // "rendered bytes are fine, nothing to report" (#2107's ruling:
        // only 'exact' means that; the other three tiers all list).
        const finalCast = JSON.parse(readFileSync(castJsonPath(bookDir), 'utf8')) as {
          characters: Array<{ id: string }>;
        };
        const finalHistory = await loadCastIdHistory(bookDir);
        const resolver = buildCastResolver(finalCast.characters, finalHistory);
        const resolved: CastResolution | undefined = resolver.resolve('anton');
        expect(resolved?.via).not.toBe('exact');
      } finally {
        removeManuscript(manuscriptId);
        await clearAnalysisCache(manuscriptId);
        clearPhase1Selection();
        if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
        else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
      }
    },
    60_000,
  );
});
