/* #2166 — the reject's two writes must fail in the RECOVERABLE direction.
   The `rejectedPairs` entry drives the chip and Undo; the `notLinkedTo` edge
   is invisible on its own. So the pair is written FIRST and the edge second,
   and a failure of either is a 500 that names which half landed.

   Its own file (not cast-reject-orphan.test.ts) because this suite needs a
   `vi.mock` on state-io.js, and that suite imports its router inside a
   Promise.all — a shape that races an async mock factory. Imports here are
   awaited SEQUENTIALLY for the same reason. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

/* `vi.hoisted` rather than a module-level `let`: the mock factory is hoisted
   above every top-level binding, so a plain `let` is in its TDZ when the
   factory runs. */
const faults = vi.hoisted(() => ({
  failHistoryWrite: false,
  failCastWrite: false,
  /* Every attempted cast/history write, in order. This IS the route's own
     binding — the route imports `writeJsonAtomic` from this module — so it is
     a real ordering observation, not a spy attached to a copy. */
  calls: [] as string[],
}));

vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return {
    ...actual,
    writeJsonAtomic: async (path: string, data: unknown) => {
      const which = path.endsWith('cast-id-history.json')
        ? 'history'
        : path.endsWith('cast.json')
          ? 'cast'
          : 'other';
      faults.calls.push(which);
      if (faults.failHistoryWrite && which === 'history') {
        throw new Error('simulated ENOSPC on cast-id-history.json');
      }
      if (faults.failCastWrite && which === 'cast') {
        throw new Error('simulated ENOSPC on cast.json');
      }
      return actual.writeJsonAtomic(path, data);
    },
  };
});

const AUTHOR = 'Della Renwick';
const SERIES = 'Standalones';
const TITLE = 'The Hollow Tide';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;

function writeBookOnDisk() {
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
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [
        { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
        { id: 'mairin', name: 'Mairin', role: 'character', color: 'unset' },
      ],
    }),
  );
  rmSync(join(bookDir, '.audiobook', 'cast-id-history.json'), { force: true });
}

function castBytes(): string {
  return readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8');
}

function readHistory(): Record<string, unknown> | null {
  const path = join(bookDir, '.audiobook', 'cast-id-history.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-reject-atomicity-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  /* Sequential, NOT Promise.all — see the header. */
  const { castRejectOrphanRouter } = await import('./cast-reject-orphan.js');
  const { makeBookId } = await import('../workspace/paths.js');

  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);

  app = express();
  app.use(express.json());
  app.use('/api/books', castRejectOrphanRouter);
});

beforeEach(() => {
  faults.failHistoryWrite = false;
  faults.failCastWrite = false;
  faults.calls.length = 0;
  writeBookOnDisk();
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('#2166 — POST fails in the recoverable direction', () => {
  it('[A1] leaves cast.json byte-unchanged when the rejectedPairs write fails', async () => {
    const before = castBytes();
    faults.failHistoryWrite = true;

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    expect(res.status).toBe(500);
    expect(castBytes()).toBe(before);
    expect(readHistory()).toBeNull();
  });

  it('[A2] says nothing was written when the rejectedPairs write fails', async () => {
    faults.failHistoryWrite = true;

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    expect(res.body.error).toMatch(/nothing was written/i);
    expect(res.body.error).toMatch(/retry/i);
  });

  it('[A3] keeps the pair and says the link half is missing when the cast.json write fails', async () => {
    faults.failCastWrite = true;

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/rejection was recorded/i);
    expect(res.body.error).toMatch(/retry/i);
    expect(readHistory()?.rejectedPairs).toEqual([{ from: 'mairin_2', to: 'mairin' }]);
    /* The half that failed really is absent — not merely unasserted. */
    expect(JSON.parse(castBytes()).characters.find((c: { id: string }) => c.id === 'mairin')
      .notLinkedTo).toBeUndefined();
  });

  it('[A4] a retry after a cast.json failure reaches a complete state', async () => {
    faults.failCastWrite = true;
    await request(app)
      .post(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    faults.failCastWrite = false;
    const retry = await request(app)
      .post(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    expect(retry.status).toBe(200);
    expect(readHistory()?.rejectedPairs).toEqual([{ from: 'mairin_2', to: 'mairin' }]);
    expect(
      JSON.parse(castBytes()).characters.find((c: { id: string }) => c.id === 'mairin').notLinkedTo,
    ).toEqual([{ bookId, characterId: 'mairin_2' }]);
  });

  it('[A5] a retry after a rejectedPairs failure reaches a complete state', async () => {
    faults.failHistoryWrite = true;
    await request(app)
      .post(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    faults.failHistoryWrite = false;
    const retry = await request(app)
      .post(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    expect(retry.status).toBe(200);
    expect(readHistory()?.rejectedPairs).toEqual([{ from: 'mairin_2', to: 'mairin' }]);
    expect(
      JSON.parse(castBytes()).characters.find((c: { id: string }) => c.id === 'mairin').notLinkedTo,
    ).toEqual([{ bookId, characterId: 'mairin_2' }]);
  });
});

describe('#2166 — the two verbs are deliberately asymmetric', () => {
  /* Pinned so a later tidy-up cannot "symmetrise" the verbs back into
     agreement. Both orders exist to fail into the SAME visible state:
     pair present, edge absent. */

  it('[A6] POST writes the pair before the edge', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    expect(res.status).toBe(200);
    expect(faults.calls).toEqual(['history', 'cast']);
  });

  it('[A7] DELETE removes the edge before the pair', async () => {
    await request(app)
      .post(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });
    faults.calls.length = 0;

    const res = await request(app)
      .delete(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    expect(res.status).toBe(200);
    expect(faults.calls).toEqual(['cast', 'history']);
  });

  it('[A8] a half-failed DELETE lands in the SAME visible state as a half-failed POST', async () => {
    await request(app)
      .post(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    faults.failHistoryWrite = true;
    const res = await request(app)
      .delete(`/api/books/${bookId}/cast/mairin/reject-orphan-match`)
      .send({ orphanedId: 'mairin_2' });

    expect(res.status).toBe(500);
    /* Edge gone, pair still there — chip renders, Undo retries, nothing is
       invisible. Exactly what [A3] asserts for the POST direction. */
    expect(
      JSON.parse(castBytes()).characters.find((c: { id: string }) => c.id === 'mairin').notLinkedTo,
    ).toEqual([]);
    expect(readHistory()?.rejectedPairs).toEqual([{ from: 'mairin_2', to: 'mairin' }]);
  });
});
