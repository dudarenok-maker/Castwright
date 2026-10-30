/* #3784 (PR #3775 review pass 6, P6-6) — the book-state slice PUT checks the
   manuscript revision and writes manuscript-edits.json inside `withBookLock`.
   That is atomic only against writers that hold the same lock, so every
   analysis writer of manuscript-edits.json takes it too: the interim rolls, the
   terminal persist and Start fresh's delete. Unlocked, one of them can land
   between the PUT's check and its write, and the PUT then overwrites the
   analysis result (or recreates the file Start fresh just removed).

   Two shapes, each driving `runMainAnalyzerJob` for real:
     1. Start fresh WAITS ON THE LOCK — the real `withBookLock`, held by the
        test: manuscript-edits.json must still exist while it is held and be
        gone once released.
     2. Every edits write in a completed run happens UNDER the lock — the
        terminal persist cannot be isolated with a held lock (the interim roll
        before it would block the run first), so `withBookLock` is wrapped to
        mark its holders and the ordered write records whether its caller was
        one. The last write recorded is the terminal persist.

   Fixture setup is copied from analysis.fresh-state-lock.test.ts. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Analyzer, AnalyzerSelection } from '../analyzer/index.js';
import type { Stage1ChapterOutput, Stage2ChapterOutput } from '../handoff/schemas.js';
import type { AnalysisJob } from './analysis.js';

const { heldBooks, editsWrites } = vi.hoisted(() => ({
  heldBooks: { als: null as unknown as AsyncLocalStorage<ReadonlySet<string>> },
  editsWrites: [] as Array<{ path: string; held: ReadonlySet<string> }>,
}));
heldBooks.als = new AsyncLocalStorage<ReadonlySet<string>>();

vi.mock('../workspace/book-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/book-lock.js')>();
  return {
    ...actual,
    withBookLock: <T>(bookId: string, fn: () => Promise<T>): Promise<T> =>
      actual.withBookLock(bookId, () =>
        heldBooks.als.run(new Set([...(heldBooks.als.getStore() ?? []), bookId]), fn),
      ),
  };
});
vi.mock('../workspace/ordered-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/ordered-write.js')>();
  return {
    ...actual,
    writeJsonAtomicOrdered: (path: string, value: unknown): Promise<void> => {
      if (path.endsWith('manuscript-edits.json')) {
        editsWrites.push({ path, held: heldBooks.als.getStore() ?? new Set() });
      }
      return actual.writeJsonAtomicOrdered(path, value);
    },
  };
});

const { detectOllamaDeviceMock, setLastKnownAnalyzerDeviceMock } = vi.hoisted(() => ({
  detectOllamaDeviceMock: vi.fn(async (): Promise<'cuda' | 'cpu' | 'unknown'> => 'cuda'),
  setLastKnownAnalyzerDeviceMock: vi.fn(),
}));
vi.mock('./ollama-health.js', () => ({
  detectOllamaDevice: detectOllamaDeviceMock,
  unloadResidentOllama: vi.fn(async () => {}),
}));
vi.mock('../gpu/analyzer-device-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gpu/analyzer-device-state.js')>()),
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

const AUTHOR = 'Edits Book Lock Author';
const SERIES = 'Standalones';
const TITLE = 'Edits Book Lock Book';
const CHAPTER_BODY = 'Nova said the plan out loud.';

let workspaceRoot: string;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-edits-book-lock-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
});
/* Warm the cold `./analysis.js` import once, with a generous budget. */
beforeAll(async () => {
  await import('./analysis.js');
}, 120_000);
afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
  return { analyzer, engine: 'gemini', model, fallbackModel: null, fallbackEngine: null };
}
afterEach(() => {
  delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
  editsWrites.length = 0;
});

function buildPhase1Analyzer(): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () =>
      Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
    async runStage2Chapter(_m: string, chapterId: number): Promise<Stage2ChapterOutput> {
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
    runAttributionEscalation: () => Promise.reject(new Error('not used')),
  };
}

interface Fixture {
  bookId: string;
  editsPath: string;
  run: (fresh: boolean) => Promise<void>;
  jobDone: () => Promise<void>;
  releasePhase0: () => void;
  cleanup: () => Promise<void>;
}

/* Seeds a book with an existing manuscript-edits.json and returns a runner for
   a main job whose Phase 0 waits on a gate (`releasePhase0`). */
