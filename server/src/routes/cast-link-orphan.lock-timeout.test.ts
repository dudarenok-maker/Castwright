/* #2260 review round 3, C3 — the link-orphan route's 500 body must describe
 * what actually happened.
 *
 * The route does two durable things in one `try`: `retireCharacterId` (the
 * alias itself) and then, only when that reports a dropped self-loop
 * rejection, `clearNotLinkedEdgesForDroppedRejections` (cosmetic cleanup of
 * the matching cast.json edge). Before #2260 only the FIRST could throw, so
 * one message covered the handler: "Failed to durably record the link. Retry
 * — the write is idempotent."
 *
 * #2260 made the cleanup rethrow a lock-acquisition timeout instead of
 * swallowing it, which puts a second, differently-shaped failure into the same
 * handler — and by the time it fires the alias IS durably on disk. The old
 * copy then tells the user the exact opposite of the truth.
 *
 * Both directions are pinned here, because a fix that made every failure say
 * "the link was recorded" would be as wrong as the state it replaces:
 *   1. the alias write itself fails  -> the original message, unchanged;
 *   2. the cleanup fails afterwards  -> a message that says the link landed.
 * Each also asserts the response does NOT carry the other's wording, so the
 * two cannot collapse back into one.
 *
 * ROUND 4 (C2) — round 3's copy for case 2 told the user to "retry to complete
 * the cleanup; the write is idempotent". It isn't, and the retry doesn't: the
 * SECOND call hits `retireCharacterId`'s idempotence short-circuit (the
 * governing `rejectedPairs` entry was consumed by the FIRST call), returns an
 * empty `droppedSelfLoopRejections`, so the route's
 * `if (result.droppedSelfLoopRejections.length)` guard is false, the cleanup is
 * never attempted, and the route answers 200. The stale edge is still on disk
 * and the user has been told it worked — the same "remediation that silently
 * does nothing" defect this file was created to fix, one line down.
 *
 * The third test below is therefore about the RETRY, not the first response,
 * which is exactly why the two tests above missed it: they never called twice.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const seam = vi.hoisted(() => ({
  retireThrows: null as unknown,
  /* `null` = pass the REAL result through untouched, which the retry test
     needs: its whole subject is what `retireCharacterId` returns on the SECOND
     call, and forcing the value would paper over exactly that. */
  droppedSelfLoopRejections: null as null | Array<{ from: string; to: string }>,
  clearThrows: null as unknown,
}));

vi.mock('../store/cast-id-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/cast-id-history.js')>();
  return {
    ...actual,
    retireCharacterId: async (bookDir: string, from: string, to: string) => {
      if (seam.retireThrows) throw seam.retireThrows;
      const result = await actual.retireCharacterId(bookDir, from, to);
      if (seam.droppedSelfLoopRejections === null) return result;
      return { ...result, droppedSelfLoopRejections: seam.droppedSelfLoopRejections };
    },
  };
});

vi.mock('../store/not-linked-edges.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/not-linked-edges.js')>();
  return {
    ...actual,
    clearNotLinkedEdgesForDroppedRejections: async (...args: unknown[]) => {
      if (seam.clearThrows) throw seam.clearThrows;
      return (
        actual.clearNotLinkedEdgesForDroppedRejections as unknown as (
          ...a: unknown[]
        ) => Promise<void>
      )(...args);
    },
  };
});

const AUTHOR = 'Della Renwick';
const SERIES = 'Standalones';
const TITLE = 'The Hollow Tide Lock Timeout';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let LockAcquisitionTimeoutError: typeof import('../workspace/file-lock.js').LockAcquisitionTimeoutError;

const CAST = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
  { id: 'mairin', name: 'Mairin', role: 'character', color: 'unset' },
];

/* The exact wording each branch owns. Written out here rather than
   substring-guessed in the assertions so a future reword has one place to
   land and cannot silently make both tests match the same string. */
const RECORD_FAILED = 'Failed to durably record the link.';
/* Deliberately only the part BOTH the round-3 and round-4 wordings share, so
   this constant discriminates which BRANCH answered and nothing else. The
   round-4 claim ("no retry is needed") is asserted separately, in the retry
   test, where reverting the copy reddens that assertion alone. */
const CLEANUP_FAILED = 'The link was recorded';

function seedDisk(): void {
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters: CAST }));
  rmSync(join(bookDir, '.audiobook', 'cast-id-history.json'), { force: true });
}

function callLink() {
  return request(app)
    .post(`/api/books/${bookId}/cast/mairin/link-orphan-match`)
    .set('Content-Type', 'application/json')
    .send({ orphanedId: 'mayrin' });
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-link-orphan-lock-timeout-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ castLinkOrphanRouter }, { makeBookId }, fileLock] = await Promise.all([
    import('./cast-link-orphan.js'),
    import('../workspace/paths.js'),
    import('../workspace/file-lock.js'),
  ]);
  LockAcquisitionTimeoutError = fileLock.LockAcquisitionTimeoutError;
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);

  app = express();
  app.use(express.json());
  app.use('/api/books', castLinkOrphanRouter);
});

