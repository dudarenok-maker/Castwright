/* #3703 part 2 — after a restart, a restructured book hydrates its chapter
   bodies from .audiobook/manuscript-hints.json (when the file provably belongs
   to state.json + the manuscript), so a re-analysis writes the restructured
   structure back instead of the raw parse's. Harness copied from
   analysis.title-flags.test.ts. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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

const AUTHOR = 'Restructure Restart Author';
const SERIES = 'Standalones';
const lineFor = (name: string) => `"${name} plan is set." Silence followed.`;

let workspaceRoot: string;
const settingsTmpDir = mkdtempSync(join(tmpdir(), 'audiobook-restructure-restart-settings-'));
process.env.USER_SETTINGS_FILE = join(settingsTmpDir, 'user-settings.json');
writeFileSync(process.env.USER_SETTINGS_FILE, JSON.stringify({ minorCastMinLines: 1 }));

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-restructure-restart-test-'));
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

/* Records the stage-2 prompt per chapter id; each sentence's text is the first
   "<Name> plan is set." line found in the prompt, so coverage matches. */
function phase1Selection(prompts: Map<number, string>): AnalyzerSelection {
  const analyzer: Analyzer = {
    runStage1: () => Promise.reject(new Error('not used')),
    async runStage1Chapter(): Promise<Stage1ChapterOutput> {
      return {
        characters: [
          { id: 'nova', name: 'Nova', role: 'character', color: '#abc', evidence: [{ quote: 'plan is set.' }] },
        ],
      } as Stage1ChapterOutput;
    },
    async runStage2Chapter(_m: string, chapterId: number, promptMd: string): Promise<Stage2ChapterOutput> {
      prompts.set(chapterId, promptMd);
      const found = /"\w+ plan is set\." Silence followed\./.exec(promptMd);
      return {
        sentences: [
          { id: chapterId * 100 + 1, chapterId, characterId: 'nova', confidence: 0.9, text: found?.[0] ?? 'none' },
        ],
      };
    },
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.resolve(null),
  };
  return { analyzer, engine: 'gemini', model: 'phase1-model', fallbackModel: null, fallbackEngine: null };
}

async function seedBook(tag: string, names: string[]) {
  const title = `Restructure Restart ${tag}`;
  const manuscriptId = `m_restructure_restart_${tag}_${Date.now()}`;
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  const { makeBookId } = await import('../workspace/paths.js');
  const bookId = makeBookId(AUTHOR, SERIES, title);
  const manuscript = `# Restart Book ${tag}

` + names.map((n) => `# ${n}\n\n${lineFor(n)}\n`).join('\n');
  writeFileSync(join(bookDir, 'manuscript.md'), manuscript);
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
      chapters: names.map((n, i) => ({ id: i + 1, slug: `0${i + 1}-x`, title: n })),
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  const sentences = names.map((n, i) => ({ id: 1, chapterId: i + 1, characterId: 'nova', text: lineFor(n) }));
  writeFileSync(join(bookDir, '.audiobook', 'manuscript-edits.json'), JSON.stringify({ sentences }));
  const { saveAnalysisCache } = await import('../store/analysis-cache.js');
  await saveAnalysisCache(manuscriptId, {
    stage1: {
      characters: [
        { id: 'nova', name: 'Nova', role: 'character', color: '#abc', evidence: [{ quote: 'plan is set.' }] },
      ],
      chapters: names.map((n, i) => ({ id: i + 1, title: n })),
    },
    chapters: {},
  } as never);
  return { manuscriptId, bookId, bookDir };
}

