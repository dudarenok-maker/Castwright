/* #3681 / #3628 — after a restructure renumbers app-made chapter titles, a
   non-fresh re-analysis must surface the titles state.json holds, not the
   ones snapshotted in the cached stage1 chapter list (keyed by the old
   ids), and not the parser's titles after a server restart re-hydrates the
   hints. Shape borrowed from analysis.rename-midrun.test.ts: a real
   workspace-backed book in a tmpdir, the analyzer/GPU mocks that keep
   runMainAnalyzerJob off any real boundary, and a stub Phase-1 analyzer. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import type { Analyzer, AnalyzerSelection } from '../analyzer/index.js';
import type { Stage1ChapterOutput, Stage2ChapterOutput } from '../handoff/schemas.js';
import type { AnalysisJob } from './analysis.js';

vi.mock('./ollama-health.js', () => ({
  detectOllamaDevice: vi.fn(async () => 'cuda'),
  unloadResidentOllama: vi.fn(async () => {}),
}));
vi.mock('../gpu/analyzer-device-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gpu/analyzer-device-state.js')>()),
  setLastKnownAnalyzerDevice: vi.fn(),
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

const AUTHOR = 'Title Source Author';
const SERIES = 'Standalones';
const LINE = '"The plan is set." Silence followed.';
const MANUSCRIPT =
  `# Prologue\n\n${LINE}\n\n# Alpha\n\n${LINE}\n\n# Beta\n\n${LINE}\n\n# Gamma\n\n${LINE}\n`;

let workspaceRoot: string;
const settingsTmpDir = mkdtempSync(join(tmpdir(), 'audiobook-title-source-settings-'));
process.env.USER_SETTINGS_FILE = join(settingsTmpDir, 'user-settings.json');
writeFileSync(process.env.USER_SETTINGS_FILE, JSON.stringify({ minorCastMinLines: 1 }));

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-title-source-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.STRUCTURE_ENGINE = '0';
  await import('./analysis.js');
}, 120_000);

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.STRUCTURE_ENGINE;
  rmSync(settingsTmpDir, { recursive: true, force: true });
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection;
});

function phase1Selection(): AnalyzerSelection {
  const analyzer: Analyzer = {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: (): Promise<Stage1ChapterOutput> => Promise.reject(new Error('not used')),
    async runStage2Chapter(_m: string, chapterId: number): Promise<Stage2ChapterOutput> {
      return {
        sentences: [{ id: chapterId * 100 + 1, chapterId, characterId: 'nova', confidence: 0.9, text: LINE }],
      };
    },
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.resolve(null),
  };
  return { analyzer, engine: 'gemini', model: 'phase1-model', fallbackModel: null, fallbackEngine: null };
}

/* Seeds a 4-chapter analysed book. Chapters 2-4 carry app-made "Chapter N"
   titles (N = position - 1, as an import with an untitled run would have made
   them) flagged `titleSynthesized`; the cached stage1 chapter list snapshots
   those pre-restructure titles. */
async function seedBook(tag: string, chapterTitles: string[]) {
  const title = `Title Source ${tag}`;
  const manuscriptId = `m_title_source_${tag}_${Date.now()}`;
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  const { makeBookId } = await import('../workspace/paths.js');
  const bookId = makeBookId(AUTHOR, SERIES, title);
  writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT);
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
      chapters: chapterTitles.map((t, i) => ({
        id: i + 1,
        title: t,
        slug: `0${i + 1}-x`,
        ...(i > 0 ? { titleSynthesized: true } : {}),
      })),
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  const sentences = [1, 2, 3, 4].map((chapterId) => ({
    id: 1,
    chapterId,
    characterId: 'nova',
    text: LINE,
  }));
  writeFileSync(join(bookDir, '.audiobook', 'manuscript-edits.json'), JSON.stringify({ sentences }));
  const { saveAnalysisCache } = await import('../store/analysis-cache.js');
  await saveAnalysisCache(manuscriptId, {
    stage1: {
      characters: [
        {
          id: 'nova',
          name: 'Nova',
          role: 'character',
          color: '#abc',
          evidence: [{ quote: 'The plan is set.' }],
        },
      ],
      /* The pre-restructure snapshot: ids 2-4 titled "Chapter 1".."Chapter 3". */
      chapters: [
        { id: 1, title: 'Prologue' },
        { id: 2, title: 'Chapter 1' },
        { id: 3, title: 'Chapter 2' },
        { id: 4, title: 'Chapter 3' },
      ],
    },
    chapters: {},
  } as never);
  return { manuscriptId, bookId, bookDir };
}

