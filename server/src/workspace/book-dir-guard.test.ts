/* Unit/integration tests for book-dir-guard.ts (issue #2196): the verify-a-
   write-target gate that refrains from re-creating a stale book folder on a
   miss and instead invalidates + re-hydrates the in-memory manuscript from the
   workspace tree.

   Test surface mirrors the established server pattern: set WORKSPACE_DIR to a
   tempdir before deferring the module loads (paths.ts caches it at load), seed
   real book folders under BOOKS_ROOT (state.json + a plaintext manuscript), and
   put ManuscriptRecords in the in-memory store. */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ManuscriptRecord } from '../store/manuscripts.js';

/* #2196 review-fix (🟠) — regression gate for the guard's transient-read retry:
   prove a HEALTHY in-tree book whose state.json read fails once (a cloud-sync
   lock / momentary EIO) still verifies ok instead of halting. We wrap
   state-io.readJson so it can be told to fail a controllable number of times
   before delegating to the real reader; the dedicated test below sets the
   counter while the rest of the file (counter 0) is untouched pass-through. */
const { readJsonTransientFailsRemaining } = vi.hoisted(() => ({
  readJsonTransientFailsRemaining: { n: 0 },
}));
vi.mock('./state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./state-io.js')>();
  return {
    ...actual,
    readJson: async (...args: unknown[]) => {
      if (readJsonTransientFailsRemaining.n > 0) {
        readJsonTransientFailsRemaining.n -= 1;
        throw new Error('transient .audiobook/state.json read failure');
      }
      return (actual as unknown as { readJson: (...a: unknown[]) => Promise<unknown> }).readJson(...args);
    },
  };
});


let workspaceRoot: string;
let guard: typeof import('./book-dir-guard.js');
let paths: typeof import('./paths.js');
let store: typeof import('../store/manuscripts.js');

function existsSyncGuard(p: string): boolean {
  return existsSync(p);
}


function seedBook(
  author: string,
  series: string,
  title: string,
  manuscriptId: string,
): { bookId: string; bookDir: string } {
  const bookId = paths.makeBookId(author, series, title);
  const bookDir = join(paths.BOOKS_ROOT, author, series, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'Once upon a time a tale was told.');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId,
      title,
      author,
      series,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: false,
      chapters: [{ id: 1, title: 'Chapter 1', slug: 'chapter-one' }],
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    }),
  );
  return { bookId, bookDir };
}

/** Put a B-s state.json (carrying a manuscriptId OTHER than the one being
    verified) at `dir`, simulating a stale path that out-of-process acquired a
    different book's identity. */
function plantForeignBook(dir: string, foreignManuscriptId: string, foreignBookId: string): void {
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: foreignBookId,
      manuscriptId: foreignManuscriptId,
      title: 'Foreign',
      author: 'A',
      series: 'Standalones',
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: false,
      chapters: [],
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    }),
  );
}

