/* Integration test for GET /api/books/:bookId/qa-report.
   Workspace tempdir + supertest pattern matches revisions.test.ts. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'QA Report Test';
const SERIES = 'Standalones';
const TITLE = 'QA Report Book';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-qa-report-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ qaReportRouter }, { makeBookId }] = await Promise.all([
    import('./qa-report.js'),
    import('../workspace/paths.js'),
  ]);
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
});
