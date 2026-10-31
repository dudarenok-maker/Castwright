/* Plan 290 (#3837) — the stale-evidence marker `sentencesPredateChapters`.

   One fixture: an analysed book merged before #3703 — state.json has 3
   chapters, the manuscript still has 4 headings, no manuscript-hints.json, and
   manuscript-edits.json holds distinct evidence keyed to the old 3 ids. On main
   that book is refused by count/id at Start and at merge; the remedy is
   re-parse.

   - set (M23): re-parse / replace-manuscript set the marker when saved
     sentences survive; the edits file is untouched.
   - clear (M25): a main analysis persist clears it; a subset persist and an
     attribution_drift main run leave it set.
   - a stale client's PUT /state slice save keeps it.
   - re-parse -> restart -> Start / merge answer 200, as main does: with the
     marker set the seams use main's rule (M24: ignoring it refuses the
     old-keyed evidence on score, the 409 loop re-parse cannot escape).
   - once a main run has cleared it, a hand-made reorder is refused at Start
     (M25).
   - re-parse -> exclude -> Start -> Start (M26): the restructure clears the
     analysis cache instead of re-seeding the old-keyed takes.

   Analyzer harness copied from analysis.title-flags.test.ts. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
      if (opts.phase === 'phase0' && g.__analyzer_device_test_phase0_selection) {
        return g.__analyzer_device_test_phase0_selection;
      }
      return actual.selectAnalyzerForPhase(
        opts as Parameters<typeof actual.selectAnalyzerForPhase>[0],
      );
    },
    isPerPhaseModelSelectionActive: () => false,
  };
});

const AUTHOR = 'Stale Evidence Author';
const SERIES = 'Standalones';
/* A distinct evidence sentence per manuscript heading (>= 24 chars). */
const lineFor = (n: number) =>
  `"The plan is set." Silence followed by ${['rain', 'snow', 'wind', 'fog'][n - 1] ?? `weather ${n}`}.`;

/* Four headings; the pre-#3703 merge folded Alpha + Beta into one state chapter. */
const MANUSCRIPT = `# Prologue\n\nIt began.\n\n${lineFor(1)}\n\n# Alpha\n\nIt began.\n\n${lineFor(2)}\n\n# Beta\n\nIt began.\n\n${lineFor(3)}\n\n# Gamma\n\nIt began.\n\n${lineFor(4)}\n`;
const MERGED_CHAPTERS = [{ title: 'Prologue' }, { title: 'Alpha', titleOverridden: true }, { title: 'Gamma' }];
/* Evidence keyed to the OLD 3 ids: old chapter 2 holds both merged bodies. */
const OLD_KEYED_SENTENCES = [
  { id: 1, chapterId: 1, characterId: 'nova', text: lineFor(1) },
  { id: 1, chapterId: 2, characterId: 'nova', text: lineFor(2) },
  { id: 2, chapterId: 2, characterId: 'nova', text: lineFor(3) },
  { id: 1, chapterId: 3, characterId: 'nova', text: lineFor(4) },
];

let workspaceRoot: string;
const settingsTmpDir = mkdtempSync(join(tmpdir(), 'audiobook-stale-evidence-settings-'));
process.env.USER_SETTINGS_FILE = join(settingsTmpDir, 'user-settings.json');
writeFileSync(process.env.USER_SETTINGS_FILE, JSON.stringify({ minorCastMinLines: 1 }));

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-stale-evidence-test-'));
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
  delete (globalThis as Record<string, unknown>).__analyzer_device_test_phase0_selection;
});

type Stage2 = (chapterId: number) => Stage2ChapterOutput;
const honestStage2: Stage2 = (chapterId) => ({
  sentences: [{ id: chapterId * 100 + 1, chapterId, characterId: 'nova', confidence: 0.9, text: lineFor(chapterId) }],
});
/* attributionDriftExceeded judges only a take of 100+ sentences; an unknown id demotes. */
const driftStage2: Stage2 = (chapterId) => ({
  sentences: Array.from({ length: 120 }, (_, k) => ({
    id: chapterId * 1000 + k + 1,
    chapterId,
    characterId: 'ghost',
    confidence: 0.9,
    text: `${lineFor(chapterId)} (${k})`,
  })),
});