function record(manuscriptId: string, bookId: string, bookDir: string): ManuscriptRecord {
  return {
    manuscriptId,
    format: 'plaintext',
    title: 'T',
    wordCount: 1,
    byteSize: 1,
    uploadedAt: '2020-01-01T00:00:00.000Z',
    sourceText: 'x',
    chapterHints: [{ id: 1, title: 'C', body: 'x' }],
    bookId,
    bookDir,
  };
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-bookdir-guard-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [g, p, s] = await Promise.all([
    import('./book-dir-guard.js'),
    import('./paths.js'),
    import('../store/manuscripts.js'),
  ]);
  guard = g;
  paths = p;
  store = s;
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});
describe('verifyBookDirForWrite', () => {
  it('1. trusts an in-tree dir whose state.json carries the manuscript identity', async () => {
    const { bookId, bookDir } = seedBook('GuardAuthor', 'Standalones', 'CaseOne', 'm_case1');
    const before = record('m_case1', bookId, bookDir);
    store.putManuscript(before);

    const result = await guard.verifyBookDirForWrite({
      manuscriptId: 'm_case1',
      candidateBookDir: bookDir,
    });

    expect(result).toEqual({ status: 'ok', bookDir });
    /* Fast-path ok → no invalidation; the in-memory record is untouched. */
    expect(store.getManuscript('m_case1')).toBe(before);
  });

  it('1b. also honours the expectedBookId cross-check on the fast path', async () => {
    const { bookId, bookDir } = seedBook('GuardAuthor', 'Standalones', 'CaseOneB', 'm_case1b');
    store.putManuscript(record('m_case1b', bookId, bookDir));

    const result = await guard.verifyBookDirForWrite({
      manuscriptId: 'm_case1b',
      candidateBookDir: bookDir,
      expectedBookId: bookId,
    });

    expect(result).toEqual({ status: 'ok', bookDir });
  });

  it(
    '🟠 a TRANSIENT state.json READ failure is absorbed by the bounded retry, not a halt',
    async () => {
      const { bookId, bookDir } = seedBook('GuardAuthor', 'Standalones', 'CaseRetry', 'm_retry');
      const before = record('m_retry', bookId, bookDir);
      store.putManuscript(before);

      /* One transient read failure (a cloud-sync lock / momentary EIO), then the
         real reader must succeed. Without the retry this healthy in-tree book
         would be treated as an identity miss and (if the re-scan blipped too)
         terminate the run STALE_BOOK_DIR. */
      readJsonTransientFailsRemaining.n = 1;
      const result = await guard.verifyBookDirForWrite({
        manuscriptId: 'm_retry',
        candidateBookDir: bookDir,
      });

      /* The blip consumed exactly one failure and was retried into success: the
         counter drained, the SAME candidate verified ok, and the in-memory
         record was untouched (no slow-path invalidation). */
      expect(readJsonTransientFailsRemaining.n).toBe(0);
      expect(result).toEqual({ status: 'ok', bookDir });
      expect(store.getManuscript('m_retry')).toBe(before);
    },
  );

  it('2. missing dir → slow path re-hydrates and returns the fresh bookDir', async () => {
    const { bookId, bookDir } = seedBook('GuardAuthor', 'Standalones', 'CaseTwo', 'm_case2');
    const stale = join(workspaceRoot, 'stale-case2'); /* does not exist */
    store.putManuscript(record('m_case2', bookId, stale));

    const result = await guard.verifyBookDirForWrite({
      manuscriptId: 'm_case2',
      candidateBookDir: stale,
    });

    /* Resolved to the re-hydrated real location, NOT the dead candidate. */
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.bookDir).toBe(bookDir);
    /* The guard never re-creates a stale dir. */
    expect(existsSyncGuard(stale)).toBe(false); // eslint-disable-line
    /* The store now holds the fresh record (post re-hydration). */
    expect(store.getManuscript('m_case2')?.bookDir).toBe(bookDir);
  });

  it('3. candidate dir holding a DIFFERENT book identity is refused and re-resolves to book A', async () => {
    /* Manuscript A points at a surviving stale path that now holds book B. */
    const { bookId: bookIdA, bookDir: bookDirA } = seedBook(
      'GuardAuthor', 'Standalones', 'CaseThree', 'm_case3a',
    );
    const { bookId: bookIdB } = seedBook('GuardAuthor', 'Standalones', 'CaseThreeB', 'm_case3b');
    const contaminated = join(workspaceRoot, 'stale-contaminated');
    plantForeignBook(contaminated, 'm_case3b', bookIdB);
    store.putManuscript(record('m_case3a', bookIdA, contaminated));

    const result = await guard.verifyBookDirForWrite({
      manuscriptId: 'm_case3a',
      candidateBookDir: contaminated,
    });

    /* Refused the stale B-path; re-hydration found book A at its real dir. */
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.bookDir).toBe(bookDirA);
  });

  it('4. identityBearing:false trusts an existing dir on the fast path', async () => {
    const { bookId } = seedBook('GuardAuthor', 'Standalones', 'CaseFour', 'm_case4');
    const plain = join(workspaceRoot, 'plain-dir-case4'); /* exists, but NO state.json */
    mkdirSync(plain, { recursive: true });
    store.putManuscript(record('m_case4', bookId, plain));

    const result = await guard.verifyBookDirForWrite({
      manuscriptId: 'm_case4',
      candidateBookDir: plain,
      identityBearing: false,
    });

    expect(result).toEqual({ status: 'ok', bookDir: plain });
    /* No invalidation on the identity-free fast-path ok. */
    expect(store.getManuscript('m_case4')?.bookDir).toBe(plain);
  });

  it('4b. identityBearing:false with a MISSING dir still goes slow and re-hydrates', async () => {
    const { bookId, bookDir } = seedBook('GuardAuthor', 'Standalones', 'CaseFourB', 'm_case4b');
    const stale = join(workspaceRoot, 'stale-case4b'); /* does not exist */
    store.putManuscript(record('m_case4b', bookId, stale));

    const result = await guard.verifyBookDirForWrite({
      manuscriptId: 'm_case4b',
      candidateBookDir: stale,
      identityBearing: false,
    });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.bookDir).toBe(bookDir);
  });

  it('5. unresolvable manuscript throws BookDirUnresolvedError', async () => {
    const stale = join(workspaceRoot, 'stale-gone');
    store.putManuscript(record('m_gone', 'b_gone', stale));

    await expect(
      guard.verifyBookDirForWrite({ manuscriptId: 'm_gone', candidateBookDir: stale }),
    ).rejects.toBeInstanceOf(guard.BookDirUnresolvedError);
    /* The stale path must never be created. */
    expect(existsSyncGuard(stale)).toBe(false);
  });
});
describe('tryResolveVerifiedBookDir', () => {
  it('returns null (no throw) when the manuscript is unresolvable', async () => {
    const stale = join(workspaceRoot, 'stale-tryresolve');
    store.putManuscript(record('m_try', 'b_try', stale));

    const resolved = await guard.tryResolveVerifiedBookDir({
      manuscriptId: 'm_try',
      candidateBookDir: stale,
    });

    expect(resolved).toBeNull();
  });

  it('returns the fresh re-hydrated path when the book still lives in BOOKS_ROOT', async () => {
    const { bookId, bookDir } = seedBook('GuardAuthor', 'Standalones', 'TryFound', 'm_tryfound');
    const stale = join(workspaceRoot, 'stale-tryfound');
    store.putManuscript(record('m_tryfound', bookId, stale));

    const resolved = await guard.tryResolveVerifiedBookDir({
      manuscriptId: 'm_tryfound',
      candidateBookDir: stale,
    });

    expect(resolved).toBe(bookDir);
    /* Never re-creates the dead candidate path. */
    expect(existsSyncGuard(stale)).toBe(false);
  });
});

