/* #3787 — GET /api/library/active-analyses through the real libraryRouter: the `{ snapshots }`
   envelope and every entry honour the openapi contract (the scan-level test in
   workspace/active-analyses.test.ts never sees the envelope). */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { expectMatchesSchema } from '../test-utils/openapi-analysis-state.js';

let workspaceRoot: string;
let app: Express;

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-library-active-analyses-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ libraryRouter }, { makeBookId }] = await Promise.all([
    import('./library.js'),
    import('../workspace/paths.js'),
  ]);
  const title = 'Halted Book';
  const bookId = makeBookId('Test Author', 'Standalones', title);
  const bookDir = join(workspaceRoot, 'books', 'Test Author', 'Standalones', title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title,
      author: 'Test Author',
      series: null,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: false,
      chapters: [{ id: 1, title: 'Chapter 1', slug: 'chapter-one' }],
      coverGradient: ['#000', '#fff'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  writeFileSync(
    join(bookDir, '.audiobook', 'analysis-state.json'),
    JSON.stringify({
      manuscriptId: `m_${bookId}`,
      phaseId: 2,
      phaseLabel: 'Attribution',
      phaseProgress: 0.5,
      state: 'halted',
      engine: 'local',
      kind: 'subset',
      subsetChapterIds: [1],
      haltCode: 'attribution_drift',
      haltReason: 'demoted to narrator',
      lastTickAt: 100,
      writtenAt: 200,
    }),
  );
  app = express();
  app.use('/api/library', libraryRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('GET /api/library/active-analyses', () => {
  it('answers the openapi { snapshots } envelope with schema-conformant entries (#3787)', async () => {
    const res = await request(app).get('/api/library/active-analyses');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['snapshots']);
    expect(Array.isArray(res.body.snapshots)).toBe(true);
    expect(res.body.snapshots).toHaveLength(1);
    for (const snap of res.body.snapshots) expectMatchesSchema('ActiveAnalysisSummary', snap);
    expect(res.body.snapshots[0]).toMatchObject({ state: 'halted', engine: 'local', kind: 'subset' });
  });
});