async function buildFixture(tag: string): Promise<Fixture> {
  const manuscriptId = `test-edits-book-lock-${tag}-${Date.now()}-${Math.random()}`;
  const title = `${TITLE} ${tag}`;
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  const { makeBookId } = await import('../workspace/paths.js');
  const bookId = makeBookId(AUTHOR, SERIES, title);
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId,
      title,
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
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [{ id: 'nova', name: 'Nova', role: 'character', color: '#abc', aliases: [] }],
    }),
  );
  const editsPath = join(bookDir, '.audiobook', 'manuscript-edits.json');
  writeFileSync(
    editsPath,
    JSON.stringify({ sentences: [{ id: 1, chapterId: 1, characterId: 'nova', text: 'old' }] }),
  );

  const { putManuscript, getManuscript, removeManuscript } =
    await import('../store/manuscripts.js');
  putManuscript({
    manuscriptId,
    format: 'plaintext',
    title,
    wordCount: 10,
    byteSize: 100,
    uploadedAt: new Date().toISOString(),
    sourceText: CHAPTER_BODY,
    chapterHints: [{ id: 1, title: 'Chapter One', body: CHAPTER_BODY }],
    bookDir,
    bookId,
  });

  let releasePhase0!: () => void;
  const phase0Gate = new Promise<void>((resolve) => {
    releasePhase0 = resolve;
  });
  const phase0Analyzer: Analyzer = {
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
  (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection = buildSelection(
    buildPhase1Analyzer(),
    'phase1-model',
  );

  const job = {
    controller: new AbortController(),
    subscribers: new Set([{ send: () => {}, res: { end: () => {} }, keepAlive: undefined }]),
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

  const originalRetries = process.env.STAGE2_COVERAGE_RETRIES;
  process.env.STAGE2_COVERAGE_RETRIES = '0';
  let jobPromise: Promise<void> | undefined;
  return {
    bookId,
    editsPath,
    releasePhase0: () => releasePhase0(),
    run: async (fresh: boolean) => {
      const { runMainAnalyzerJob } = await import('./analysis.js');
      jobPromise = runMainAnalyzerJob(
        job,
        getManuscript(manuscriptId)! as never,
        buildSelection(phase0Analyzer, 'phase0-model'),
        { requestedFresh: fresh, allowStage1Shrink: true, requestedModel: undefined },
      );
      jobPromise.catch(() => {});
    },
    jobDone: async () => {
      await jobPromise;
    },
    cleanup: async () => {
      releasePhase0();
      if (jobPromise) await jobPromise.catch(() => {});
      removeManuscript(manuscriptId);
      if (originalRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
      else process.env.STAGE2_COVERAGE_RETRIES = originalRetries;
    },
  };
}

describe('#3784 — Start fresh deletes manuscript-edits.json under the book lock', () => {
  it('leaves manuscript-edits.json in place while the book lock is held, then removes it', async () => {
    const fx = await buildFixture('fresh');
    const { withBookLock } = await vi.importActual<typeof import('../workspace/book-lock.js')>(
      '../workspace/book-lock.js',
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const acquiredSignal = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holder = withBookLock(fx.bookId, async () => {
      acquired();
      await held;
    });
    try {
      await acquiredSignal;
      await fx.run(true);
      /* Give the job a real chance to reach (and, if unlocked, perform) the
           delete: it needs the cast hold and two cast-file rm()s first. */
      await new Promise((r) => setTimeout(r, 400));
      expect(existsSync(fx.editsPath)).toBe(true);

      release();
      await holder;
      await vi.waitFor(() => expect(existsSync(fx.editsPath)).toBe(false), {
        timeout: 5_000,
        interval: 20,
      });
    } finally {
      release();
      await holder.catch(() => {});
      await fx.cleanup();
    }
  }, 60_000);
});

describe('#3784 — every analysis write of manuscript-edits.json holds the book lock', () => {
  it('the interim roll and the terminal persist both write under withBookLock(bookId)', async () => {
    const fx = await buildFixture('persist');
    try {
      fx.releasePhase0();
      await fx.run(false);
      await fx.jobDone();
      expect(editsWrites.length).toBeGreaterThanOrEqual(2);
      const unlocked = editsWrites
        .map((w, i) => ({ i, of: editsWrites.length, held: w.held.has(fx.bookId) }))
        .filter((w) => !w.held);
      /* The last entry is the terminal persist; the earlier ones the rolls. */
      expect(unlocked).toEqual([]);
    } finally {
      await fx.cleanup();
    }
  }, 60_000);
});
