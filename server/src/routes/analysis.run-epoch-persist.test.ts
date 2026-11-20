/* #3437 — a superseded analysis run (a newer run registered for the same manuscript) must
 * END QUIETLY as `aborted` and must not land its state.json write: not be reported as a
 * curated persist failure, and not as a success.
 *
 * Driven end to end against real `runMainAnalyzerJob` / `runSubsetAnalyzerJob`, with the
 * run-epoch bump (what a Start fresh does at registration) injected at two seams:
 *   - BEFORE the planned cast.json persist (`persistPlannedCast` mock) -> the cast write is
 *     dropped (StaleRunEpochError, nothing written), the state.json write is dropped too, and
 *     the parked StaleRunEpochError reaches the top-level catch as `aborted`;
 *   - AFTER the cast.json persist landed, before the state.json step (the cast-id-history step
 *     `dropSupersededIdsReclaimedByLiveCast`) -> only state.json is dropped, nothing is parked,
 *     and the pre-`result` stale check must still end the run as `aborted`.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CharacterOutput,
  SentenceOutput,
  Stage1ChapterOutput,
  Stage2ChapterOutput,
} from '../handoff/schemas.js';
import type { Analyzer, AnalyzerSelection } from '../analyzer/index.js';
import { ANALYSIS_CACHE_VERSION, clearAnalysisCache, saveAnalysisCache } from '../store/analysis-cache.js';
import { putManuscript, removeManuscript, getManuscript, type ChapterHint } from '../store/manuscripts.js';
import { beginRunEpoch, __resetRunEpochsForTests } from '../store/analysis-run-epoch.js';
import type { Response } from '../http.js';

/* Seams. Each fires once, then disarms. */
const seam = vi.hoisted(() => ({
  /** runs inside the `persistPlannedCast` call, before the real persist. */
  beforePersist: null as null | (() => void),
  /** runs at the persist window: after cast.json landed, before the state.json step. */
  afterCastPersist: null as null | (() => void),
}));

vi.mock('../workspace/analysis-cast-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/analysis-cast-io.js')>();
  return {
    ...actual,
    persistPlannedCast: (...a: Parameters<typeof actual.persistPlannedCast>) => {
      const hook = seam.beforePersist;
      seam.beforePersist = null;
      hook?.();
      return actual.persistPlannedCast(...a);
    },
  };
});

vi.mock('../store/cast-id-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/cast-id-history.js')>();
  return {
    ...actual,
    dropSupersededIdsReclaimedByLiveCast: async (bookDir: string, liveIds: string[]) => {
      const hook = seam.afterCastPersist;
      seam.afterCastPersist = null;
      hook?.();
      return actual.dropSupersededIdsReclaimedByLiveCast(bookDir, liveIds);
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
      return actual.selectAnalyzerForPhase(opts as Parameters<typeof actual.selectAnalyzerForPhase>[0]);
    },
    isPerPhaseModelSelectionActive: () => false,
  };
});

const { runMainAnalyzerJob, runSubsetAnalyzerJob } = await import('./analysis.js');
type AnalysisJob = import('./analysis.js').AnalysisJob;

const CHAPTER_BODY = '“Are you sure this will work,” Nova asked.\n\nOlga nodded and looked away.';
const STALE_UPDATED_AT = '2020-01-01T00:00:00.000Z';

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
    { id: chapterId * 100 + 1, chapterId, characterId: 'nova', confidence: 0.9, text: 'Are you sure this will work' },
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
    async runStage2Chapter(_m: string, chapterId: number): Promise<Stage2ChapterOutput> {
      return { sentences: attributionForChapter(chapterId) };
    },
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.reject(new Error('no flagged windows')),
  };
}

function buildSelection(analyzer: Analyzer, model: string): AnalyzerSelection {
  return { analyzer, engine: 'gemini', model, fallbackModel: null, fallbackEngine: null };
}

interface Run {
  events: Array<{ kind?: string; code?: string; message?: string }>;
  logs: string[];
  errors: string[];
  bookDir: string;
  manuscriptId: string;
  read: (name: string) => string | null;
  cleanup: () => Promise<void>;
}