function phase1Selection(stage2: Stage2 = honestStage2): AnalyzerSelection {
  const analyzer: Analyzer = {
    runStage1: () => Promise.reject(new Error('not used')),
    async runStage1Chapter(): Promise<Stage1ChapterOutput> {
      return {
        characters: [
          { id: 'nova', name: 'Nova', role: 'character', color: '#abc', evidence: [{ quote: 'The plan is set.' }] },
        ],
      } as Stage1ChapterOutput;
    },
    async runStage2Chapter(_m: string, chapterId: number): Promise<Stage2ChapterOutput> {
      return stage2(chapterId);
    },
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.resolve(null),
  };
  return { analyzer, engine: 'gemini', model: 'phase1-model', fallbackModel: null, fallbackEngine: null };
}

async function seedMergedBook(tag: string, sentences: unknown[] | null = OLD_KEYED_SENTENCES) {
  const title = `Stale Evidence ${tag}`;
  const manuscriptId = `m_stale_evidence_${tag}_${Date.now()}`;
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
      chapters: MERGED_CHAPTERS.map((c, i) => ({ id: i + 1, slug: `0${i + 1}-x`, ...c })),
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  if (sentences !== null) {
    writeFileSync(join(bookDir, '.audiobook', 'manuscript-edits.json'), JSON.stringify({ sentences }));
  }
  return { manuscriptId, bookId, bookDir };
}

type StateOnDisk = {
  chapters: Array<Record<string, unknown>>;
  sentencesPredateChapters?: boolean;
  analysisProvenance?: { scope?: string };
  tags?: string[];
};
const statePath = (bookDir: string) => join(bookDir, '.audiobook', 'state.json');
const editsPath = (bookDir: string) => join(bookDir, '.audiobook', 'manuscript-edits.json');
const readState = (bookDir: string): StateOnDisk => JSON.parse(readFileSync(statePath(bookDir), 'utf8'));

async function appWith() {
  const { bookStateRouter } = await import('./book-state.js');
  const { chaptersRestructureRouter } = await import('./chapters-restructure.js');
  const { analysisRouter } = await import('./analysis.js');
  const app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
  app.use('/api/books', chaptersRestructureRouter);
  app.use('/api/manuscripts', analysisRouter);
  return app;
}

async function reparse(bookId: string): Promise<void> {
  const res = await request(await appWith()).post(`/api/books/${bookId}/reparse`);
  expect(res.status).toBe(200);
}

