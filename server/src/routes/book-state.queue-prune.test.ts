/* Plan 102 — book-delete prunes matching queue entries atomically.
 *
 * Standalone test for the queue-prune hook on DELETE /api/books/:bookId
 * (book-state.ts:910-927 + new hook). Other book-state tests live in
 * book-state.test.ts / book-state.hydrate.test.ts / etc. — this one is
 * isolated so the plan-102 contract has its own focused regression. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE_A = 'Delete Me';
const TITLE_B = 'Keep Me';

let workspaceRoot: string;
let app: Express;
let bookIdA: string;
let bookIdB: string;

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'queue-prune-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ bookStateRouter }, { makeBookId }] = await Promise.all([
    import('./book-state.js'),
    import('../workspace/paths.js'),
  ]);
  bookIdA = makeBookId(AUTHOR, SERIES, TITLE_A);
  bookIdB = makeBookId(AUTHOR, SERIES, TITLE_B);

  for (const title of [TITLE_A, TITLE_B]) {
    const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: makeBookId(AUTHOR, SERIES, title),
        manuscriptId: `m_${title.toLowerCase().replace(/\s+/g, '_')}`,
        title,
        author: AUTHOR,
        series: SERIES,
        updatedAt: '2026-05-23T00:00:00.000Z',
        schema: 1,
        chapters: [],
      }),
    );
  }

  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('DELETE /api/books/:bookId prunes queue entries', () => {
  it('drops every entry matching the deleted bookId, leaves other books alone', async () => {
    const { queueJsonPath } = await import('../workspace/paths.js');
    const { writeQueueFile, readQueueFile } = await import('../workspace/queue-migrate.js');

    /* Seed the workspace queue with three entries: 2 from book A, 1 from
       book B. */
    await writeQueueFile(queueJsonPath(), {
      entries: [
        {
          id: 'a1',
          bookId: bookIdA,
          chapterId: 1,
          scope: 'this',
          addedAt: '2026-05-23T00:00:00.000Z',
          status: 'queued',
          order: 0,
        },
        {
          id: 'b1',
          bookId: bookIdB,
          chapterId: 1,
          scope: 'this',
          addedAt: '2026-05-23T00:00:01.000Z',
          status: 'queued',
          order: 1,
        },
        {
          id: 'a2',
          bookId: bookIdA,
          chapterId: 2,
          scope: 'this',
          addedAt: '2026-05-23T00:00:02.000Z',
          status: 'queued',
          order: 2,
        },
      ],
      paused: false,
    });

    /* Delete book A. */
    const res = await request(app).delete(`/api/books/${bookIdA}`);
    expect(res.status).toBe(204);

    /* Book A's directory is gone. */
    expect(existsSync(join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE_A))).toBe(false);
    /* Book B's directory remains. */
    expect(existsSync(join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE_B))).toBe(true);

    /* Queue has only b1 left, renumbered to order 0. */
    const queue = await readQueueFile(queueJsonPath());
    expect(queue.entries).toHaveLength(1);
    expect(queue.entries[0]).toMatchObject({ id: 'b1', bookId: bookIdB, order: 0 });
  });

  it('does not error when the queue file is empty or absent on delete', async () => {
    const { queueJsonPath } = await import('../workspace/paths.js');
    const { rm } = await import('node:fs/promises');
    await rm(queueJsonPath(), { force: true });

    /* Re-seed book B so the delete actually finds something to drop. */
    const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE_B);
    if (!existsSync(bookDir)) {
      mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
      const { makeBookId } = await import('../workspace/paths.js');
      writeFileSync(
        join(bookDir, '.audiobook', 'state.json'),
        JSON.stringify({
          bookId: makeBookId(AUTHOR, SERIES, TITLE_B),
          manuscriptId: 'm_keep_me_2',
          title: TITLE_B,
          author: AUTHOR,
          series: SERIES,
          updatedAt: '2026-05-23T00:00:00.000Z',
          schema: 1,
          chapters: [],
        }),
      );
    }

    /* Should succeed with no queue file present. */
    const res = await request(app).delete(`/api/books/${bookIdB}`);
    expect(res.status).toBe(204);
  });
});
