/* #3711 PR #3714 review pass 6 -- an analysis start reads its ManuscriptRecord
   before it registers its job under book-op. A bundle overwrite queued ahead of
   that registration replaces the book, so the run must work from the record for
   the manuscript the LEASE names, not from the one it captured while queuing:

     - same manuscriptId: the run's prompts carry the bundle's text;
     - new manuscriptId: a start for the old id is refused (`unknown_manuscript`)
       and analyses nothing -- both for a start queued behind the overwrite and
       for one sent after it (the overwrite drops the old id's record).

   Real analysis router and `importPortableBundle`; a stub analyzer records every
   prompt. Unique manuscript ids per case: server/handoff/cache persists. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { ZipFile } from 'yazl';
import type { Analyzer, AnalyzerSelection } from '../analyzer/index.js';
import type {
  CharacterOutput,
  Stage1ChapterOutput,
  Stage2ChapterOutput,
} from '../handoff/schemas.js';

type G = Record<string, unknown>;
const g = globalThis as G;

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
      const sel = (globalThis as G)[opts.phase === 'phase1' ? '__ovr_phase1' : '__ovr_phase0'];
      return (
        sel ??
        actual.selectAnalyzerForPhase(opts as Parameters<typeof actual.selectAnalyzerForPhase>[0])
      );
    },
    isPerPhaseModelSelectionActive: () => false,
  };
});

const AUTHOR = 'Overwrite Analysis';
const SERIES = 'S';
const TITLE = 'Analysis Book';
const OLD_TEXT = '"Alpha speaks." Old text.';
const NEW_TEXT = '"Omega speaks." New text.';

let workspaceRoot: string;
let app: Express;
let bookId: string;
let bookDir: string;
let paths: typeof import('../workspace/paths.js');
let title: string;
let opLock: typeof import('../workspace/book-op-lock.js');
let fileLock: typeof import('../workspace/file-lock.js');
let portable: typeof import('../import/scan-import-folder.js');
let store: typeof import('../store/manuscripts.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-overwrite-analysis-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.STAGE2_COVERAGE_RETRIES = '0';
  /* Sequential imports -- a Promise.all of dynamic imports races vi.mock factories (#2083). */
  const analysisModule = await import('./analysis.js');
  paths = await import('../workspace/paths.js');
  opLock = await import('../workspace/book-op-lock.js');
  fileLock = await import('../workspace/file-lock.js');
  portable = await import('../import/scan-import-folder.js');
  store = await import('../store/manuscripts.js');
  app = express();
  app.use(express.json());
  app.use('/api/manuscripts', analysisModule.analysisRouter);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}, 120_000);

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.STAGE2_COVERAGE_RETRIES;
});

/* A book of its own per case (#3785). A finished analysis ends its SSE response
   before its `runBookJob` 'analysis' lease releases (at `job.settled`), so on a
   shared bookId the next case's overwrite saw the previous case's lease and was
   refused with BookBusyError. */
let startedRuns: Array<Promise<unknown>> = [];
beforeEach(() => {
  startedRuns = [];
  title = `${TITLE} ${Math.random().toString(36).slice(2, 8)}`;
  bookId = paths.makeBookId(AUTHOR, SERIES, title);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
});

afterEach(async () => {
  /* Let any start a failed case left queued finish while the stubs still exist,
     then wait for its lease, before the stubs and the book go. */
  await Promise.allSettled(startedRuns);
  await vi.waitFor(() => expect(opLock.bookJobKinds(bookId)).toEqual([]));
  for (const k of Object.keys(g)) if (k.startsWith('__ovr_')) delete g[k];
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  opLock.__bookDirIndexForTest().clear();
});

const uid = (tag: string): string =>
  `m_ovr_analysis_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function stateFor(manuscriptId: string): Record<string, unknown> {
  return {
    bookId,
    manuscriptId,
    title,
    author: AUTHOR,
    series: SERIES,
    seriesPosition: 1,
    isStandalone: false,
    manuscriptFile: 'manuscript.md',
    castConfirmed: false,
    language: 'en',
    chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
    coverGradient: ['#000', '#fff'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Seed the OLD book on disk and warm its record, as after any open. */
async function seedOld(manuscriptId: string): Promise<void> {
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, '.audiobook', 'state.json'), JSON.stringify(stateFor(manuscriptId)));
  writeFileSync(join(bookDir, 'manuscript.md'), `# Chapter One\n\n${OLD_TEXT}\n`);
  expect((await store.getOrHydrateManuscript(manuscriptId))?.sourceText).toContain('Alpha');
}

function bundleFor(manuscriptId: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    zip.addBuffer(Buffer.from(JSON.stringify({ schemaVersion: 1 })), 'MANIFEST.json');
    zip.addBuffer(Buffer.from(JSON.stringify(stateFor(manuscriptId))), 'state.json');
    zip.addBuffer(Buffer.from(`# Chapter One\n\n${NEW_TEXT}\n`), 'manuscript.md');
    zip.end();
  });
}

const nova = (): CharacterOutput => ({
  id: 'nova',
  name: 'Nova',
  role: 'character',
  color: '#abc',
  evidence: [{ quote: 'speaks' }],
});
function stub(seen: string[]): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    async runStage1Chapter(_m: string, _c: number, promptMd: string): Promise<Stage1ChapterOutput> {
      seen.push(promptMd);
      return { characters: [nova()] };
    },
    async runStage2Chapter(
      _m: string,
      chapterId: number,
      promptMd: string,
    ): Promise<Stage2ChapterOutput> {
      seen.push(promptMd);
      return {
        sentences: [
          { id: chapterId * 100 + 1, chapterId, characterId: 'nova', confidence: 0.9, text: 'x' },
        ],
      };
    },
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.resolve(null),
  } as Analyzer;
}
const sel = (a: Analyzer): AnalyzerSelection => ({
  analyzer: a,
  engine: 'gemini',
  model: 'gemini-3.6-flash',
  fallbackModel: null,
  fallbackEngine: null,
});

