/* R55 (PR #4103 pass 5, owner ruling 2026-11-12) — a cast-identity write is refused
   while an analysis job is registered for the book.

   A write that changes the roster's id set, or writes merge / `supersededBy` history,
   answers 409 `book_busy` while `runBookJob(bookId, 'analysis', ...)` holds the book: the
   same signal the whole-slice cast PUT's 409 uses (`book-state.ts`). A write that only
   touches voice, style or decline markers stays live, and dismissing a suggestion stays
   live (its reversal is a spec promise). Each refused route is paired with a control: the
   same request once the job's token is released goes through.

   The check sits inside the write's own book-op span. A registration takes book-op
   (`runBookJob`), so a job cannot register between the check and the write. The TOCTOU
   case below pins that: the request is parked on book-op, a job registers while it waits,
   and the request is still refused.

   Driven through the real assembled app (`app.ts`), imported after WORKSPACE_DIR is set. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Busy Author';
const SERIES = 'Busy Series';
const TITLE_A = 'Book A';
const TITLE_B = 'Book B';

let workspaceRoot: string;
let app: Express;
let bookId: string;
let otherBookId: string;
let bookDir: string;
let otherDir: string;

const state = (id: string, title: string, position: number) => ({
  bookId: id,
  manuscriptId: `m_r55_${position}`,
  title,
  author: AUTHOR,
  series: SERIES,
  seriesPosition: position,
  isStandalone: false,
  manuscriptFile: 'manuscript.txt',
  castConfirmed: true,
  chapters: [{ id: 1, title: 'One', slug: '01-one' }],
  coverGradient: ['#000', '#fff'],
  createdAt: '2026-11-12T00:00:00.000Z',
  updatedAt: '2026-11-12T00:00:00.000Z',
});

const CAST = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator', lines: 2, scenes: 1 },
  { id: 'wren', name: 'Wren', role: 'lead', color: 'eliza', lines: 2, scenes: 1 },
  { id: 'marlow', name: 'Marlow Halden', role: 'sidekick', color: 'halloran', lines: 1, scenes: 1, aliases: ['Marl'] },
];
const EDITS = [
  { id: 1, chapterId: 1, characterId: 'wren', text: 'Hello.' },
  { id: 2, chapterId: 1, characterId: 'wren', text: 'Where am I?' },
  { id: 3, chapterId: 1, characterId: 'marlow', text: 'Whoa there.' },
];

function writeBook(dir: string, s: ReturnType<typeof state>): void {
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, '.audiobook', 'state.json'), JSON.stringify(s));
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters: CAST }));
  writeFileSync(join(dir, '.audiobook', 'manuscript-edits.json'), JSON.stringify({ sentences: EDITS }));
  /* A rejected pair the reject route's DELETE can undo. */
  writeFileSync(
    join(dir, '.audiobook', 'cast-id-history.json'),
    JSON.stringify({ schema: 1, supersededBy: {}, rejectedPairs: [{ from: 'ghost', to: 'marlow' }] }),
  );
}

/** Every file under the book's `.audiobook/`, by name. */
function snapshot(dir: string): Record<string, string> {
  const d = join(dir, '.audiobook');
  return Object.fromEntries(readdirSync(d).map((f) => [f, readFileSync(join(d, f), 'utf8')]));
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-identity-busy-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { makeBookId } = await import('../workspace/paths.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE_A);
  otherBookId = makeBookId(AUTHOR, SERIES, TITLE_B);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE_A);
  otherDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE_B);
  ({ app } = await import('../app.js'));
});

