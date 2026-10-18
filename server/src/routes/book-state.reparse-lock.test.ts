/* #3400, pass 8 — reparse / replace-manuscript's `state.json` write is a book-
   locked step of its own, taken AFTER the cast / audio / cache work (never
   while holding `cast`: the global order is `cast` -> `book`).

   Before: `applyReparse` wrote `{ ...state, chapters }` from a read taken
   before the (slow) parse, with no book lock. Two consequences, one test each:
     (1) a chapter restructure holds the book lock across its writes; the
         unlocked reparse landed in the middle of them and the end state was a
         mix (reparse's chapter list + analysis cache the restructure rebuilt
         AFTER reparse had wiped it);
     (2) an `excluded` POST that landed between the reparse's read and its
         write was reverted, because the carryover was computed from the stale
         read.

   Deterministic: the restructure is held with a gate on `rewriteChapterSlugs`
   (it runs after the restructure's state/edits/hints writes, still under the
   lock); the reparse is held with a gate on `parseManuscript`. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

interface Gate {
  reached: Promise<void>;
  release: () => void;
  wait: () => Promise<void>;
}
function makeGate(): Gate {
  let release!: () => void;
  let reached!: () => void;
  const reachedP = new Promise<void>((r) => (reached = r));
  const open = new Promise<void>((r) => (release = r));
  return {
    reached: reachedP,
    release,
    wait: async () => {
      reached();
      await open;
    },
  };
}
const gates = vi.hoisted(() => ({
  slugs: null as null | { wait: () => Promise<void> },
  parse: null as null | { wait: () => Promise<void> },
  reset: null as null | { wait: () => Promise<void> },
}));

vi.mock('../audio/rewrite-chapter-slugs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../audio/rewrite-chapter-slugs.js')>();
  return {
    ...actual,
    rewriteChapterSlugs: async (...args: Parameters<typeof actual.rewriteChapterSlugs>) => {
      const g = gates.slugs;
      gates.slugs = null;
      if (g) await g.wait();
      return actual.rewriteChapterSlugs(...args);
    },
  };
});
/* PR #3714 review pass 4 -- holds a reparse INSIDE its book-op commit (the
   revisions reset is one of applyReparse's arms). */
vi.mock('../workspace/revisions-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/revisions-store.js')>();
  return {
    ...actual,
    resetRevisions: async (...args: Parameters<typeof actual.resetRevisions>) => {
      const g = gates.reset;
      gates.reset = null;
      if (g) await g.wait();
      return actual.resetRevisions(...args);
    },
  };
});
vi.mock('../parsers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../parsers/index.js')>();
  return {
    ...actual,
    parseManuscript: async (...args: Parameters<typeof actual.parseManuscript>) => {
      const g = gates.parse;
      gates.parse = null;
      if (g) await g.wait();
      return actual.parseManuscript(...args);
    },
  };
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(resolve(__dirname, '..', '..'), 'handoff', 'cache');

const AUTHOR = 'Reparse Lock Test';
const SERIES = 'Standalones';
const TITLE = 'Reparse Lock Book';
const MANUSCRIPT_ID = 'm_reparse_lock_test';
const MANUSCRIPT_BODY =
  '# Chapter One\n\nAlpha first.\nAlpha second.\n\n# Chapter Two\n\nBeta first.\nBeta second.\n\n# Chapter Three\n\nGamma first.\nGamma second.\n';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let cachePath: string;

