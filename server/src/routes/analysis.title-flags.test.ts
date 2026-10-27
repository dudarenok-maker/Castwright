/* #3628 review pass 2 — analysis persists must carry the server/user-owned
   title-source flags (titleSynthesized, titleOverridden) from state.json.
   Same real-workspace harness as analysis.title-source.test.ts. */

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

const AUTHOR = 'Title Flags Author';
const SERIES = 'Standalones';
const LINE = '"The plan is set." Silence followed.';

let workspaceRoot: string;
const settingsTmpDir = mkdtempSync(join(tmpdir(), 'audiobook-title-flags-settings-'));
process.env.USER_SETTINGS_FILE = join(settingsTmpDir, 'user-settings.json');
writeFileSync(process.env.USER_SETTINGS_FILE, JSON.stringify({ minorCastMinLines: 1 }));

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-title-flags-test-'));
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

function phase1Selection(): AnalyzerSelection {
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

/* Seeds an analysed book whose state.json chapters carry the given fields,
   plus a cached stage1 (so the subset job takes its already-analysed branch). */
async function seedBook(tag: string, manuscript: string, chapters: Array<Record<string, unknown>>) {
  const title = `Title Flags ${tag}`;
  const manuscriptId = `m_title_flags_${tag}_${Date.now()}`;
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  const { makeBookId } = await import('../workspace/paths.js');
  const bookId = makeBookId(AUTHOR, SERIES, title);
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
      chapters: chapters.map((c, i) => ({ id: i + 1, slug: `0${i + 1}-x`, ...c })),
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  const sentences = chapters.map((_, i) => ({ id: 1, chapterId: i + 1, characterId: 'nova', text: LINE }));
  writeFileSync(join(bookDir, '.audiobook', 'manuscript-edits.json'), JSON.stringify({ sentences }));
  const { saveAnalysisCache } = await import('../store/analysis-cache.js');
  await saveAnalysisCache(manuscriptId, {
    stage1: {
      characters: [
        { id: 'nova', name: 'Nova', role: 'character', color: '#abc', evidence: [{ quote: 'The plan is set.' }] },
      ],
      chapters: chapters.map((c, i) => ({ id: i + 1, title: String(c.title) })),
    },
    chapters: {},
  } as never);
  return { manuscriptId, bookId, bookDir };
}

function makeJob(manuscriptId: string, bookDir: string, kind: 'main' | 'subset', ids: number[]) {
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

async function runAnalysis(manuscriptId: string, kind: 'main' | 'subset'): Promise<void> {
  const { runMainAnalyzerJob, runSubsetAnalyzerJob } = await import('./analysis.js');
  const { getOrHydrateManuscript } = await import('../store/manuscripts.js');
  const record = (await getOrHydrateManuscript(manuscriptId))!;
  (globalThis as Record<string, unknown>).__analyzer_device_test_phase1_selection = phase1Selection();
  const job = makeJob(manuscriptId, record.bookDir!, kind, record.chapterHints.map((c) => c.id));
  const prior = process.env.STAGE2_COVERAGE_RETRIES;
  process.env.STAGE2_COVERAGE_RETRIES = '0';
  try {
    if (kind === 'main') {
      await runMainAnalyzerJob(job, record as never, phase1Selection(), {
        requestedFresh: false,
        allowStage1Shrink: true,
        requestedModel: undefined,
      });
    } else {
      await runSubsetAnalyzerJob(
        job,
        record as never,
        phase1Selection(),
        phase1Selection(),
        record.chapterHints,
        false,
      );
    }
  } finally {
    if (prior === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
    else process.env.STAGE2_COVERAGE_RETRIES = prior;
  }
}

function readState(bookDir: string): {
  chapters: Array<Record<string, unknown>>;
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

const FLAGGED_BOOK = [
  { title: 'Chapter 1', titleSynthesized: true },
  { title: 'Prologue' },
  { title: 'Epilogue' },
];
const FLAGGED_MANUSCRIPT = `# Alpha\n\n${LINE}\n\n# Prologue\n\n${LINE}\n\n# Epilogue\n\n${LINE}\n`;

describe.each(['main', 'subset'] as const)(
  '#3628 — a completed %s analysis keeps the title-source flags',
  (kind) => {
    it('keeps titleSynthesized so a later reorder renumbers the app-made title', async () => {
      const { manuscriptId, bookId, bookDir } = await seedBook(`synth-${kind}`, FLAGGED_MANUSCRIPT, FLAGGED_BOOK);
      await runAnalysis(manuscriptId, kind);
      /* The persist must really have run (it stamps the scope), else the flag
         assertions below would pass vacuously. */
      expect(readState(bookDir).analysisProvenance?.scope).toBe(kind === 'main' ? 'book' : 'subset');
      expect(readState(bookDir).chapters[0].titleSynthesized).toBe(true);

      const app = await restructureApp();
      const reorder = () => request(app).post(`/api/books/${bookId}/chapters/reorder`).send({ order: [2, 1, 3] });
      const first = await reorder();
      expect(first.status).toBe(200);
      expect((first.body.chapters as { title: string }[]).map((c) => c.title)).toEqual([
        'Prologue',
        'Chapter 2',
        'Epilogue',
      ]);
      // A second analysis, then the swap back: the flag must have survived both.
      await runAnalysis(manuscriptId, kind);
      const res = await reorder();
      expect(res.status).toBe(200);
      expect((res.body.chapters as { title: string }[]).map((c) => c.title)).toEqual([
        'Chapter 1',
        'Prologue',
        'Epilogue',
      ]);
    }, 60_000);

    it('keeps titleOverridden across the analysis', async () => {
      const { manuscriptId, bookDir } = await seedBook(`over-${kind}`, FLAGGED_MANUSCRIPT, [
        { title: 'Alpha' },
        { title: 'My Own Title', titleOverridden: true },
        { title: 'Epilogue' },
      ]);
      await runAnalysis(manuscriptId, kind);
      expect(readState(bookDir).analysisProvenance?.scope).toBe(kind === 'main' ? 'book' : 'subset');
      const ch = readState(bookDir).chapters;
      expect(ch[1].titleOverridden).toBe(true);
      expect(ch[1].title).toBe('My Own Title');
    }, 60_000);
  },
);

describe('#3628 — merge after an analysis renumbers like a merge without one', () => {
  it('yields the same titles as a merge on a book that was never analysed', async () => {
    const book = [
      { title: 'Prologue' },
      { title: 'Chapter 1', titleSynthesized: true },
      { title: 'Chapter 2', titleSynthesized: true },
      { title: 'Chapter 3', titleSynthesized: true },
    ];
    /* The headings read "Chapter 1".."Chapter 3", so the parse's titles equal state's: a
       merge on a parse-fallback book title-checks them (#3791), and a heading of other
       wording against a synthesized state title is a state no current import produces. */
    const ms = `# Prologue\n\n${LINE}\n\n# Chapter 1\n\n${LINE}\n\n# Chapter 2\n\n${LINE}\n\n# Chapter 3\n\n${LINE}\n`;
    const control = await seedBook('merge-control', ms, book);
    const analysed = await seedBook('merge-analysed', ms, book);
    await runAnalysis(analysed.manuscriptId, 'main');
    const app = await restructureApp();
    const titlesAfterMerge = async (bookId: string) => {
      const res = await request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [2, 3] });
      expect(res.status).toBe(200);
      return (res.body.chapters as { title: string }[]).map((c) => c.title);
    };
    const expected = await titlesAfterMerge(control.bookId);
    expect(await titlesAfterMerge(analysed.bookId)).toEqual(expected);
  }, 60_000);
});

describe('#3628 — a renamed chapter is not excluded as front matter after a restart', () => {
  it('derives the exclusion default from the parse title, not the renamed state title', async () => {
    const { manuscriptId } = await seedBook('rename-intro', FLAGGED_MANUSCRIPT, [
      { title: 'Alpha' },
      { title: 'Introduction', titleOverridden: true },
      { title: 'Epilogue' },
    ]);
    const { removeManuscript, getOrHydrateManuscript } = await import('../store/manuscripts.js');
    removeManuscript(manuscriptId); // a restart: the next lookup re-parses the manuscript file
    const record = (await getOrHydrateManuscript(manuscriptId))!;
    expect(record.chapterHints[1].title).toBe('Introduction');
    expect(record.chapterHints[1].excluded).toBeFalsy();
  }, 60_000);
});

describe.each(['main', 'subset'] as const)(
  '#3829 — a %s analysis start is refused on a book whose chapter hints are out of sync with state.json',
  (kind) => {
  /* Both phases get the stub analyzer, so a start that is NOT refused never reaches Ollama. */
  const start = (app: express.Express, manuscriptId: string) => {
    const g = globalThis as Record<string, unknown>;
    g.__analyzer_device_test_phase0_selection = phase1Selection();
    g.__analyzer_device_test_phase1_selection = phase1Selection();
    return kind === 'main'
      ? request(app).post(`/api/manuscripts/${manuscriptId}/analysis`).send({})
      : request(app).post(`/api/manuscripts/${manuscriptId}/analysis/chapters`).send({ chapterIds: [1] });
  };
  const analysisApp = async () => {
    const { analysisRouter } = await import('./analysis.js');
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);
    return app;
  };

  it('answers 409 hints_out_of_sync and leaves state.json byte-identical', async () => {
    // Chapter 2 is a merge the user titled "Part Two"; the manuscript still has four headings.
    const ms = `# Prologue\n\n${LINE}\n\n# Alpha\n\n${LINE}\n\n# Beta\n\n${LINE}\n\n# Gamma\n\n${LINE}\n`;
    const { manuscriptId, bookDir } = await seedBook(`misaligned-${kind}`, ms, [
      { title: 'Prologue' },
      { title: 'Part Two', titleOverridden: true },
      { title: 'Gamma' },
    ]);
    const { removeManuscript } = await import('../store/manuscripts.js');
    removeManuscript(manuscriptId); // a restart: hints come from a fresh parse of the 4 headings
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const before = readFileSync(statePath);
    const res = await start(await analysisApp(), manuscriptId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('hints_out_of_sync');
    expect(res.body.error).toMatch(/Re-parse/);
    expect(readFileSync(statePath).equals(before)).toBe(true);
    expect(readState(bookDir).chapters.length).toBe(3);
  }, 60_000);

  it('does not refuse a restructured book whose persisted hints pair with state.json', async () => {
    const { manuscriptId, bookId, bookDir } = await seedBook(`persisted-${kind}`, FLAGGED_MANUSCRIPT, FLAGGED_BOOK);
    // A real merge: state now has 2 chapters, the manuscript still parses to 3, and the merge persists its hints.
    const merge = await request(await restructureApp())
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [2, 3] });
    expect(merge.status).toBe(200);
    expect(readState(bookDir).chapters.length).toBe(2);
    const { removeManuscript, getOrHydrateManuscript } = await import('../store/manuscripts.js');
    removeManuscript(manuscriptId); // a restart: the next lookup re-hydrates from disk
    expect((await getOrHydrateManuscript(manuscriptId))!.hintsSource).toBe('persisted');
    const res = await start(await analysisApp(), manuscriptId);
    expect(res.status).toBe(200);
  }, 60_000);

  it('does not refuse a never-restructured book whose state title is an older parser form', async () => {
    // Same ids and count as the parse; chapter 2's title was written before the parser decoded entities.
    const { manuscriptId } = await seedBook(`drift-${kind}`, FLAGGED_MANUSCRIPT, [
      { title: 'Alpha' },
      { title: 'Prologue&rsquo;' },
      { title: 'Epilogue' },
    ]);
    const { removeManuscript, getOrHydrateManuscript } = await import('../store/manuscripts.js');
    removeManuscript(manuscriptId);
    expect((await getOrHydrateManuscript(manuscriptId))!.hintsSource).toBe('parse');
    const res = await start(await analysisApp(), manuscriptId);
    expect(res.status).toBe(200);
  }, 60_000);

  it('refuses a same-count book whose headings were reordered before hints were persisted', async () => {
    // Same ids and count; "# Alpha" is swallowed as the book title, so the parse is [made up, Prologue, Epilogue]
    // and state is [Prologue, Alpha, Epilogue]: a heading sits on the parser-made position.
    const { manuscriptId, bookDir } = await seedBook(`reordered-${kind}`, FLAGGED_MANUSCRIPT, [
      { title: 'Prologue' },
      { title: 'Alpha' },
      { title: 'Epilogue' },
    ]);
    const { removeManuscript } = await import('../store/manuscripts.js');
    removeManuscript(manuscriptId);
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const before = readFileSync(statePath);
    const res = await start(await analysisApp(), manuscriptId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('hints_out_of_sync');
    expect(readFileSync(statePath).equals(before)).toBe(true);
  }, 60_000);

  it('refuses a same-count reorder among real headings at non-null positions', async () => {
    // "# Book" is the title, so the parse is [made up, Alpha, Beta, Gamma]; state has Gamma, Alpha, Beta.
    const ms = `# Book\n\n${LINE}\n\n# Alpha\n\n${LINE}\n\n# Beta\n\n${LINE}\n\n# Gamma\n\n${LINE}\n`;
    const { manuscriptId, bookId, bookDir } = await seedBook(`headings-${kind}`, ms, [
      { title: 'Chapter 1', titleSynthesized: true },
      { title: 'Gamma' },
      { title: 'Alpha' },
      { title: 'Beta' },
    ]);
    const { removeManuscript } = await import('../store/manuscripts.js');
    removeManuscript(manuscriptId);
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const before = readFileSync(statePath);
    const res = await start(await analysisApp(), manuscriptId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('hints_out_of_sync');
    expect(readFileSync(statePath).equals(before)).toBe(true);
    const merge = await request(await restructureApp())
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [3, 4] });
    expect(merge.status).toBe(409);
    expect(merge.body.code).toBe('hints_out_of_sync');
  }, 60_000);

  it('does not refuse a fresh import whose untitled lead section precedes a bare "Chapter 1"', async () => {
    // Parse and state are both ["Chapter 1" (made up), "Chapter 1", "Chapter 2"].
    const ms = `# Book\n\n${LINE}\n\n# Chapter 1\n\n${LINE}\n\n# Chapter 2\n\n${LINE}\n`;
    const { manuscriptId } = await seedBook(`lead-${kind}`, ms, [
      { title: 'Chapter 1', titleSynthesized: true },
      { title: 'Chapter 1' },
      { title: 'Chapter 2' },
    ]);
    const { removeManuscript, getOrHydrateManuscript } = await import('../store/manuscripts.js');
    removeManuscript(manuscriptId);
    const rec = (await getOrHydrateManuscript(manuscriptId))!;
    expect(rec.hintsSource).toBe('parse');
    expect(rec.parseTitles).toEqual([null, 'Chapter 1', 'Chapter 2']);
    const res = await start(await analysisApp(), manuscriptId);
    expect(res.status).toBe(200);
  }, 60_000);

  it('merges a fresh import whose untitled lead section precedes a bare "Chapter 1"', async () => {
    const ms = `# Book

${LINE}

# Chapter 1

${LINE}

# Chapter 2

${LINE}
`;
    const { manuscriptId, bookId } = await seedBook(`lead-merge-${kind}`, ms, [
      { title: 'Chapter 1', titleSynthesized: true },
      { title: 'Chapter 1' },
      { title: 'Chapter 2' },
    ]);
    const { removeManuscript } = await import('../store/manuscripts.js');
    removeManuscript(manuscriptId);
    const merge = await request(await restructureApp())
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [2, 3] });
    expect(merge.status).toBe(200);
  }, 60_000);

  it('does not refuse a healthy fresh import', async () => {
    const { manuscriptId } = await seedBook(`healthy-${kind}`, FLAGGED_MANUSCRIPT, FLAGGED_BOOK);
    const { removeManuscript } = await import('../store/manuscripts.js');
    removeManuscript(manuscriptId);
    const res = await start(await analysisApp(), manuscriptId);
    expect(res.status).toBe(200);
  }, 60_000);
  },
);
