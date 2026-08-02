/* Survival guard: cast-id-history.json must survive both cast PUT and reparse.

   Under the previous field-based design, two paths destroyed id history:
   1. Client cast PUT (rebuilds rows from allow-list, silently drops history field)
   2. applyReparse (rebuilds carryover rows from {id, name} + aliases + voice fields, then rm cast.json)

   This test proves the side-table design is immune to both: the history lives
   separately and persists regardless of cast.json lifecycle. If either test fails,
   a cleanup path is deleting the file — exclude cast-id-history.json there. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import {
  loadCastIdHistory,
  retireCharacterId,
  castIdHistoryPath,
} from './cast-id-history.js';

const AUTHOR = 'Test Author';
const SERIES = 'Survival Guard Tests';
const TITLE = 'Cast Id History Survival';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'cast-id-history-survival-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ bookStateRouter }, { makeBookId }] = await Promise.all([
    import('../routes/book-state.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });

  // Seed state.json
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_survival_test',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter 1', slug: 'chapter-one' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );

  // Seed manuscript
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');

  // Seed initial cast.json with a character
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [
        { id: 'mayrin', name: 'Mayrin' },
        { id: 'narrator', name: 'Narrator' },
      ],
    }),
  );

  // Set up Express app
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('cast-id-history survival', () => {
  it('a client cast PUT leaves the id history intact', async () => {
    // Seed history with a mapping: mayrin -> mairin
    const historyBefore = await retireCharacterId(bookDir, 'mayrin', 'mairin');

    // Verify the history was written
    const loadedBefore = await loadCastIdHistory(bookDir);
    expect(loadedBefore.supersededBy).toHaveProperty('mayrin', 'mairin');

    // Now do a PUT that knows nothing about the history
    const newCast = {
      characters: [
        { id: 'mairin', name: 'Mairin (renamed)' },
        { id: 'narrator', name: 'Narrator' },
      ],
    };

    const putRes = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'cast', patch: newCast });

    expect(putRes.status).toBe(204);

    // The history file must still exist and contain the mapping
    const historyPath = castIdHistoryPath(bookDir);
    expect(existsSync(historyPath)).toBe(true);

    const loadedAfter = await loadCastIdHistory(bookDir);
    expect(loadedAfter.supersededBy).toHaveProperty('mayrin', 'mairin');
  });

  it('a reparse leaves the id history intact', async () => {
    // Seed history with a mapping: narrator -> unknown-narrator
    await retireCharacterId(bookDir, 'narrator', 'unknown-narrator');

    const loadedBefore = await loadCastIdHistory(bookDir);
    expect(loadedBefore.supersededBy).toHaveProperty('narrator', 'unknown-narrator');

    // Verify the file exists before reparse
    const historyPath = castIdHistoryPath(bookDir);
    expect(existsSync(historyPath)).toBe(true);

    // Now trigger reparse, which deletes cast.json and other files
    const reParseRes = await request(app)
      .post(`/api/books/${bookId}/reparse`)
      .set('Content-Type', 'application/json')
      .send({});

    expect(reParseRes.status).toBe(200);

    // The history file must STILL exist after reparse deletes cast.json
    expect(existsSync(historyPath)).toBe(true);

    const loadedAfter = await loadCastIdHistory(bookDir);
    expect(loadedAfter.supersededBy).toHaveProperty('narrator', 'unknown-narrator');
  });
});