function statePath(): string {
  return join(bookDir, '.audiobook', 'state.json');
}
function readState(): {
  castConfirmed?: boolean;
  chapters: Array<{ id: number; title: string; excluded?: boolean }>;
} {
  return JSON.parse(readFileSync(statePath(), 'utf8'));
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-reparse-lock-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { bookStateRouter } = await import('./book-state.js');
  const { chaptersRestructureRouter } = await import('./chapters-restructure.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  cachePath = join(CACHE_DIR, `${MANUSCRIPT_ID}.json`);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT_BODY);
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
  app.use('/api/books', chaptersRestructureRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  if (cachePath && existsSync(cachePath)) rmSync(cachePath, { force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(async () => {
  gates.slugs = null;
  gates.parse = null;
  gates.reset = null;
  writeFileSync(
    statePath(),
    JSON.stringify({
      bookId,
      manuscriptId: MANUSCRIPT_ID,
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapters: [
        { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
        { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
        { id: 3, title: 'Chapter Three', slug: '03-chapter-three' },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(
    join(bookDir, '.audiobook', 'manuscript-edits.json'),
    JSON.stringify({
      sentences: [
        { id: 1, chapterId: 1, characterId: 'narr', text: 'Alpha first.' },
        { id: 1, chapterId: 2, characterId: 'narr', text: 'Beta first.' },
        { id: 1, chapterId: 3, characterId: 'narr', text: 'Gamma first.' },
      ],
    }),
  );
  for (const f of ['cast.json', 'cast-reuse-carryover.json', 'change-log.json', 'revisions.json']) {
    rmSync(join(bookDir, '.audiobook', f), { force: true });
  }
  rmSync(join(bookDir, 'audio'), { recursive: true, force: true });
  rmSync(cachePath, { force: true });
  const { removeManuscript } = await import('../store/manuscripts.js');
  removeManuscript(MANUSCRIPT_ID);
});

describe('reparse — state.json write is serialised with the chapter restructure', () => {
  it('waits for an in-flight restructure; end state is the serial outcome (restructure, then reparse)', async () => {
    const gate = makeGate();
    gates.slugs = gate;
    const restructure = request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [2, 3] })
      .then((r) => r);
    await gate.reached; // restructure holds the book lock; state.json already merged
    expect(readState().chapters).toHaveLength(2);

    const { __keyWaitersForTest } = await import('../workspace/file-lock.js');
    const reparse = request(app)
      .post(`/api/books/${bookId}/reparse`)
      .then((r) => r);
    /* Event-based (PR #3714): the reparse parses with no lock held, then commits
       under `book-op`, which the restructure holds -- wait until it is genuinely
       queued there, never a fixed sleep. */
    const deadline = Date.now() + 8000;
    while (__keyWaitersForTest(`book-op:${bookId}`) < 1) {
      if (Date.now() > deadline) {
        gate.release();
        throw new Error('timed out waiting for the reparse to queue on book-op');
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    /* THE LOCK: the reparse must not have written state.json while the
       restructure still holds the lock (the old unlocked write landed here). */
    const midFlight = readState().chapters.length;
    gate.release(); // always release, so a red run cannot hang the next test
    expect(midFlight).toBe(2);
    const [rs, rp] = await Promise.all([restructure, reparse]);
    expect(rs.status).toBe(200);
    expect(rp.status).toBe(200);

    const final = readState();
    expect(final.chapters.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(final.castConfirmed).toBe(false);
    /* Reparse is last: its analysis-cache wipe is the final word. The old code
       wiped it mid-restructure and the restructure then rebuilt it. */
    expect(existsSync(cachePath)).toBe(false);
    const { getManuscript } = await import('../store/manuscripts.js');
    expect(getManuscript(MANUSCRIPT_ID)?.chapterHints).toHaveLength(3);
  });

  it('an exclude that lands between the reparse read and its write survives (decided from the fresh read)', async () => {
    const gate = makeGate();
    gates.parse = gate;
    const reparse = request(app)
      .post(`/api/books/${bookId}/reparse`)
      .then((r) => r);
    await gate.reached; // reparse has read state.json (stale) and is parked at the parse

    let ex;
    try {
      ex = await request(app).post(`/api/books/${bookId}/chapters/1/exclude`).send({ excluded: true });
    } finally {
      gate.release();
    }
    expect(ex.status).toBe(200);
    expect(readState().chapters.find((c) => c.id === 1)?.excluded).toBe(true);
    const rp = await reparse;
    expect(rp.status).toBe(200);
    expect(readState().chapters.find((c) => c.id === 1)?.excluded).toBe(true);
  });
});

describe('a restructure queued behind a reparse commits to the LIVE ManuscriptRecord (PR #3714 review pass 4)', () => {
  it('state.json and the in-memory chapter hints agree after the merge', async () => {
    /* The merge prepares (and hydrates the record) before book-op; the reparse
       commit then REPLACES the store entry. A merge that wrote its hints into the
       record it prepared left the live one on the reparse's 3 chapters while
       state.json had 2, until a restart. */
    const { getOrHydrateManuscript, getManuscript } = await import('../store/manuscripts.js');
    const { __keyWaitersForTest } = await import('../workspace/file-lock.js');
    await getOrHydrateManuscript(MANUSCRIPT_ID);

    const gate = makeGate();
    gates.reset = gate;
    const reparse = request(app)
      .post(`/api/books/${bookId}/reparse`)
      .then((r) => r);
    let merge!: Promise<request.Response>;
    try {
      await gate.reached; // the reparse holds book-op, inside its arms
      merge = request(app)
        .post(`/api/books/${bookId}/chapters/merge`)
        .send({ chapterIds: [2, 3] })
        .then((r) => r);
      const deadline = Date.now() + 8000;
      while (__keyWaitersForTest(`book-op:${bookId}`) < 1) {
        if (Date.now() > deadline) throw new Error('timed out waiting for the merge to queue on book-op');
        await new Promise((r) => setTimeout(r, 5));
      }
    } finally {
      gate.release();
    }
    const [rp, rs] = await Promise.all([reparse, merge]);
    expect(rp.status).toBe(200);
    expect(rs.status).toBe(200);
    expect(readState().chapters).toHaveLength(2);
    expect(getManuscript(MANUSCRIPT_ID)?.chapterHints).toHaveLength(2);
  });
});
