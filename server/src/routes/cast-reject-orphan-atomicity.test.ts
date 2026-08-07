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
  /* #2198 — fails the Nth cast-id-history.json write, COUNTED CUMULATIVELY
     across every call in the test (not reset per HTTP request), so the same
     mechanism naturally distinguishes the pre-fix two-loop shape (several
     history writes per DELETE call) from the post-#2198 batched shape (one).
     `null` disables it. */
  historyWriteFailAtCount: null as number | null,
  historyWriteCallCount: 0,
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
      if (which === 'history') {
        faults.historyWriteCallCount += 1;
        if (faults.historyWriteFailAtCount === faults.historyWriteCallCount) {
          throw new Error(`simulated failure on cast-id-history.json write #${faults.historyWriteCallCount}`);
        }
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

function historyPath(): string {
  return join(bookDir, '.audiobook', 'cast-id-history.json');
}

/** Raw bytes, not parsed — byte-identity is the whole point of the #2198
    atomicity tests below ("it threw" does not prove the file survived). */
function historyBytes(): string | null {
  return existsSync(historyPath()) ? readFileSync(historyPath(), 'utf8') : null;
}

function readHistory(): Record<string, unknown> | null {
  if (!existsSync(historyPath())) return null;
  return JSON.parse(readFileSync(historyPath(), 'utf8'));
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
  faults.historyWriteFailAtCount = null;
  faults.historyWriteCallCount = 0;
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

describe('#2198 — a multi-pair reject Undo is atomic (one batched write, not two loops)', () => {
  /* Live cast target for the normalised-sibling shape below: 'the_torment'
     (the row's own raw id, no supersededBy entry of its own) and
     'The-Torment' (a differently-spelled sibling that normalises to the same
     key) both govern the SAME live character, 'the-torment' — the repo's own
     real drift shape (see cast-reject-orphan.test.ts's M-6/M-7). */
  function seedTormentBook() {
    writeFileSync(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
          {
            id: 'the-torment',
            name: 'The Torment',
            role: 'character',
            color: 'unset',
            notLinkedTo: [
              { bookId, characterId: 'the_torment' },
              { bookId, characterId: 'The-Torment' },
            ],
          },
        ],
      }),
    );
    writeFileSync(
      historyPath(),
      JSON.stringify({
        schema: 1,
        supersededBy: {},
        rejectedPairs: [
          // The row's OWN raw id — carries the stash that, once restored,
          // is what blinds the retry (see the test body for the mechanism).
          { from: 'the_torment', to: 'the-torment', forgotSupersededTo: 'the-torment' },
          // A differently-spelled sibling that normalises to the same key,
          // with NO supersededBy entry of its own — it governs this row only
          // via the normalised-id tier, which is exactly what's at stake.
          { from: 'The-Torment', to: 'the-torment' },
        ],
      }),
    );
  }

  it('[B1] #2198 repro — a mid-batch failure must not blind a retry to a normalised-spelling sibling pair', async () => {
    seedTormentBook();

    /* Fails the SECOND cast-id-history.json write across the whole test
       (cumulative, not per-request — see the mock's own comment). Under the
       pre-#2198 two-loop shape this lands exactly between "pair 1's restore
       lands" (write #1, succeeds — moves supersededBy['the_torment'] to
       'the-torment') and "pair 1's removal from rejectedPairs" (write #2,
       fails) — the failure mode #2198 exists to close. Under the fixed
       batched shape there is only ONE history write per DELETE call, so this
       merely fails the whole first attempt outright, leaving the file
       untouched for a clean retry — no blinding is possible either way. */
    faults.historyWriteFailAtCount = 2;

    await request(app)
      .delete(`/api/books/${bookId}/cast/the-torment/reject-orphan-match`)
      .send({ orphanedId: 'the_torment' });

    // Retry — no further fault injected (the counter only ever hits 2 once).
    // Under the FIXED (batched) shape the first call already completes the
    // whole undo in its one write (count never reaches 2), so this retry is
    // a confirmatory no-op. Under the PRE-FIX (two-loop) shape the first
    // call 500s partway through, having already moved `supersededBy` for the
    // raw pair — that's what's asserted below via the FINAL state, since the
    // pre-fix bug is specifically that a retry's response silently omits the
    // stuck sibling rather than reporting an error.
    const retry = await request(app)
      .delete(`/api/books/${bookId}/cast/the-torment/reject-orphan-match`)
      .send({ orphanedId: 'the_torment' });
    expect(retry.status).toBe(200);

    // THE ASSERTION THIS TEST EXISTS FOR: after the retry, BOTH pairs must be
    // gone — not just the raw self-pair. Pre-#2198, the sibling pair drops
    // out of `rejectedPairsGoverning` on the retry (the restored alias makes
    // `the_torment` resolve via the `history` tier instead of
    // `normalised-id`, so `normalisedTierRelevant` goes false) and is
    // permanently stuck on disk — this fails on the pre-fix code.
    const history = readHistory();
    expect(history?.rejectedPairs).toEqual([]);
    expect(history?.supersededBy).toEqual({ the_torment: 'the-torment' });
  });

  it('[B3] a failure at the SECOND history write discriminates a truly batched write from a per-pair one', async () => {
    /* [B2] below kills the FIRST history write — that fails identically
       before ANY mutation lands whether the primitive writes once for the
       whole batch or once per pair, so it cannot tell the two shapes apart.
       This case can: under the FIXED (batched) shape there is only ONE
       history write for this whole 2-pair batch, so failing the SECOND one
       never fires — the request must succeed outright, in one shot, with
       the whole batch landed. Under a per-pair-write shape (one write per
       loop iteration, in ADDITION to the final write), write #1 (pair 1)
       lands and write #2 (pair 2) fails — a 500 with a file that reflects
       pair 1 done and pair 2 still pending. */
    seedTormentBook();
    faults.historyWriteFailAtCount = 2;

    const res = await request(app)
      .delete(`/api/books/${bookId}/cast/the-torment/reject-orphan-match`)
      .send({ orphanedId: 'the_torment' });

    expect(res.status).toBe(200);
    expect(res.body.removedFrom).toEqual(['the_torment', 'The-Torment']);

    const history = readHistory();
    expect(history?.rejectedPairs).toEqual([]);
    expect(history?.supersededBy).toEqual({ the_torment: 'the-torment' });
  });

  it('[B2] a failure at the FIRST history write leaves cast-id-history.json byte-identical — writeJsonAtomic\'s own atomicity, plus no mutation lands before the write fires. Does NOT by itself distinguish a batched write from a per-pair one (see [B3])', async () => {
    seedTormentBook();
    const before = historyBytes();

    // Fails the very first (and, in the fixed shape, only) history write.
    faults.historyWriteFailAtCount = 1;

    const res = await request(app)
      .delete(`/api/books/${bookId}/cast/the-torment/reject-orphan-match`)
      .send({ orphanedId: 'the_torment' });

    expect(res.status).toBe(500);
    // Byte-identical — not merely "still parses the same" — proving the
    // temp-file-plus-rename write never landed at all.
    expect(historyBytes()).toBe(before);

    // The cast.json edge removal is unconditional and runs BEFORE the
    // id-history write (I5), so it's unaffected by this failure.
    const cast = JSON.parse(castBytes());
    expect(cast.characters.find((c: { id: string }) => c.id === 'the-torment').notLinkedTo).toEqual([]);
  });
});
