/* #2292 (owner decision) — `POST …/reject-orphan-match`'s `forgetSupersededId`
 * handler: "non-fatal" for a disk fault, fatal for a lock-acquisition timeout.
 *
 * The route writes three things. Two are already fatal. The third — forgetting
 * the now-redundant `supersededBy[orphanedId]` alias — was best-effort for
 * everything, so a lock timeout there reported a completed reject with the
 * stash cleanup silently skipped.
 *
 * The decision turned on ONE question: does the leftover self-heal at the next
 * analysis persist, the way `cast-link-orphan`'s stale `notLinkedTo` edge does
 * via `reconcileRejectEdgesOnDisk`'s removal pass? It does not, and the first
 * fixture below proves it directly rather than asserting it in prose: the two
 * passes that ever prune `supersededBy` key on the OPPOSITE conditions to the
 * shape this leftover has, and neither touches it. So the request fails loud
 * and names a remediation that works.
 *
 * "A remediation that works" is not decoration either — `cast-link-orphan`'s
 * message went through two wrong versions, both of which told the user to do
 * something that silently did nothing. So the retry fixture below does not
 * stop at the 500: it performs the retry the message asks for and asserts the
 * outcome the message promises.
 *
 * `forgetSupersededId` is mocked rather than the lock genuinely contended: the
 * real budget is 10s and vitest's testTimeout is 15s. The mock throws the REAL
 * error class; that the real mutex throws it on expiry is pinned in
 * `workspace/file-lock.test.ts`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const forget = vi.hoisted(() => ({ toThrow: null as unknown, calls: 0 }));

vi.mock('../store/cast-id-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/cast-id-history.js')>();
  return {
    ...actual,
    forgetSupersededId: async (...args: Parameters<typeof actual.forgetSupersededId>) => {
      forget.calls += 1;
      if (forget.toThrow) throw forget.toThrow;
      return actual.forgetSupersededId(...args);
    },
  };
});

const AUTHOR = 'Della Renwick';
const SERIES = 'Standalones';
const TITLE = 'The Hollow Tide Reject Lock';

/** The live cast row the orphan is being rejected AGAINST. */
const CHARACTER_ID = 'mairin';
/** The orphaned attribution id — deliberately NOT a cast row, which is the
 *  whole reason the leftover cannot self-heal. */
const ORPHANED_ID = 'mayrin';

let workspaceRoot: string;
let bookDir: string;
let bookId: string;
let app: Express;
let LockAcquisitionTimeoutError: typeof import('../workspace/file-lock.js').LockAcquisitionTimeoutError;
let dropSupersededIdsReclaimedByLiveCast: typeof import('../store/cast-id-history.js').dropSupersededIdsReclaimedByLiveCast;
let dropSupersededTargetsNoLongerLive: typeof import('../store/cast-id-history.js').dropSupersededTargetsNoLongerLive;

const cast = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
  { id: CHARACTER_ID, name: 'Mairin', role: 'character', color: 'unset' },
];

interface HistoryOnDisk {
  supersededBy: Record<string, string>;
  rejectedPairs?: Array<{ from: string; to: string; forgotSupersededTo?: string }>;
}

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
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters: cast }));
  /* The alias the reject is supposed to forget: key = the orphan, value = the
     live character. `forgotSupersededTo` is only computed when the entry
     points at THIS characterId (the route's own guard), so this exact shape is
     the one that reaches the handler under test. */
  writeFileSync(
    join(bookDir, '.audiobook', 'cast-id-history.json'),
    /* `schema: 1` is not decoration — `isWellFormedHistory` is all-or-nothing,
       and without it every mutating helper throws `CastIdHistoryUnreadableError`
       before the handler under test is ever reached (the vacuous-pass shape
       this branch has already hit once). */
    JSON.stringify({
      schema: 1,
      seq: 1,
      supersededBy: { [ORPHANED_ID]: CHARACTER_ID },
    }),
  );
}

function readHistory(): HistoryOnDisk {
  return JSON.parse(
    readFileSync(join(bookDir, '.audiobook', 'cast-id-history.json'), 'utf8'),
  ) as HistoryOnDisk;
}

function readCast(): { characters: Array<{ id: string; notLinkedTo?: Array<{ characterId: string }> }> } {
  return JSON.parse(readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'));
}

function callReject() {
  return request(app)
    .post(`/api/books/${bookId}/cast/${CHARACTER_ID}/reject-orphan-match`)
    .set('Content-Type', 'application/json')
    .send({ orphanedId: ORPHANED_ID });
}

/** The two halves of the reject that are already durable by the time the
 *  forget runs — asserted on BOTH sides of the discrimination, because the
 *  500's message claims them and a message that overstates what landed is the
 *  defect this route has been fixed for twice. */
function expectRejectDurable(): void {
  const history = readHistory();
  expect(history.rejectedPairs ?? []).toEqual([
    { from: ORPHANED_ID, to: CHARACTER_ID, forgotSupersededTo: CHARACTER_ID },
  ]);
  const row = readCast().characters.find((c) => c.id === CHARACTER_ID);
  expect((row?.notLinkedTo ?? []).some((e) => e.characterId === ORPHANED_ID)).toBe(true);
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-reject-orphan-lock-timeout-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  /* SEQUENTIAL, not `Promise.all` — a parallel batch of dynamic imports races
     the `vi.mock` factory above, and the route then binds the REAL
     `forgetSupersededId`. Observed here first time out: every fixture ran
     green-ish while `forget.calls` stayed 0, i.e. the seam under test was
     never in the graph at all. */
  const history = await import('../store/cast-id-history.js');
  const { castRejectOrphanRouter } = await import('./cast-reject-orphan.js');
  const { makeBookId } = await import('../workspace/paths.js');
  const fileLock = await import('../workspace/file-lock.js');
  LockAcquisitionTimeoutError = fileLock.LockAcquisitionTimeoutError;
  dropSupersededIdsReclaimedByLiveCast = history.dropSupersededIdsReclaimedByLiveCast;
  dropSupersededTargetsNoLongerLive = history.dropSupersededTargetsNoLongerLive;
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);

  app = express();
  app.use(express.json());
  app.use('/api/books', castRejectOrphanRouter);
});

