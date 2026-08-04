/* Integration tests for POST /:bookId/cast/:characterId/reject-orphan-match
   (#2040 Task 17).

   Seeds one book on disk with a live "mairin" cast row. Tests assert:

   - 400 on missing fields.
   - 404 on unknown book / unknown character.
   - 409 when the book has no cast on disk yet.
   - Happy path: writes a one-sided notLinkedTo edge onto the live character
     (this book's own bookId, the orphaned id as `characterId`), AND records
     the rejection in cast-id-history.json (`rejected` list) AND forgets any
     stale `supersededBy` entry naming the orphaned id.
   - Idempotency: a second identical call doesn't duplicate the notLinkedTo
     entry or the `rejected` list entry.

   Same lazy-import-after-WORKSPACE_DIR pattern as cast-not-linked-to.test.ts
   so paths.ts binds BOOKS_ROOT against the temp workspace. */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Della Renwick';
const SERIES = 'Standalones';
const TITLE = 'The Hollow Tide';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;

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

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-reject-orphan-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ castRejectOrphanRouter }, { makeBookId }] = await Promise.all([
    import('./cast-reject-orphan.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);

  app = express();
  app.use(express.json());
  app.use('/api/books', castRejectOrphanRouter);
});

beforeEach(() => {
  writeBookOnDisk(initialCast);
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

describe('POST /api/books/:bookId/cast/:characterId/reject-orphan-match', () => {
  it('rejects when orphanedId is missing', async () => {
    const res = await callReject(bookId, 'mairin', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('returns 404 for an unknown book', async () => {
    const res = await callReject('nonexistent-book', 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown character', async () => {
    const res = await callReject(bookId, 'nonexistent', { orphanedId: 'mayrin' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 409 when the book has no cast on disk yet', async () => {
    writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters: [] }));
    const res = await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(409);
  });

  it('#2040 Task 17 fix round 2 finding 4 — rejects a self-pair (characterId === orphanedId)', async () => {
    // Without this guard, a self notLinkedTo edge would later be honoured by
    // remapFreshToPriorIds' notLinkedToId and refuse a legitimate future
    // by-name remap of this character onto itself — a dead, misleading edge.
    const res = await callReject(bookId, 'mairin', { orphanedId: 'mairin' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/self-pair/i);

    const cast = readCast();
    const mairin = cast.characters.find((c) => c.id === 'mairin');
    expect(mairin?.notLinkedTo).toBeUndefined();
  });

  it('writes a one-sided notLinkedTo edge naming the orphaned id, and echoes the pair', async () => {
    const res = await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ characterId: 'mairin', orphanedId: 'mayrin', alreadyPresent: false });

    const cast = readCast();
    const mairin = cast.characters.find((c) => c.id === 'mairin');
    expect(mairin?.notLinkedTo).toEqual([{ bookId, characterId: 'mayrin' }]);
    // The other cast row is untouched.
    const narrator = cast.characters.find((c) => c.id === 'narrator');
    expect(narrator?.notLinkedTo).toBeUndefined();
  });

  it('records the rejection in cast-id-history.json', async () => {
    await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    const history = readHistory();
    expect(history?.rejected).toEqual(['mayrin']);
  });

  it('forgets a stale supersededBy entry naming the orphaned id', async () => {
    writeFileSync(
      join(bookDir, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({ schema: 1, supersededBy: { mayrin: 'mairin' } }),
    );
    await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    const history = readHistory();
    expect(history?.supersededBy).toEqual({});
    expect(history?.rejected).toEqual(['mayrin']);
  });

  it('is idempotent — a second identical call does not duplicate the notLinkedTo entry or the rejected entry', async () => {
    await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    const res2 = await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res2.status).toBe(200);
    expect(res2.body.alreadyPresent).toBe(true);

    const cast = readCast();
    const mairin = cast.characters.find((c) => c.id === 'mairin');
    expect(mairin?.notLinkedTo).toEqual([{ bookId, characterId: 'mayrin' }]);

    const history = readHistory();
    expect(history?.rejected).toEqual(['mayrin']);
  });

  it('rejecting a second, distinct orphaned id against the same character appends rather than replaces', async () => {
    await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    await callReject(bookId, 'mairin', { orphanedId: 'the-torment' });
    const cast = readCast();
    const mairin = cast.characters.find((c) => c.id === 'mairin');
    expect(mairin?.notLinkedTo).toEqual([
      { bookId, characterId: 'mayrin' },
      { bookId, characterId: 'the-torment' },
    ]);
    const history = readHistory();
    expect(history?.rejected).toEqual(['mayrin', 'the-torment']);
  });
});
