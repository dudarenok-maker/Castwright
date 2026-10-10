/* #3084 P23 + P14 — after Task 3c.10 adds the pre-run checks, every analyzer selection call
   site still reports a missing endpoint as analyzer-endpoint-missing, and the five sites
   3b Task 3b.1a routed through analyzerSelectionErrorEvent still send THAT helper's event,
   whether the error comes from a pre-run check (`check`: no endpoint `gone` is saved) or
   from selection itself (`selection`: the check passes an Ollama id and selection throws).
   For this class the helper's event and classifyAnalysisFailure's are identical on the
   wire, so the spy on the helper is what tells a site that kept it from one that replaced
   it. Phase 1 codes the error through runMainAnalyzerJob's job catch, as 3b.1a left it. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { AnalyzerEndpointMissingError } from '../analyzer/errors.js';
import type { Analyzer, AnalyzerSelection } from '../analyzer/index.js';
import type { Stage1ChapterOutput } from '../handoff/schemas.js';
import { analyzerSelectionErrorEvent } from './failure-taxonomy.js';
import type { AnalysisJob } from './analysis.js';

const { selection } = vi.hoisted(() => ({ selection: { error: null as Error | null } }));

vi.mock('../analyzer/select-analyzer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analyzer/select-analyzer.js')>();
  return {
    ...actual,
    selectAnalyzerForPhase: (opts: Parameters<typeof actual.selectAnalyzerForPhase>[0]) => {
      if (selection.error) throw selection.error;
      return actual.selectAnalyzerForPhase(opts);
    },
    isPerPhaseModelSelectionActive: () => false,
  };
});
vi.mock('./failure-taxonomy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./failure-taxonomy.js')>();
  return { ...actual, analyzerSelectionErrorEvent: vi.fn(actual.analyzerSelectionErrorEvent) };
});
/* Defensive, as in script-review.test.ts: no row reaches the review teardown, but the real
   unloadResidentOllama evicts every resident model on a box with a live daemon. */
vi.mock('./ollama-health.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ollama-health.js')>();
  return { ...actual, unloadResidentOllama: vi.fn(async () => {}) };
});

const AUTHOR = 'Selection Coding Author';
const SERIES = 'Selection Coding Series';
const BOOK = 'Selection Coding Book';
const SENTENCES = [
  { id: 1, chapterId: 1, characterId: 'narrator', text: 'The room was quiet.' },
  { id: 2, chapterId: 1, characterId: 'wren', text: '"Get down!"' },
];

let workspaceRoot: string;
let app: Express;
let bookId: string;

function writeBook(): void {
  const dir = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title: BOOK,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: 1,
      isStandalone: true,
      language: 'en',
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(dir, '.audiobook', 'cast.json'),
    JSON.stringify({ characters: [{ id: 'wren', name: 'Wren', role: 'protagonist', color: '#ff0000' }] }),
  );
  writeFileSync(join(dir, '.audiobook', 'manuscript-edits.json'), JSON.stringify({ sentences: SENTENCES }));
}