describe('BookDirUnresolvedError', () => {
  it('6. carries code STALE_BOOK_DIR', () => {
    const err = new guard.BookDirUnresolvedError();
    expect(err.code).toBe('STALE_BOOK_DIR');
    expect(err).toBeInstanceOf(guard.BookDirUnresolvedError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('withVerifiedBookDir', () => {
  it('calls fn with the verified bookDir on the ok path', async () => {
    const { bookId, bookDir } = seedBook('GuardAuthor', 'Standalones', 'WithOk', 'm_withok');
    store.putManuscript(record('m_withok', bookId, bookDir));
    const called: string[] = [];

    await guard.withVerifiedBookDir(
      { manuscriptId: 'm_withok', candidateBookDir: bookDir },
      async (dir) => {
        called.push(dir);
      },
    );

    expect(called).toEqual([bookDir]);
  });

  it('7. mode:"drop" does NOT call fn on unresolved', async () => {
    const stale = join(workspaceRoot, 'stale-drop');
    store.putManuscript(record('m_drop', 'b_drop', stale));
    let called = false;

    await guard.withVerifiedBookDir(
      { manuscriptId: 'm_drop', candidateBookDir: stale, mode: 'drop' },
      async () => {
        called = true;
      },
    );

    expect(called).toBe(false);
    expect(existsSyncGuard(stale)).toBe(false);
  });

  it('default mode:"throw" throws BookDirUnresolvedError on unresolved', async () => {
    const stale = join(workspaceRoot, 'stale-withthrow');
    store.putManuscript(record('m_withthrow', 'b_withthrow', stale));

    await expect(
      guard.withVerifiedBookDir(
        { manuscriptId: 'm_withthrow', candidateBookDir: stale },
        async () => {
          throw new Error('should not run');
        },
      ),
    ).rejects.toBeInstanceOf(guard.BookDirUnresolvedError);
  });
});
