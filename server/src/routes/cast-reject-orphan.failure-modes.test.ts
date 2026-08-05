/* #2040 Task 17 fix round 2 review finding 3 — the two id-history writes
   `POST /:bookId/cast/:characterId/reject-orphan-match` performs are NOT
   treated alike on failure, and this file pins the asymmetry directly by
   mocking each primitive to fail independently. Updated for #2092/#2089
   (pair-scoped reject): the fatal write is now `rejectOrphanedPair`, not the
   legacy id-wide `rejectOrphanedId` (which the route no longer calls).

   - `forgetSupersededId` failing is NON-FATAL — the route still 200s. A
     stale `supersededBy` entry left behind is redundant-but-harmless once
     `rejectedPairs` (written next) independently blocks resolution of THIS
     pair. Only exercised when there's actually something to forget: the
     route now only calls `forgetSupersededId` when the existing
     `supersededBy[orphanedId]` entry targets the SAME `characterId` being
     rejected (#2092/#2089's own pair-scope guard — an entry targeting a
     DIFFERENT character is a live, unrelated alias and must not be
     touched), so this test seeds a matching `supersededBy` entry first.
   - `rejectOrphanedPair` failing IS FATAL — the route 500s. For the two
     normalised tiers (where all real orphaned segments in the workspace
     live), `rejectedPairs` is the ONLY mechanism that enforces the reject; a
     swallowed failure there would report success while the reject stayed
     purely cosmetic at render time.

   I1 (review round 1) — `rejectOrphanedPair` now runs BEFORE
   `forgetSupersededId` (reversed from the original order this file's tests
   were first written against). The original forget-then-reject order made
   this route's own "POST is safe to retry" claim false for the stash
   specifically: if forget succeeded and rejectOrphanedPair then failed, a
   retry's own pair-scope guard would find `supersededBy[orphanedId]`
   already gone and compute `forgotSupersededTo: undefined`, so the RETRY's
   successful `rejectOrphanedPair` call would durably record the pair
   WITHOUT the stash — a later Undo would then have nothing to restore, with
   no error ever surfaced. Reordering means a failed first attempt never
   reaches `forgetSupersededId` at all, so the retry re-reads the still-
   intact `supersededBy` entry fresh. See the dedicated I1 test below.

   Separate file from cast-reject-orphan.test.ts because `vi.mock` must be
   declared before the module under test is imported, and the main test file
   needs the REAL cast-id-history.ts primitives for its own coverage. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Della Renwick';
const SERIES = 'Standalones';
const TITLE = 'The Hollow Tide Failure Modes';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;

const rejectOrphanedPairMock = vi.fn();
const forgetSupersededIdMock = vi.fn();
const restoreSupersededIdMock = vi.fn();

vi.mock('../store/cast-id-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/cast-id-history.js')>();
  return {
    ...actual,
    rejectOrphanedPair: (...args: Parameters<typeof actual.rejectOrphanedPair>) =>
      rejectOrphanedPairMock(...args) ?? actual.rejectOrphanedPair(...args),
    forgetSupersededId: (...args: Parameters<typeof actual.forgetSupersededId>) =>
      forgetSupersededIdMock(...args) ?? actual.forgetSupersededId(...args),
    restoreSupersededId: (...args: Parameters<typeof actual.restoreSupersededId>) =>
      restoreSupersededIdMock(...args) ?? actual.restoreSupersededId(...args),
  };
});

const initialCast = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
  { id: 'mairin', name: 'Mairin', role: 'character', color: 'unset' },
];

function writeBookOnDisk(characters: object[]) {
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
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
}

function readCast(): { characters: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'));
}

function readHistory(): Record<string, unknown> | null {
  const path = join(bookDir, '.audiobook', 'cast-id-history.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Seeds a `supersededBy` entry targeting `mairin` so the route's pair-scope
    forget-guard actually calls `forgetSupersededId` (it now no-ops when
    there's nothing matching `characterId` to forget). */
function seedMatchingSupersededByEntry() {
  writeFileSync(
    join(bookDir, '.audiobook', 'cast-id-history.json'),
    JSON.stringify({ schema: 1, supersededBy: { mayrin: 'mairin' } }),
  );
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-reject-orphan-failure-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  /* #2083 — sequential awaits, not Promise.all: a Promise.all of dynamic
     imports here races the async vi.mock factory above (module-under-test can
     receive the real binding instead of the mock). Measured latent for this
     file — 0 failures in 14 runs (#2083's own survey) — not the live
     ~2-in-5 rate, which belongs to voices.test.ts, a different file already
     fixed under #2046. */
  const { castRejectOrphanRouter } = await import('./cast-reject-orphan.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);

  app = express();
  app.use(express.json());
  app.use('/api/books', castRejectOrphanRouter);
});

