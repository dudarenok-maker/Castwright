/* Integration tests for POST /:bookId/cast/:characterId/link-orphan-match
   (#2238) — the positive mirror of cast-reject-orphan.ts's POST. Seeds one
   book on disk with a live "mairin" cast row plus the two reserved
   fold-bucket ids. Tests assert:

   - 400 on missing fields / self-pair / a reserved fold-bucket target.
   - 404 on unknown book / unknown character.
   - 409 when the book has no cast on disk yet.
   - Happy path: records `orphanedId -> characterId` in
     cast-id-history.json's `supersededBy` (via retireCharacterId) and
     echoes the resolution recomputed after that write.
   - Idempotency: a second identical call doesn't error and leaves the same
     alias in place.
   - Decision 1 (accepting a previously-rejected pair): a plain link call
     while a pair-scoped rejection is still on disk writes the alias but
     reports `resolution: null` — still blocked — until the rejection is
     actually cleared, at which point the SAME alias (already durably
     written) resolves. Proves the route is unconditional (D3-style) rather
     than silently no-op-ing under a stale rejection.
   - Decision 3 (no withCastLock owed): the route never mutates cast.json —
     asserted by leaving cast.json untouched (mtime/content) across a call.

   Same lazy-import-after-WORKSPACE_DIR pattern as cast-reject-orphan.test.ts
   so paths.ts binds BOOKS_ROOT against the temp workspace. */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { loadCastIdHistory } from '../store/cast-id-history.js';
import { buildCastResolver } from '../store/cast-resolve.js';

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
  { id: 'unknown-male', name: 'Unknown (Male)', role: 'character', color: 'unset' },
  { id: 'unknown-female', name: 'Unknown (Female)', role: 'character', color: 'unset' },
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

async function resolveOrphanedId(orphanedId: string) {
  const cast = readCast();
  const history = await loadCastIdHistory(bookDir);
  return buildCastResolver(cast.characters as Array<{ id: string }>, history).resolve(orphanedId);
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-link-orphan-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ castLinkOrphanRouter }, { castRejectOrphanRouter }, { makeBookId }] = await Promise.all([
    import('./cast-link-orphan.js'),
    import('./cast-reject-orphan.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);

  app = express();
  app.use(express.json());
  app.use('/api/books', castLinkOrphanRouter);
  app.use('/api/books', castRejectOrphanRouter);
});

beforeEach(() => {
  writeBookOnDisk(initialCast);
  const historyPath = join(bookDir, '.audiobook', 'cast-id-history.json');
  if (existsSync(historyPath)) rmSync(historyPath, { force: true });
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function callLink(theBookId: string, characterId: string, body: object) {
  return request(app)
    .post(`/api/books/${theBookId}/cast/${characterId}/link-orphan-match`)
    .set('Content-Type', 'application/json')
    .send(body);
}

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

describe('POST /api/books/:bookId/cast/:characterId/link-orphan-match', () => {
  it('rejects when orphanedId is missing', async () => {
    const res = await callLink(bookId, 'mairin', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('returns 404 for an unknown book', async () => {
    const res = await callLink('nonexistent-book', 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown character', async () => {
    const res = await callLink(bookId, 'nonexistent', { orphanedId: 'mayrin' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 409 when the book has no cast on disk yet', async () => {
    writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters: [] }));
    const res = await callLink(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(409);
  });

  it('rejects a self-pair (characterId === orphanedId)', async () => {
    const res = await callLink(bookId, 'mairin', { orphanedId: 'mairin' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/self-pair/i);
    const history = readHistory();
    expect(history?.supersededBy ?? {}).toEqual({});
  });

  it('decision 4 — refuses a reserved fold-bucket target with a visible reason, and writes nothing', async () => {
    const res = await callLink(bookId, 'unknown-male', { orphanedId: 'the-jogger' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/shared fallback voice/i);
    const history = readHistory();
    expect(history).toBeNull();

    const resFemale = await callLink(bookId, 'unknown-female', { orphanedId: 'the-nurse' });
    expect(resFemale.status).toBe(400);
    expect(resFemale.body.error).toMatch(/shared fallback voice/i);
  });

  it('records the alias in cast-id-history.json and echoes the resolution recomputed after the write', async () => {
    const res = await callLink(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      characterId: 'mairin',
      orphanedId: 'mayrin',
      resolution: 'history',
      resolvedCharacterId: 'mairin',
    });

    const history = readHistory();
    expect(history?.supersededBy).toEqual({ mayrin: 'mairin' });

    const resolved = await resolveOrphanedId('mayrin');
    expect(resolved?.character.id).toBe('mairin');
    expect(resolved?.via).toBe('history');
  });

  it('decision 3 — never writes cast.json (only cast-id-history.json)', async () => {
    const before = readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8');
    const res = await callLink(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(200);
    const after = readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8');
    expect(after).toBe(before);
  });

  it('is idempotent — a second identical call leaves the same alias in place', async () => {
    await callLink(bookId, 'mairin', { orphanedId: 'mayrin' });
    const res2 = await callLink(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res2.status).toBe(200);
    expect(res2.body.resolvedCharacterId).toBe('mairin');

    const history = readHistory();
    expect(history?.supersededBy).toEqual({ mayrin: 'mairin' });
  });

  it('decision 1 — a still-active rejection blocks resolution even after the link write lands, until it is cleared', async () => {
    // Seed a pair-scoped rejection for this exact (orphanedId, characterId)
    // pair, as cast-reject-orphan.ts's POST would have written it.
    const rejectRes = await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(rejectRes.status).toBe(200);
    expect(readHistory()?.rejectedPairs).toEqual([{ from: 'mayrin', to: 'mairin' }]);

    // Calling link WITHOUT clearing the rejection first (a direct API call
    // that skips the frontend's reuse-the-undo-path step) still writes the
    // alias durably...
    const linkRes = await callLink(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(linkRes.status).toBe(200);
    expect(readHistory()?.supersededBy).toEqual({ mayrin: 'mairin' });
    // ...but the pair-scoped rejection still blocks resolve() outright (D2
    // on the reject route: no fall-through past a rejected tier candidate),
    // so the response is honest that nothing visibly changed yet.
    expect(linkRes.body.resolution).toBeNull();
    expect(linkRes.body.resolvedCharacterId).toBeUndefined();

    // Clearing the rejection via the EXISTING undo path (no second removal
    // implementation) lets the already-written alias take immediately, with
    // no further link call needed.
    const undoRes = await callUndoReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(undoRes.status).toBe(200);
    expect(undoRes.body.resolution).toBe('history');
    expect(undoRes.body.resolvedCharacterId).toBe('mairin');

    const resolved = await resolveOrphanedId('mayrin');
    expect(resolved?.character.id).toBe('mairin');
  });
});
