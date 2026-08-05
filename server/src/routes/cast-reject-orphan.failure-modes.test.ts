/* #2040 Task 17 fix round 2 review finding 3 — the two id-history writes
   `POST /:bookId/cast/:characterId/reject-orphan-match` performs are NOT
   treated alike on failure, and this file pins the asymmetry directly by
   mocking each primitive to fail independently:

   - `forgetSupersededId` failing is NON-FATAL — the route still 200s. A
     stale `supersededBy` entry left behind is redundant-but-harmless once
     `rejected` (written next) independently blocks resolution.
   - `rejectOrphanedId` failing IS FATAL — the route 500s. For the two
     normalised tiers (where all real orphaned segments in the workspace
     live), `rejected` is the ONLY mechanism that enforces the reject; a
     swallowed failure there would report success while the reject stayed
     purely cosmetic at render time.

   Separate file from cast-reject-orphan.test.ts because `vi.mock` must be
   declared before the module under test is imported, and the main test file
   needs the REAL cast-id-history.ts primitives for its own coverage. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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

const rejectOrphanedIdMock = vi.fn();
const forgetSupersededIdMock = vi.fn();

vi.mock('../store/cast-id-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/cast-id-history.js')>();
  return {
    ...actual,
    rejectOrphanedId: (...args: Parameters<typeof actual.rejectOrphanedId>) =>
      rejectOrphanedIdMock(...args) ?? actual.rejectOrphanedId(...args),
    forgetSupersededId: (...args: Parameters<typeof actual.forgetSupersededId>) =>
      forgetSupersededIdMock(...args) ?? actual.forgetSupersededId(...args),
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
  rejectOrphanedIdMock.mockReset();
  forgetSupersededIdMock.mockReset();
  // Default: both no-op and fall through to the real implementation
  // (`?? actual...` in the mock factory above), so a test only needs to
  // override the ONE primitive it's exercising.
  rejectOrphanedIdMock.mockReturnValue(undefined);
  forgetSupersededIdMock.mockReturnValue(undefined);
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

describe('POST reject-orphan-match — id-history write failure modes (#2040 Task 17 fix round 2)', () => {
  it('forgetSupersededId failing is non-fatal — the route still 200s', async () => {
    forgetSupersededIdMock.mockImplementation(() => {
      throw new Error('disk full');
    });
    const res = await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ characterId: 'mairin', orphanedId: 'mayrin', alreadyPresent: false });

    // The notLinkedTo edge still landed despite the forget failure.
    const cast = readCast();
    const mairin = cast.characters.find((c) => c.id === 'mairin');
    expect(mairin?.notLinkedTo).toEqual([{ bookId, characterId: 'mayrin' }]);
  });

  it('rejectOrphanedId failing IS fatal — the route 500s', async () => {
    rejectOrphanedIdMock.mockImplementation(() => {
      throw new Error('disk full');
    });
    const res = await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to durably record/i);
  });

  it('rejectOrphanedId failing still leaves the earlier notLinkedTo write in place (safe to retry)', async () => {
    rejectOrphanedIdMock.mockImplementation(() => {
      throw new Error('disk full');
    });
    await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });

    const cast = readCast();
    const mairin = cast.characters.find((c) => c.id === 'mairin');
    expect(mairin?.notLinkedTo).toEqual([{ bookId, characterId: 'mayrin' }]);
  });

  it('a subsequent successful retry after a rejectOrphanedId failure returns 200', async () => {
    rejectOrphanedIdMock.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const first = await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(first.status).toBe(500);

    // Second call: rejectOrphanedIdMock's mockReturnValue(undefined) default
    // (set in beforeEach) is back in effect after the mockImplementationOnce
    // override is consumed — this call succeeds.
    const second = await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(second.status).toBe(200);
    // The notLinkedTo write is idempotent — already present from the first
    // (failed-only-at-history) attempt.
    expect(second.body.alreadyPresent).toBe(true);
  });
});