beforeEach(() => {
  seam.retireThrows = null;
  seam.clearThrows = null;
  seam.droppedSelfLoopRejections = null;
  seedDisk();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('POST link-orphan-match — which write failed decides the 500 copy (#2260 C3)', () => {
  it('a timeout on the ALIAS write keeps the original "failed to record the link" copy', async () => {
    seam.retireThrows = new LockAcquisitionTimeoutError(`cast-id-history:${bookDir}`, 10_000);

    const res = await callLink();

    expect(res.status).toBe(500);
    expect(res.body.error).toContain(RECORD_FAILED);
    /* Nothing landed, so it must NOT claim the link was recorded. */
    expect(res.body.error).not.toContain(CLEANUP_FAILED);
  });

  it('a timeout on the FOLLOW-UP cleanup says the link WAS recorded, because it was', async () => {
    /* Force the route past `retireCharacterId` (which really runs and really
       writes the alias) and into the cleanup, then fail that. */
    seam.droppedSelfLoopRejections = [{ from: 'mayrin', to: 'mairin' }];
    seam.clearThrows = new LockAcquisitionTimeoutError(`cast:${bookDir}`, 10_000);

    const res = await callLink();

    expect(res.status).toBe(500);
    expect(res.body.error).toContain(CLEANUP_FAILED);
    /* The bug: this branch used to serve the alias-write copy, telling the
       user to retry a write that had already succeeded. */
    expect(res.body.error).not.toContain(RECORD_FAILED);

    /* And the claim it now makes is TRUE — the alias really is on disk. */
    const { loadCastIdHistory } = await import('../store/cast-id-history.js');
    const history = (await loadCastIdHistory(bookDir)) as { supersededBy?: Record<string, string> };
    expect(history.supersededBy?.mayrin).toBe('mairin');
  });

  /* #2260 round 4 (C2). Everything above stops at the FIRST response, which is
     how round 3's "retry to complete the cleanup" survived review: the claim it
     makes is about the SECOND call, and nothing called twice.

     The fixture assembles the two conditions the production join actually
     needs — a `rejectedPairs` entry this retirement turns into a self-loop
     (`{from:'mairin', to:'mayrin'}` repointed through mayrin -> mairin) and a
     same-book `notLinkedTo` edge naming that pair's `from` — rather than
     replaying the multi-run history that produces them, which is not what is
     under test. No forced `droppedSelfLoopRejections`: the real one is the
     subject. */
  it('the retry does NOT complete the cleanup — it 200s with the stale edge still on disk', async () => {
    writeFileSync(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          CAST[0],
          { ...CAST[1], notLinkedTo: [{ bookId, characterId: 'mairin' }] },
        ],
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({
        schema: 1,
        supersededBy: {},
        rejectedPairs: [{ from: 'mairin', to: 'mayrin' }],
      }),
    );
    seam.clearThrows = new LockAcquisitionTimeoutError(`cast:${bookDir}`, 10_000);

    /* Call 1 — the real retirement lands, consumes the rejectedPairs entry,
       reports the dropped self-loop, and the cleanup then times out. */
    const first = await callLink();
    expect(first.status).toBe(500);
    expect(first.body.error).toContain(CLEANUP_FAILED);

    /* The consumed half: the pair is gone, so nothing will ever report this
       drop again. This is the mechanism the retry copy got wrong. */
    const historyAfterFirst = JSON.parse(
      readFileSync(join(bookDir, '.audiobook', 'cast-id-history.json'), 'utf8'),
    ) as { rejectedPairs?: unknown[]; supersededBy?: Record<string, string> };
    expect(historyAfterFirst.supersededBy?.mayrin).toBe('mairin');
    expect(historyAfterFirst.rejectedPairs ?? []).toHaveLength(0);

    /* Call 2 — the retry the OLD copy told the user to perform. The lock is
       still unavailable, so a retry that genuinely re-attempted the cleanup
       would 500 again. It does not: it never reaches the cleanup at all. */
    const second = await callLink();
    expect(second.status).toBe(200);

    /* ...and the edge the retry was supposed to clear is still there. Both
       halves matter: a 200 alone could be a real success, and a surviving edge
       alone could be a failed-but-honest retry. Together they are the exact
       shape "retry to complete the cleanup" promised and did not deliver. */
    const castAfter = JSON.parse(
      readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'),
    ) as { characters: Array<{ id: string; notLinkedTo?: Array<{ characterId: string }> }> };
    const mairin = castAfter.characters.find((c) => c.id === 'mairin');
    expect((mairin?.notLinkedTo ?? []).map((e) => e.characterId)).toContain('mairin');

    /* So the copy must not send them there. Asserted against the RESPONSE
       BODY, not a comment: this is the half that reddens if the branch is
       collapsed back to the old wording. */
    expect(first.body.error).toContain('no retry is needed');
    expect(first.body.error).not.toMatch(/retry to complete/i);
    expect(first.body.error).not.toMatch(/the write is idempotent/i);
    /* And it names what DOES clear it, so the user has somewhere to go. */
    expect(first.body.error).toContain('next analysis');
  });
});
