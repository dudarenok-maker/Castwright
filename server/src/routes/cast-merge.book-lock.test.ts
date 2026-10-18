/* #3400, pass 7 — the cast merge rewrites manuscript-edits.json, a file a
   chapter restructure also rewrites under the per-book lock. The merge holds
   the cast lock (outer), so the lock order is cast -> book (book-lock.ts header)
   and it takes the book lock around its edits read -> write.

   Deterministic: the merge's FIRST manuscript-edits.json write is paused for
   40 ms and a stand-in restructure (a lock-taking read-modify-write that re-keys
   every sentence's chapter) is started in the pause, from the test's own async
   context (started inside the paused writer it would inherit the merge's held
   book lock and run inline).
     - UNLOCKED: the merge already read the old edits; the restructure lands; the
       merge's stale write lands last and reverts the re-keying. RED.
     - LOCKED: the restructure queues behind the merge. GREEN. */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const hooks = vi.hoisted(() => ({
  beforeEditsWrite: undefined as undefined | (() => Promise<void>),
}));

vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../workspace/state-io.js')>();
  return {
    ...orig,
    writeJsonAtomic: (async (path: string, ...rest: unknown[]) => {
      if (path.endsWith('manuscript-edits.json')) {
        const fire = hooks.beforeEditsWrite;
        if (fire) {
          hooks.beforeEditsWrite = undefined;
          await fire();
        }
      }
      return (orig.writeJsonAtomic as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof orig.writeJsonAtomic,
  };
});

const AUTHOR = 'Merge Lock';
const SERIES = 'Standalones';
const TITLE = 'Merge Lock Book';

let workspaceRoot: string;
let bookDir: string;
let bookId: string;
let app: Express;
let lock: typeof import('../workspace/book-lock.js');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const editsPath = () => join(bookDir, '.audiobook', 'manuscript-edits.json');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-merge-lock-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ castMergeRouter }, { makeBookId }] = await Promise.all([
    import('./cast-merge.js'),
    import('../workspace/paths.js'),
  ]);
  lock = await import('../workspace/book-lock.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_merge_lock',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'One', slug: '01-one', uuid: 'u1' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [
        { id: 'wren-sparrow', name: 'Wren Sparrow', role: 'protagonist', color: 'eliza', lines: 1, scenes: 1 },
        { id: 'wren', name: 'Wren', role: 'protagonist', color: 'eliza', lines: 2, scenes: 1 },
      ],
    }),
  );
  writeFileSync(
    editsPath(),
    JSON.stringify({
      sentences: [
        { id: 1, chapterId: 1, characterId: 'wren', text: 'Hello.' },
        { id: 2, chapterId: 1, characterId: 'wren-sparrow', text: 'Hi.' },
      ],
    }),
  );
  app = express();
  app.use(express.json());
  app.use('/api/books', castMergeRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('cast merge: manuscript-edits.json write holds the book lock (#3400)', () => {
  it('a restructure landing during the merge keeps its re-keying and the merge keeps its remap', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const restructure = gate.then(() =>
      lock.withBookLock(bookId, async () => {
        const cur = JSON.parse(readFileSync(editsPath(), 'utf8'));
        cur.sentences = cur.sentences.map((s: { chapterId: number }) => ({ ...s, chapterId: s.chapterId + 10 }));
        writeFileSync(editsPath(), JSON.stringify(cur));
      }),
    );
    hooks.beforeEditsWrite = async () => {
      open();
      await sleep(40);
    };
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/merge`)
      .send({ sourceId: 'wren', targetId: 'wren-sparrow' });
    expect(res.status).toBe(200);
    await restructure;
    const sentences = JSON.parse(readFileSync(editsPath(), 'utf8')).sentences as Array<{
      chapterId: number;
      characterId: string;
    }>;
    expect(sentences.map((s) => s.chapterId)).toEqual([11, 11]);
    expect(sentences.map((s) => s.characterId)).toEqual(['wren-sparrow', 'wren-sparrow']);
  });
});