async function runJob(
  label: string,
  kind: 'main' | 'subset',
  /** Armed once the book exists; `read` returns a file's current bytes (null = absent). */
  arm: (ctx: { manuscriptId: string; read: (name: string) => string | null }) => void,
): Promise<Run> {
  const manuscriptId = `test-run-epoch-persist-${label}-${Date.now()}-${Math.random()}`;
  const bookId = `b_run_epoch_persist_${label}`;
  const bookDir = mkdtempSync(join(tmpdir(), `audiobook-run-epoch-persist-${label}-`));
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  const originalCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;
  process.env.STAGE2_COVERAGE_RETRIES = '0';

  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId,
      title: 'Run Epoch Persist Test Book',
      author: 'Test Author',
      series: 'Standalones',
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.md',
      castConfirmed: false,
      chapters: [
        { id: 1, title: 'STALE 1', slug: '01-stale' },
        { id: 2, title: 'STALE 2', slug: '02-stale' },
        { id: 3, title: 'STALE 3', slug: '03-stale' },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: STALE_UPDATED_AT,
      updatedAt: STALE_UPDATED_AT,
    }),
  );

  const chapterHints: ChapterHint[] = [
    { id: 1, title: 'Chapter One', body: CHAPTER_BODY },
    { id: 2, title: 'Chapter Two', body: CHAPTER_BODY },
    { id: 3, title: 'Chapter Three', body: CHAPTER_BODY },
  ];
  putManuscript({
    manuscriptId,
    bookId,
    format: 'plaintext',
    title: 'Run Epoch Persist Test Book',
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
  if (kind === 'subset') {
    await saveAnalysisCache(manuscriptId, {
      version: ANALYSIS_CACHE_VERSION,
      stage1: { characters: stage1Roster(), chapters: chapterHints.map((c) => ({ id: c.id, title: c.title })) },
      chapters: {},
    });
  }

  const read = (name: string): string | null => {
    const p = join(bookDir, '.audiobook', name);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  };

  const events: Run['events'] = [];
  const keepAlive = setInterval(() => {}, 60_000);
  keepAlive.unref();
  const job: AnalysisJob = {
    controller: new AbortController(),
    subscribers: new Set([
      {
        send: (payload: unknown) => {
          events.push(payload as { kind?: string });
        },
        res: { end: () => {} } as unknown as Response,
        keepAlive,
      },
    ]),
    manuscriptId,
    kind,
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
  /* This run registers as the newest run for the manuscript, as `registerJob` does. */
  job.runEpoch = beginRunEpoch(manuscriptId);

  arm({ manuscriptId, read });

  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const recordRef = getManuscript(manuscriptId);
  if (!recordRef) throw new Error('stub manuscript not found');

  if (kind === 'subset') {
    await runSubsetAnalyzerJob(
      job,
      recordRef as never,
      buildSelection(buildPhase0Analyzer(), 'phase0-model'),
      buildSelection(buildPhase1Analyzer(), 'phase1-model'),
      recordRef.chapterHints,
      true,
    );
  } else {
    await runMainAnalyzerJob(job, recordRef as never, buildSelection(buildPhase0Analyzer(), 'phase0-model'), {
      requestedFresh: false,
      allowStage1Shrink: true,
      requestedModel: undefined,
    });
  }

  const logs = logSpy.mock.calls.map((c) => String(c[0]));
  const errors = errorSpy.mock.calls.map((c) => String(c[0]));
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  clearInterval(keepAlive);

  return {
    events,
    logs,
    errors,
    bookDir,
    manuscriptId,
    read,
    cleanup: async () => {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
      rmSync(bookDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      if (originalCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
      else process.env.STAGE2_COVERAGE_RETRIES = originalCoverageRetries;
    },
  };
}

function terminal(run: Run): { kind?: string; code?: string; message?: string } | undefined {
  return [...run.events].reverse().find((e) => e.kind === 'error' || e.kind === 'result');
}

describe('a superseded analysis run ends as aborted and drops its state.json write (#3437)', () => {
  afterEach(() => {
    seam.beforePersist = null;
    seam.afterCastPersist = null;
    __resetRunEpochsForTests();
    delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
  });

  for (const kind of ['main', 'subset'] as const) {
    it(`${kind} job: superseded before the persist -> nothing lands, ends aborted (not a persist failure, not a result)`, async () => {
      const before: Record<string, string | null> = {};
      const run = await runJob(`before-${kind}`, kind, ({ manuscriptId, read }) => {
        seam.beforePersist = () => {
          for (const f of ['cast.json', 'manuscript-edits.json', 'state.json']) before[f] = read(f);
          beginRunEpoch(manuscriptId); // a Start fresh registers here
        };
      });
      try {
        expect(Object.keys(before)).toHaveLength(3); // the seam fired
        const t = terminal(run);
        expect(t?.kind).toBe('error');
        expect(t?.code).toBe('aborted');
        expect(run.events.some((e) => e.kind === 'result')).toBe(false);
        for (const f of ['cast.json', 'manuscript-edits.json', 'state.json']) {
          expect(run.read(f), f).toBe(before[f]);
        }
        expect(run.logs.some((l) => l.includes('dropped stale-run write: persist cast.json'))).toBe(true);
        expect(run.logs.some((l) => /dropped stale-run write: state\.json /.test(l))).toBe(true);
        expect(run.errors.filter((l) => l.includes('failed to persist'))).toEqual([]);
      } finally {
        await run.cleanup();
      }
    });
  }

  it('main job: superseded after the cast.json persist landed -> cast.json written, state.json untouched, ends aborted', async () => {
    const before: Record<string, string | null> = {};
    const run = await runJob('after-main', 'main', ({ manuscriptId, read }) => {
      seam.beforePersist = () => {
        before['cast.json'] = read('cast.json');
        before['state.json'] = read('state.json');
      };
      seam.afterCastPersist = () => {
        beginRunEpoch(manuscriptId);
      };
    });
    try {
      const t = terminal(run);
      expect(t?.kind).toBe('error');
      expect(t?.code).toBe('aborted');
      expect(run.events.some((e) => e.kind === 'result')).toBe(false);
      expect(run.read('cast.json')).not.toBe(before['cast.json']); // the persist landed
      expect(run.read('state.json')).toBe(before['state.json']);
      expect(run.logs.some((l) => /dropped stale-run write: state\.json /.test(l))).toBe(true);
    } finally {
      await run.cleanup();
    }
  });

  it('a current-epoch run still persists and ends with a result', async () => {
    const run = await runJob('current', 'main', () => {});
    try {
      const t = terminal(run);
      expect(t?.kind).toBe('result');
      expect(JSON.parse(run.read('state.json') ?? '{}').chapters.map((c: { title: string }) => c.title)).toEqual([
        'Chapter One',
        'Chapter Two',
        'Chapter Three',
      ]);
      expect(run.logs.some((l) => l.includes('dropped stale-run write'))).toBe(false);
    } finally {
      await run.cleanup();
    }
  });
});