async function runNonFreshAnalysis(manuscriptId: string): Promise<{ title: string }[]> {
  const { runMainAnalyzerJob } = await import('./analysis.js');
  const { getOrHydrateManuscript } = await import('../store/manuscripts.js');
  const record = (await getOrHydrateManuscript(manuscriptId))!;
  (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection = phase1Selection();
  const events: Array<Record<string, unknown>> = [];
  const job = {
    controller: new AbortController(),
    subscribers: new Set([
      {
        keepAlive: { unref() {} } as unknown as ReturnType<typeof setInterval>,
        res: { end() {} } as never,
        send: (p: unknown) => events.push(p as Record<string, unknown>),
      },
    ]),
    manuscriptId,
    kind: 'main',
    bookDir: record.bookDir,
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
  const prior = process.env.STAGE2_COVERAGE_RETRIES;
  process.env.STAGE2_COVERAGE_RETRIES = '0';
  try {
    await runMainAnalyzerJob(job, record as never, phase1Selection(), {
      requestedFresh: false,
      allowStage1Shrink: true,
      requestedModel: undefined,
    });
  } finally {
    if (prior === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
    else process.env.STAGE2_COVERAGE_RETRIES = prior;
  }
  const result = events.find((e) => e.kind === 'result') as
    | { response: { chapters: { title: string }[] } }
    | undefined;
  expect(result, `no result event: ${JSON.stringify(events.slice(-3))}`).toBeDefined();
  return result!.response.chapters;
}

describe('#3681 — re-analysis surfaces the titles state.json holds', () => {
  it('after a restructure, a non-fresh re-analysis does not serve the stale cached stage1 titles', async () => {
    const { manuscriptId, bookId, bookDir } = await seedBook('restructure', [
      'Prologue',
      'Chapter 1',
      'Chapter 2',
      'Chapter 3',
    ]);
    const { chaptersRestructureRouter } = await import('./chapters-restructure.js');
    const app = express();
    app.use(express.json());
    app.use('/api/books', chaptersRestructureRouter);
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/exclude`)
      .send({ chapterIds: [4], excluded: true });
    expect(res.status).toBe(200);
    const stateTitles = (res.body.chapters as { title: string }[]).map((c) => c.title);
    expect(stateTitles).toEqual(['Prologue', 'Chapter 2', 'Chapter 3', 'Chapter 4']);

    const chapters = await runNonFreshAnalysis(manuscriptId);
    expect(chapters.map((c) => c.title)).toEqual(stateTitles);
    void bookDir;
  }, 60_000);

  it('after a server restart, the re-hydrated hints carry state.json titles into the result', async () => {
    const { manuscriptId } = await seedBook('restart', [
      'Prologue',
      'Chapter 2',
      'Chapter 3',
      'Chapter 4',
    ]);
    const { removeManuscript } = await import('../store/manuscripts.js');
    removeManuscript(manuscriptId); // a restart: the next lookup re-parses the manuscript file

    const chapters = await runNonFreshAnalysis(manuscriptId);
    expect(chapters.map((c) => c.title)).toEqual(['Prologue', 'Chapter 2', 'Chapter 3', 'Chapter 4']);
  }, 60_000);
});
