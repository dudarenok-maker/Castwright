/* #3436 (owner decision 2026-11-21) -- render and analysis on one book are mutually exclusive.
   An analysis START (main POST, subset POST) is refused with a 409 `book_busy` while the book has
   a live `render` job (generation, splice, QA repair). Two checks: an EARLY one, before the SSE
   headers (plain JSON 409), and a LATE one made atomically with the analysis's own registration
   (`runBookJob`'s `refuseIfLive`, inside book-op), which answers an SSE terminal `error` frame
   because the headers are already flushed. Harness copied from analysis.title-flags.test.ts. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import type { Analyzer, AnalyzerSelection } from '../analyzer/index.js';
import type { Stage1ChapterOutput, Stage2ChapterOutput } from '../handoff/schemas.js';
import type { BookJobKind } from '../workspace/book-op-lock.js';

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

const AUTHOR = 'Render Busy Analysis Author';
const SERIES = 'Standalones';
const LINE = '"The plan is set." Silence followed by rain.';
const MANUSCRIPT = `# Alpha\n\nIt began.\n\n${LINE}\n`;

let workspaceRoot: string;
const settingsTmpDir = mkdtempSync(join(tmpdir(), 'audiobook-analysis-render-busy-settings-'));
process.env.USER_SETTINGS_FILE = join(settingsTmpDir, 'user-settings.json');
writeFileSync(process.env.USER_SETTINGS_FILE, JSON.stringify({ minorCastMinLines: 1 }));

let bookJobs: typeof import('../workspace/book-jobs.js');
let bookOp: typeof import('../workspace/book-op-lock.js');
let fileLock: typeof import('../workspace/file-lock.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-analysis-render-busy-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.STRUCTURE_ENGINE = '0';
  await import('./analysis.js');
  bookJobs = await import('../workspace/book-jobs.js');
  bookOp = await import('../workspace/book-op-lock.js');
  fileLock = await import('../workspace/file-lock.js');
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

function stubSelection(): AnalyzerSelection {
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
      return { sentences: [{ id: chapterId * 100 + 1, chapterId, characterId: 'nova', confidence: 0.9, text: LINE }] };
    },
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.resolve(null),
  };
  return { analyzer, engine: 'gemini', model: 'phase1-model', fallbackModel: null, fallbackEngine: null };
}

/* An analysed one-chapter book (cached stage1, so a subset start takes its already-analysed branch). */
async function seedBook(tag: string) {
  const title = `Render Busy Analysis ${tag}`;
  const manuscriptId = `m_render_busy_analysis_${tag}_${Date.now()}`;
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
      chapters: [{ id: 1, slug: '01-x', title: 'Alpha' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(
    join(bookDir, '.audiobook', 'manuscript-edits.json'),
    JSON.stringify({ sentences: [{ id: 1, chapterId: 1, characterId: 'nova', text: LINE }] }),
  );
  const { saveAnalysisCache } = await import('../store/analysis-cache.js');
  await saveAnalysisCache(manuscriptId, {
    version: 2,
    stage1: {
      characters: [
        { id: 'nova', name: 'Nova', role: 'character', color: '#abc', evidence: [{ quote: 'The plan is set.' }] },
      ],
      chapters: [{ id: 1, title: 'Alpha' }],
    },
    chapters: {},
  } as never);
  return { manuscriptId, bookId, bookDir };
}

async function holdJob(bookId: string, kind: BookJobKind): Promise<{ finish: () => Promise<void> }> {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const reg = await bookJobs.runBookJob(bookId, kind, () => gate);
  if (reg === bookOp.BOOK_GONE) throw new Error('test setup: book not found');
  return {
    finish: async () => {
      open();
      await reg.done;
    },
  };
}

/** Hang guard, not a synchroniser: fails with a NAMED error rather than a bare testTimeout. */
async function waitUntil(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sseText = (res: request.Response) => (typeof res.body === 'string' ? res.body : res.text ?? '');
const collectText = (res: request.Response, cb: (err: Error | null, body: unknown) => void) => {
  let data = '';
  res.on('data', (c) => (data += c));
  res.on('end', () => cb(null, data));
};

describe.each(['main', 'subset'] as const)('#3436 — a %s analysis start while the book is rendering', (kind) => {
  const analysisApp = async () => {
    const { analysisRouter } = await import('./analysis.js');
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);
    return app;
  };
  const start = (app: express.Express, manuscriptId: string) => {
    const g = globalThis as Record<string, unknown>;
    g.__analyzer_device_test_phase0_selection = stubSelection();
    g.__analyzer_device_test_phase1_selection = stubSelection();
    return kind === 'main'
      ? request(app).post(`/api/manuscripts/${manuscriptId}/analysis`).send({})
      : request(app).post(`/api/manuscripts/${manuscriptId}/analysis/chapters`).send({ chapterIds: [1] });
  };

  it('(a) a live render job → plain 409 book_busy before any stream opens; state untouched; only the render stays registered', async () => {
    const { manuscriptId, bookId, bookDir } = await seedBook(`refused-${kind}`);
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const before = readFileSync(statePath);
    const job = await holdJob(bookId, 'render');
    try {
      const res = await start(await analysisApp(), manuscriptId);
      expect(res.status).toBe(409);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.code).toBe('book_busy');
      expect(res.body.error).toMatch(/rendering audio/);
      expect(res.body.error).toMatch(/not started/);
      expect(res.text).not.toContain(workspaceRoot);
      expect(readFileSync(statePath).equals(before)).toBe(true);
      expect(bookOp.bookJobKinds(bookId)).toEqual(['render']);
    } finally {
      await job.finish();
    }
  });

  it('(b) control: a render job on ANOTHER book does not refuse it', async () => {
    const mine = await seedBook(`other-a-${kind}`);
    const other = await seedBook(`other-b-${kind}`);
    const job = await holdJob(other.bookId, 'render');
    try {
      const res = await start(await analysisApp(), mine.manuscriptId);
      expect(res.status).toBe(200);
      expect(sseText(res)).not.toContain('book_busy');
    } finally {
      await job.finish();
    }
  });

  it('(c) control: a non-render job (export) on the same book does not refuse it', async () => {
    const { manuscriptId, bookId } = await seedBook(`nonrender-${kind}`);
    const job = await holdJob(bookId, 'export');
    try {
      const res = await start(await analysisApp(), manuscriptId);
      expect(res.status).toBe(200);
      expect(sseText(res)).not.toContain('book_busy');
    } finally {
      await job.finish();
    }
  });

  it('(c2) symmetric: a splice remix / dry-run scan (kind audio-fix) never rebuilds the cache, so it does not refuse an analysis start', async () => {
    const { manuscriptId, bookId } = await seedBook(`audiofix-${kind}`);
    const job = await holdJob(bookId, 'audio-fix');
    try {
      const res = await start(await analysisApp(), manuscriptId);
      expect(res.status).toBe(200);
      expect(sseText(res)).not.toContain('book_busy');
    } finally {
      await job.finish();
    }
  });

  it('(d) race: a render that registers while the start waits on book-op still refuses it, as an SSE error frame; nothing registered', async () => {
    const { manuscriptId, bookId } = await seedBook(`race-${kind}`);
    const waiters = () =>
      (fileLock as unknown as { __keyWaitersForTest: (k: string) => number }).__keyWaitersForTest(`book-op:${bookId}`);
    let release!: () => void;
    const open = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const held = new Promise<void>((r) => (acquired = r));
    void bookOp.withBookOp(bookId, async () => {
      acquired();
      await open;
    });
    await held;
    let openJob!: () => void;
    const jobGate = new Promise<void>((r) => (openJob = r));
    const jobP = bookJobs.runBookJob(bookId, 'render', () => jobGate);
    await waitUntil(() => waiters() >= 1, 'the render job to queue on book-op');
    const routeP = Promise.resolve(start(await analysisApp(), manuscriptId).buffer(true).parse(collectText));
    await waitUntil(() => waiters() >= 2, 'the analysis start to queue on book-op behind the render');
    release();
    const res = await routeP;
    const reg = await jobP;
    if (reg === bookOp.BOOK_GONE) throw new Error('test setup: book not found');
    try {
      expect(res.status).toBe(200);
      expect(sseText(res)).toContain('"code":"book_busy"');
      expect(sseText(res)).toMatch(/rendering audio/);
      expect(bookOp.bookJobKinds(bookId)).toEqual(['render']);
    } finally {
      openJob();
      await reg.done;
    }
  });
});
