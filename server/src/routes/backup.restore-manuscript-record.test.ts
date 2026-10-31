/* PR #3966 review pass 1 -- a backup restore swaps state.json, so the warm
   in-memory ManuscriptRecord built from the pre-restore state is stale. The
   bundle overwrite drops it (scan-import-folder.ts); the restore did not. With
   the stale record still warm, a main analysis run with no restart in between
   rebuilt state.chapters from it and silently undid the restore.

   Repro: analyse a 3-chapter parse book, back it up, reorder [2,1,3] through
   the real route, restore the pre-reorder snapshot through the real route, then
   run a main analysis WITHOUT dropping the record. The restored chapter list
   (ids + titles, in order) must survive the run. Nothing is asserted about the
   analysis cache here. */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const actual = await vi.importActual<typeof import('../analyzer/select-analyzer.js')>('../analyzer/select-analyzer.js');
  return {
    ...actual,
    selectAnalyzerForPhase: (opts: { phase: 'phase0' | 'phase1' }) => {
      const g = globalThis as Record<string, unknown>;
      if (g.__restore_rec_sel) return g.__restore_rec_sel;
      return actual.selectAnalyzerForPhase(opts as Parameters<typeof actual.selectAnalyzerForPhase>[0]);
    },
    isPerPhaseModelSelectionActive: () => false,
  };
});

const AUTHOR = 'Restore Record Author';
const SERIES = 'Standalones';
const TITLE = 'Restore Record Book';
const lineFor = (n: number) =>
  `"The plan is set." Silence followed by ${['rain', 'snow', 'wind'][n - 1]} over the hills.`;
const MANUSCRIPT = `# Book\n\n# Alpha\n\nIt began.\n\n${lineFor(1)}\n\n# Beta\n\nIt began.\n\n${lineFor(2)}\n\n# Gamma\n\nIt began.\n\n${lineFor(3)}\n`;

let workspaceRoot: string;
const settingsTmpDir = mkdtempSync(join(tmpdir(), 'restore-record-settings-'));
process.env.USER_SETTINGS_FILE = join(settingsTmpDir, 'user-settings.json');
writeFileSync(process.env.USER_SETTINGS_FILE, JSON.stringify({ minorCastMinLines: 1 }));
const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(resolve(__dirname, '..', '..'), 'handoff', 'cache');
const MID = `m_restore_record_${Date.now()}`;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'restore-record-ws-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.STRUCTURE_ENGINE = '0';
  await import('./analysis.js');
}, 120_000);
afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  const cp = join(CACHE_DIR, `${MID}.json`);
  if (existsSync(cp)) rmSync(cp, { force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.STRUCTURE_ENGINE;
  delete process.env.STAGE2_COVERAGE_RETRIES;
  rmSync(settingsTmpDir, { recursive: true, force: true });
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>).__restore_rec_sel;
});

function selection(): AnalyzerSelection {
  const analyzer: Analyzer = {
    runStage1: () => Promise.reject(new Error('not used')),
    async runStage1Chapter(): Promise<Stage1ChapterOutput> {
      return {
        characters: [{ id: 'nova', name: 'Nova', role: 'character', color: '#abc', evidence: [{ quote: 'The plan is set.' }] }],
      } as Stage1ChapterOutput;
    },
    async runStage2Chapter(_m: string, chapterId: number, ...rest: unknown[]): Promise<Stage2ChapterOutput> {
      /* Attribute whatever body it is handed: find which line it holds. */
      const body = JSON.stringify(rest);
      const n = [1, 2, 3].find((k) => body.includes(['rain', 'snow', 'wind'][k - 1]!)) ?? chapterId;
      return { sentences: [{ id: chapterId * 100 + 1, chapterId, characterId: 'nova', confidence: 0.9, text: lineFor(n) }] };
    },
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.resolve(null),
  };
  return { analyzer, engine: 'gemini', model: 'm', fallbackModel: null, fallbackEngine: null };
}

