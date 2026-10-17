/* #3625 — analysis "Start fresh" un-confirms the book (`castConfirmed: false`)
   with a state.json read-modify-write. That write must hold the per-book
   `state-json` lock (`withStateJsonLock`, #3700), or a concurrent state.json writer's stamp is dropped (or this
   un-confirm is) by whichever atomic rename lands last.

   Two directions, each in its own describe so the lock mock cannot leak:
     1. WAITS ON THE LOCK — the real `withStateJsonLock`, held by the test:
        state.json must still read `castConfirmed: true` while held and flip to
        `false` once released. Removing the site's lock turns the "still
        confirmed while held" assertion red.
     2. FAILS LOUD — `withStateJsonLock` really times out (a queued holder and a
        50ms budget): the job must end through its top-level catch as
        `code: 'lock-contention'` and the workspace path in the lock key must
        never reach the event.

   Fixture setup is copied from analysis.fresh-cast-lock.test.ts; its assertion
   shape deliberately is not (#3022: that test cannot detect removal of its
   cast lock). */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Analyzer, AnalyzerSelection } from '../analyzer/index.js';
import type { Stage1ChapterOutput, Stage2ChapterOutput } from '../handoff/schemas.js';
import type { AnalysisJob } from './analysis.js';

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

/* Passthrough by default; the fail-loud describe swaps in a rejecting
   implementation for its own test and restores it in a finally. */
vi.mock('../workspace/file-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/file-lock.js')>();
  return { ...actual, withStateJsonLock: vi.fn(actual.withStateJsonLock) };
});

const AUTHOR = 'Fresh State Lock Author';
const SERIES = 'Standalones';
const TITLE = 'Fresh State Lock Book';
const CHAPTER_BODY = 'Nova said the plan out loud.';

let workspaceRoot: string;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-fresh-state-lock-test-'));
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
  return { analyzer, engine: 'gemini', model, fallbackModel: null };
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
    runStage1Chapter: () => Promise.reject(new Error('Phase-1 analyzer does not run Phase-0 calls')),
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
  bookDir: string;
  statePath: string;
  runFresh: () => Promise<void>;
  events: Array<Record<string, unknown>>;
  cleanup: () => Promise<void>;
}

/* Seeds a confirmed book + manuscript and returns a runner for a
   `requestedFresh` main job whose Phase 0 hangs on a gate (released in
   cleanup), so the only state.json writer in play is the Start-fresh
   un-confirm under test. */
async function buildFixture(tag: string): Promise<Fixture> {
  const manuscriptId = `test-fresh-state-lock-${tag}-${Date.now()}-${Math.random()}`;
  const title = `${TITLE} ${tag}`;
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  const { makeBookId } = await import('../workspace/paths.js');
  const statePath = join(bookDir, '.audiobook', 'state.json');
  writeFileSync(
    statePath,
    JSON.stringify({
      bookId: makeBookId(AUTHOR, SERIES, title),
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

  const { putManuscript, getManuscript, removeManuscript } = await import(
    '../store/manuscripts.js'
  );
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
    runStage2Chapter: () => Promise.reject(new Error('Phase-0 analyzer does not run Phase-1 calls')),
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.reject(new Error('not used')),
  };
  (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection = buildSelection(
    buildPhase1Analyzer(),
    'phase1-model',
  );

  const events: Array<Record<string, unknown>> = [];
  const job = {
    controller: new AbortController(),
    subscribers: new Set([
      {
        send: (p: unknown) => events.push(p as Record<string, unknown>),
        res: { end: () => {} },
        keepAlive: undefined,
      },
    ]),
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
    bookDir,
    statePath,
    events,
    runFresh: async () => {
      const { runMainAnalyzerJob } = await import('./analysis.js');
      jobPromise = runMainAnalyzerJob(
        job,
        getManuscript(manuscriptId)! as never,
        buildSelection(phase0Analyzer, 'phase0-model'),
        { requestedFresh: true, allowStage1Shrink: true, requestedModel: undefined },
      );
      jobPromise.catch(() => {});
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

const readConfirmed = (statePath: string): boolean =>
  (JSON.parse(readFileSync(statePath, 'utf8')) as { castConfirmed: boolean }).castConfirmed;

describe('#3625 — "Start fresh" un-confirm waits on the state lock', () => {
  it(
    'leaves castConfirmed:true while the state lock is held, then un-confirms on release',
    async () => {
      const fx = await buildFixture('waits');
      const { withStateJsonLock } = await vi.importActual<typeof import('../workspace/file-lock.js')>(
        '../workspace/file-lock.js',
      );
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let acquired!: () => void;
      const acquiredSignal = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const holder = withStateJsonLock(fx.statePath, async () => {
        acquired();
        await held;
      });
      try {
        await acquiredSignal;
        await fx.runFresh();
        /* Give the job a real chance to reach (and, if unlocked, perform) the
           un-confirm: it needs the cast hold, a few rm()s and two journal
           clears first. */
        await new Promise((r) => setTimeout(r, 400));
        expect(readConfirmed(fx.statePath)).toBe(true);

        release();
        await holder;
        await vi.waitFor(() => expect(readConfirmed(fx.statePath)).toBe(false), {
          timeout: 5_000,
          interval: 20,
        });
      } finally {
        release();
        await holder.catch(() => {});
        await fx.cleanup();
      }
    },
    60_000,
  );
});

describe('#3625 — "Start fresh" un-confirm fails loud on a state-lock timeout', () => {
  it(
    'ends the job as lock-contention without leaking the lock key path',
    async () => {
      const fx = await buildFixture('timeout');
      const fileLock = await import('../workspace/file-lock.js');
      const spy = vi.mocked(fileLock.withStateJsonLock);
      const actual = await vi.importActual<typeof import('../workspace/file-lock.js')>(
        '../workspace/file-lock.js',
      );
      const actualImpl = actual.withStateJsonLock;
      spy.mockImplementation(async (p, fn) => {
        if (p !== fx.statePath) return actualImpl(p, fn);
        const holder = actualImpl(p, () => new Promise<void>((r) => setTimeout(r, 300)));
        try {
          return await actualImpl(p, fn, 50);
        } finally {
          await holder;
        }
      });
      try {
        await fx.runFresh();
        await vi.waitFor(() => expect(fx.events.some((e) => e.kind === 'error')).toBe(true), {
          timeout: 10_000,
          interval: 20,
        });
        const err = fx.events.find((e) => e.kind === 'error')!;
        expect(err.code).toBe('lock-contention');
        expect(JSON.stringify(err)).not.toContain('state-json:');
        /* The lock was never acquired, so the un-confirm never landed. */
        expect(readConfirmed(fx.statePath)).toBe(true);
      } finally {
        spy.mockImplementation(actualImpl);
        await fx.cleanup();
      }
    },
    60_000,
  );
});

/* #3625 sweep - the un-confirm's in-lock read recovers a torn state.json from
   .bak.1 instead of throwing (which, fail-loud, would end the job). */
describe('#3625 - "Start fresh" un-confirm recovers a torn state.json', () => {
  it(
    'un-confirms and rewrites the main file whole',
    async () => {
      const fx = await buildFixture('torn');
      const full = readFileSync(fx.statePath, 'utf8');
      writeFileSync(`${fx.statePath}.bak.1`, full);
      writeFileSync(fx.statePath, full.slice(0, 40));
      try {
        await fx.runFresh();
        await vi.waitFor(() => expect(readConfirmed(fx.statePath)).toBe(false), {
          timeout: 5_000,
          interval: 20,
        });
      } finally {
        await fx.cleanup();
      }
    },
    30_000,
  );
});
