/* Integration test for GET /api/books/:bookId/qa-report and
   POST /api/books/:bookId/resume-scoring.
   Workspace tempdir + supertest pattern matches revisions.test.ts. */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

/* Mocks findBookByBookId so a sentinel bookId ('THROW_TRIGGER') exercises the
   route's catch block, proving a thrown error from the disk-read path
   returns a clean 500 instead of an unhandled rejection. Real lookups pass
   through to the actual implementation. */
vi.mock('../workspace/scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/scan.js')>();
  return {
    ...actual,
    findBookByBookId: async (bookId: string) => {
      if (bookId === 'THROW_TRIGGER') {
        throw new Error('disk read failed');
      }
      return actual.findBookByBookId(bookId);
    },
  };
});

/* srv-36 hardening (Task 7) — stub ONLY scoreBook so the resume-scoring
   route's "triggers scoring" test can observe the route → triggerScoring
   wiring without needing a real 12-anchor centroid fixture (scoreBook
   itself is already exhaustively covered in aggregate.test.ts and
   generation.test.ts's own "triggerScoring" suite). Unlike
   generation-spk.test.ts's full-replacement mock of this module (which only
   needs scoreBook, since generation.ts only imports scoreBook from here),
   this file's existing GET /qa-report route ALSO reaches into this module
   indirectly (via buildAudioQaReport), so every other export must pass
   through to the real implementation. */
vi.mock('../audio/render-integrity/aggregate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../audio/render-integrity/aggregate.js')>();
  return {
    ...actual,
    scoreBook: vi.fn(async () => ({ usedQwenTiers: { keep06: false, keep17: false }, mismatchCount: 0 })),
  };
});

const AUTHOR = 'QA Report Test';
const SERIES = 'Standalones';
const TITLE = 'QA Report Book';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
/* Dynamically imported inside beforeAll, AFTER process.env.WORKSPACE_DIR is
   set below — generation.ts (and, transitively, aggregate.ts) statically
   import workspace/paths.js, whose WORKSPACE_ROOT is computed once at
   module load from that env var (same reason qa-report.js itself is
   dynamically imported here — a top-level static import of any of these
   at this file's own load time would compute WORKSPACE_ROOT from the real
   default workspace dir, before the tempdir below even exists). */
let __registerFakeJobForTest: typeof import('./generation.js').__registerFakeJobForTest;
let __awaitScoringSettled: typeof import('./generation.js').__awaitScoringSettled;
let scoreBook: typeof import('../audio/render-integrity/aggregate.js').scoreBook;
/* Captured (rather than a static top-level `import * as cfg`) so the
   vi.spyOn below reliably intercepts the SAME binding generation.ts's
   `triggerScoring` resolves — mirrors generation.test.ts's own
   `configModule` capture for its triggerScoring describe block. */
let configModule: typeof import('../config/resolver.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-qa-report-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  // Resolve the mocked aggregate.js module FIRST, standalone — importing it
  // concurrently alongside generation.js (which transitively imports it too)
  // in the same Promise.all raced two "first touch" resolutions of the same
  // to-be-mocked module and left generation.ts's binding pointing at a stale
  // pre-mock reference. Awaiting it alone first guarantees the vi.mock
  // factory has fully settled before anything else touches the module.
  const aggregateModule = await import('../audio/render-integrity/aggregate.js');
  scoreBook = aggregateModule.scoreBook;

  const [{ qaReportRouter }, { makeBookId }, generationModule, configMod] = await Promise.all([
    import('./qa-report.js'),
    import('../workspace/paths.js'),
    import('./generation.js'),
    import('../config/resolver.js'),
  ]);
  __registerFakeJobForTest = generationModule.__registerFakeJobForTest;
  __awaitScoringSettled = generationModule.__awaitScoringSettled;
  configModule = configMod;
  bookId = makeBookId(AUTHOR, SERIES, TITLE);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  mkdirSync(join(bookDir, 'audio'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), '# Chapter One\nbody.');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_qa_report_test',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );

  app = express();
  app.use(express.json());
  app.use('/api/books', qaReportRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('GET /api/books/:bookId/qa-report', () => {
  it('returns a BookQaReport for an existing book', async () => {
    const res = await request(app).get(`/api/books/${bookId}/qa-report`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      bookId,
      chaptersRendered: 0,
      chaptersTotal: 0,
      configDrift: { counts: { mild: 0, moderate: 0, severe: 0 } },
    });
  });

  it('404s for an unknown book', async () => {
    const res = await request(app).get('/api/books/does-not-exist/qa-report');
    expect(res.status).toBe(404);
  });

  it('returns 500 when the underlying lookup throws', async () => {
    const res = await request(app).get('/api/books/THROW_TRIGGER/qa-report');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'disk read failed' });
  });
});

describe('POST /:bookId/resume-scoring', () => {
  it('triggers scoring and returns 202', async () => {
    vi.mocked(scoreBook).mockClear();
    const configSpy = vi.spyOn(configModule, 'configValue').mockReturnValue(true);
    try {
      const res = await request(app).post(`/api/books/${bookId}/resume-scoring`);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ started: true });
      // triggerScoring is fire-and-forget — wait for the background run to
      // settle (same pattern as generation.test.ts's triggerScoring suite)
      // before asserting on the scoreBook call it makes.
      await __awaitScoringSettled(bookId);
      expect(scoreBook).toHaveBeenCalledWith(expect.any(String), [], [], expect.any(Object));
    } finally {
      configSpy.mockRestore();
    }
  });

  it('returns 409 when the book has an active generation job', async () => {
    const cleanup = __registerFakeJobForTest(bookId, []);
    try {
      const res = await request(app).post(`/api/books/${bookId}/resume-scoring`);
      expect(res.status).toBe(409);
    } finally {
      cleanup();
    }
  });

  it('returns 404 for an unknown bookId', async () => {
    const res = await request(app).post('/api/books/does-not-exist/resume-scoring');
    expect(res.status).toBe(404);
  });
});