beforeEach(() => {
  forget.toThrow = null;
  forget.calls = 0;
  seedDisk();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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

describe('the leftover this handler can produce does NOT self-heal (#2292)', () => {
  it('survives both `supersededBy` prune passes an analysis persist runs', async () => {
    /* The evidence the fail-loud decision rests on, driven against the REAL
       passes rather than asserted in prose.

       `dropSupersededIdsReclaimedByLiveCast` prunes an entry whose KEY became
       live; the key here is an orphaned attribution id with no cast row.
       `dropSupersededTargetsNoLongerLive` prunes an entry whose TARGET died;
       the target here is the live row the route just validated. The leftover
       sits exactly in the gap between them. The third healer,
       `reconcileRejectEdgesOnDisk`, only ever rewrites cast.json's
       `notLinkedTo` edges and never opens this file's `supersededBy` at all —
       which is why `cast-link-orphan` can honestly say "the next analysis
       clears it" and this route cannot. */
    const liveIds = cast.map((c) => c.id);
    expect(liveIds).not.toContain(ORPHANED_ID); // the premise, not an assumption
    expect(liveIds).toContain(CHARACTER_ID);

    const reclaimed = await dropSupersededIdsReclaimedByLiveCast(bookDir, liveIds);
    const deadTarget = await dropSupersededTargetsNoLongerLive(bookDir, liveIds);

    expect(reclaimed).toEqual([]);
    expect(deadTarget).toEqual([]);
    expect(readHistory().supersededBy[ORPHANED_ID]).toBe(CHARACTER_ID);
  });
});

describe('POST reject-orphan-match — forget lock timeout vs disk fault (#2292)', () => {
  it('a lock timeout FAILS the request, with the rejection itself still durable', async () => {
    forget.toThrow = new LockAcquisitionTimeoutError(`cast-id-history:${bookDir}`, 10_000);

    const res = await callReject();

    expect(forget.calls).toBe(1); // the handler under test really ran
    expect(res.status).toBe(500);
    expect(res.type).toBe('application/json');
    /* The message's three claims, each checked against disk below: the
       rejection IS durable, the alias was NOT cleared, and a retry — not a
       later analysis — is what finishes it. */
    expect(res.body.error).toContain('recorded and is durable');
    expect(res.body.error).toContain('Retry this same action');
    expect(res.body.error).toContain('no later analysis will clear it');

    expectRejectDurable();
    expect(readHistory().supersededBy[ORPHANED_ID]).toBe(CHARACTER_ID);
  });

  it('the retry the message promises actually finishes the job', async () => {
    /* The trap this fixture exists for: pinning the first response and never
       the follow-up is how a false remediation shipped on the sibling route.
       If the message says "retry this same action", retrying must end with
       the stated outcome. */
    forget.toThrow = new LockAcquisitionTimeoutError(`cast-id-history:${bookDir}`, 10_000);
    const first = await callReject();
    expect(first.status).toBe(500);

    forget.toThrow = null;
    const retry = await callReject();

    expect(retry.status).toBe(200);
    expect(forget.calls).toBe(2);

    const history = readHistory();
    /* THE STATED OUTCOME: the stale alias is gone. */
    expect(history.supersededBy[ORPHANED_ID]).toBeUndefined();
    /* ...and the retry did not duplicate the pair or lose its stash — the
       `rejectOrphanedPair` early-return is what makes the retry safe, and the
       stash is what keeps Undo lossless. */
    expect(history.rejectedPairs ?? []).toEqual([
      { from: ORPHANED_ID, to: CHARACTER_ID, forgotSupersededTo: CHARACTER_ID },
    ]);
    expect(retry.body.alreadyPresent).toBe(true);
  });

  it('an EPERM-shaped disk fault is STILL swallowed — the request succeeds', async () => {
    /* The direction that reddens if the fix is over-applied into "fail on any
       forget error". A transient EPERM leaves the same redundant entry, and
       `rejectedPairs` (already written) blocks resolution through it anyway,
       so failing the user's reject over one would be the regression. */
    forget.toThrow = Object.assign(
      new Error("EPERM: operation not permitted, rename 'cast-id-history.json'"),
      { code: 'EPERM' },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await callReject();

    expect(forget.calls).toBe(1);
    expect(res.status).toBe(200);
    expect(res.body.orphanedId).toBe(ORPHANED_ID);
    expectRejectDurable();
    expect(readHistory().supersededBy[ORPHANED_ID]).toBe(CHARACTER_ID);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes('failed to forget stale supersededBy entry')),
    ).toBe(true);
  });

  it('the ordinary path is untouched — no throw, alias forgotten, 200', async () => {
    const res = await callReject();

    expect(res.status).toBe(200);
    expect(forget.calls).toBe(1);
    expect(readHistory().supersededBy[ORPHANED_ID]).toBeUndefined();
    expectRejectDurable();
    expect(existsSync(join(bookDir, '.audiobook', 'cast-id-history.json'))).toBe(true);
  });
});