beforeEach(() => {
  writeBookOnDisk(initialCast);
  rejectOrphanedPairMock.mockReset();
  forgetSupersededIdMock.mockReset();
  restoreSupersededIdMock.mockReset();
  // Default: all three no-op and fall through to the real implementation
  // (`?? actual...` in the mock factory above), so a test only needs to
  // override the ONE primitive it's exercising.
  rejectOrphanedPairMock.mockReturnValue(undefined);
  forgetSupersededIdMock.mockReturnValue(undefined);
  restoreSupersededIdMock.mockReturnValue(undefined);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function callReject(theBookId: string, characterId: string, body: object) {
  return request(app)
    .post(`/api/books/${theBookId}/cast/${characterId}/reject-orphan-match`)
    .set('Content-Type', 'application/json')
    .send(body);
}

function callUndoReject(theBookId: string, characterId: string, body: object) {
  return request(app)
    .delete(`/api/books/${theBookId}/cast/${characterId}/reject-orphan-match`)
    .set('Content-Type', 'application/json')
    .send(body);
}

describe('POST reject-orphan-match — id-history write failure modes (#2040 Task 17 fix round 2; #2092/#2089 pair-scope)', () => {
  it('forgetSupersededId failing is non-fatal — the route still 200s', async () => {
    seedMatchingSupersededByEntry();
    forgetSupersededIdMock.mockImplementation(() => {
      throw new Error('disk full');
    });
    const res = await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      characterId: 'mairin',
      orphanedId: 'mayrin',
      alreadyPresent: false,
      resolution: null,
      resolvedCharacterId: undefined,
    });

    // The notLinkedTo edge still landed despite the forget failure.
    const cast = readCast();
    const mairin = cast.characters.find((c) => c.id === 'mairin');
    expect(mairin?.notLinkedTo).toEqual([{ bookId, characterId: 'mayrin' }]);
  });

  it('rejectOrphanedPair failing IS fatal — the route 500s', async () => {
    rejectOrphanedPairMock.mockImplementation(() => {
      throw new Error('disk full');
    });
    const res = await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to durably record/i);
  });

  it('rejectOrphanedPair failing still leaves the earlier notLinkedTo write in place (safe to retry)', async () => {
    rejectOrphanedPairMock.mockImplementation(() => {
      throw new Error('disk full');
    });
    await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });

    const cast = readCast();
    const mairin = cast.characters.find((c) => c.id === 'mairin');
    expect(mairin?.notLinkedTo).toEqual([{ bookId, characterId: 'mayrin' }]);
  });

  it('a subsequent successful retry after a rejectOrphanedPair failure returns 200', async () => {
    rejectOrphanedPairMock.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const first = await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(first.status).toBe(500);

    // Second call: rejectOrphanedPairMock's mockReturnValue(undefined) default
    // (set in beforeEach) is back in effect after the mockImplementationOnce
    // override is consumed — this call succeeds.
    const second = await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(second.status).toBe(200);
    // The notLinkedTo write is idempotent — already present from the first
    // (failed-only-at-history) attempt.
    expect(second.body.alreadyPresent).toBe(true);
  });

  it('I1 (review round 1) — a rejectOrphanedPair failure on attempt 1 never reaches forgetSupersededId, so the retry writes the stash', async () => {
    seedMatchingSupersededByEntry(); // supersededBy: { mayrin: 'mairin' }
    rejectOrphanedPairMock.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const first = await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(first.status).toBe(500);

    // The reorder's whole point: a failed FATAL write must never let the
    // non-fatal forget run first and consume the stash.
    expect(forgetSupersededIdMock).not.toHaveBeenCalled();
    expect(readHistory()?.supersededBy).toEqual({ mayrin: 'mairin' });

    // Retry: rejectOrphanedPairMock's mockReturnValue(undefined) default is
    // back in effect (mockImplementationOnce is consumed), so this call
    // reaches the REAL primitive with a freshly-recomputed stash.
    const second = await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(second.status).toBe(200);

    const history = readHistory();
    expect(history?.rejectedPairs).toEqual([
      { from: 'mayrin', to: 'mairin', forgotSupersededTo: 'mairin' },
    ]);
  });

  it('#2092/#2089 pair-scope guard — forgetSupersededId is NOT called when the existing supersededBy entry targets a DIFFERENT character', async () => {
    // 'mayrin' aliases to 'narrator', but this reject is against 'mairin' —
    // the entry must be left alone, so forgetSupersededId must never even be
    // invoked (proven directly on the mock, not just indirectly via its
    // absence of a thrown error).
    writeFileSync(
      join(bookDir, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({ schema: 1, supersededBy: { mayrin: 'narrator' } }),
    );
    const res = await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(200);
    expect(forgetSupersededIdMock).not.toHaveBeenCalled();
  });
});

describe('DELETE reject-orphan-match (undo) — I5 (review round 1): the notLinkedTo removal already landed before any fatal id-history step can fail', () => {
  it('a restoreSupersededId failure 500s with a message that does NOT claim "nothing else was changed" — the notLinkedTo edge is already gone', async () => {
    // Seed a state matching what a genuine prior POST reject leaves behind:
    // the notLinkedTo edge on cast.json, and a pair with a stash to restore
    // on cast-id-history.json.
    writeBookOnDisk([
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
      {
        id: 'mairin',
        name: 'Mairin',
        role: 'character',
        color: 'unset',
        notLinkedTo: [{ bookId, characterId: 'mayrin' }],
      },
    ]);
    writeFileSync(
      join(bookDir, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({
        schema: 1,
        supersededBy: {},
        rejectedPairs: [{ from: 'mayrin', to: 'mairin', forgotSupersededTo: 'mairin' }],
      }),
    );

    restoreSupersededIdMock.mockImplementation(() => {
      throw new Error('disk full');
    });
    const res = await callUndoReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(500);
    // I5's actual pin: the message must not claim nothing changed.
    expect(res.body.error).not.toMatch(/nothing else was changed/i);
    expect(res.body.error).toMatch(/character link removal.*already saved/i);

    // I5's other half — prove the claim in the corrected message is TRUE:
    // the notLinkedTo edge really is already gone by the time this 500 is
    // returned, because it's written unconditionally, first, before any
    // fatal id-history step runs.
    const cast = readCast();
    const mairin = cast.characters.find((c) => c.id === 'mairin');
    expect(mairin?.notLinkedTo).toEqual([]);

    // And the id-history side is untouched by the failed restore attempt —
    // the pair is still there for a retry to find.
    const history = readHistory();
    expect(history?.rejectedPairs).toEqual([
      { from: 'mayrin', to: 'mairin', forgotSupersededTo: 'mairin' },
    ]);
  });
});