async function registerStub(): Promise<string> {
  const { putManuscript } = await import('../store/manuscripts.js');
  const id = `m_selection_coding_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const chapterHints = [1, 2].map((n) => ({ id: n, title: `Chapter ${n}`, body: `Chapter ${n} body. ` + 'lorem ipsum dolor sit amet '.repeat(50) }));
  putManuscript({
    manuscriptId: id,
    format: 'plaintext',
    title: `Stub ${id}`,
    wordCount: 200,
    byteSize: 10_000,
    uploadedAt: new Date().toISOString(),
    sourceText: chapterHints.map((c) => c.body).join('\n\n'),
    chapterHints,
  });
  return id;
}

function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice('data: '.length)) as Record<string, unknown>);
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-selection-coding-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Sequential awaits, not Promise.all (#2083): a Promise.all of dynamic imports races the
     async vi.mock factories above. */
  const { analysisRouter } = await import('./analysis.js');
  const { annotateEmotionRouter } = await import('./annotate-emotion.js');
  const { instructAnnotationRouter } = await import('./instruct-annotation.js');
  const { scriptReviewRouter } = await import('./script-review.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookId = makeBookId(AUTHOR, SERIES, BOOK);
  app = express();
  app.use(express.json());
  app.use('/api/manuscripts', analysisRouter);
  app.use('/api/books', annotateEmotionRouter);
  app.use('/api/books', instructAnnotationRouter);
  app.use('/api/books', scriptReviewRouter);
});

beforeEach(() => {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  vi.mocked(analyzerSelectionErrorEvent).mockClear();
});

afterEach(() => {
  selection.error = null;
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

interface RouteSite {
  site: string;
  target: 'manuscript' | 'book';
  post: (id: string, model: string) => request.Test;
}

const ROUTE_SITES: RouteSite[] = [
  { site: 'analysis phase 0', target: 'manuscript', post: (id, model) => request(app).post(`/api/manuscripts/${id}/analysis`).send({ model }) },
  { site: 'subset retry', target: 'manuscript', post: (id, model) => request(app).post(`/api/manuscripts/${id}/analysis/chapters`).send({ chapterIds: [1], model }) },
  { site: 'annotate-emotion', target: 'book', post: (id, model) => request(app).post(`/api/books/${id}/annotate-emotion`).send({ model }) },
  { site: 'instruct-annotation', target: 'book', post: (id, model) => request(app).post(`/api/books/${id}/instruct-annotation`).send({ model }) },
  { site: 'script review', target: 'book', post: (id, model) => request(app).post(`/api/books/${id}/script-review`).send({ model }) },
];

const ROWS = ROUTE_SITES.flatMap((s) => (['check', 'selection'] as const).map((source) => ({ ...s, source })));

describe('every selection call site codes a missing endpoint after the pre-run checks (#3084 P23, P14)', () => {
  it.each(ROWS)('$site ($source) sends analyzerSelectionErrorEvent\'s analyzer-endpoint-missing event', async ({ target, post, source }) => {
    let manuscriptId: string | null = null;
    if (target === 'book') writeBook();
    else manuscriptId = await registerStub();
    /* check: the per-run pick names an endpoint that is not saved, so runAnalyzerPreflight throws.
       selection: an Ollama id passes the checks (no Test record), and selection throws. */
    const model = source === 'check' ? 'openai:gone::m' : 'qwen3.5:4b';
    if (source === 'selection') selection.error = new AnalyzerEndpointMissingError('gone', 'settings');
    try {
      const res = await post(target === 'book' ? bookId : manuscriptId!, model);
      expect(res.status).toBe(200);
      const error = parseSse(res.text).find((e) => e.kind === 'error');
      expect(error).toMatchObject({ kind: 'error', code: 'analyzer-endpoint-missing' });
      const helper = vi.mocked(analyzerSelectionErrorEvent);
      expect(helper).toHaveBeenCalledWith(expect.any(AnalyzerEndpointMissingError));
      const sent = helper.mock.results.find((r) => r.type === 'return')?.value; // never null (Q2)
      expect(error).toEqual(sent);
    } finally {
      if (manuscriptId) {
        const { removeManuscript } = await import('../store/manuscripts.js');
        removeManuscript(manuscriptId);
      }
    }
  });

  it('analysis phase 1 — runMainAnalyzerJob codes a selection throw through its job catch', async () => {
    const { runMainAnalyzerJob } = await import('./analysis.js');
    const { getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const { clearAnalysisCache } = await import('../store/analysis-cache.js');
    const id = await registerStub();
    selection.error = new AnalyzerEndpointMissingError('gone', 'settings');
    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    const cast = (chapterId: number): Stage1ChapterOutput => ({
      characters: [
        { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator', evidence: [{ quote: 'lorem ipsum dolor sit amet' }, { quote: 'lorem ipsum dolor sit amet' }, { quote: 'lorem ipsum dolor sit amet' }] },
        { id: `ch${chapterId}-char`, name: `Character_ch${chapterId}`, role: 'character', color: 'unset', evidence: [{ quote: 'lorem ipsum dolor sit amet' }, { quote: 'lorem ipsum dolor sit amet' }, { quote: 'lorem ipsum dolor sit amet' }] },
      ],
    });
    const phase0Analyzer: Analyzer = {
      runStage1: () => Promise.reject(new Error('not used')),
      runStage1Chapter: (_m, chapterId) => Promise.resolve(cast(chapterId)),
      runStage2Chapter: () => Promise.reject(new Error('not used')),
      runEmotionChapter: () => Promise.reject(new Error('not used')),
      runScriptReviewChapter: () => Promise.reject(new Error('not used')),
      runStage3Chapter: () => Promise.reject(new Error('not used')),
      runAttributionEscalation: () => Promise.resolve(null),
    };
    const events: Array<Record<string, unknown>> = [];
    const job = {
      controller: new AbortController(),
      subscribers: new Set(),
      manuscriptId: id,
      kind: 'main',
      bookDir: null,
      engine: 'gemini',
      replay: { logs: [], lastPhase: null, lastEta: null, lastCastUpdate: null, failedByChapterId: new Map(), lastSeriesPrior: null, warnings: new Map() },
      lastDiskWriteAt: 0,
    } as unknown as AnalysisJob;
    const keepAlive = setInterval(() => {}, 100_000);
    clearInterval(keepAlive);
    job.subscribers.add({
      send: (payload: unknown) => events.push(payload as Record<string, unknown>),
      res: { end: () => {} } as unknown as import('express').Response,
      keepAlive,
    });
    const phase0: AnalyzerSelection = { analyzer: phase0Analyzer, engine: 'gemini', model: 'gemma-selection-coding-test', fallbackModel: null };
    try {
      await runMainAnalyzerJob(job, getManuscript(id) as never, phase0, { requestedFresh: true, allowStage1Shrink: true, requestedModel: undefined });
      expect(events.find((e) => e.kind === 'error')).toMatchObject({ kind: 'error', code: 'analyzer-endpoint-missing' });
    } finally {
      removeManuscript(id);
      await clearAnalysisCache(id);
      process.env.STAGE2_COVERAGE_RETRIES = origCovRetries;
    }
  }, 60_000);
});