function makeJob(bookDir: string): AnalysisJob {
  return {
    controller: new AbortController(),
    subscribers: new Set([{ keepAlive: { unref() {} }, res: { end() {} }, send: () => {} }]),
    manuscriptId: MID,
    kind: 'main',
    bookDir,
    engine: 'gemini',
    replay: { logs: [], lastPhase: null, lastEta: null, lastCastUpdate: null, failedByChapterId: new Map(), lastSeriesPrior: null, warnings: new Map() },
    lastDiskWriteAt: 0,
  } as unknown as AnalysisJob;
}

async function runMain(): Promise<void> {
  const { runMainAnalyzerJob } = await import('./analysis.js');
  const { getOrHydrateManuscript } = await import('../store/manuscripts.js');
  const record = (await getOrHydrateManuscript(MID))!;
  const sel = selection();
  (globalThis as Record<string, unknown>).__restore_rec_sel = sel;
  process.env.STAGE2_COVERAGE_RETRIES = '0';
  await runMainAnalyzerJob(makeJob(record.bookDir!), record as never, sel, {
    requestedFresh: false,
    allowStage1Shrink: true,
    requestedModel: undefined,
  });
}

describe('backup restore drops the warm manuscript record', () => {
  it('a main run after reorder -> restore (no restart) keeps the restored chapter list', async () => {
    const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
    const { makeBookId } = await import('../workspace/paths.js');
    const bookId = makeBookId(AUTHOR, SERIES, TITLE);
    writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT);
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId, manuscriptId: MID, title: TITLE, author: AUTHOR, series: SERIES, seriesPosition: null, isStandalone: true,
        manuscriptFile: 'manuscript.md', castConfirmed: false, language: 'en', schema: 1,
        chapters: ['Alpha', 'Beta', 'Gamma'].map((t, i) => ({ id: i + 1, title: t, slug: `0${i + 1}-${t.toLowerCase()}`, uuid: `uu-${t}` })),
        coverGradient: ['#000', '#fff'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }),
    );
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const chapterList = () =>
      (JSON.parse(readFileSync(statePath, 'utf8')).chapters as Array<{ id: number; title: string }>).map(
        (c) => `${c.id}:${c.title}`,
      );

    // 1. analyse the fresh import
    await runMain();
    expect(chapterList()).toEqual(['1:Alpha', '2:Beta', '3:Gamma']);

    // 2. back it up
    const { backupBook } = await import('../workspace/auto-backup.js');
    const file = await backupBook({ bookId, bookDir }, { keep: 5, now: new Date(2026, 0, 1, 9, 0, 0) });
    expect(file).toBeTruthy();

    // 3. reorder through the real route -- this warms a record for the new order
    const { chaptersRestructureRouter } = await import('./chapters-restructure.js');
    const { backupRouter } = await import('./backup.js');
    const app = express();
    app.use(express.json());
    app.use('/api/books', chaptersRestructureRouter);
    app.use('/api/books', backupRouter);
    const ro = await request(app).post(`/api/books/${bookId}/chapters/reorder`).send({ order: [2, 1, 3] });
    expect(ro.status, JSON.stringify(ro.body)).toBe(200);
    expect(chapterList()).toEqual(['1:Beta', '2:Alpha', '3:Gamma']);

    // 4. restore the pre-reorder snapshot through the real route
    const rs = await request(app).post(`/api/books/${bookId}/backups/restore`).send({ backupFile: file });
    expect(rs.status, JSON.stringify(rs.body)).toBe(200);
    expect(chapterList()).toEqual(['1:Alpha', '2:Beta', '3:Gamma']);

    // 5. a main run with NO restart (the record is not dropped by the test)
    await runMain();
    expect(chapterList()).toEqual(['1:Alpha', '2:Beta', '3:Gamma']);
  }, 120_000);
});