beforeEach(() => {
  writeBook(bookDir, state(bookId, TITLE_A, 2));
  writeBook(otherDir, state(otherBookId, TITLE_B, 1));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

/** Register an analysis job the real way (`runBookJob`), held open until `finish`. */
async function holdAnalysis(): Promise<{ finish: () => Promise<void> }> {
  const { runBookJob } = await import('../workspace/book-jobs.js');
  const bookOp = await import('../workspace/book-op-lock.js');
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const reg = await runBookJob(bookId, 'analysis', () => gate);
  if (reg === bookOp.BOOK_GONE) throw new Error('test setup: book not found');
  return {
    finish: async () => {
      open();
      await reg.done;
    },
  };
}

type Call = { name: string; send: () => request.Test };
const post = (path: string, body: Record<string, unknown>) => () =>
  request(app).post(`/api/books/${bookId}${path}`).set('Content-Type', 'application/json').send(body);
const del = (path: string, body: Record<string, unknown>) => () =>
  request(app).delete(`/api/books/${bookId}${path}`).set('Content-Type', 'application/json').send(body);

/* Every route whose write changes the roster's id set or writes merge / `supersededBy`
   history. (A character delete is a whole-slice cast PUT, refused by book-state.test.ts.) */
const REFUSED: Call[] = [
  { name: 'POST /cast/merge', send: post('/cast/merge', { sourceId: 'wren', targetId: 'marlow' }) },
  {
    name: 'POST /cast/merge (downgrade into a bucket)',
    send: post('/cast/merge', { sourceId: 'wren', targetId: 'unknown-male' }),
  },
  {
    name: 'POST /cast/merge-suggestions/accept',
    send: post('/cast/merge-suggestions/accept', { sourceId: 'wren', targetId: 'marlow' }),
  },
  {
    name: 'POST /cast/:id/link-orphan-match',
    send: post('/cast/marlow/link-orphan-match', { orphanedId: 'old-marlow' }),
  },
  {
    name: 'POST /cast/:id/reject-orphan-match',
    send: post('/cast/marlow/reject-orphan-match', { orphanedId: 'stray-id' }),
  },
  {
    name: 'DELETE /cast/:id/reject-orphan-match',
    send: del('/cast/marlow/reject-orphan-match', { orphanedId: 'ghost' }),
  },
  {
    name: 'POST /cast/unlink-alias',
    send: post('/cast/unlink-alias', { sourceCharacterId: 'marlow', aliasName: 'Marl' }),
  },
  { name: 'POST /cast/create', send: post('/cast/create', { name: 'Brand New Person' }) },
  {
    name: 'POST /cast/add-from-roster',
    send: () =>
      request(app)
        .post(`/api/books/${bookId}/cast/add-from-roster`)
        .set('Content-Type', 'application/json')
        .send({ targetBookId: otherBookId, targetCharacterId: 'wren' }),
  },
];

describe('R55: a cast-identity write is refused with 409 book_busy while an analysis runs', () => {
  describe.each(REFUSED)('$name', ({ send }) => {
    it('answers 409 book_busy while the job is registered, and writes nothing', async () => {
      const before = snapshot(bookDir);
      const job = await holdAnalysis();
      try {
        const res = await send();
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('book_busy');
        expect(res.body.error).toMatch(/read-only until the analysis finishes/);
        expect(res.text).not.toContain(workspaceRoot);
        expect(snapshot(bookDir)).toEqual(before);
      } finally {
        await job.finish();
      }
    });

    it('control: once the job is released the same request goes through', async () => {
      const job = await holdAnalysis();
      await job.finish();
      const res = await send();
      expect(res.status).toBe(200);
    });
  });

  /* A lock-free check before the book-op span would pass here: the job registers while
     the request is parked on book-op, after any such check and before the write. */
  it.each([
    ['POST /cast/merge', post('/cast/merge', { sourceId: 'wren', targetId: 'marlow' })],
    ['POST /cast/merge-suggestions/accept', post('/cast/merge-suggestions/accept', { sourceId: 'wren', targetId: 'marlow' })],
  ])('%s: a job registered while the request waits on book-op still refuses it (no TOCTOU)', async (_n, send) => {
    const { withBookOp, __addBookJobToken } = await import('../workspace/book-op-lock.js');
    const { __keyWaitersForTest } = await import('../workspace/file-lock.js');
    const before = snapshot(bookDir);
    let releaseOp!: () => void;
    const held = new Promise<void>((r) => (releaseOp = r));
    let acquired!: () => void;
    const holding = new Promise<void>((r) => (acquired = r));
    const op = withBookOp(bookId, async () => {
      acquired();
      await held;
    });
    await holding;
    const pending = send().then((r) => r);
    for (let i = 0; i < 500 && __keyWaitersForTest(`book-op:${bookId}`) === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(__keyWaitersForTest(`book-op:${bookId}`)).toBe(1);
    /* What `runBookJob` does under book-op; it cannot be called here, since this test
       already holds book-op and runBookJob would queue behind the request. */
    const releaseJob = __addBookJobToken(bookId, 'analysis');
    releaseOp();
    try {
      await op;
      const res = await pending;
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('book_busy');
      expect(snapshot(bookDir)).toEqual(before);
    } finally {
      releaseJob();
    }
  });
});

/* Writes that only touch voice, style or decline markers stay live mid-run, and so does a
   dismissal. B109 relies on designing a voice mid-run (its route tests live with it). */
describe('R55: a write that leaves the id set and the identity history alone stays live', () => {
  const LIVE: Call[] = [
    {
      name: 'POST /cast/merge-suggestions/dismiss',
      send: post('/cast/merge-suggestions/dismiss', { sourceId: 'wren', targetId: 'marlow' }),
    },
    { name: 'POST /cast/add-alias', send: post('/cast/add-alias', { characterId: 'wren', aliasName: 'Wrenny' }) },
    {
      name: 'POST /cast/:id/not-linked-to',
      send: () =>
        request(app)
          .post(`/api/books/${bookId}/cast/wren/not-linked-to`)
          .set('Content-Type', 'application/json')
          .send({ otherBookId, otherCharacterId: 'marlow' }),
    },
  ];
  it.each(LIVE)('$name answers 200 while the job is registered', async ({ send }) => {
    const job = await holdAnalysis();
    try {
      const res = await send();
      expect(res.status).toBe(200);
    } finally {
      await job.finish();
    }
  });
});