function stubAnalyzers(): string[] {
  const seen: string[] = [];
  g.__ovr_phase0 = sel(stub(seen));
  g.__ovr_phase1 = sel(stub(seen));
  return seen;
}

const framesOf = (
  res: request.Response,
): Array<{ kind: string; code?: string; message?: string }> =>
  res.text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)) as { kind: string; code?: string; message?: string });

async function waitWaiters(n: number, release: () => void): Promise<void> {
  const deadline = Date.now() + 8000;
  while (fileLock.__keyWaitersForTest(`book-op:${bookId}`) < n) {
    if (Date.now() > deadline) {
      release();
      throw new Error(`timed out waiting for ${n} book-op waiters`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Hold book-op, queue the overwrite, then queue `start` behind it, then release. */
async function queuedBehindOverwrite(
  bundle: Buffer,
  start: () => Promise<request.Response>,
): Promise<request.Response> {
  let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const holding = new Promise<void>((r) => (entered = r));
  const holder = opLock.withBookOp(bookId, () => {
    entered();
    return open;
  });
  let overwrite!: Promise<unknown>;
  let run!: Promise<request.Response>;
  try {
    await holding;
    overwrite = portable.importPortableBundle(bundle, { onConflict: 'overwrite' });
    await waitWaiters(1, release);
    run = start();
    startedRuns.push(run);
    await waitWaiters(2, release);
  } finally {
    release();
  }
  await holder;
  await overwrite;
  return run;
}

const mainStart = (id: string) => () =>
  request(app)
    .post(`/api/manuscripts/${id}/analysis`)
    .send({})
    .then((r) => r);
const subsetStart = (id: string) => () =>
  request(app)
    .post(`/api/manuscripts/${id}/analysis/chapters`)
    .send({ chapterIds: [1] })
    .then((r) => r);

describe('an analysis start runs on the record the lease names, not the one it captured while queuing', () => {
  it('control: overwrite completes, then the start -- the prompts carry the bundle text', async () => {
    const mid = uid('ctrl');
    await seedOld(mid);
    const seen = stubAnalyzers();
    await portable.importPortableBundle(await bundleFor(mid), { onConflict: 'overwrite' });
    await mainStart(mid)();
    expect(seen.some((p) => p.includes('Omega'))).toBe(true);
    expect(seen.some((p) => p.includes('Alpha'))).toBe(false);
  }, 30_000);

  it('main start queued behind a same-id overwrite analyses the bundle text', async () => {
    const mid = uid('main_same');
    await seedOld(mid);
    const seen = stubAnalyzers();
    await queuedBehindOverwrite(await bundleFor(mid), mainStart(mid));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((p) => p.includes('Alpha'))).toBe(false);
    expect(seen.some((p) => p.includes('Omega'))).toBe(true);
  }, 30_000);

  it('subset start queued behind a same-id overwrite analyses the bundle text', async () => {
    const mid = uid('subset_same');
    await seedOld(mid);
    const seen = stubAnalyzers();
    await queuedBehindOverwrite(await bundleFor(mid), subsetStart(mid));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((p) => p.includes('Alpha'))).toBe(false);
    expect(seen.some((p) => p.includes('Omega'))).toBe(true);
  }, 30_000);

  it('main start for the old id, queued behind a new-id overwrite, is refused and analyses nothing', async () => {
    const oldId = uid('main_old');
    await seedOld(oldId);
    const seen = stubAnalyzers();
    const res = await queuedBehindOverwrite(await bundleFor(uid('main_new')), mainStart(oldId));
    expect(seen).toHaveLength(0);
    const frames = framesOf(res);
    expect(frames.some((f) => f.kind === 'error' && f.code === 'unknown_manuscript')).toBe(true);
    expect(JSON.stringify(frames)).not.toContain(workspaceRoot);
  }, 30_000);

  it('subset start for the old id, queued behind a new-id overwrite, is refused and analyses nothing', async () => {
    const oldId = uid('subset_old');
    await seedOld(oldId);
    const seen = stubAnalyzers();
    const res = await queuedBehindOverwrite(await bundleFor(uid('subset_new')), subsetStart(oldId));
    expect(seen).toHaveLength(0);
    expect(framesOf(res).some((f) => f.kind === 'error' && f.code === 'unknown_manuscript')).toBe(
      true,
    );
  }, 30_000);

  /* Review pass 6 minor 1 -- pins the overwrite's eviction of the OLD id's
     record (`commitOverwrite`, scan-import-folder.ts): a client still holding
     the old id (a view left open from before the overwrite) must not analyse
     the replaced text into the overwritten book. The lease re-read above
     refuses such a start too, so the store assertion is what pins the
     eviction itself: without it the replaced manuscript stays in memory under
     the old id until a restart. */
  it('a start for the old id sent after a new-id overwrite is refused (unknown_manuscript)', async () => {
    const oldId = uid('stale_old');
    await seedOld(oldId);
    const seen = stubAnalyzers();
    await portable.importPortableBundle(await bundleFor(uid('stale_new')), {
      onConflict: 'overwrite',
    });
    expect(store.getManuscript(oldId)).toBeUndefined();
    const res = await mainStart(oldId)();
    expect(seen).toHaveLength(0);
    expect(framesOf(res).some((f) => f.kind === 'error' && f.code === 'unknown_manuscript')).toBe(
      true,
    );
  }, 30_000);
});