function makeJob(manuscriptId: string, bookDir: string) {
  return {
    controller: new AbortController(),
    subscribers: new Set([
      {
        keepAlive: { unref() {} } as unknown as ReturnType<typeof setInterval>,
        res: { end() {} } as never,
        send: (p: unknown) => {
          const e = p as Record<string, unknown>;
          if (e.kind === 'error' || e.kind === 'warning') console.log('EV', JSON.stringify(e));
        },
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
}

async function runMainAnalysis(manuscriptId: string, requestedFresh = false): Promise<Map<number, string>> {
  const { runMainAnalyzerJob } = await import('./analysis.js');
  const { getOrHydrateManuscript } = await import('../store/manuscripts.js');
  const record = (await getOrHydrateManuscript(manuscriptId))!;
  const prompts = new Map<number, string>();
  (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection = phase1Selection(prompts);
  const job = makeJob(manuscriptId, record.bookDir!);
  const prior = process.env.STAGE2_COVERAGE_RETRIES;
  process.env.STAGE2_COVERAGE_RETRIES = '0';
  try {
    await runMainAnalyzerJob(job, record as never, phase1Selection(prompts), {
      requestedFresh,
      allowStage1Shrink: true,
      requestedModel: undefined,
    });
  } finally {
    if (prior === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
    else process.env.STAGE2_COVERAGE_RETRIES = prior;
  }
  return prompts;
}

function readState(bookDir: string): {
  chapters: Array<{ title: string }>;
  analysisProvenance?: { scope?: string };
} {
  return JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
}

async function restructureApp() {
  const { chaptersRestructureRouter } = await import('./chapters-restructure.js');
  const app = express();
  app.use(express.json());
  app.use('/api/books', chaptersRestructureRouter);
  return app;
}

describe('#3703 — a restructure survives a restart + re-analysis', () => {
  it('merge: the re-analysis keeps the merged chapter', async () => {
    const { manuscriptId, bookId, bookDir } = await seedBook('merge', ['Delta', 'Alpha', 'Beta', 'Gamma']);
    const app = await restructureApp();
    const res = await request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [2, 3] });
    expect(res.status).toBe(200);
    const { removeManuscript } = await import('../store/manuscripts.js');
    removeManuscript(manuscriptId); // a restart

    const prompts = await runMainAnalysis(manuscriptId, true);
    expect(readState(bookDir).analysisProvenance?.scope).toBe('book');
    expect(readState(bookDir).chapters.length).toBe(3);
    expect(prompts.size).toBe(3);
    expect(prompts.get(2)).toContain(lineFor('Alpha'));
    expect(prompts.get(2)).toContain(lineFor('Beta'));
  }, 60_000);

  it('reorder: each title stays on its own body', async () => {
    const { manuscriptId, bookId, bookDir } = await seedBook('reorder', ['Alpha', 'Beta', 'Gamma']);
    const app = await restructureApp();
    const res = await request(app).post(`/api/books/${bookId}/chapters/reorder`).send({ order: [3, 1, 2] });
    expect(res.status).toBe(200);
    const { removeManuscript } = await import('../store/manuscripts.js');
    removeManuscript(manuscriptId); // a restart

    const prompts = await runMainAnalysis(manuscriptId, true);
    expect(readState(bookDir).analysisProvenance?.scope).toBe('book');
    expect(readState(bookDir).chapters.map((c) => c.title)).toEqual(['Gamma', 'Alpha', 'Beta']);
    expect(prompts.size).toBe(3);
    expect(prompts.get(1)).toContain(lineFor('Gamma'));
    expect(prompts.get(2)).toContain(lineFor('Alpha'));
    expect(prompts.get(3)).toContain(lineFor('Beta'));
  }, 60_000);

  it('a manuscript edited on disk after hydrate is not masked by the restructure (no stale bodies under the new sha)', async () => {
    const { manuscriptId, bookId, bookDir } = await seedBook('edited', ['Delta', 'Alpha', 'Beta', 'Gamma']);
    const { removeManuscript, getOrHydrateManuscript } = await import('../store/manuscripts.js');
    removeManuscript(manuscriptId);
    await getOrHydrateManuscript(manuscriptId); // caches the record parsed from the "Gamma" file
    const file = join(bookDir, 'manuscript.md');
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('Gamma', 'Omega'));
    const app = await restructureApp();
    const res = await request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [1, 2] });
    expect(res.status).toBe(200);
    removeManuscript(manuscriptId); // a restart
    const record = (await getOrHydrateManuscript(manuscriptId))!;
    const bodies = record.chapterHints.map((h) => h.body).join('\n');
    expect(bodies).toContain('Omega plan is set.');
    expect(bodies).not.toContain('Gamma plan is set.');
  }, 60_000);

  it('a stale hints file (uuid changed) is ignored and the fresh parse is used', async () => {
    const { manuscriptId, bookId, bookDir } = await seedBook('stale', ['Delta', 'Alpha', 'Beta', 'Gamma']);
    const app = await restructureApp();
    const res = await request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [2, 3] });
    expect(res.status).toBe(200);
    const file = join(bookDir, '.audiobook', 'manuscript-hints.json');
    const hints = JSON.parse(readFileSync(file, 'utf8'));
    hints.entries[0].chapters[0].uuid = 'not-the-real-uuid';
    writeFileSync(file, JSON.stringify(hints));
    const { removeManuscript, getOrHydrateManuscript } = await import('../store/manuscripts.js');
    removeManuscript(manuscriptId); // a restart
    const record = (await getOrHydrateManuscript(manuscriptId))!;
    expect(record.chapterHints.length).toBe(4);
  }, 60_000);
});