function makeJob(manuscriptId: string, bookDir: string, kind: 'main' | 'subset', ids: number[]) {
  return {
    controller: new AbortController(),
    subscribers: new Set([
      {
        keepAlive: { unref() {} } as unknown as ReturnType<typeof setInterval>,
        res: { end() {} } as never,
        send: () => {},
      },
    ]),
    manuscriptId,
    kind,
    ...(kind === 'subset' ? { subsetChapterIds: ids } : {}),
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
}

async function runAnalysis(manuscriptId: string, kind: 'main' | 'subset', stage2?: Stage2): Promise<void> {
  const { runMainAnalyzerJob, runSubsetAnalyzerJob } = await import('./analysis.js');
  const { getOrHydrateManuscript } = await import('../store/manuscripts.js');
  const record = (await getOrHydrateManuscript(manuscriptId))!;
  const selection = phase1Selection(stage2);
  (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection = selection;
  const job = makeJob(manuscriptId, record.bookDir!, kind, record.chapterHints.map((c) => c.id));
  const prior = process.env.STAGE2_COVERAGE_RETRIES;
  process.env.STAGE2_COVERAGE_RETRIES = '0';
  try {
    if (kind === 'main') {
      await runMainAnalyzerJob(job, record as never, selection, {
        requestedFresh: false,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });
    } else {
      await runSubsetAnalyzerJob(job, record as never, selection, selection, record.chapterHints, false);
    }
  } finally {
    if (prior === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
    else process.env.STAGE2_COVERAGE_RETRIES = prior;
  }
}

describe('plan 290 — set (M23)', () => {
  it('re-parse sets sentencesPredateChapters and leaves manuscript-edits.json unchanged', async () => {
    const { bookId, bookDir } = await seedMergedBook('set-reparse');
    const editsBefore = readFileSync(editsPath(bookDir));
    expect(readState(bookDir)).not.toHaveProperty('sentencesPredateChapters');
    await reparse(bookId);
    const after = readState(bookDir);
    expect(after.chapters).toHaveLength(4);
    expect(after.sentencesPredateChapters).toBe(true);
    expect(readFileSync(editsPath(bookDir)).equals(editsBefore)).toBe(true);
  }, 60_000);

  it('replace-manuscript sets sentencesPredateChapters and leaves manuscript-edits.json unchanged', async () => {
    const { bookId, bookDir } = await seedMergedBook('set-replace');
    const editsBefore = readFileSync(editsPath(bookDir));
    const res = await request(await appWith())
      .post(`/api/books/${bookId}/replace-manuscript`)
      .attach('file', Buffer.from(MANUSCRIPT), { filename: 'fresh.md', contentType: 'text/markdown' });
    expect(res.status).toBe(200);
    expect(readState(bookDir).sentencesPredateChapters).toBe(true);
    expect(readFileSync(editsPath(bookDir)).equals(editsBefore)).toBe(true);
  }, 60_000);

  it('a re-parse of a book with no saved sentences does not set it', async () => {
    const absent = await seedMergedBook('set-none-absent', null);
    await reparse(absent.bookId);
    expect(readState(absent.bookDir).chapters).toHaveLength(4);
    expect(readState(absent.bookDir)).not.toHaveProperty('sentencesPredateChapters');

    const empty = await seedMergedBook('set-none-empty', []);
    await reparse(empty.bookId);
    expect(readState(empty.bookDir)).not.toHaveProperty('sentencesPredateChapters');
  }, 60_000);
});

describe('plan 290 — the seams after re-parse + restart (the marker keeps main\'s rule)', () => {
  it('re-parse -> restart -> Start answers 200', async () => {
    const { manuscriptId, bookId, bookDir } = await seedMergedBook('start');
    await reparse(bookId);
    expect(readState(bookDir).sentencesPredateChapters).toBe(true);
    const { removeManuscript } = await import('../store/manuscripts.js');
    removeManuscript(manuscriptId); // a restart
    const g = globalThis as Record<string, unknown>;
    g.__analyzer_device_test_phase0_selection = phase1Selection();
    g.__analyzer_device_test_phase1_selection = phase1Selection();
    const res = await request(await appWith()).post(`/api/manuscripts/${manuscriptId}/analysis`).send({});
    expect(res.status).toBe(200);
  }, 60_000);

  it('re-parse -> restart -> merge answers 200 and writes its hints file', async () => {
    const { manuscriptId, bookId, bookDir } = await seedMergedBook('merge');
    await reparse(bookId);
    expect(readState(bookDir).sentencesPredateChapters).toBe(true);
    const { removeManuscript } = await import('../store/manuscripts.js');
    removeManuscript(manuscriptId); // a restart
    const res = await request(await appWith())
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [2, 3] });
    expect(res.status).toBe(200);
    expect(existsSync(join(bookDir, '.audiobook', 'manuscript-hints.json'))).toBe(true);
    /* A restructure's result state spreads the old one: the marker survives. */
    expect(readState(bookDir).sentencesPredateChapters).toBe(true);
  }, 60_000);
});

describe('plan 290 — clear (M25)', () => {
  it('a main analysis persist clears the marker', async () => {
    const { manuscriptId, bookId, bookDir } = await seedMergedBook('clear-main');
    await reparse(bookId);
    expect(readState(bookDir).sentencesPredateChapters).toBe(true);
    await runAnalysis(manuscriptId, 'main');
    const after = readState(bookDir);
    /* The persist really ran (it stamps the scope), so the absence is not vacuous. */
    expect(after.analysisProvenance?.scope).toBe('book');
    expect(after).not.toHaveProperty('sentencesPredateChapters');
  }, 60_000);

  it('after a main run clears it, a hand-made reorder of two analysed chapters is refused at Start', async () => {
    const { manuscriptId, bookId, bookDir } = await seedMergedBook('clear-then-reorder');
    await reparse(bookId);
    await runAnalysis(manuscriptId, 'main');
    /* The main persist ran (the clear itself is pinned by the test above); the Start below
       is what this case asserts, so a marker left set (M25) answers 200 there. */
    expect(readState(bookDir).analysisProvenance?.scope).toBe('book');
    /* A reorder made before #3703: Alpha and Beta swapped in state.json, their saved
       sentences remapped with them, and no hints file. */
    const state = readState(bookDir);
    const [c1, c2, c3, c4] = state.chapters;
    writeFileSync(
      statePath(bookDir),
      JSON.stringify({ ...state, chapters: [c1, { ...c3, id: 2 }, { ...c2, id: 3 }, c4] }),
    );
    const edits = JSON.parse(readFileSync(editsPath(bookDir), 'utf8')) as { sentences: Array<{ chapterId: number }> };
    const swap: Record<number, number> = { 2: 3, 3: 2 };
    writeFileSync(
      editsPath(bookDir),
      JSON.stringify({ ...edits, sentences: edits.sentences.map((x) => ({ ...x, chapterId: swap[x.chapterId] ?? x.chapterId })) }),
    );
    rmSync(join(bookDir, '.audiobook', 'manuscript-hints.json'), { force: true });
    const { removeManuscript, getOrHydrateManuscript } = await import('../store/manuscripts.js');
    removeManuscript(manuscriptId); // a restart
    expect((await getOrHydrateManuscript(manuscriptId))!.hintsSource).toBe('parse');
    const g = globalThis as Record<string, unknown>;
    g.__analyzer_device_test_phase0_selection = phase1Selection();
    g.__analyzer_device_test_phase1_selection = phase1Selection();
    const res = await request(await appWith()).post(`/api/manuscripts/${manuscriptId}/analysis`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('hints_out_of_sync');
  }, 60_000);

  it('a subset analysis persist leaves the marker set', async () => {
    const { manuscriptId, bookId, bookDir } = await seedMergedBook('clear-subset');
    await reparse(bookId);
    expect(readState(bookDir).sentencesPredateChapters).toBe(true);
    /* Re-parse wiped the cache; seed a stage1 so the subset job takes its
       already-analysed branch (as analysis.title-flags.test.ts does). */
    const { saveAnalysisCache } = await import('../store/analysis-cache.js');
    await saveAnalysisCache(manuscriptId, {
      stage1: {
        characters: [
          { id: 'nova', name: 'Nova', role: 'character', color: '#abc', evidence: [{ quote: 'The plan is set.' }] },
        ],
        chapters: readState(bookDir).chapters.map((c) => ({ id: c.id as number, title: String(c.title) })),
      },
      chapters: {},
    } as never);
    await runAnalysis(manuscriptId, 'subset');
    const after = readState(bookDir);
    expect(after.analysisProvenance?.scope).toBe('subset');
    expect(after.sentencesPredateChapters).toBe(true);
  }, 60_000);

  it('an attribution_drift main run (state write skipped) leaves the marker set', async () => {
    const { manuscriptId, bookId, bookDir } = await seedMergedBook('clear-drift');
    await reparse(bookId);
    expect(readState(bookDir).sentencesPredateChapters).toBe(true);
    await runAnalysis(manuscriptId, 'main', driftStage2);
    /* The drift branch really ran: the persist reached its edits write (which
       precedes the drift check) with the demoted 120-per-chapter takes, so the
       skipped state write is not a run that failed earlier. */
    const edits = JSON.parse(readFileSync(editsPath(bookDir), 'utf8')) as {
      sentences: Array<{ characterId: string }>;
    };
    expect(edits.sentences.length).toBeGreaterThanOrEqual(4 * 120);
    expect(edits.sentences.some((s) => s.characterId === 'ghost')).toBe(false);
    const after = readState(bookDir);
    /* No persist landed on state.json: no provenance was stamped. */
    expect(after.analysisProvenance).toBeUndefined();
    expect(after.sentencesPredateChapters).toBe(true);
  }, 60_000);
});

describe('plan 290 — re-parse -> exclude -> Start -> Start (M26)', () => {
  it('the exclude clears the cache, Start #1 attributes every chapter and clears the marker, Start #2 is not refused', async () => {
    const { manuscriptId, bookId, bookDir } = await seedMergedBook('exclude-start');
    await reparse(bookId);
    expect(readState(bookDir).sentencesPredateChapters).toBe(true);
    const app = await appWith();
    const exclude = await request(app)
      .post(`/api/books/${bookId}/chapters/exclude`)
      .send({ chapterIds: [4], excluded: true });
    expect(exclude.status).toBe(200);
    const { cachePath } = await import('../store/analysis-cache.js');
    expect(existsSync(cachePath(manuscriptId))).toBe(false);

    const attributed: number[] = [];
    const counting: Stage2 = (chapterId) => {
      attributed.push(chapterId);
      return honestStage2(chapterId);
    };
    const startOnce = () => {
      const g = globalThis as Record<string, unknown>;
      g.__analyzer_device_test_phase0_selection = phase1Selection(counting);
      g.__analyzer_device_test_phase1_selection = phase1Selection(counting);
      return request(app).post(`/api/manuscripts/${manuscriptId}/analysis`).send({});
    };
    const first = await startOnce();
    expect(first.status).toBe(200);
    /* Every non-excluded chapter was attributed: none was replayed from a re-seeded take. */
    expect([...new Set(attributed)].sort()).toEqual([1, 2, 3]);
    const after = readState(bookDir);
    expect(after.analysisProvenance?.scope).toBe('book');
    expect(after).not.toHaveProperty('sentencesPredateChapters');

    /* A restart, so Start #2 judges a fresh-parse record (re-parse put one with no
       hintsSource, which the seam never checks). */
    const { removeManuscript, getOrHydrateManuscript } = await import('../store/manuscripts.js');
    removeManuscript(manuscriptId);
    expect((await getOrHydrateManuscript(manuscriptId))!.hintsSource).toBe('parse');
    const second = await startOnce();
    expect(second.body?.code).not.toBe('hints_out_of_sync');
    expect(second.status).toBe(200);
  }, 60_000);
});

describe('plan 290 — survives the client', () => {
  it('a PUT /state slice save from a stale client copy keeps the marker', async () => {
    const { bookId, bookDir } = await seedMergedBook('put-survives');
    const staleCopy = readState(bookDir); // read before the re-parse: no marker
    await reparse(bookId);
    expect(readState(bookDir).sentencesPredateChapters).toBe(true);
    const res = await request(await appWith())
      .put(`/api/books/${bookId}/state`)
      .send({ slice: 'state', patch: { ...staleCopy, tags: ['stale-save'] } });
    expect(res.status).toBe(200);
    const after = readState(bookDir);
    expect(after.tags).toEqual(['stale-save']); // the save landed
    expect(after.sentencesPredateChapters).toBe(true);
  }, 60_000);
});
